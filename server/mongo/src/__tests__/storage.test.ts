/* eslint-disable @typescript-eslint/no-non-null-assertion */
//
// Copyright © 2020 Anticrm Platform Contributors.
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
  type Client,
  type ClientConnection,
  createClient,
  type Doc,
  type DocChunk,
  type Domain,
  DOMAIN_MODEL,
  DOMAIN_TX,
  generateId,
  getWorkspaceId,
  Hierarchy,
  type MeasureContext,
  MeasureMetricsContext,
  ModelDb,
  type Ref,
  SortingOrder,
  type Space,
  TxOperations,
  type WorkspaceId
} from '@hcengineering/core'
import {
  type ContentTextAdapter,
  createNullStorageFactory,
  createServerStorage,
  type DbAdapter,
  type DbConfiguration,
  DummyDbAdapter,
  DummyFullTextAdapter,
  type FullTextAdapter
} from '@hcengineering/server-core'
import { createMongoAdapter, createMongoTxAdapter } from '..'
import { getMongoClient, type MongoClientReference, shutdown } from '../utils'
import { genMinModel } from './minmodel'
import { createTaskModel, type Task, type TaskComment, taskPlugin } from './tasks'

const txes = genMinModel()

createTaskModel(txes)

async function createNullAdapter (): Promise<DbAdapter> {
  return new DummyDbAdapter()
}

async function createNullFullTextAdapter (): Promise<FullTextAdapter> {
  return new DummyFullTextAdapter()
}

async function createNullContentTextAdapter (): Promise<ContentTextAdapter> {
  return {
    async content () {
      return ''
    },
    metrics (): MeasureContext {
      return new MeasureMetricsContext('', {})
    }
  }
}

describe('mongo operations', () => {
  const mongodbUri: string = process.env.MONGO_URL ?? 'mongodb://localhost:27017'
  let mongoClient!: MongoClientReference
  let dbId: string = generateId()
  let hierarchy: Hierarchy
  let model: ModelDb
  let client: Client
  let operations: TxOperations

  beforeAll(async () => {
    mongoClient = getMongoClient(mongodbUri)
  })

  afterAll(async () => {
    await shutdown()
  })

  beforeEach(async () => {
    dbId = 'mongo-testdb-' + generateId()
  })

  afterEach(async () => {
    try {
      await (await mongoClient.getClient()).db(dbId).dropDatabase()
    } catch (eee) {}
  })

  async function initDb (): Promise<void> {
    // Remove all stuff from database.
    hierarchy = new Hierarchy()
    model = new ModelDb(hierarchy)
    for (const t of txes) {
      hierarchy.tx(t)
    }
    for (const t of txes) {
      await model.tx(t)
    }

    const mctx = new MeasureMetricsContext('', {})
    const txStorage = await createMongoTxAdapter(
      new MeasureMetricsContext('', {}),
      hierarchy,
      mongodbUri,
      getWorkspaceId(dbId, ''),
      model
    )

    // Put all transactions to Tx
    for (const t of txes) {
      await txStorage.tx(mctx, t)
    }

    const conf: DbConfiguration = {
      domains: {
        [DOMAIN_TX]: 'MongoTx',
        [DOMAIN_MODEL]: 'Null'
      },
      defaultAdapter: 'Mongo',
      adapters: {
        MongoTx: {
          factory: createMongoTxAdapter,
          url: mongodbUri
        },
        Mongo: {
          factory: createMongoAdapter,
          url: mongodbUri
        },
        Null: {
          factory: createNullAdapter,
          url: ''
        }
      },
      metrics: new MeasureMetricsContext('', {}),
      fulltextAdapter: {
        factory: createNullFullTextAdapter,
        url: '',
        stages: () => []
      },
      contentAdapters: {
        default: {
          factory: createNullContentTextAdapter,
          contentType: '',
          url: ''
        }
      },
      serviceAdapters: {},
      defaultContentAdapter: 'default',
      workspace: { ...getWorkspaceId(dbId, ''), workspaceName: '', workspaceUrl: '' },
      storageFactory: () => createNullStorageFactory()
    }
    const ctx = new MeasureMetricsContext('client', {})
    const serverStorage = await createServerStorage(ctx, conf, { upgrade: false })
    client = await createClient(async () => {
      const st: ClientConnection = {
        findAll: async (_class, query, options) => await serverStorage.findAll(ctx, _class, query, options),
        tx: async (tx) => (await serverStorage.tx(ctx, tx))[0],
        searchFulltext: async () => ({ docs: [] }),
        close: async () => {},
        loadChunk: async (): Promise<DocChunk> => await Promise.reject(new Error('unsupported')),
        closeChunk: async () => {},
        loadDocs: async () => [],
        upload: async () => {},
        clean: async () => {},
        loadModel: async () => txes,
        getAccount: async () => ({}) as any,
        measure: async () => async () => ({ time: 0, serverTime: 0 }),
        sendForceClose: async () => {}
      }
      return st
    })

    operations = new TxOperations(client, core.account.System)
  }

  beforeEach(async () => {
    await initDb()
  })

  it('check add', async () => {
    jest.setTimeout(50000)
    for (let i = 0; i < 50; i++) {
      await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
        name: `my-task-${i}`,
        description: `${i * i}`,
        rate: 20 + i
      })
    }

    const r = await client.findAll<Task>(taskPlugin.class.Task, {})
    expect(r.length).toEqual(50)

    const r2 = await client.findAll(core.class.Tx, {})
    expect(r2.length).toBeGreaterThan(50)
  })

  it('check find by criteria', async () => {
    jest.setTimeout(20000)
    for (let i = 0; i < 50; i++) {
      await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
        name: `my-task-${i}`,
        description: `${i * i}`,
        rate: 20 + i
      })
    }

    const r = await client.findAll<Task>(taskPlugin.class.Task, {})
    expect(r.length).toEqual(50)

    const first = await client.findAll<Task>(taskPlugin.class.Task, { name: 'my-task-0' })
    expect(first.length).toEqual(1)

    const second = await client.findAll<Task>(taskPlugin.class.Task, { name: { $like: '%0' } })
    expect(second.length).toEqual(5)

    const third = await client.findAll<Task>(taskPlugin.class.Task, { rate: { $in: [25, 26, 27, 28] } })
    expect(third.length).toEqual(4)
  })

  it('check update', async () => {
    await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
      name: 'my-task',
      description: 'some data ',
      rate: 20
    })

    const doc = (await client.findAll<Task>(taskPlugin.class.Task, {}))[0]

    await operations.updateDoc(doc._class, doc.space, doc._id, { rate: 30 })
    const tasks = await client.findAll<Task>(taskPlugin.class.Task, {})
    expect(tasks.length).toEqual(1)
    expect(tasks[0].rate).toEqual(30)
  })

  it('check remove', async () => {
    for (let i = 0; i < 10; i++) {
      await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
        name: `my-task-${i}`,
        description: `${i * i}`,
        rate: 20 + i
      })
    }

    let r = await client.findAll<Task>(taskPlugin.class.Task, {})
    expect(r.length).toEqual(10)
    await operations.removeDoc<Task>(taskPlugin.class.Task, '' as Ref<Space>, r[0]._id)
    r = await client.findAll<Task>(taskPlugin.class.Task, {})
    expect(r.length).toEqual(9)
  })

  it('limit and sorting', async () => {
    for (let i = 0; i < 5; i++) {
      await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
        name: `my-task-${i}`,
        description: `${i * i}`,
        rate: 20 + i
      })
    }

    const without = await client.findAll(taskPlugin.class.Task, {})
    expect(without).toHaveLength(5)

    const limit = await client.findAll(taskPlugin.class.Task, {}, { limit: 1 })
    expect(limit).toHaveLength(1)

    const sortAsc = await client.findAll(taskPlugin.class.Task, {}, { sort: { name: SortingOrder.Ascending } })
    expect(sortAsc[0].name).toMatch('my-task-0')

    const sortDesc = await client.findAll(taskPlugin.class.Task, {}, { sort: { name: SortingOrder.Descending } })
    expect(sortDesc[0].name).toMatch('my-task-4')
  })

  it('check attached', async () => {
    const docId = await operations.createDoc(taskPlugin.class.Task, '' as Ref<Space>, {
      name: 'my-task',
      description: 'Descr',
      rate: 20
    })

    const commentId = await operations.addCollection(
      taskPlugin.class.TaskComment,
      '' as Ref<Space>,
      docId,
      taskPlugin.class.Task,
      'tasks',
      {
        message: 'my-msg',
        date: new Date()
      }
    )

    await operations.addCollection(
      taskPlugin.class.TaskComment,
      '' as Ref<Space>,
      docId,
      taskPlugin.class.Task,
      'tasks',
      {
        message: 'my-msg2',
        date: new Date()
      }
    )

    const r2 = await client.findAll<TaskComment>(
      taskPlugin.class.TaskComment,
      {},
      {
        lookup: {
          attachedTo: taskPlugin.class.Task
        }
      }
    )
    expect(r2.length).toEqual(2)
    expect((r2[0].$lookup?.attachedTo as Task)?._id).toEqual(docId)

    const r3 = await client.findAll<Task>(
      taskPlugin.class.Task,
      {},
      {
        lookup: {
          _id: { comment: taskPlugin.class.TaskComment }
        }
      }
    )

    expect(r3).toHaveLength(1)
    expect((r3[0].$lookup as any).comment).toHaveLength(2)

    const comment2Id = await operations.addCollection(
      taskPlugin.class.TaskComment,
      '' as Ref<Space>,
      commentId,
      taskPlugin.class.TaskComment,
      'comments',
      {
        message: 'my-msg3',
        date: new Date()
      }
    )

    const r4 = await client.findAll<TaskComment>(
      taskPlugin.class.TaskComment,
      {
        _id: comment2Id
      },
      {
        lookup: { attachedTo: [taskPlugin.class.TaskComment, { attachedTo: taskPlugin.class.Task } as any] }
      }
    )
    expect((r4[0].$lookup?.attachedTo as TaskComment)?._id).toEqual(commentId)
    expect(((r4[0].$lookup?.attachedTo as any)?.$lookup.attachedTo as Task)?._id).toEqual(docId)
  })
})
