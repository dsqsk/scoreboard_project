import { z } from 'zod'
import { GAME_MODES } from './game'
import type { Me, RoomPreview, RoomSnapshot, RecentRoomPage } from './room'
import type { PointSnapshot, PointCommitState } from './point'
import { daARequestSchema, type DaASnapshot } from './da-a'
import {
  entityIdSchema as id,
  commandIdSchema as requestId,
  revisionSchema as revision,
} from './primitives'

const code = z
  .string()
  .trim()
  .regex(/^\d{6}$/)
const payload = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict()
const configInput = payload({
  baseStake: z
    .string()
    .regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
    .optional(),
})

export const foundationRequestSchema = z.discriminatedUnion('action', [
  ...daARequestSchema.options,
  payload({
    action: z.literal('point.getState'),
    payload: payload({ roomId: id, resultCursor: id.optional(), changeCursor: id.optional() }),
  }),
  payload({
    action: z.literal('point.claim'),
    requestId,
    payload: payload({
      roomId: id,
      activityId: id,
      number: z.number().int().min(1).max(15),
      expectedCardRevision: revision,
    }),
  }),
  payload({
    action: z.literal('point.correct'),
    requestId,
    payload: payload({
      roomId: id,
      activityId: id,
      number: z.number().int().min(1).max(15),
      expectedCardRevision: revision,
      ownerUserId: id.nullable(),
    }),
  }),
  payload({
    action: z.literal('point.post'),
    requestId,
    payload: payload({ roomId: id, activityId: id, expectedActivityRevision: revision }),
  }),
  payload({ action: z.literal('identity.getMe'), payload: payload({}) }),
  payload({
    action: z.literal('identity.updateProfile'),
    requestId,
    payload: payload({
      displayName: z.string().trim().min(1).max(32),
      avatarFileId: z
        .string()
        .max(512)
        .refine(
          (value) =>
            value.startsWith('cloud://') ||
            /^avatar:v1:usr_[a-f0-9]{64}:[a-f0-9]{32}\.(png|jpg|webp)$/.test(value),
        )
        .nullable()
        .optional(),
    }),
  }),
  payload({
    action: z.literal('room.create'),
    requestId,
    payload: payload({ mode: z.enum(GAME_MODES) }),
  }),
  payload({ action: z.literal('room.preview'), payload: payload({ joinCode: code }) }),
  payload({ action: z.literal('room.join'), requestId, payload: payload({ joinCode: code }) }),
  payload({ action: z.literal('room.listRecent'), payload: payload({}) }),
  payload({
    action: z.literal('room.listRecentPage'),
    payload: payload({ cursor: id.optional(), limit: z.number().int().min(1).max(20).default(20) }),
  }),
  payload({ action: z.literal('room.enter'), requestId, payload: payload({ roomId: id }) }),
  payload({ action: z.literal('room.dismissRecent'), requestId, payload: payload({ roomId: id }) }),
  payload({ action: z.literal('room.getSnapshot'), payload: payload({ roomId: id }) }),
  payload({
    action: z.literal('room.listMembers'),
    payload: payload({
      roomId: id,
      cursor: id.optional(),
      limit: z.number().int().min(1).max(20).default(20),
    }),
  }),
  payload({
    action: z.literal('room.selectMode'),
    requestId,
    payload: payload({
      roomId: id,
      mode: z.enum(GAME_MODES),
      expectedRoomRevision: revision,
    }),
  }),
  payload({
    action: z.literal('activity.prepare'),
    requestId,
    payload: payload({
      roomId: id,
      expectedRoomRevision: revision,
      participantIds: z
        .array(id)
        .min(2)
        .max(5)
        .refine((ids) => new Set(ids).size === ids.length, '参与者不可重复'),
      configInput: configInput.default({}),
    }),
  }),
])

export type FoundationRequest = z.infer<typeof foundationRequestSchema>
export type CommandRequest = Extract<FoundationRequest, { requestId: string }>
export interface IdentityDTO extends Me {
  avatarFileId: string | null
  profileCompleted: boolean
}
export interface CommandReceipt {
  requestId: string
  entityId: string
  roomId?: string
  roomRevision?: number
  activityId?: string
  activityRevision?: number
  joinCode?: string
  pointState?: PointCommitState
}
export interface FoundationRoomPreview extends RoomPreview {
  displayName: string
}
export interface MemberSummary extends Me {
  joinedAt: string
}
export interface Shortcut {
  key: string
  label: string
  positiveUnits: number
  negativeUnits: number
}
export type ActivityConfig =
  | { mode: 'nine_ball'; shortcuts: Shortcut[]; unavailableShortcutKeys: string[] }
  | {
      mode: 'kill_ball'
      distribution: number[]
      shortHandUserId: string | null
      dealStatus: 'undealt'
    }
  | { mode: 'point_ball'; cardNumbers: number[]; totalPoints: 120; baselineUnits: number }
  | {
      mode: 'da_a'
      baseStakeUnits: number
      coefficientScale: 1
      nonZeroSumPolicy: 'not_configured' | 'personal'
    }
  | { mode: 'dui_jia'; baseStakeUnits: number; allowedMultipliers: [1, 2] }
export interface ActivitySummary {
  activityId: string
  mode: (typeof GAME_MODES)[number]
  status: 'open' | 'posted' | 'archived'
  participantIds: string[]
  participants: Me[]
  rulesVersion: string
  revision: number
  configRevision: number
  scoreScale: number
  config: ActivityConfig
}
export interface FoundationRoomSnapshot extends RoomSnapshot {
  displayName: string
  roomRevision: number
  activeActivityId: string | null
  signalDocumentId: string
  activity: ActivitySummary | null
  scores: {
    userId: string
    netUnits: number
    earnedPoints: number | null
    remainingCount: number | null
  }[]
  cards: { number: number; ownerUserId: string | null; revision: number }[]
  isCurrentParticipant: boolean
}
export interface MemberPage {
  members: MemberSummary[]
  nextCursor: string | null
}
export type FoundationResponse =
  | IdentityDTO
  | CommandReceipt
  | FoundationRoomPreview
  | FoundationRoomSnapshot
  | MemberPage
  | FoundationRoomPreview[]
  | PointSnapshot
  | RecentRoomPage
  | DaASnapshot
