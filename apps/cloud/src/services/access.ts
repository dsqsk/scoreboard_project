import type { Member, Room, User } from '../domain/models'
import type { Transaction } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { stableId } from '../infrastructure/ids'

export async function activeUser(tx: Transaction, id: string): Promise<User> {
  const user = await tx.get('users', id)
  if (!user || user.status !== 'active') throw new AppError('FORBIDDEN', '当前用户不可用')
  return user
}
export async function activeRoom(tx: Transaction, roomId: string, now: number): Promise<Room> {
  const room = await tx.get('rooms', roomId)
  if (!room || room.status !== 'active' || (room.expiresAt !== null && room.expiresAt <= now))
    throw new AppError('NOT_FOUND', '房间不存在或已失效')
  return room
}
export async function requireMember(
  tx: Transaction,
  roomId: string,
  userId: string,
  now: number,
): Promise<{ room: Room; member: Member }> {
  const user = await activeUser(tx, userId)
  const room = await activeRoom(tx, roomId, now)
  if (room.wechatAppId !== user.wechatAppId)
    throw new AppError('FORBIDDEN', '无法访问其他小程序的房间')
  const member = await tx.get('room_members', stableId('mem', roomId, userId))
  if (!member || member.status !== 'active') throw new AppError('FORBIDDEN', '请先加入房间')
  return { room, member }
}
export async function roomFromCode(
  tx: Transaction,
  joinCode: string,
  now: number,
  appId: string,
): Promise<Room> {
  const code = await tx.get('room_codes', joinCode)
  if (!code || code.status !== 'active' || (code.expiresAt !== null && code.expiresAt <= now))
    throw new AppError('NOT_FOUND', '未找到可加入的房间')
  const room = await activeRoom(tx, code.roomId, now)
  if (room.wechatAppId !== appId) throw new AppError('NOT_FOUND', '未找到可加入的房间')
  if (room.activeCodeId !== joinCode) throw new AppError('NOT_FOUND', '房间码已失效')
  return room
}
