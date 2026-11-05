import type { ITouchEvent } from '@tarojs/components'
import { useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import type { RoomPreview } from '../../modules/room-api/types'
import { MODE_LABELS } from '../../modules/room-api/types'
import { BaseButton } from '../../components/ui'
import { beginSwipe, moveSwipe, endSwipe, REVEAL_WIDTH } from './gesture'
import type { SwipeGesture } from './gesture'
import './recent.css'
interface Props {
  rooms: RoomPreview[]
  opened: string | null
  setOpened(id: string | null): void
  busy: boolean
  pendingRoomId?: string
  onDismiss(id: string): void
  onEnter(id: string): void
}
function RecentRoom({
  room,
  opened,
  setOpened,
  busy,
  pendingRoomId,
  onDismiss,
  onEnter,
}: Omit<Props, 'rooms'> & { room: RoomPreview }) {
  const gesture = useRef<SwipeGesture | null>(null)
  const suppress = useRef(false)
  const [drag, setDrag] = useState<number | null>(null)
  const expanded = opened === room.roomId
  const horizontal = gesture.current?.direction === 'horizontal'
  function click(event: { stopPropagation(): void }, enter: boolean) {
    event.stopPropagation()
    if (suppress.current) {
      suppress.current = false
      return
    }
    if (expanded || opened) {
      setOpened(null)
      return
    }
    if (enter && !busy && room.status === 'active') onEnter(room.roomId)
  }
  return (
    <View className="recent-swipe">
      <BaseButton
        className="recent-delete"
        ariaLabel={`从最近房间移除${room.name} ${room.joinCode}`}
        disabled={busy || !expanded}
        onClick={(event) => {
          event.stopPropagation()
          if (!busy) onDismiss(room.roomId)
        }}
      >
        {pendingRoomId === room.roomId ? '移除中…' : '删除'}
      </BaseButton>
      <View
        className={`recent-front ${drag !== null ? 'recent-front--dragging' : ''}`}
        style={{ transform: `translateX(${drag ?? (expanded ? -REVEAL_WIDTH : 0)}px)` }}
        catchMove={!!horizontal}
        onTouchStart={(event) => {
          if (busy) return
          const touch = (event as ITouchEvent).touches[0]
          if (!touch) return
          suppress.current = false
          gesture.current = beginSwipe(touch.clientX, touch.clientY, expanded)
        }}
        onTouchMove={(event) => {
          const touch = (event as ITouchEvent).touches[0]
          if (!touch || !gesture.current || busy) return
          gesture.current = moveSwipe(gesture.current, touch.clientX, touch.clientY)
          if (gesture.current.direction === 'horizontal') {
            event.stopPropagation()
            setOpened(room.roomId)
            setDrag(gesture.current.offset)
          }
        }}
        onTouchEnd={() => {
          if (!gesture.current) return
          const result = endSwipe(gesture.current)
          suppress.current = result.suppressClick
          if (gesture.current.direction === 'horizontal')
            setOpened(result.opened ? room.roomId : null)
          gesture.current = null
          setDrag(null)
        }}
        onTouchCancel={() => {
          if (gesture.current?.moved) suppress.current = true
          gesture.current = null
          setDrag(null)
        }}
        onClick={(event) => click(event, false)}
      >
        <Text className="room-card__title">{room.name}</Text>
        <Text className="muted caption">房间码 {room.joinCode}</Text>
        <View className="room-card__bottom">
          <Text className="muted caption">
            {room.memberCount}人 · {MODE_LABELS[room.selectedMode]}
          </Text>
          <BaseButton
            className="action action--compact"
            disabled={busy || room.status !== 'active'}
            onClick={(event) => click(event, true)}
          >
            {room.status === 'active' ? '进入房间 →' : '已关闭'}
          </BaseButton>
        </View>
      </View>
    </View>
  )
}
export function RecentRooms(props: Props) {
  return (
    <View className="recent-rooms">
      {props.rooms.map((room) => (
        <RecentRoom {...props} key={room.roomId} room={room} />
      ))}
    </View>
  )
}
