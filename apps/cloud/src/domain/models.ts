import type {
  ActivityConfig,
  GameMode,
  Shortcut,
  CommandReceipt,
  PointChange,
  PointResult,
  DefaultAvatar,
  DaABaseStake,
  DaAEntry,
} from '@scoreboard/shared'

export interface Meta {
  _id: string
  schemaVersion: 1
  createdAt: number
  updatedAt: number
  revision: number
}
export interface User extends Meta {
  wechatAppId: string
  wechatOpenId: string
  displayName: string
  avatarFileId: string | null
  status: 'active' | 'disabled'
  profileCompletedAt?: number | null
  defaultAvatar?: DefaultAvatar
}
export interface Room extends Meta {
  daABaseStake?: DaABaseStake
  displayName: string
  wechatAppId: string
  selectedMode: GameMode
  activeActivityId: string | null
  createdBy: string
  status: 'active' | 'closed'
  activeCodeId: string
  memberCount: number
  expiresAt: number | null
}
export interface Member extends Meta {
  roomId: string
  userId: string
  status: 'active' | 'left'
  joinedAt: number
  leftAt: number | null
  joinSource: 'create' | 'code'
  lastVisitedAt: number
  recentHidden?: boolean
}
export interface RoomCode extends Meta {
  roomId: string
  status: 'active' | 'revoked'
  expiresAt: number | null
}
export interface Activity extends Meta {
  roomId: string
  mode: GameMode
  createdBy: string
  status: 'open' | 'posted' | 'archived'
  participantIds: string[]
  participants: {
    userId: string
    displayName: string
    avatarFileId: string | null
    defaultAvatar?: DefaultAvatar
  }[]
  rulesVersion: string
  configRevision: number
  scoreScale: number
  config: ActivityConfig
  completedResultEventId: string | null
  currentResultToken: string | null
  latestPointChangeId?: string | null
}
export interface ActivityScore extends Meta {
  roomId: string
  activityId: string
  mode: GameMode
  userId: string
  scoreScale: number
  netUnits: number
  earnedPoints: number | null
  ownedCardCount: number | null
  remainingCount: number | null
}
export interface PointCard extends Meta {
  roomId: string
  activityId: string
  mode: 'point_ball'
  number: number
  points: number
  ownerUserId: string | null
  updatedBy: string | null
  initialRecordedBy?: string | null
}
export interface PointChangeRecord extends Meta {
  roomId: string
  activityId: string
  previousId: string | null
  change: PointChange
}
export interface PointResultRecord extends Meta {
  roomId: string
  previousId: string | null
  result: PointResult
}
export interface PointTotals extends Meta {
  roomId: string
  latestResultId: string | null
  totals: Record<string, number>
}
export interface CommandRecord extends Meta {
  actorUserId: string
  action: string
  payloadHash: string
  result: CommandReceipt
}
export interface Signal extends Meta {
  _openid: string
  roomId: string
  signalVersion: number
}
export interface Outbox extends Meta {
  roomId: string
  activityId: string | null
  changeId: string
  status: 'pending'
  paginationCursor: string | null
  attempts: number
  nextAttemptAt: number
  leaseUntil: number | null
}
export interface ResultSlot extends Meta {
  roomId: string
  activityId: string
  mode: 'da_a' | 'dui_jia'
  configRevision: number
  participantIds: string[]
  participantsSnapshot: Activity['participants']
  status: 'open'
  postedEventId: null
  previousResultToken: null
}
export interface RateBucket extends Meta {
  count: number
  windowStart: number
  requestKeys: string[]
}
export interface DaAEntryRecord extends Meta {
  roomId: string
  previousId: string | null
  entry: DaAEntry
}
export interface DaATotals extends Meta {
  roomId: string
  latestEntryId: string | null
  totalsUnits: Record<string, number>
}
export interface Collections {
  users: User
  rooms: Room
  room_members: Member
  room_codes: RoomCode
  activities: Activity
  activity_scores: ActivityScore
  activity_cards: PointCard
  commands: CommandRecord
  user_room_signals: Signal
  notification_outbox: Outbox
  result_slots: ResultSlot
  rate_limits: RateBucket
  point_changes: PointChangeRecord
  point_results: PointResultRecord
  point_totals: PointTotals
  da_a_entries: DaAEntryRecord
  da_a_totals: DaATotals
}
export interface Caller {
  appId: string
  openId: string
}
export interface Rules {
  version: string
  pokerScale: number
  twoPlayerNineShortcuts: Shortcut[] | null
  fourPlayerKillShortHand: 'not_configured'
}
