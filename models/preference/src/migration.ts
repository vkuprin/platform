//
// Copyright © 2023 Hardcore Engineering Inc.
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

import { TxOperations } from '@hcengineering/core'
import {
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'
import core from '@hcengineering/model-core'
import preference, { preferenceId } from '@hcengineering/preference'

async function createSpace (tx: TxOperations): Promise<void> {
  const current = await tx.findOne(core.class.Space, {
    _id: preference.space.Preference
  })
  if (current === undefined) {
    await tx.createDoc(
      core.class.Space,
      core.space.Space,
      {
        name: 'Preference',
        description: 'Preference space',
        private: false,
        archived: false,
        members: []
      },
      preference.space.Preference
    )
  }
}

async function createDefaults (tx: TxOperations): Promise<void> {
  await createSpace(tx)
}

export const preferenceOperation: MigrateOperation = {
  async migrate (): Promise<void> {},
  async upgrade (client: MigrationUpgradeClient): Promise<void> {
    await tryUpgrade(client, preferenceId, [
      {
        state: 'create-defaults',
        func: async (client) => {
          const ops = new TxOperations(client, core.account.System)
          await createDefaults(ops)
        }
      }
    ])
  }
}
