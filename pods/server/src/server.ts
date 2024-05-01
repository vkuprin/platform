/* eslint-disable @typescript-eslint/unbound-method */
//
// Copyright © 2022 Hardcore Engineering Inc.
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

import {
  coreId,
  DOMAIN_BLOB,
  DOMAIN_FULLTEXT_BLOB,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  type MeasureContext,
  type ServerStorage,
  type WorkspaceId
} from '@hcengineering/core'
import { createElasticAdapter, createElasticBackupDataAdapter } from '@hcengineering/elastic'
import {
  ConfigurationMiddleware,
  ModifiedMiddleware,
  PrivateMiddleware,
  QueryJoinMiddleware,
  SpacePermissionsMiddleware,
  SpaceSecurityMiddleware
} from '@hcengineering/middleware'
import { createMongoAdapter, createMongoTxAdapter } from '@hcengineering/mongo'
import { OpenAIEmbeddingsStage, openAIId, openAIPluginImpl } from '@hcengineering/openai'
import { addLocation, addStringsLoader, platformId } from '@hcengineering/platform'
import {
  BackupClientSession,
  buildStorageFromConfig,
  createNullAdapter,
  createRekoniAdapter,
  createStorageDataAdapter,
  createYDocAdapter,
  getMetricsContext
} from '@hcengineering/server'
import { serverActivityId } from '@hcengineering/server-activity'
import { serverAttachmentId } from '@hcengineering/server-attachment'
import { serverCalendarId } from '@hcengineering/server-calendar'
import { serverChunterId } from '@hcengineering/server-chunter'
import { CollaborativeContentRetrievalStage, serverCollaborationId } from '@hcengineering/server-collaboration'
import { serverContactId } from '@hcengineering/server-contact'
import {
  ContentRetrievalStage,
  createInMemoryAdapter,
  createPipeline,
  FullSummaryStage,
  FullTextPushStage,
  globalIndexer,
  IndexedFieldStage,
  type StorageConfiguration,
  type ContentTextAdapter,
  type DbConfiguration,
  type FullTextAdapter,
  type FullTextPipelineStage,
  type MiddlewareCreator,
  type Pipeline,
  type StorageAdapter
} from '@hcengineering/server-core'
import { serverDocumentId } from '@hcengineering/server-document'
import { serverGmailId } from '@hcengineering/server-gmail'
import { serverGuestId } from '@hcengineering/server-guest'
import { serverHrId } from '@hcengineering/server-hr'
import { serverInventoryId } from '@hcengineering/server-inventory'
import { serverLeadId } from '@hcengineering/server-lead'
import { serverNotificationId } from '@hcengineering/server-notification'
import { serverRecruitId } from '@hcengineering/server-recruit'
import { serverRequestId } from '@hcengineering/server-request'
import { serverSettingId } from '@hcengineering/server-setting'
import { serverTagsId } from '@hcengineering/server-tags'
import { serverTaskId } from '@hcengineering/server-task'
import { serverTelegramId } from '@hcengineering/server-telegram'
import { serverTimeId } from '@hcengineering/server-time'
import { type Token } from '@hcengineering/server-token'
import { serverTrackerId } from '@hcengineering/server-tracker'
import { serverViewId } from '@hcengineering/server-view'
import {
  ClientSession,
  start as startJsonRpc,
  type BroadcastCall,
  type PipelineFactory,
  type ServerFactory,
  type Session
} from '@hcengineering/server-ws'

import { activityId } from '@hcengineering/activity'
import { attachmentId } from '@hcengineering/attachment'
import { bitrixId } from '@hcengineering/bitrix'
import { boardId } from '@hcengineering/board'
import { calendarId } from '@hcengineering/calendar'
import { chunterId } from '@hcengineering/chunter'
import { contactId } from '@hcengineering/contact'
import { documentId } from '@hcengineering/document'
import { gmailId } from '@hcengineering/gmail'
import { hrId } from '@hcengineering/hr'
import { inventoryId } from '@hcengineering/inventory'
import { leadId } from '@hcengineering/lead'
import { loginId } from '@hcengineering/login'
import { notificationId } from '@hcengineering/notification'
import { preferenceId } from '@hcengineering/preference'
import { recruitId } from '@hcengineering/recruit'
import { requestId } from '@hcengineering/request'
import { settingId } from '@hcengineering/setting'
import { supportId } from '@hcengineering/support'
import { tagsId } from '@hcengineering/tags'
import { taskId } from '@hcengineering/task'
import { telegramId } from '@hcengineering/telegram'
import { templatesId } from '@hcengineering/templates'
import { trackerId } from '@hcengineering/tracker'
import { viewId } from '@hcengineering/view'
import { workbenchId } from '@hcengineering/workbench'

import coreEng from '@hcengineering/core/lang/en.json'
import loginEng from '@hcengineering/login-assets/lang/en.json'
import platformEng from '@hcengineering/platform/lang/en.json'

import activityEn from '@hcengineering/activity-assets/lang/en.json'
import attachmentEn from '@hcengineering/attachment-assets/lang/en.json'
import bitrixEn from '@hcengineering/bitrix-assets/lang/en.json'
import boardEn from '@hcengineering/board-assets/lang/en.json'
import calendarEn from '@hcengineering/calendar-assets/lang/en.json'
import chunterEn from '@hcengineering/chunter-assets/lang/en.json'
import contactEn from '@hcengineering/contact-assets/lang/en.json'
import documentEn from '@hcengineering/document-assets/lang/en.json'
import gmailEn from '@hcengineering/gmail-assets/lang/en.json'
import hrEn from '@hcengineering/hr-assets/lang/en.json'
import inventoryEn from '@hcengineering/inventory-assets/lang/en.json'
import leadEn from '@hcengineering/lead-assets/lang/en.json'
import notificationEn from '@hcengineering/notification-assets/lang/en.json'
import preferenceEn from '@hcengineering/preference-assets/lang/en.json'
import recruitEn from '@hcengineering/recruit-assets/lang/en.json'
import requestEn from '@hcengineering/request-assets/lang/en.json'
import settingEn from '@hcengineering/setting-assets/lang/en.json'
import supportEn from '@hcengineering/support-assets/lang/en.json'
import tagsEn from '@hcengineering/tags-assets/lang/en.json'
import taskEn from '@hcengineering/task-assets/lang/en.json'
import telegramEn from '@hcengineering/telegram-assets/lang/en.json'
import templatesEn from '@hcengineering/templates-assets/lang/en.json'
import trackerEn from '@hcengineering/tracker-assets/lang/en.json'
import viewEn from '@hcengineering/view-assets/lang/en.json'
import workbenchEn from '@hcengineering/workbench-assets/lang/en.json'

addStringsLoader(coreId, async () => coreEng)
addStringsLoader(loginId, async () => loginEng)
addStringsLoader(platformId, async () => platformEng)

addStringsLoader(taskId, async () => taskEn)
addStringsLoader(viewId, async () => viewEn)
addStringsLoader(chunterId, async () => chunterEn)
addStringsLoader(attachmentId, async () => attachmentEn)
addStringsLoader(contactId, async () => contactEn)
addStringsLoader(recruitId, async () => recruitEn)
addStringsLoader(activityId, async () => activityEn)
addStringsLoader(settingId, async () => settingEn)
addStringsLoader(supportId, async () => supportEn)
addStringsLoader(telegramId, async () => telegramEn)
addStringsLoader(leadId, async () => leadEn)
addStringsLoader(gmailId, async () => gmailEn)
addStringsLoader(workbenchId, async () => workbenchEn)
addStringsLoader(inventoryId, async () => inventoryEn)
addStringsLoader(templatesId, async () => templatesEn)
addStringsLoader(notificationId, async () => notificationEn)
addStringsLoader(tagsId, async () => tagsEn)
addStringsLoader(calendarId, async () => calendarEn)
addStringsLoader(trackerId, async () => trackerEn)
addStringsLoader(boardId, async () => boardEn)
addStringsLoader(preferenceId, async () => preferenceEn)
addStringsLoader(hrId, async () => hrEn)
addStringsLoader(bitrixId, async () => bitrixEn)
addStringsLoader(requestId, async () => requestEn)
addStringsLoader(documentId, async () => documentEn)

/**
 * @public
 */
export function start (
  dbUrl: string,
  opt: {
    fullTextUrl: string
    storageConfig: StorageConfiguration
    rekoniUrl: string
    port: number
    productId: string
    serverFactory: ServerFactory

    indexProcessing: number // 1000
    indexParallel: number // 2

    enableCompression?: boolean

    accountsUrl: string
  }
): () => Promise<void> {
  addLocation(serverAttachmentId, () => import('@hcengineering/server-attachment-resources'))
  addLocation(serverCollaborationId, () => import('@hcengineering/server-collaboration-resources'))
  addLocation(serverContactId, () => import('@hcengineering/server-contact-resources'))
  addLocation(serverNotificationId, () => import('@hcengineering/server-notification-resources'))
  addLocation(serverSettingId, () => import('@hcengineering/server-setting-resources'))
  addLocation(serverChunterId, () => import('@hcengineering/server-chunter-resources'))
  addLocation(serverInventoryId, () => import('@hcengineering/server-inventory-resources'))
  addLocation(serverLeadId, () => import('@hcengineering/server-lead-resources'))
  addLocation(serverRecruitId, () => import('@hcengineering/server-recruit-resources'))
  addLocation(serverTaskId, () => import('@hcengineering/server-task-resources'))
  addLocation(serverTrackerId, () => import('@hcengineering/server-tracker-resources'))
  addLocation(serverTagsId, () => import('@hcengineering/server-tags-resources'))
  addLocation(serverCalendarId, () => import('@hcengineering/server-calendar-resources'))
  addLocation(serverGmailId, () => import('@hcengineering/server-gmail-resources'))
  addLocation(serverTelegramId, () => import('@hcengineering/server-telegram-resources'))
  addLocation(serverRequestId, () => import('@hcengineering/server-request-resources'))
  addLocation(serverViewId, () => import('@hcengineering/server-view-resources'))
  addLocation(serverHrId, () => import('@hcengineering/server-hr-resources'))
  addLocation(serverActivityId, () => import('@hcengineering/server-activity-resources'))
  addLocation(serverGuestId, () => import('@hcengineering/server-guest-resources'))
  addLocation(openAIId, () => Promise.resolve({ default: openAIPluginImpl }))
  addLocation(serverDocumentId, () => import('@hcengineering/server-document-resources'))
  addLocation(serverTimeId, () => import('@hcengineering/server-time-resources'))

  const middlewares: MiddlewareCreator[] = [
    ModifiedMiddleware.create,
    PrivateMiddleware.create,
    SpaceSecurityMiddleware.create,
    SpacePermissionsMiddleware.create,
    ConfigurationMiddleware.create,
    QueryJoinMiddleware.create // Should be last one
  ]

  const metrics = getMetricsContext()

  const externalStorage = buildStorageFromConfig(opt.storageConfig, dbUrl)

  function createIndexStages (
    fullText: MeasureContext,
    workspace: WorkspaceId,
    adapter: FullTextAdapter,
    storage: ServerStorage,
    storageAdapter: StorageAdapter,
    contentAdapter: ContentTextAdapter
  ): FullTextPipelineStage[] {
    // Allow 2 workspaces to be indexed in parallel
    globalIndexer.allowParallel = opt.indexParallel
    globalIndexer.processingSize = opt.indexProcessing

    const stages: FullTextPipelineStage[] = []

    // Add regular stage to for indexable fields change tracking.
    stages.push(new IndexedFieldStage(storage))

    // Obtain text content from storage(like minio) and use content adapter to convert files to text content.
    stages.push(new ContentRetrievalStage(storageAdapter, workspace, fullText.newChild('content', {}), contentAdapter))

    // Obtain collaborative content
    stages.push(
      new CollaborativeContentRetrievalStage(
        storageAdapter,
        workspace,
        fullText.newChild('collaborative', {}),
        contentAdapter
      )
    )

    // // Add any => english language translation
    // const retranslateStage = new LibRetranslateStage(fullText.newChild('retranslate', {}), workspace)
    // retranslateStage.clearExcept = stages.map(it => it.stageId)
    // for (const st of stages) {
    //   // Clear retranslation on content change.
    //   st.updateFields.push((doc, upd) => retranslateStage.update(doc, upd))
    // }
    // stages.push(retranslateStage)

    // Summary stage
    const summaryStage = new FullSummaryStage(storage)

    stages.push(summaryStage)

    // Push all content to elastic search
    const pushStage = new FullTextPushStage(storage, adapter, workspace)
    stages.push(pushStage)

    // OpenAI prepare stage
    const openAIStage = new OpenAIEmbeddingsStage(adapter, workspace)
    // We depend on all available stages.
    openAIStage.require = stages.map((it) => it.stageId)

    openAIStage.updateSummary(summaryStage)

    stages.push(openAIStage)

    return stages
  }

  const pipelineFactory: PipelineFactory = (ctx, workspace, upgrade, broadcast) => {
    const wsMetrics = metrics.newChild('🧲 session', {})
    const conf: DbConfiguration = {
      domains: {
        [DOMAIN_TX]: 'MongoTx',
        [DOMAIN_TRANSIENT]: 'InMemory',
        [DOMAIN_BLOB]: 'MinioData',
        [DOMAIN_FULLTEXT_BLOB]: 'FullTextBlob',
        [DOMAIN_MODEL]: 'Null'
      },
      metrics: wsMetrics,
      defaultAdapter: 'Mongo',
      adapters: {
        MongoTx: {
          factory: createMongoTxAdapter,
          url: dbUrl
        },
        Mongo: {
          factory: createMongoAdapter,
          url: dbUrl
        },
        Null: {
          factory: createNullAdapter,
          url: ''
        },
        InMemory: {
          factory: createInMemoryAdapter,
          url: ''
        },
        MinioData: {
          factory: createStorageDataAdapter,
          url: ''
        },
        FullTextBlob: {
          factory: createElasticBackupDataAdapter,
          url: opt.fullTextUrl
        }
      },
      fulltextAdapter: {
        factory: createElasticAdapter,
        url: opt.fullTextUrl,
        stages: (adapter, storage, storageAdapter, contentAdapter) =>
          createIndexStages(
            wsMetrics.newChild('stages', {}),
            workspace,
            adapter,
            storage,
            storageAdapter,
            contentAdapter
          )
      },
      contentAdapters: {
        Rekoni: {
          factory: createRekoniAdapter,
          contentType: '*',
          url: opt.rekoniUrl
        },
        YDoc: {
          factory: createYDocAdapter,
          contentType: 'application/ydoc',
          url: ''
        }
      },
      serviceAdapters: {},
      defaultContentAdapter: 'Rekoni',
      storageFactory: () => externalStorage,
      workspace
    }
    return createPipeline(ctx, conf, middlewares, upgrade, broadcast)
  }

  const sessionFactory = (token: Token, pipeline: Pipeline, broadcast: BroadcastCall): Session => {
    if (token.extra?.mode === 'backup') {
      return new BackupClientSession(broadcast, token, pipeline)
    }
    return new ClientSession(broadcast, token, pipeline)
  }

  return startJsonRpc(getMetricsContext(), {
    pipelineFactory,
    sessionFactory,
    port: opt.port,
    productId: opt.productId,
    serverFactory: opt.serverFactory,
    enableCompression: opt.enableCompression,
    accountsUrl: opt.accountsUrl
  })
}
