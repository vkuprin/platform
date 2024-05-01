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

import contact, { Channel, ChannelProvider, Contact, Employee, PersonAccount } from '@hcengineering/contact'
import {
  Account,
  Class,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  Tx,
  TxCreateDoc,
  TxProcessor
} from '@hcengineering/core'
import { TriggerControl } from '@hcengineering/server-core'
import telegram, { TelegramMessage } from '@hcengineering/telegram'
import notification, { NotificationType } from '@hcengineering/notification'
import setting, { Integration } from '@hcengineering/setting'

/**
 * @public
 */
export async function FindMessages (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  const channel = doc as Channel
  if (channel.provider !== contact.channelProvider.Telegram) {
    return []
  }
  const messages = await findAll(telegram.class.Message, { attachedTo: channel._id })
  const newMessages = await findAll(telegram.class.NewMessage, { attachedTo: channel._id })
  return [...messages, ...newMessages]
}

/**
 * @public
 */
export async function OnMessageCreate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  const message = TxProcessor.createDoc2Doc<TelegramMessage>(tx as TxCreateDoc<TelegramMessage>)
  const channel = (await control.findAll(contact.class.Channel, { _id: message.attachedTo }, { limit: 1 }))[0]
  if (channel !== undefined) {
    if (channel.lastMessage === undefined || channel.lastMessage < message.sendOn) {
      const tx = control.txFactory.createTxUpdateDoc(channel._class, channel.space, channel._id, {
        lastMessage: message.sendOn
      })
      res.push(tx)
    }

    if (message.incoming) {
      const docs = await control.findAll(notification.class.DocNotifyContext, {
        attachedTo: channel._id,
        user: message.modifiedBy
      })
      for (const doc of docs) {
        // TODO: push inbox notifications
        // res.push(
        //   control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, {
        //     $push: {
        //       txes: {
        //         _id: tx._id as Ref<TxCUD<Doc>>,
        //         modifiedOn: tx.modifiedOn,
        //         modifiedBy: tx.modifiedBy,
        //         isNew: true
        //       }
        //     }
        //   })
        // )
        res.push(
          control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, {
            lastUpdateTimestamp: tx.modifiedOn,
            hidden: false
          })
        )
      }
      if (docs.length === 0) {
        res.push(
          control.txFactory.createTxCreateDoc(notification.class.DocNotifyContext, channel.space, {
            user: tx.modifiedBy,
            attachedTo: channel._id,
            attachedToClass: channel._class,
            hidden: false,
            lastUpdateTimestamp: tx.modifiedOn
            // TODO: push inbox notifications
            // txes: [
            //   { _id: tx._id as Ref<TxCUD<Doc>>, modifiedOn: tx.modifiedOn, modifiedBy: tx.modifiedBy, isNew: true }
            // ]
          })
        )
      }
    }
  }

  return res
}

/**
 * @public
 */
export async function IsIncomingMessage (
  tx: Tx,
  doc: Doc,
): Promise<boolean> {
  const message = TxProcessor.createDoc2Doc(TxProcessor.extractTx(tx) as TxCreateDoc<TelegramMessage>)
  return message.incoming && message.sendOn > (doc.createdOn ?? doc.modifiedOn)
}

export async function GetCurrentEmployeeTG (
  control: TriggerControl,
): Promise<string | undefined> {
  const account = await control.modelDb.findOne(contact.class.PersonAccount, {
    _id: control.txFactory.account as Ref<PersonAccount>
  })
  if (account === undefined) return
  const employee = (await control.findAll(contact.mixin.Employee, { _id: account.person as Ref<Employee> }))[0]
  if (employee !== undefined) {
    return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  }
}

export async function GetIntegrationOwnerTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  const value = context[setting.class.Integration] as Integration
  if (value === undefined) return
  const account = await control.modelDb.findOne(contact.class.PersonAccount, {
    _id: value.modifiedBy as Ref<PersonAccount>
  })
  if (account === undefined) return
  const employee = (await control.findAll(contact.mixin.Employee, { _id: account.person as Ref<Employee> }))[0]
  if (employee !== undefined) {
    return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  }
}

async function getContactChannel (
  control: TriggerControl,
  value: Contact,
  provider: Ref<ChannelProvider>
): Promise<string | undefined> {
  if (value === undefined) return
  const res = (
    await control.findAll(contact.class.Channel, {
      attachedTo: value._id,
      provider
    })
  )[0]
  return res?.value ?? ''
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageCreate
  },
  function: {
    IsIncomingMessage,
    FindMessages,
    GetCurrentEmployeeTG,
    GetIntegrationOwnerTG
  }
})
