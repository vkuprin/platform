import { Class, Doc, Ref, Space } from '@hcengineering/core'
import type { Asset, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import { AnyComponent, Location } from '@hcengineering/ui'

export * from './utils'

export interface PublicLink extends Doc {
  attachedTo: Ref<Doc>
  url: string
  location: Location
  restrictions: Restrictions
  revokable: boolean
}

export interface Restrictions {
  readonly: boolean
  disableComments: boolean
  disableNavigation: boolean
  disableActions: boolean
}

export const guestAccountEmail = '#guest@hc.engineering'

export const guestId = 'guest' as Plugin
export default plugin(guestId, {
  class: {
    PublicLink: '' as Ref<Class<PublicLink>>
  },
  icon: {
    Link: '' as Asset
  },
  space: {
    Links: '' as Ref<Space>
  },
  component: {
    GuestApp: '' as AnyComponent
  }
})