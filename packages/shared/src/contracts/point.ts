export interface PointParticipant {
  userId: string
  displayName: string
}
export interface PointCardDTO {
  number: number
  ownerUserId: string | null
  revision: number
  initialRecordedBy: string | null
  lastModifiedBy: string | null
}
export interface PointChange {
  requestId: string
  number: number
  fromUserId: string | null
  toUserId: string | null
  actorUserId: string
  actorName: string
  createdAt: number
}
export interface PointCommitState {
  activityId: string
  revision: number
  status: 'open'
  cards: PointCardDTO[]
  earnedPoints: Record<string, number>
  change: PointChange
}
export interface PointResult {
  activityId: string
  participants: PointParticipant[]
  earnedPoints: Record<string, number>
  deltas: Record<string, number>
  savedAt: number
}
export interface PointSnapshot {
  roomId: string
  roomRevision: number
  activity: null | {
    activityId: string
    revision: number
    status: 'open' | 'posted'
    participants: PointParticipant[]
    cards: PointCardDTO[]
    earnedPoints: Record<string, number>
    changes: PointChange[]
    result: PointResult | null
  }
  results: PointResult[]
  totals: Record<string, number>
  nextResultCursor: string | null
  nextChangeCursor: string | null
}
