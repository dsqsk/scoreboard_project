import type { GameMode } from './game'

// Room UI contract. Backend-only activity extensions live in foundation.ts.
export interface DefaultAvatar {
  template: 'person-v1'
  color: string
}
export interface Me {
  userId: string
  displayName: string
  avatarFileId?: string | null
  defaultAvatar?: DefaultAvatar
  profileCompleted?: boolean
}
export interface RoomPreview {
  roomId: string
  name: string
  joinCode: string
  selectedMode: GameMode
  memberCount: number
  status: 'active' | 'closed'
}
export interface RecentRoomPreview extends RoomPreview {
  lastEnteredAt: number
}
export interface RecentRoomPage {
  rooms: RecentRoomPreview[]
  nextCursor: string | null
}
export interface RoomMember extends Me {
  joinedAt: string
}
export interface RoomSnapshot extends RoomPreview {
  revision: number
  activeActivityId: string | null
  members: RoomMember[]
  membersNextCursor?: string | null
}
export interface RoomReceipt {
  roomId: string
  requestId: string
}
export interface RoomApi {
  getMe(): Promise<Me>
  createRoom(mode: GameMode, requestId: string): Promise<RoomReceipt>
  previewRoom(joinCode: string): Promise<RoomPreview>
  joinRoom(joinCode: string, requestId: string): Promise<RoomReceipt>
  listRecent(): Promise<RoomPreview[]>
  listRecentPage(cursor?: string, limit?: number): Promise<RecentRoomPage>
  enterRoom(roomId: string, requestId: string): Promise<RoomReceipt>
  dismissRecentRoom(roomId: string, requestId: string): Promise<RoomReceipt>
  getRoomSnapshot(roomId: string): Promise<RoomSnapshot>
}
