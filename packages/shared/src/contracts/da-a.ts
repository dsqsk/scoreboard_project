import { z } from 'zod'
import type { Me } from './room'
import {
  entityIdSchema as id,
  commandIdSchema as requestId,
  revisionSchema as revision,
} from './primitives'

export const DA_A_BASE_STAKES = [1, 5, 10] as const
export const DA_A_VALUES = [1, 2, 3, 4, 6, 8, 16, 32] as const
export type DaABaseStake = (typeof DA_A_BASE_STAKES)[number]
export type DaAValue = (typeof DA_A_VALUES)[number]
const baseStake = z.union([z.literal(1), z.literal(5), z.literal(10)])
const value = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(6),
  z.literal(8),
  z.literal(16),
  z.literal(32),
])
export const daARequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('daA.createRoom'),
      requestId,
      payload: z.object({ baseStake }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('daA.prepare'),
      requestId,
      payload: z
        .object({
          roomId: id,
          expectedRoomRevision: revision,
          participantIds: z
            .array(id)
            .length(5)
            .refine((ids) => new Set(ids).size === 5, '参与者不可重复'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('daA.addDelta'),
      requestId,
      payload: z
        .object({
          roomId: id,
          activityId: id,
          expectedConfigRevision: revision,
          direction: z.union([z.literal(1), z.literal(-1)]),
          value,
          mingA: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('daA.getState'),
      payload: z.object({ roomId: id, cursor: id.optional() }).strict(),
    })
    .strict(),
])
export type DaARequest = z.infer<typeof daARequestSchema>
export interface DaAEntry {
  entryId: string
  requestId: string
  roomId: string
  activityId: string
  userId: string
  displayName: string
  direction: 1 | -1
  value: DaAValue
  baseStake: DaABaseStake
  mingA: boolean
  deltaUnits: number
  savedAt: number
}
export interface DaASnapshot {
  roomId: string
  roomRevision: number
  baseStake: DaABaseStake
  scoreScale: 100
  activity: null | {
    activityId: string
    configRevision: number
    revision: number
    status: 'open' | 'posted' | 'archived'
    participants: Me[]
  }
  canRecord: boolean
  entries: DaAEntry[]
  nextCursor: string | null
  totalsUnits: Record<string, number>
}
