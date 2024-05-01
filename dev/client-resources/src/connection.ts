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
  Account,
  Class,
  ClientConnection,
  Doc,
  DocChunk,
  DocumentQuery,
  Domain,
  DOMAIN_TX,
  FindOptions,
  FindResult,
  getWorkspaceId,
  MeasureDoneOperation,
  MeasureMetricsContext,
  Ref,
  SearchOptions,
  SearchQuery,
  SearchResult,
  ServerStorage,
  Timestamp,
  Tx,
  TxHandler,
  TxResult
} from '@hcengineering/core'
import { createInMemoryTxAdapter } from '@hcengineering/dev-storage'
import devmodel from '@hcengineering/devmodel'
import { setMetadata } from '@hcengineering/platform'
import { protoDeserialize, protoSerialize } from '@hcengineering/rpc'
import {
  ContentTextAdapter,
  createInMemoryAdapter,
  createServerStorage,
  DbConfiguration,
  DummyFullTextAdapter,
  FullTextAdapter
} from '@hcengineering/server-core'

class ServerStorageWrapper implements ClientConnection {
  measureCtx = new MeasureMetricsContext('client', {})
  constructor (
    private readonly storage: ServerStorage,
    private readonly handler: TxHandler
  ) {}

  findAll<T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    const [c, q, o] = protoDeserialize(protoSerialize([_class, query, options], false), false)
    return this.storage.findAll(this.measureCtx, c, q, o)
  }

  async searchFulltext (): Promise<SearchResult> {
    return { docs: [] }
  }

  async loadModel (lastModelTx: Timestamp): Promise<Tx[]> {
    return await this.storage.findAll(this.measureCtx, core.class.Tx, {
      space: core.space.Model,
      modifiedOn: { $gt: lastModelTx }
    })
  }

  async getAccount (): Promise<Account> {
    return (await this.storage.findAll(this.measureCtx, core.class.Account, {}))[0]
  }

  async tx (tx: Tx): Promise<TxResult> {
    const _tx = protoDeserialize(protoSerialize(tx, false), false)
    const [result, derived] = await this.storage.tx(this.measureCtx, _tx)
    for (const tx of derived) {
      this.handler(tx)
    }
    return result
  }

  async close (): Promise<void> {}

  async loadChunk (): Promise<DocChunk> {
    return { idx: -1, docs: [], finished: true }
  }

  async closeChunk (): Promise<void> {}

  async loadDocs (): Promise<Doc[]> {
    return []
  }

  async upload (): Promise<void> {}

  async clean (): Promise<void> {}

  async measure (): Promise<MeasureDoneOperation> {
    return async () => ({ time: 0, serverTime: 0 })
  }

  async sendForceClose (): Promise<void> {}
}

async function createNullFullTextAdapter (): Promise<FullTextAdapter> {
  return new DummyFullTextAdapter()
}
async function createNullContentTextAdapter (): Promise<ContentTextAdapter> {
  return {
    async content () {
      return ''
    },
    metrics () {
      return new MeasureMetricsContext('', {})
    }
  }
}

export async function connect (handler: (tx: Tx) => void): Promise<ClientConnection> {
  const conf: DbConfiguration = {
    domains: {
      [DOMAIN_TX]: 'InMemoryTx'
    },
    defaultAdapter: 'InMemory',
    adapters: {
      InMemoryTx: {
        factory: createInMemoryTxAdapter,
        url: ''
      },
      InMemory: {
        factory: createInMemoryAdapter,
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
    workspace: { ...getWorkspaceId(''), workspaceUrl: '', workspaceName: '' }
  }
  const ctx = new MeasureMetricsContext('client', {})
  const serverStorage = await createServerStorage(ctx, conf, {
    upgrade: false
  })
  setMetadata(devmodel.metadata.DevModel, serverStorage)
  return new ServerStorageWrapper(serverStorage, handler)
}
