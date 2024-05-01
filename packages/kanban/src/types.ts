import { type Doc, type Rank } from '@hcengineering/core'
import { type Asset } from '@hcengineering/platform'

/**
 * @public
 */
export interface DocWithRank extends Doc {
  rank: Rank
}

export type StateType = any
/**
 * @public
 */
export type Item = DocWithRank

/**
 * @public
 */
export type CardDragEvent = DragEvent & { currentTarget: EventTarget & HTMLDivElement }
