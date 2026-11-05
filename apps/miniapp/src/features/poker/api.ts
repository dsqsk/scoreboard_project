import type { RoomApi, RoomMember } from '../../modules/room-api/types'
import type { MockStorage } from '../../modules/room-api/mock'
import { RoomApiError } from '../../modules/room-api/errors'
import { deltaFor, isPoker, isPresetBase, requiredPlayers } from './model'
import type { PokerEntryInput, PokerMode } from './model'
export interface PokerCommand extends PokerEntryInput {
  mode: PokerMode
  base: number
}
export interface PokerEntry extends PokerCommand {
  requestId: string
  userId: string
  displayName: string
  delta: number
  savedAt: string
}
export interface PokerSnapshot {
  roomId: string
  mode: PokerMode
  base: number
  configRevision: number
  participants: Pick<RoomMember, 'userId' | 'displayName'>[]
  totals: Record<string, number>
  entries: PokerEntry[]
  canRecord: boolean
  blockedReason: string | null
}
export interface PokerApi {
  get(roomId: string): Promise<PokerSnapshot>
  save(roomId: string, command: PokerCommand, requestId: string): Promise<PokerEntry>
}
interface Data {
  version: 1
  entries: Record<string, PokerEntry[]>
  receipts: Record<string, { signature: string; entry: PokerEntry }>
}
export function createMockPokerApi(
  roomApi: RoomApi,
  storage: MockStorage,
): PokerApi & { failNext(): void; loseNextResponse(): void } {
  let failure = false
  let lost = false
  function read(): Data {
    const value = storage.read()
    if (!value) return { version: 1, entries: {}, receipts: {} }
    const data = value as Data
    if (data.version !== 1 || !data.entries || !data.receipts)
      throw new RoomApiError('INVALID_RESPONSE', '扑克记录无法读取，请保留本地数据并检查')
    return JSON.parse(JSON.stringify(data)) as Data
  }
  async function context(roomId: string) {
    const [me, room] = await Promise.all([roomApi.getMe(), roomApi.getRoomSnapshot(roomId)])
    if (
      !isPoker(room.selectedMode) ||
      room.status !== 'active' ||
      !room.members.some((m) => m.userId === me.userId)
    )
      throw new RoomApiError('FORBIDDEN', '你不能在当前房间记分')
    if (room.pokerBase === undefined || !isPresetBase(room.pokerBase))
      throw new RoomApiError('RULE_NOT_CONFIGURED', '本房间尚无有效底分，请创建时选择预设底分')
    return { me, room, mode: room.selectedMode, base: room.pokerBase }
  }
  return {
    failNext() {
      failure = true
    },
    loseNextResponse() {
      lost = true
    },
    async get(roomId) {
      const { room, mode, base } = await context(roomId)
      const entries = read().entries[roomId] ?? []
      const totals = Object.fromEntries(room.members.map((m) => [m.userId, 0]))
      for (const entry of entries) totals[entry.userId] = (totals[entry.userId] ?? 0) + entry.delta
      const required = requiredPlayers(mode)
      const canRecord = room.members.length === required
      return {
        roomId,
        mode,
        base,
        configRevision: room.revision,
        participants: room.members.map(({ userId, displayName }) => ({ userId, displayName })),
        totals,
        entries: [...entries].reverse(),
        canRecord,
        blockedReason: canRecord
          ? null
          : room.members.length < required
            ? `还需${required - room.members.length}位朋友加入，满${required}人后可记分。`
            : `当前人数超过${required}人，参与名单规则待确认，暂不能记分。`,
      }
    },
    async save(roomId, command, requestId) {
      const { room, mode, base, me } = await context(roomId)
      const data = read()
      const signature = JSON.stringify([roomId, me.userId, command])
      const receipt = data.receipts[requestId]
      // Check the receipt before revisions: retrying an already saved entry is always safe.
      if (receipt) {
        if (receipt.signature !== signature)
          throw new RoomApiError('IDEMPOTENCY_MISMATCH', '该请求已用于其他记分')
        return receipt.entry
      }
      if (!requestId) throw new RoomApiError('INVALID_ARGUMENT', '缺少请求标识')
      if (
        command.configRevision !== room.revision ||
        command.base !== base ||
        command.mode !== mode
      )
        throw new RoomApiError('STALE_CONTEXT', '底分或名单已变化，请刷新后重新选择')
      if (room.members.length !== requiredPlayers(mode))
        throw new RoomApiError('FORBIDDEN', `需要${requiredPlayers(mode)}位入局玩家后才能记分`)
      const delta = deltaFor(mode, base, command)
      if (failure) {
        failure = false
        throw new RoomApiError('INTERNAL_ERROR', '未保存，请重试')
      }
      const previousTotal = (data.entries[roomId] ?? [])
        .filter((e) => e.userId === me.userId)
        .reduce((sum, e) => sum + e.delta, 0)
      if (!Number.isSafeInteger(previousTotal + delta))
        throw new RoomApiError('INVALID_ARGUMENT', '累计数值超出支持范围，请保留记录并检查')
      const entry: PokerEntry = {
        ...command,
        requestId,
        userId: me.userId,
        displayName: me.displayName,
        delta,
        savedAt: new Date().toISOString(),
      }
      data.entries[roomId] = [...(data.entries[roomId] ?? []), entry]
      data.receipts[requestId] = { signature, entry }
      storage.write(JSON.parse(JSON.stringify(data)))
      if (lost) {
        lost = false
        throw new RoomApiError('TRANSPORT_UNKNOWN', '保存结果待确认，请重试原记分')
      }
      return entry
    },
  }
}
export const unavailableCloudPokerApi: PokerApi = {
  async get() {
    throw new RoomApiError(
      'RULE_NOT_CONFIGURED',
      '云端扑克记分接口尚未接入，暂时无法读取底分、记录与累计',
    )
  },
  async save() {
    throw new RoomApiError('RULE_NOT_CONFIGURED', '云端扑克记分接口尚未接入')
  },
}
