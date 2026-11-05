import type { RoomMember, RoomApi } from '../../modules/room-api/types'
import type { MockStorage } from '../../modules/room-api/mock'
import { RoomApiError } from '../../modules/room-api/errors'

// Frontend adapter contract; cloud kill endpoints are not available yet.
export interface OwnBall {
  number: number
  potted: boolean
}
export interface KillResult {
  savedAt: string
  winnerId: string
  scores: Record<string, number>
}
export interface KillSnapshot {
  revision: number
  participants: Pick<RoomMember, 'userId' | 'displayName'>[]
  ownBalls: OwnBall[]
  remaining: Record<string, number>
  result: KillResult | null
}
export type KillCommand =
  | { kind: 'deal'; participantIds: string[] }
  | { kind: 'pot'; number: number; potted: boolean; revision: number }
  | { kind: 'transfer'; number: number; revision: number }
  | { kind: 'save'; winnerId: string; remaining: Record<string, number>; revision: number }
export interface KillApi {
  get(roomId: string): Promise<KillSnapshot | null>
  execute(roomId: string, command: KillCommand, requestId: string): Promise<void>
}
interface Ball {
  number: number
  ownerId: string
  initialOwnerId: string
  potted: boolean
}
interface Round {
  revision: number
  participants: KillSnapshot['participants']
  balls: Ball[]
  result: KillResult | null
}
interface Data {
  version: 1
  rounds: Record<string, Round>
  receipts: Record<string, string>
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const reject = (code: ConstructorParameters<typeof RoomApiError>[0], message: string): never => {
  throw new RoomApiError(code, message)
}
export function createMockKillApi(
  roomApi: RoomApi,
  storage: MockStorage,
  random = Math.random,
): KillApi {
  // Read on every operation so separate adapter instances observe the latest persisted revision.
  function read(): Data {
    const value = storage.read()
    if (!value) return { version: 1, rounds: {}, receipts: {} }
    const data = value as Data
    if (data.version !== 1 || !data.rounds || !data.receipts)
      return reject('INVALID_RESPONSE', '本地杀球数据无法读取，请保留数据并检查')
    return clone(data)
  }
  async function context(roomId: string) {
    const [me, room] = await Promise.all([roomApi.getMe(), roomApi.getRoomSnapshot(roomId)])
    if (
      room.selectedMode !== 'kill_ball' ||
      room.status !== 'active' ||
      !room.members.some((m) => m.userId === me.userId)
    )
      return reject('FORBIDDEN', '当前无法操作这个杀球房间')
    return { me, room }
  }
  return {
    async get(roomId) {
      const { me } = await context(roomId)
      const round = read().rounds[roomId]
      if (!round) return null
      return {
        revision: round.revision,
        participants: round.participants,
        result: round.result,
        ownBalls: round.balls
          .filter((b) => b.ownerId === me.userId)
          .map(({ number, potted }) => ({ number, potted }))
          .sort((a, b) => a.number - b.number),
        remaining: Object.fromEntries(
          round.participants.map((p) => [
            p.userId,
            round.balls.filter((b) => b.ownerId === p.userId && !b.potted).length,
          ]),
        ),
      }
    },
    async execute(roomId, command, requestId) {
      const { me, room } = await context(roomId)
      const data = read()
      const signature = JSON.stringify([roomId, me.userId, command])
      if (!requestId) return reject('INVALID_ARGUMENT', '缺少请求标识')
      if (data.receipts[requestId]) {
        if (data.receipts[requestId] !== signature)
          return reject('IDEMPOTENCY_MISMATCH', '请求标识已用于其他操作')
        return
      }
      let round = data.rounds[roomId]
      if (command.kind === 'deal') {
        if (round) return reject('CONFLICT', '已经发牌，请刷新恢复原来的牌')
        const ids = command.participantIds
        if (ids.length === 4)
          return reject('RULE_NOT_CONFIGURED', '四人少牌者规则待确定，暂不支持四人发牌')
        if (
          ids.length !== 3 ||
          new Set(ids).size !== 3 ||
          !ids.includes(me.userId) ||
          ids.some((id) => !room.members.some((m) => m.userId === id))
        )
          return reject('INVALID_ARGUMENT', '请选择包括自己在内的三位房间成员')
        const numbers = Array.from({ length: 15 }, (_, i) => i + 1)
        for (let i = numbers.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1))
          ;[numbers[i], numbers[j]] = [numbers[j]!, numbers[i]!]
        }
        round = {
          revision: 1,
          participants: ids.map((id) => {
            const m = room.members.find((m) => m.userId === id)!
            return { userId: id, displayName: m.displayName }
          }),
          balls: numbers.map((number, i) => ({
            number,
            ownerId: ids[Math.floor(i / 5)]!,
            initialOwnerId: ids[Math.floor(i / 5)]!,
            potted: false,
          })),
          result: null,
        }
        data.rounds[roomId] = round
      } else {
        if (!round || !round.participants.some((p) => p.userId === me.userId))
          return reject('FORBIDDEN', '你未参加本次发牌')
        if (round.result) return reject('ALREADY_POSTED', '结果已保存，本次牌局只读')
        if (command.revision !== round.revision)
          return reject('CONFLICT', '状态已变化，已为你刷新，请重新确认')
        if (command.kind === 'pot' || command.kind === 'transfer') {
          const ball = round.balls.find((b) => b.number === command.number)
          if (!ball) return reject('INVALID_ARGUMENT', '请选择1—15号球')
          if (command.kind === 'pot') {
            if (ball.ownerId !== me.userId) return reject('FORBIDDEN', '只能记录自己的球')
            ball.potted = command.potted
          } else {
            if (ball.ownerId === me.userId) return reject('CONFLICT', '这颗球已经归你')
            ball.ownerId = me.userId
            ball.potted = false
          }
        } else {
          if (!round.participants.some((p) => p.userId === command.winnerId))
            return reject('INVALID_ARGUMENT', '请选择赢家')
          const losers = round.participants.filter((p) => p.userId !== command.winnerId)
          if (
            losers.some(
              (p) =>
                !Number.isSafeInteger(command.remaining[p.userId]) ||
                command.remaining[p.userId]! < 0 ||
                command.remaining[p.userId]! > 15,
            )
          )
            return reject('INVALID_ARGUMENT', '剩余球数须为0—15的整数')
          const scores = Object.fromEntries(
            losers.map((p) => [p.userId, -command.remaining[p.userId]!]),
          )
          scores[command.winnerId] = losers.reduce(
            (sum, p) => sum + command.remaining[p.userId]!,
            0,
          )
          round.result = { winnerId: command.winnerId, scores, savedAt: new Date().toISOString() }
        }
        round.revision++
      }
      data.receipts[requestId] = signature
      storage.write(clone(data))
    },
  }
}
export const unavailableCloudKillApi: KillApi = {
  async get() {
    return reject('RULE_NOT_CONFIGURED', '云端杀球接口尚未接入，当前不能发牌或保存杀球记录')
  },
  async execute() {
    return reject('RULE_NOT_CONFIGURED', '云端杀球接口尚未接入')
  },
}
