//
// Copyright © 2024 Hardcore Engineering Inc.
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
  Account,
  CollaborativeDoc,
  Hierarchy,
  Markup,
  Ref,
  Timestamp,
  WorkspaceId,
  collaborativeDocWithVersion,
  concatLink
} from '@hcengineering/core'
import { DocumentId } from './types'
import { formatMinioDocumentId } from './utils'

/** @public */
export interface GetContentRequest {
  documentId: DocumentId
  field: string
}

/** @public */
export interface GetContentResponse {
  html: string
}

/** @public */
export interface UpdateContentRequest {
  documentId: DocumentId
  field: string
  html: string
}

/** @public */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface UpdateContentResponse {}

/** @public */
export interface CopyContentRequest {
  documentId: DocumentId
  sourceField: string
  targetField: string
}

/** @public */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CopyContentResponse {}

/** @public */
export interface BranchDocumentRequest {
  sourceDocumentId: DocumentId
  targetDocumentId: DocumentId
}

/** @public */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface BranchDocumentResponse {}

/** @public */
export interface RemoveDocumentRequest {
  documentId: DocumentId
}

/** @public */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface RemoveDocumentResponse {}

/** @public */
export interface TakeSnapshotRequest {
  documentId: DocumentId
  createdBy: Ref<Account>
  snapshotName: string
}

/** @public */
export interface TakeSnapshotResponse {
  versionId: string
  name: string

  createdBy: Ref<Account>
  createdOn: Timestamp
}

/** @public */
export interface CollaborativeDocSnapshotParams {
  snapshotName: string
  createdBy: Ref<Account>
}

/** @public */
export interface CollaboratorClient {
  // field operations
  getContent: (collaborativeDoc: CollaborativeDoc, field: string) => Promise<Markup>
  updateContent: (collaborativeDoc: CollaborativeDoc, field: string, value: Markup) => Promise<void>
  copyContent: (collaborativeDoc: CollaborativeDoc, sourceField: string, targetField: string) => Promise<void>

  // document operations
  branch: (source: CollaborativeDoc, target: CollaborativeDoc) => Promise<void>
  remove: (collaborativeDoc: CollaborativeDoc) => Promise<void>
  snapshot: (collaborativeDoc: CollaborativeDoc, params: CollaborativeDocSnapshotParams) => Promise<CollaborativeDoc>
}

/** @public */
export function getClient (
  hierarchy: Hierarchy,
  workspaceId: WorkspaceId,
  token: string,
  collaboratorUrl: string
): CollaboratorClient {
  return new CollaboratorClientImpl(hierarchy, workspaceId, token, collaboratorUrl)
}

class CollaboratorClientImpl implements CollaboratorClient {
  constructor (
    private readonly hierarchy: Hierarchy,
    private readonly workspace: WorkspaceId,
    private readonly token: string,
    private readonly collaboratorUrl: string
  ) {}

  private async rpc (method: string, payload: any): Promise<any> {
    const url = concatLink(this.collaboratorUrl, '/rpc')

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ method, payload })
    })

    const result = await res.json()

    if (result.error != null) {
      throw new Error(result.error)
    }

    return result
  }

  async getContent (document: CollaborativeDoc, field: string): Promise<Markup> {
    const workspace = this.workspace.name

    const documentId = formatMinioDocumentId(workspace, document)
    const payload: GetContentRequest = { documentId, field }
    const res = (await this.rpc('getContent', payload)) as GetContentResponse

    return res.html ?? ''
  }

  async updateContent (document: CollaborativeDoc, field: string, value: Markup): Promise<void> {
    const workspace = this.workspace.name

    const documentId = formatMinioDocumentId(workspace, document)
    const payload: UpdateContentRequest = { documentId, field, html: value }
    await this.rpc('updateContent', payload)
  }

  async copyContent (document: CollaborativeDoc, sourceField: string, targetField: string): Promise<void> {
    const workspace = this.workspace.name

    const documentId = formatMinioDocumentId(workspace, document)
    const payload: CopyContentRequest = { documentId, sourceField, targetField }
    await this.rpc('copyContent', payload)
  }

  async branch (source: CollaborativeDoc, target: CollaborativeDoc): Promise<void> {
    const workspace = this.workspace.name

    const sourceDocumentId = formatMinioDocumentId(workspace, source)
    const targetDocumentId = formatMinioDocumentId(workspace, target)

    const payload: BranchDocumentRequest = { sourceDocumentId, targetDocumentId }
    await this.rpc('branchDocument', payload)
  }

  async remove (document: CollaborativeDoc): Promise<void> {
    const workspace = this.workspace.name

    const documentId = formatMinioDocumentId(workspace, document)

    const payload: RemoveDocumentRequest = { documentId }
    await this.rpc('removeDocument', payload)
  }

  async snapshot (document: CollaborativeDoc, params: CollaborativeDocSnapshotParams): Promise<CollaborativeDoc> {
    const workspace = this.workspace.name

    const documentId = formatMinioDocumentId(workspace, document)
    const payload: TakeSnapshotRequest = { documentId, ...params }
    const res = (await this.rpc('takeSnapshot', payload)) as TakeSnapshotResponse

    return collaborativeDocWithVersion(document, res.versionId)
  }
}