//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  AttachedDoc,
  BackupClient,
  BlobData,
  Client as CoreClient,
  Doc,
  Domain,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  MeasureContext,
  Ref,
  SortingOrder,
  TxCollectionCUD,
  WorkspaceId
} from '@hcengineering/core'
import { connect } from '@hcengineering/server-tool'
import { createGzip } from 'node:zlib'
import { join } from 'path'
import { Writable } from 'stream'
import { extract, Pack, pack } from 'tar-stream'
import { createGunzip, gunzipSync, gzipSync } from 'zlib'
import { BackupStorage } from './storage'
export * from './storage'

const dataBlobSize = 50 * 1024 * 1024
const dataUploadSize = 2 * 1024 * 1024
const retrieveChunkSize = 2 * 1024 * 1024

const defaultLevel = 9

/**
 * @public
 */
export interface Snapshot {
  added: Map<Ref<Doc>, string>
  updated: Map<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface SnapshotV6 {
  added: Record<Ref<Doc>, string>
  updated: Record<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface DomainData {
  snapshot?: string // 0.6 json snapshot
  snapshots?: string[]
  storage?: string[]

  // Some statistics
  added: number
  updated: number
  removed: number
}

/**
 * @public
 */
export interface BackupSnapshot {
  // _id => hash of added items.
  domains: Record<Domain, DomainData>
  date: number
}

/**
 * @public
 */
export interface BackupInfo {
  workspace: string
  version: string
  productId: string
  snapshots: BackupSnapshot[]
  snapshotsIndex?: number
  lastTxId?: string
}

async function loadDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain,
  date?: number
): Promise<Map<Ref<Doc>, string>> {
  ctx = ctx.newChild('load digest', { domain, count: snapshots.length })
  const result = new Map<Ref<Doc>, string>()
  for (const s of snapshots) {
    const d = s.domains[domain]

    // Load old JSON snapshot
    if (d?.snapshot !== undefined) {
      const dChanges: SnapshotV6 = JSON.parse(gunzipSync(await storage.loadFile(d.snapshot)).toString())
      for (const [k, v] of Object.entries(dChanges.added)) {
        result.set(k as Ref<Doc>, v)
      }
      for (const [k, v] of Object.entries(dChanges.updated)) {
        result.set(k as Ref<Doc>, v)
      }
      for (const d of dChanges.removed) {
        result.delete(d)
      }
    }
    for (const snapshot of d?.snapshots ?? []) {
      try {
        const dataBlob = gunzipSync(await storage.loadFile(snapshot))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        for (const k of removed) {
          result.delete(k as Ref<Doc>)
        }
      } catch (err: any) {
        ctx.error('digest is broken, will do full backup for', { domain })
      }
    }
    // Stop if stop date is matched and provided
    if (date !== undefined && date === s.date) {
      break
    }
  }
  ctx.end()
  return result
}

async function write (chunk: any, stream: Writable): Promise<void> {
  let needDrain = false
  await new Promise((resolve, reject) => {
    needDrain = !stream.write(chunk, (err) => {
      if (err != null) {
        reject(err)
      } else {
        resolve(null)
      }
    })
  })
  if (needDrain) {
    await new Promise((resolve) => stream.once('drain', resolve))
  }
}

async function writeChanges (storage: BackupStorage, snapshot: string, changes: Snapshot): Promise<void> {
  const snapshotWritable = await storage.write(snapshot)
  const writable = createGzip({ level: defaultLevel })
  writable.pipe(snapshotWritable)

  // Write size
  await write(`${changes.added.size}\n`, writable)
  for (const [k, v] of changes.added.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.updated.size}\n`, writable)
  for (const [k, v] of changes.updated.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.removed.length}\n`, writable)
  for (const k of changes.removed) {
    await write(`${k}\n`, writable)
  }
  writable.end()
  await new Promise((resolve) => {
    writable.flush(() => {
      resolve(null)
    })
  })
}

/**
 * @public
 */
export async function cloneWorkspace (
  transactorUrl: string,
  sourceWorkspaceId: WorkspaceId,
  targetWorkspaceId: WorkspaceId,
  clearTime: boolean = true,
  progress: (value: number) => Promise<void>
): Promise<void> {
  const sourceConnection = (await connect(transactorUrl, sourceWorkspaceId, undefined, {
    mode: 'backup'
  })) as unknown as CoreClient & BackupClient
  const targetConnection = (await connect(transactorUrl, targetWorkspaceId, undefined, {
    mode: 'backup',
    model: 'upgrade',
    admin: 'true'
  })) as unknown as CoreClient & BackupClient
  try {
    const domains = sourceConnection
      .getHierarchy()
      .domains()
      .filter((it) => it !== DOMAIN_TRANSIENT && it !== DOMAIN_MODEL)

    let i = 0
    for (const c of domains) {
      console.log('clone domain...', c)

      // We need to clean target connection before copying something.
      await cleanDomain(targetConnection, c)

      const changes: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let idx: number | undefined

      // update digest tar
      const needRetrieveChunks: Ref<Doc>[][] = []

      let processed = 0
      let st = Date.now()
      // Load all digest from collection.
      while (true) {
        try {
          const it = await sourceConnection.loadChunk(c)
          idx = it.idx

          let needRetrieve: Ref<Doc>[] = []
          let needRetrieveSize = 0

          for (const { id, hash, size } of it.docs) {
            processed++
            if (Date.now() - st > 2500) {
              console.log('processed', processed, Date.now() - st)
              st = Date.now()
            }

            changes.added.set(id as Ref<Doc>, hash)
            needRetrieve.push(id as Ref<Doc>)
            needRetrieveSize += size

            if (needRetrieveSize > retrieveChunkSize) {
              needRetrieveChunks.push(needRetrieve)
              needRetrieveSize = 0
              needRetrieve = []
            }
          }
          if (needRetrieve.length > 0) {
            needRetrieveChunks.push(needRetrieve)
          }
          if (it.finished) {
            await sourceConnection.closeChunk(idx)
            break
          }
        } catch (err: any) {
          console.error(err)
          if (idx !== undefined) {
            await sourceConnection.closeChunk(idx)
          }
          // Try again
          idx = undefined
          processed = 0
        }
      }
      while (needRetrieveChunks.length > 0) {
        const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

        console.log('Retrieve chunk:', needRetrieve.length)
        let docs: Doc[] = []
        try {
          docs = await sourceConnection.loadDocs(c, needRetrieve)
          if (clearTime) {
            docs = docs.map((p) => {
              let collectionCud = false
              try {
                collectionCud = sourceConnection.getHierarchy().isDerived(p._class, core.class.TxCollectionCUD)
              } catch (err: any) {
                console.log(err)
              }
              if (collectionCud) {
                return {
                  ...p,
                  modifiedOn: Date.now(),
                  createdOn: Date.now(),
                  tx: {
                    ...(p as TxCollectionCUD<Doc, AttachedDoc>).tx,
                    modifiedOn: Date.now(),
                    createdOn: Date.now()
                  }
                }
              } else {
                return {
                  ...p,
                  modifiedOn: Date.now(),
                  createdOn: Date.now()
                }
              }
            })
          }
          await targetConnection.upload(c, docs)
        } catch (err: any) {
          console.log(err)
          // Put back.
          needRetrieveChunks.push(needRetrieve)
          continue
        }
      }

      i++
      await progress((100 / domains.length) * i)
    }
  } catch (err: any) {
    console.error(err)
  } finally {
    console.log('end clone')
    await sourceConnection.close()
    await targetConnection.sendForceClose()
    await targetConnection.close()
  }
}

async function cleanDomain (connection: CoreClient & BackupClient, domain: Domain): Promise<void> {
  // Load all digest from collection.
  let idx: number | undefined
  const ids: Ref<Doc>[] = []
  while (true) {
    try {
      const it = await connection.loadChunk(domain)
      idx = it.idx

      ids.push(...it.docs.map((it) => it.id as Ref<Doc>))
      if (it.finished) {
        break
      }
    } catch (err: any) {
      console.error(err)
      if (idx !== undefined) {
        await connection.closeChunk(idx)
      }
    }
  }
  while (ids.length > 0) {
    const part = ids.splice(0, 5000)
    await connection.clean(domain, part)
  }
}

/**
 * @public
 */
export async function backup (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  storage: BackupStorage,
  skipDomains: string[] = [],
  force: boolean = false,
  timeout: number = -1
): Promise<void> {
  ctx = ctx.newChild('backup', { workspaceId: workspaceId.name, force })
  const connection = await ctx.with(
    'connect',
    {},
    async () =>
      (await connect(transactorUrl, workspaceId, undefined, {
        mode: 'backup'
      })) as unknown as CoreClient & BackupClient
  )
  ctx.info('starting backup', { workspace: workspaceId.name })

  let canceled = false
  let timer: any

  if (timeout > 0) {
    timer = setTimeout(() => {
      ctx.error('Timeout during backup', { workspace: workspaceId.name, timeout: timeout / 1000 })
      canceled = true
    }, timeout)
  }

  try {
    const domains = [
      ...connection
        .getHierarchy()
        .domains()
        .filter((it) => it !== DOMAIN_TRANSIENT && it !== DOMAIN_MODEL && !skipDomains.includes(it))
    ]
    ctx.info('domains for dump', { domains: domains.length })

    let backupInfo: BackupInfo = {
      workspace: workspaceId.name,
      productId: workspaceId.productId,
      version: '0.6.2',
      snapshots: []
    }

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
    }
    backupInfo.version = '0.6.2'

    backupInfo.workspace = workspaceId.name
    backupInfo.productId = workspaceId.productId

    // Skip backup if there is no transaction changes.
    const lastTx = await connection.findOne(
      core.class.Tx,
      {},
      { limit: 1, sort: { modifiedOn: SortingOrder.Descending } }
    )
    if (lastTx !== undefined) {
      if (lastTx._id === backupInfo.lastTxId && !force) {
        ctx.info('No transaction changes. Skipping backup.', { workspace: workspaceId.name })
        return
      }
    }

    backupInfo.lastTxId = '' // Clear until full backup will be complete

    const snapshot: BackupSnapshot = {
      date: Date.now(),
      domains: {}
    }

    backupInfo.snapshots.push(snapshot)
    let backupIndex = `${backupInfo.snapshotsIndex ?? backupInfo.snapshots.length}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    async function loadChangesFromServer (
      ctx: MeasureContext,
      domain: Domain,
      digest: Map<Ref<Doc>, string>,
      changes: Snapshot
    ): Promise<{ changed: number, needRetrieveChunks: Ref<Doc>[][] }> {
      let idx: number | undefined
      let processed = 0
      let st = Date.now()
      let changed: number = 0
      const needRetrieveChunks: Ref<Doc>[][] = []
      // Load all digest from collection.
      while (true) {
        try {
          const currentChunk = await ctx.with('loadChunk', {}, async () => await connection.loadChunk(domain, idx))
          idx = currentChunk.idx

          let needRetrieve: Ref<Doc>[] = []
          let currentNeedRetrieveSize = 0

          for (const { id, hash, size } of currentChunk.docs) {
            processed++
            if (Date.now() - st > 2500) {
              ctx.info('processed', {
                processed,
                digest: digest.size,
                time: Date.now() - st,
                workspace: workspaceId.name
              })
              st = Date.now()
            }
            const kHash = digest.get(id as Ref<Doc>)
            if (kHash !== undefined) {
              digest.delete(id as Ref<Doc>)
              if (kHash !== hash) {
                changes.updated.set(id as Ref<Doc>, hash)
                needRetrieve.push(id as Ref<Doc>)
                currentNeedRetrieveSize += size
                changed++
              }
            } else {
              changes.added.set(id as Ref<Doc>, hash)
              needRetrieve.push(id as Ref<Doc>)
              changed++
              currentNeedRetrieveSize += size
            }

            if (currentNeedRetrieveSize > retrieveChunkSize) {
              needRetrieveChunks.push(needRetrieve)
              currentNeedRetrieveSize = 0
              needRetrieve = []
            }
          }
          if (needRetrieve.length > 0) {
            needRetrieveChunks.push(needRetrieve)
          }
          if (currentChunk.finished) {
            await ctx.with('closeChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
            break
          }
        } catch (err: any) {
          console.error(err)
          ctx.error('failed to load chunks', { error: err })
          if (idx !== undefined) {
            await ctx.with('loadChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
          }
          // Try again
          idx = undefined
          processed = 0
        }
      }
      return { changed, needRetrieveChunks }
    }

    async function processDomain (ctx: MeasureContext, domain: Domain): Promise<void> {
      const changes: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let stIndex = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      const digest = await ctx.with(
        'load-digest',
        {},
        async (ctx) => await loadDigest(ctx, storage, backupInfo.snapshots, domain)
      )

      let _pack: Pack | undefined
      let addedDocuments = 0

      let { changed, needRetrieveChunks } = await ctx.with(
        'load-chunks',
        { domain },
        async (ctx) => await loadChangesFromServer(ctx, domain, digest, changes)
      )

      if (needRetrieveChunks.length > 0) {
        ctx.info('dumping domain...', { workspace: workspaceId.name, domain })
      }

      while (needRetrieveChunks.length > 0) {
        if (canceled) {
          return
        }
        const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

        ctx.info('Retrieve chunk', {
          needRetrieve: needRetrieveChunks.reduce((v, docs) => v + docs.length, 0),
          toLoad: needRetrieve.length,
          workspace: workspaceId.name
        })
        let docs: Doc[] = []
        try {
          docs = await ctx.with('load-docs', {}, async () => await connection.loadDocs(domain, needRetrieve))
        } catch (err: any) {
          ctx.error('error loading docs', { domain, err, workspace: workspaceId.name })
          // Put back.
          needRetrieveChunks.push(needRetrieve)
          continue
        }

        // Chunk data into small pieces
        if (addedDocuments > dataBlobSize && _pack !== undefined) {
          _pack.finalize()
          _pack = undefined
          addedDocuments = 0

          if (changed > 0) {
            snapshot.domains[domain] = domainInfo
            domainInfo.added += processedChanges.added.size
            domainInfo.updated += processedChanges.updated.size
            domainInfo.removed += processedChanges.removed.length

            const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
            snapshotIndex++
            domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
            await writeChanges(storage, snapshotFile, processedChanges)

            processedChanges.added.clear()
            processedChanges.removed = []
            processedChanges.updated.clear()
            await storage.writeFile(
              infoFile,
              gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
            )
          }
        }
        if (_pack === undefined) {
          _pack = pack()
          stIndex++
          const storageFile = join(backupIndex, `${domain}-data-${snapshot.date}-${stIndex}.tar.gz`)
          ctx.info('storing from domain', { domain, storageFile, workspace: workspaceId.name })
          domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]
          const dataStream = await storage.write(storageFile)
          const storageZip = createGzip({ level: defaultLevel })

          _pack.pipe(storageZip)
          storageZip.pipe(dataStream)
        }

        while (docs.length > 0) {
          if (canceled) {
            return
          }
          const d = docs.shift()
          if (d === undefined) {
            break
          }

          // Move processed document to processedChanges
          if (changes.added.has(d._id)) {
            processedChanges.added.set(d._id, changes.added.get(d._id) ?? '')
            changes.added.delete(d._id)
          } else {
            processedChanges.updated.set(d._id, changes.updated.get(d._id) ?? '')
            changes.updated.delete(d._id)
          }
          if (d._class === core.class.BlobData) {
            const blob = d as BlobData
            const data = Buffer.from(blob.base64Data, 'base64')
            blob.base64Data = ''
            const descrJson = JSON.stringify(d)
            addedDocuments += descrJson.length
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, descrJson, function (err) {
              if (err != null) throw err
            })
            _pack.entry({ name: d._id }, data, function (err) {
              if (err != null) throw err
            })
          } else {
            const data = JSON.stringify(d)
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, data, function (err) {
              if (err != null) throw err
            })
          }
        }
      }
      processedChanges.removed = Array.from(digest.keys())
      if (processedChanges.removed.length > 0) {
        changed++
      }

      if (changed > 0) {
        snapshot.domains[domain] = domainInfo
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
        snapshotIndex++
        domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
        await writeChanges(storage, snapshotFile, processedChanges)

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        _pack?.finalize()
        // This will allow to retry in case of critical error.
        await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
      }
    }

    for (const domain of domains) {
      if (canceled) {
        break
      }
      await ctx.with('process-domain', { domain }, async (ctx) => {
        await processDomain(ctx, domain)
      })
    }
    if (!canceled) {
      backupInfo.snapshotsIndex = backupInfo.snapshots.length
      backupInfo.lastTxId = lastTx?._id ?? '0' // We could store last tx, since full backup is complete
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }
  } catch (err: any) {
    ctx.error('backup error', { err, workspace: workspaceId.name })
  } finally {
    ctx.info('end backup', { workspace: workspaceId.name })
    await connection.close()
    ctx.end()
    if (timeout !== -1) {
      clearTimeout(timer)
    }
  }
}

/**
 * @public
 */
export async function backupList (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  for (const s of backupInfo.snapshots) {
    console.log('snapshot: id:', s.date, ' date:', new Date(s.date))
  }
}

/**
 * @public
 * Restore state of DB to specified point.
 */
export async function restore (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  storage: BackupStorage,
  date: number,
  merge?: boolean
): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
  let snapshots = backupInfo.snapshots
  if (date !== -1) {
    const bk = backupInfo.snapshots.findIndex((it) => it.date === date)
    if (bk === -1) {
      throw new Error(`${infoFile} could not restore to ${date}. Snapshot is missing.`)
    }
    snapshots = backupInfo.snapshots.slice(0, bk + 1)
  } else {
    date = snapshots[snapshots.length - 1].date
  }
  console.log('restore to ', date, new Date(date))
  const rsnapshots = Array.from(snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  console.log('connecting:', transactorUrl, workspaceId.name)
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup',
    model: 'upgrade'
  })) as unknown as CoreClient & BackupClient
  console.log('connected')

  // We need to find empty domains and clean them.
  const allDomains = connection.getHierarchy().domains()
  for (const d of allDomains) {
    domains.add(d)
  }

  async function processDomain (c: Domain): Promise<void> {
    const changeset = await loadDigest(ctx, storage, snapshots, c, date)
    // We need to load full changeset from server
    const serverChangeset = new Map<Ref<Doc>, string>()

    let idx: number | undefined
    let loaded = 0
    let el = 0
    let chunks = 0
    try {
      while (true) {
        const st = Date.now()
        const it = await connection.loadChunk(c)
        chunks++

        idx = it.idx
        el += Date.now() - st

        for (const { id, hash } of it.docs) {
          serverChangeset.set(id as Ref<Doc>, hash)
          loaded++
        }

        if (el > 2500) {
          console.log(' loaded from server', loaded, el, chunks)
          el = 0
          chunks = 0
        }
        if (it.finished) {
          break
        }
      }
    } finally {
      if (idx !== undefined) {
        await connection.closeChunk(idx)
      }
    }
    console.log(' loaded', loaded)
    console.log('\tcompare documents', changeset.size, serverChangeset.size)

    // Let's find difference
    const docsToAdd = new Map(
      Array.from(changeset.entries()).filter(
        ([it]) => !serverChangeset.has(it) || (serverChangeset.has(it) && serverChangeset.get(it) !== changeset.get(it))
      )
    )
    const docsToRemove = Array.from(serverChangeset.keys()).filter((it) => !changeset.has(it))

    const docs: Doc[] = []
    const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
    let sendSize = 0
    let totalSend = 0
    async function sendChunk (doc: Doc | undefined, len: number): Promise<void> {
      if (doc !== undefined) {
        docsToAdd.delete(doc._id)
        docs.push(doc)
      }
      sendSize = sendSize + len
      if (sendSize > dataUploadSize || (doc === undefined && docs.length > 0)) {
        console.log('upload', docs.length, `send: ${totalSend} from ${docsToAdd.size + totalSend}`, 'size:', sendSize)
        totalSend += docs.length
        await connection.upload(c, docs)
        docs.length = 0
        sendSize = 0
      }
    }
    let processed = 0

    for (const s of rsnapshots) {
      const d = s.domains[c]

      if (d !== undefined && docsToAdd.size > 0) {
        const sDigest = await loadDigest(ctx, storage, [s], c)
        const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => docsToAdd.has(it)))
        if (requiredDocs.size > 0) {
          console.log('updating', c, requiredDocs.size)
          // We have required documents here.
          for (const sf of d.storage ?? []) {
            if (docsToAdd.size === 0) {
              break
            }
            console.log('processing', sf, processed)

            const readStream = await storage.load(sf)
            const ex = extract()

            ex.on('entry', (headers, stream, next) => {
              const name = headers.name ?? ''
              processed++
              // We found blob data
              if (requiredDocs.has(name as Ref<Doc>)) {
                const chunks: Buffer[] = []
                stream.on('data', (chunk) => {
                  chunks.push(chunk)
                })
                stream.on('end', () => {
                  const bf = Buffer.concat(chunks)
                  const d = blobs.get(name)
                  if (d === undefined) {
                    blobs.set(name, { doc: undefined, buffer: bf })
                    next()
                  } else {
                    const d = blobs.get(name)
                    blobs.delete(name)
                    const doc = d?.doc as BlobData
                    doc.base64Data = bf.toString('base64') ?? ''
                    void sendChunk(doc, bf.length).finally(() => {
                      requiredDocs.delete(doc._id)
                      next()
                    })
                  }
                })
              } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                const chunks: Buffer[] = []
                const bname = name.substring(0, name.length - 5)
                stream.on('data', (chunk) => {
                  chunks.push(chunk)
                })
                stream.on('end', () => {
                  const bf = Buffer.concat(chunks)
                  const doc = JSON.parse(bf.toString()) as Doc
                  if (doc._class === core.class.BlobData) {
                    const d = blobs.get(bname)
                    if (d === undefined) {
                      blobs.set(bname, { doc, buffer: undefined })
                      next()
                    } else {
                      const d = blobs.get(bname)
                      blobs.delete(bname)
                      ;(doc as BlobData).base64Data = d?.buffer?.toString('base64') ?? ''
                      ;(doc as any)['%hash%'] = changeset.get(doc._id)
                      void sendChunk(doc, bf.length).finally(() => {
                        requiredDocs.delete(doc._id)
                        next()
                      })
                    }
                  } else {
                    ;(doc as any)['%hash%'] = changeset.get(doc._id)
                    void sendChunk(doc, bf.length).finally(() => {
                      requiredDocs.delete(doc._id)
                      next()
                    })
                  }
                })
              } else {
                next()
              }
              stream.resume() // just auto drain the stream
            })

            const endPromise = new Promise((resolve) => {
              ex.on('finish', () => {
                resolve(null)
              })
            })
            const unzip = createGunzip({ level: defaultLevel })

            readStream.on('end', () => {
              readStream.destroy()
            })
            readStream.pipe(unzip)
            unzip.pipe(ex)

            await endPromise
          }
        } else {
          console.log('domain had no changes', c)
        }
      }
    }

    await sendChunk(undefined, 0)
    if (docsToRemove.length > 0 && merge !== true) {
      console.log('cleanup', docsToRemove.length)
      while (docsToRemove.length > 0) {
        const part = docsToRemove.splice(0, 10000)
        await connection.clean(c, part)
      }
    }
  }

  try {
    for (const c of domains) {
      console.log('processing domain', c)
      let retry = 5
      let delay = 1
      while (retry > 0) {
        retry--
        try {
          await processDomain(c)
          if (delay > 1) {
            console.log('retry-success')
          }
          break
        } catch (err: any) {
          console.error('error', err)
          if (retry !== 0) {
            console.log('cool-down to retry', delay)
            await new Promise((resolve) => setTimeout(resolve, delay * 1000))
            delay++
          }
        }
      }
    }
  } finally {
    await connection.sendForceClose()
    await connection.close()
  }
}

/**
 * Compacting backup into just one snapshot.
 * @public
 */
export async function compactBackup (
  ctx: MeasureContext,
  storage: BackupStorage,
  force: boolean = false
): Promise<void> {
  console.log('starting backup compaction')
  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
    } else {
      console.log('No backup found')
      return
    }
    if (backupInfo.version !== '0.6.2') {
      console.log('Invalid backup version')
      return
    }

    if (backupInfo.snapshots.length < 5 && !force) {
      console.log('No need to compact, less 5 snapshots')
      return
    }

    const snapshot: BackupSnapshot = {
      date: Date.now(),
      domains: {}
    }

    const oldSnapshots = [...backupInfo.snapshots]

    backupInfo.snapshots = [snapshot]
    let backupIndex = `${backupInfo.snapshotsIndex ?? oldSnapshots.length}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    const domains: Domain[] = []
    for (const sn of oldSnapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }

    for (const domain of domains) {
      console.log('compacting domain...', domain)

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let changed = 0
      let stIndex = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      const digest = await loadDigest(ctx, storage, oldSnapshots, domain)
      const digestAdded = new Map<Ref<Doc>, string>()

      const rsnapshots = Array.from(oldSnapshots).reverse()

      let _pack: Pack | undefined
      let addedDocuments = 0

      let processed = 0

      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()

      async function pushDocs (docs: Doc[], size: number): Promise<void> {
        addedDocuments += size
        changed += docs.length
        // Chunk data into small pieces
        if (addedDocuments > dataBlobSize && _pack !== undefined) {
          _pack.finalize()
          _pack = undefined
          addedDocuments = 0

          if (changed > 0) {
            snapshot.domains[domain] = domainInfo
            domainInfo.added += processedChanges.added.size
            domainInfo.updated += processedChanges.updated.size
            domainInfo.removed += processedChanges.removed.length

            const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
            snapshotIndex++
            domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
            await writeChanges(storage, snapshotFile, processedChanges)

            processedChanges.added.clear()
            processedChanges.removed = []
            processedChanges.updated.clear()
            await storage.writeFile(
              infoFile,
              gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
            )
          }
        }
        if (_pack === undefined) {
          _pack = pack()
          stIndex++
          const storageFile = join(backupIndex, `${domain}-data-${snapshot.date}-${stIndex}.tar.gz`)
          console.log('storing from domain', domain, storageFile)
          domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]
          const dataStream = await storage.write(storageFile)
          const storageZip = createGzip({ level: defaultLevel })

          _pack.pipe(storageZip)
          storageZip.pipe(dataStream)
        }

        while (docs.length > 0) {
          const d = docs.shift()
          if (d === undefined) {
            break
          }

          // Move processed document to processedChanges
          processedChanges.added.set(d._id, digestAdded.get(d._id) ?? '')

          if (d._class === core.class.BlobData) {
            const blob = d as BlobData
            const data = Buffer.from(blob.base64Data, 'base64')
            blob.base64Data = ''
            const descrJson = JSON.stringify(d)
            addedDocuments += descrJson.length
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, descrJson, function (err) {
              if (err != null) throw err
            })
            _pack.entry({ name: d._id }, data, function (err) {
              if (err != null) throw err
            })
          } else {
            const data = JSON.stringify(d)
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, data, function (err) {
              if (err != null) throw err
            })
          }
        }
      }
      async function sendChunk (doc: Doc | undefined, len: number): Promise<void> {
        if (doc !== undefined) {
          const hash = digest.get(doc._id)
          digest.delete(doc._id)
          digestAdded.set(doc._id, hash ?? '')
          await pushDocs([doc], len)
        }
      }

      for (const s of rsnapshots) {
        const d = s.domains[domain]

        if (d !== undefined && digest.size > 0) {
          const sDigest = await loadDigest(ctx, storage, [s], domain)
          const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))
          if (requiredDocs.size > 0) {
            console.log('updating', domain, requiredDocs.size)
            // We have required documents here.
            for (const sf of d.storage ?? []) {
              if (digest.size === 0) {
                break
              }
              console.log('processing', sf, processed)

              const readStream = await storage.load(sf)
              const ex = extract()

              ex.on('entry', (headers, stream, next) => {
                const name = headers.name ?? ''
                processed++
                // We found blob data
                if (requiredDocs.has(name as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    const d = blobs.get(name)
                    if (d === undefined) {
                      blobs.set(name, { doc: undefined, buffer: bf })
                      next()
                    } else {
                      const d = blobs.get(name)
                      blobs.delete(name)
                      const doc = d?.doc as BlobData
                      doc.base64Data = bf.toString('base64') ?? ''
                      void sendChunk(doc, bf.length).finally(() => {
                        requiredDocs.delete(doc._id)
                        next()
                      })
                    }
                  })
                } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  const bname = name.substring(0, name.length - 5)
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    const doc = JSON.parse(bf.toString()) as Doc
                    if (doc._class === core.class.BlobData) {
                      const d = blobs.get(bname)
                      if (d === undefined) {
                        blobs.set(bname, { doc, buffer: undefined })
                        next()
                      } else {
                        const d = blobs.get(bname)
                        blobs.delete(bname)
                        ;(doc as BlobData).base64Data = d?.buffer?.toString('base64') ?? ''
                        ;(doc as any)['%hash%'] = digest.get(doc._id)
                        void sendChunk(doc, bf.length).finally(() => {
                          requiredDocs.delete(doc._id)
                          next()
                        })
                      }
                    } else {
                      ;(doc as any)['%hash%'] = digest.get(doc._id)
                      void sendChunk(doc, bf.length).finally(() => {
                        requiredDocs.delete(doc._id)
                        next()
                      })
                    }
                  })
                } else {
                  next()
                }
                stream.resume() // just auto drain the stream
              })

              const endPromise = new Promise((resolve) => {
                ex.on('finish', () => {
                  resolve(null)
                })
              })
              const unzip = createGunzip({ level: defaultLevel })

              readStream.on('end', () => {
                readStream.destroy()
              })
              readStream.pipe(unzip)
              unzip.pipe(ex)

              await endPromise
            }
          } else {
            console.log('domain had no changes', domain)
          }
        }
      }

      if (changed > 0) {
        snapshot.domains[domain] = domainInfo
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
        snapshotIndex++
        domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
        await writeChanges(storage, snapshotFile, processedChanges)

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        _pack?.finalize()
        // This will allow to retry in case of critical error.
        await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
      }
    }

    // We could get rid of all old snapshot files.
    for (const s of oldSnapshots) {
      for (const [, dta] of Object.entries(s.domains)) {
        for (const sf of dta.storage ?? []) {
          console.log('removing', sf)
          await storage.delete(sf)
        }
        for (const sf of dta.snapshots ?? []) {
          console.log('removing', sf)
          await storage.delete(sf)
        }
        if (dta.snapshot !== undefined) {
          await storage.delete(dta.snapshot)
        }
      }
    }

    backupInfo.snapshotsIndex = backupInfo.snapshots.length
    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
  } catch (err: any) {
    console.error(err)
  } finally {
    console.log('end compacting')
  }
}

export * from './service'
