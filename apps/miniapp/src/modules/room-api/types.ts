import type { GameMode } from '@scoreboard/shared'
// Shared room view contract; backend activity extensions stay outside page code.
export type { Me, RoomMember, RoomPreview, RoomReceipt } from '@scoreboard/shared'
import type {
  RoomApi as SharedRoomApi,
  RoomSnapshot as SharedRoomSnapshot,
  RoomReceipt,
} from '@scoreboard/shared'
import type { PokerMode } from '../../features/poker/model'
// Local adapter extension pending a server poker contract; cloud never invents a base.
export interface RoomSnapshot extends SharedRoomSnapshot {
  pokerBase?: number
}
export interface RoomApi extends SharedRoomApi {
  updateProfile?(
    input: { displayName: string; avatarFileId?: string },
    requestId: string,
  ): Promise<void>
  createPokerRoom?(mode: PokerMode, base: number, requestId: string): Promise<RoomReceipt>
  getRoomSnapshot(roomId: string): Promise<RoomSnapshot>
}
export const MODE_LABELS: Record<GameMode, string> = {
  nine_ball: '中式九球',
  kill_ball: '杀球',
  point_ball: '打分',
  da_a: '打大A',
  dui_jia: '打对家',
}
