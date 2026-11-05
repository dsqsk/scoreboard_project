import type { CommandReceipt, DaASnapshot, DaAEntry } from '@scoreboard/shared'
import type { RoomApi } from '../../modules/room-api/types'
import type { MockStorage } from '../../modules/room-api/mock'
import { RoomApiError } from '../../modules/room-api/errors'
import { isPresetBase } from '../poker/model'
import { requestFor } from './api'
import type { DaAApi } from './api'
interface Data {
  version: 1
  rooms: Record<
    string,
    { activity: DaASnapshot['activity']; entries: DaAEntry[]; revision: number }
  >
  receipts: Record<string, { signature: string; receipt: CommandReceipt }>
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
export function createMockDaAApi(
  roomApi: RoomApi,
  storage: MockStorage,
): DaAApi & { failNext(): void; loseNextResponse(): void } {
  let fail = false,
    lost = false
  function read(): Data {
    const value = storage.read() as Data | null
    if (!value) return { version: 1, rooms: {}, receipts: {} }
    if (value.version !== 1 || !value.rooms || !value.receipts) throw new Error('打大A演示数据损坏')
    return clone(value)
  }
  async function context(roomId: string) {
    const [me, room] = await Promise.all([roomApi.getMe(), roomApi.getRoomSnapshot(roomId)])
    if (
      room.selectedMode !== 'da_a' ||
      room.status !== 'active' ||
      !room.members.some((p) => p.userId === me.userId)
    )
      throw new RoomApiError('FORBIDDEN', '请先加入打大A房间')
    if (!room.pokerBase || !isPresetBase(room.pokerBase))
      throw new RoomApiError('RULE_NOT_CONFIGURED', '旧房间底分未配置，请创建带预设底分的新房间')
    return { me, room, baseStake: room.pokerBase as 1 | 5 | 10 }
  }
  return {
    failNext() {
      fail = true
    },
    loseNextResponse() {
      lost = true
    },
    async get(roomId, cursor) {
      const { me, room, baseStake } = await context(roomId)
      const data = read().rooms[roomId] ?? { activity: null, entries: [], revision: 0 }
      const start = cursor ? data.entries.findIndex((e) => e.entryId === cursor) : 0
      if (start < 0) throw new RoomApiError('INVALID_ARGUMENT', '分页已失效，请刷新')
      const totalsUnits: Record<string, number> = {}
      for (const e of data.entries)
        totalsUnits[e.userId] = (totalsUnits[e.userId] ?? 0) + e.deltaUnits
      return clone({
        roomId,
        roomRevision: room.revision + data.revision,
        baseStake,
        scoreScale: 100,
        activity: data.activity,
        canRecord:
          data.activity?.status === 'open' &&
          data.activity.participants.some((p) => p.userId === me.userId),
        entries: data.entries.slice(start, start + 20),
        nextCursor: data.entries[start + 20]?.entryId ?? null,
        totalsUnits,
      })
    },
    async execute(roomId, command, requestId) {
      requestFor(roomId, command, requestId)
      const { me, room, baseStake } = await context(roomId)
      const data = read(),
        signature = JSON.stringify([roomId, me.userId, command])
      const old = data.receipts[requestId]
      if (old) {
        if (old.signature !== signature)
          throw new RoomApiError('IDEMPOTENCY_MISMATCH', '请求已用于其他操作')
        return old.receipt
      }
      if (fail) {
        fail = false
        throw new RoomApiError('INTERNAL_ERROR', '本次操作未保存，请重试')
      }
      const saved = data.rooms[roomId] ?? { activity: null, entries: [], revision: 0 }
      let entityId: string
      if (command.kind === 'prepare') {
        if (room.revision + saved.revision !== command.expectedRoomRevision)
          throw new RoomApiError('STALE_CONTEXT', '房间状态已变化，请重新确认')
        if (saved.activity) throw new RoomApiError('CONFLICT', '已有固定参与名单')
        const ids = command.participantIds
        if (
          ids.length !== 5 ||
          new Set(ids).size !== 5 ||
          !ids.includes(me.userId) ||
          ids.some((id) => !room.members.some((p) => p.userId === id))
        )
          throw new RoomApiError('INVALID_ARGUMENT', '请选择包括本人在内的五名不同成员')
        saved.activity = {
          activityId: `daa-${requestId}`,
          revision: 0,
          configRevision: 0,
          status: 'open',
          participants: ids.map((id) => clone(room.members.find((p) => p.userId === id)!)),
        }
        saved.revision++
        entityId = saved.activity.activityId
      } else {
        const a = saved.activity
        if (
          !a ||
          a.activityId !== command.activityId ||
          a.configRevision !== command.expectedConfigRevision ||
          a.status !== 'open'
        )
          throw new RoomApiError('STALE_CONTEXT', '活动或配置已变化')
        const player = a.participants.find((p) => p.userId === me.userId)
        if (!player) throw new RoomApiError('FORBIDDEN', '你未参加本场，不能记分')
        const deltaUnits =
          command.direction * command.value * baseStake * (command.mingA ? 2 : 1) * 100
        const previous = saved.entries
          .filter((e) => e.userId === me.userId)
          .reduce((sum, e) => sum + e.deltaUnits, 0)
        if (!Number.isSafeInteger(previous + deltaUnits))
          throw new RoomApiError('CONFLICT', '累计超出支持范围')
        entityId = `entry-${requestId}`
        saved.entries.unshift({
          entryId: entityId,
          requestId,
          roomId,
          activityId: a.activityId,
          userId: me.userId,
          displayName: player.displayName,
          baseStake,
          direction: command.direction,
          value: command.value,
          mingA: command.mingA,
          deltaUnits,
          savedAt: Date.now(),
        })
        a.revision++
      }
      const receipt: CommandReceipt = {
        requestId,
        entityId,
        roomId,
        activityId: saved.activity!.activityId,
        roomRevision: room.revision + saved.revision,
        activityRevision: saved.activity!.revision,
      }
      data.rooms[roomId] = saved
      data.receipts[requestId] = { signature, receipt }
      storage.write(clone(data))
      if (lost) {
        lost = false
        throw new RoomApiError('TRANSPORT_UNKNOWN', '保存结果待确认，请确认原操作')
      }
      return receipt
    },
  }
}
