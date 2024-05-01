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

import { SortingOrder, type SortingQuery } from '@hcengineering/core'
import { type Asset, type IntlString } from '@hcengineering/platform'
import {
  IssuePriority,
  IssuesDateModificationPeriod,
  IssuesGrouping,
  IssuesOrdering,
  MilestoneStatus,
  type Issue
} from '@hcengineering/tracker'
import tracker from './plugin'

export const issuePriorities: Record<IssuePriority, { icon: Asset, label: IntlString }> = {
  [IssuePriority.NoPriority]: { icon: tracker.icon.PriorityNoPriority, label: tracker.string.NoPriority },
  [IssuePriority.Urgent]: { icon: tracker.icon.PriorityUrgent, label: tracker.string.Urgent },
  [IssuePriority.High]: { icon: tracker.icon.PriorityHigh, label: tracker.string.High },
  [IssuePriority.Medium]: { icon: tracker.icon.PriorityMedium, label: tracker.string.Medium },
  [IssuePriority.Low]: { icon: tracker.icon.PriorityLow, label: tracker.string.Low }
}
export const defaultMilestoneStatuses = [
  MilestoneStatus.Planned,
  MilestoneStatus.InProgress,
  MilestoneStatus.Completed,
  MilestoneStatus.Canceled
]

export const milestoneStatusAssets: Record<MilestoneStatus, { icon: Asset, label: IntlString }> = {
  [MilestoneStatus.Planned]: { icon: tracker.icon.MilestoneStatusPlanned, label: tracker.string.Planned },
  [MilestoneStatus.InProgress]: { icon: tracker.icon.MilestoneStatusInProgress, label: tracker.string.InProgress },
  [MilestoneStatus.Completed]: { icon: tracker.icon.MilestoneStatusCompleted, label: tracker.string.Completed },
  [MilestoneStatus.Canceled]: { icon: tracker.icon.MilestoneStatusCanceled, label: tracker.string.Canceled }
}

export const defaultPriorities = [
  IssuePriority.NoPriority,
  IssuePriority.Low,
  IssuePriority.Medium,
  IssuePriority.High,
  IssuePriority.Urgent
]
