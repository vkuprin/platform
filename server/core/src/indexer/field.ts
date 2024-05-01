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

import core, {
  type Class,
  type Doc,
  type DocIndexState,
  type DocumentUpdate,
  extractDocKey,
  type IndexStageState,
  type MeasureContext,
  type Ref,
  type ServerStorage,
  getFullTextIndexableAttributes,
  getFullTextContext
} from '@hcengineering/core'
import { deepEqual } from 'fast-equals'
import { type DbAdapter } from '../adapter'
import { type IndexedDoc } from '../types'
import {
  contentStageId,
  type DocUpdateHandler,
  fieldStateId,
  type FullTextPipeline,
  type FullTextPipelineStage
} from './types'
import {
  collectPropagate,
  docKey,
  docUpdKey,
  getContent,
  getCustomAttrKeys,
  isFullTextAttribute,
  loadIndexStageStage
} from './utils'

/**
 * @public
 */
export class IndexedFieldStage implements FullTextPipelineStage {
  require = []
  stageId = fieldStateId
  // Do not clear downloaded content
  clearExcept: string[] = [contentStageId]
  updateFields: DocUpdateHandler[] = []

  enabled = true

  stageValue: boolean | string = true

  indexState?: IndexStageState

  constructor (private readonly dbStorage: ServerStorage) {}

  async initialize (ctx: MeasureContext, storage: DbAdapter, pipeline: FullTextPipeline): Promise<void> {
    const indexablePropogate = (
      await pipeline.model.findAll(core.class.Class, {
        [core.mixin.FullTextSearchContext]: { $exists: true }
      })
    )
      .map((it) => pipeline.hierarchy.as(it, core.mixin.FullTextSearchContext))
      .filter((it) => it.propagate != null || it.parentPropagate)
      .map((it) =>
        JSON.stringify({
          id: it._id,
          propogate: it.propagate,
          parentPropgate: it.parentPropagate
        })
      )

    const forceIndexing = (
      await pipeline.model.findAll(core.class.Class, { [core.mixin.FullTextSearchContext + '.forceIndex']: true })
    ).map((it) => it._id)

    indexablePropogate.sort()
    ;[this.stageValue, this.indexState] = await loadIndexStageStage(
      ctx,
      storage,
      this.indexState,
      this.stageId,
      'config',
      {
        classes: indexablePropogate,
        forceIndex: forceIndexing
      }
    )
  }

  async search (
    _classes: Ref<Class<Doc>>[],
  ): Promise<{ docs: IndexedDoc[], pass: boolean }> {
    return { docs: [], pass: true }
  }

  async collect (toIndex: DocIndexState[], pipeline: FullTextPipeline, metrics: MeasureContext): Promise<void> {
    const byClass = toIndex.reduce<Record<Ref<Class<Doc>>, DocIndexState[]>>((p, c) => {
      p[c.objectClass] = [...(p[c.objectClass] ?? []), c]
      return p
    }, {})

    const processed = new Set<Ref<DocIndexState>>()

    for (const [v, values] of Object.entries(byClass)) {
      // Obtain real documents
      const valueIds = new Map(values.map((it) => [it._id, it]))
      const objClass = v as Ref<Class<Doc>>
      const kids = Array.from(valueIds.keys())
      const docs = await this.dbStorage.findAll(
        metrics,
        objClass,
        {
          _id: kids.length === 1 ? kids[0] : { $in: kids }
        },
        { limit: kids.length }
      )
      const attributes = getFullTextIndexableAttributes(pipeline.hierarchy, objClass)

      // Child docs.

      let allChildDocs: DocIndexState[] | undefined

      for (const doc of docs) {
        if (pipeline.cancelling) {
          return
        }
        processed.add(doc._id as Ref<DocIndexState>)
        const docState = valueIds.get(doc._id as Ref<DocIndexState>) as DocIndexState

        try {
          // Copy content attributes as well.
          const content = getContent(pipeline.hierarchy, attributes, doc)

          const docUpdate: DocumentUpdate<DocIndexState> = {}

          let changes = 0
          docUpdate.mixins = pipeline.hierarchy.findAllMixins(doc as Doc)
          // Convert previous child fields to just
          for (const [k] of Object.entries(docState.attributes)) {
            const { attr, docId, _class } = extractDocKey(k)
            if (
              (docId !== undefined && attr !== '') ||
              (_class !== undefined && !pipeline.hierarchy.isDerived(docState.objectClass, _class))
            ) {
              // If it some previous indexed field.
              // ;(docUpdate as any)[docUpdKey(k)] = null
              ;(docUpdate as any).$unset = { ...((docUpdate as any).$unset ?? {}), [docUpdKey(k)]: '' }
            }
          }

          const customAttrValues: any = []
          for (const [, v] of Object.entries(content)) {
            if (v.attr.isCustom === true && v.value !== '' && v.value !== undefined) {
              // No need to put localized text as attributes. We do not use it at all
              // Just put all content for custom attribute inside one custom field
              customAttrValues.push({ label: v.attr.label, value: v.value })
              continue
            }

            // Check for content changes and collect update
            const dKey = docKey(v.attr.name, { _class: v.attr.attributeOf })
            const dUKey = docUpdKey(v.attr.name, { _class: v.attr.attributeOf })

            // Full re-index in case stage value is changed
            if (!deepEqual(docState.attributes[dKey], v.value)) {
              changes++
              if (typeof v.value !== 'object') {
                ;(docUpdate as any)[dUKey] = v.value
              }
            }
          }

          const { customAttrKey, customAttrUKey } = getCustomAttrKeys()
          if (
            (docState.attributes[customAttrKey] !== undefined || customAttrValues.length > 0) &&
            !deepEqual(docState.attributes[customAttrKey], customAttrValues)
          ) {
            changes++
            ;(docUpdate as any)[customAttrUKey] = customAttrValues
          }

          if (docState.attachedTo != null && changes > 0) {
            const ctx = getFullTextContext(pipeline.hierarchy, objClass)
            if (ctx.parentPropagate ?? true) {
              // We need to clear field stage from parent, so it will be re indexed.
              await pipeline.update(docState.attachedTo as Ref<DocIndexState>, false, {})
            }
          }

          const propagate: Ref<Class<Doc>>[] = collectPropagate(pipeline, docState.objectClass)
          if (propagate.length > 0) {
            // We need to propagate all changes to all child's of following classes.
            if (allChildDocs === undefined) {
              const ids = docs.map((it) => it._id)

              allChildDocs = await metrics.with(
                'propagate',
                {},
                async (ctx) =>
                  await this.dbStorage.findAll(
                    ctx,
                    core.class.DocIndexState,
                    {
                      attachedTo: ids.length === 1 ? ids[0] : { $in: ids }
                    },
                    { limit: ids.length }
                  )
              )
            }
            const childs = allChildDocs.filter((it) => it.attachedTo === docState._id)
            for (const u of childs) {
              if (propagate.some((it) => pipeline.hierarchy.isDerived(u.objectClass, it))) {
                pipeline.add(u)
                await pipeline.update(u._id, false, {})
              }
            }
          }

          await pipeline.update(docState._id, this.stageValue, docUpdate)
        } catch (err: any) {
          console.error(err)
          continue
        }
      }
    }
    if (!pipeline.cancelling) {
      for (const d of toIndex) {
        if (!processed.has(d._id)) {
          await pipeline.markRemove(d)
        }
      }
    }
  }

  // Remove should be safe to missing class
  async remove (docs: DocIndexState[], pipeline: FullTextPipeline): Promise<void> {
    for (const doc of docs) {
      if (doc.attachedTo !== undefined) {
        const attachedTo = doc.attachedTo as Ref<DocIndexState>
        const parentDocUpdate: DocumentUpdate<DocIndexState> = {}

        for (const [k] of Object.entries(doc.attributes)) {
          const { _class, attr, extra, docId } = extractDocKey(k)

          if (_class !== undefined && docId === undefined) {
            const keyAttr = pipeline.hierarchy.findAttribute(_class, attr)
            if (keyAttr !== undefined && isFullTextAttribute(keyAttr)) {
              ;(parentDocUpdate as any)[docUpdKey(attr, { _class, docId: doc._id, extra })] = null
            }
          }
        }

        if (Object.keys(parentDocUpdate).length > 0) {
          await pipeline.update(attachedTo, false, parentDocUpdate)
        }
      }
      await pipeline.update(doc._id, this.stageValue, {})
    }
  }
}
