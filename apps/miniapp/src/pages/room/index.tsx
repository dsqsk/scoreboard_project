import { createRoomReadLifecycle } from '../../features/room/read-lifecycle'
import { DaAFeature } from '../../features/da-a/DaAFeature'
import { enterRoomOnce } from '../../features/recent/visit'
import type { RoomVisit } from '../../features/recent/visit'
import { Avatar } from '../../features/profile/ProfileAvatar'
import { ProfileGate } from '../../features/profile/ProfileGate'
import { useEffect, useRef, useState } from 'react'
import Taro, {
  useDidShow,
  useDidHide,
  useRouter,
  useUnload,
  useShareAppMessage,
} from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import { MODE_LABELS } from '../../modules/room-api/types'
import { BaseButton, ActionButton, Notice, StatePanel } from '../../components/ui'
import { isMock, stores } from '../../runtime'
import { PointFeature } from '../../features/point/PointFeature'
import { PokerFeature } from '../../features/poker/PokerFeature'
import { isPoker } from '../../features/poker/model'
import { KillFeature } from '../../features/kill/KillFeature'
import { MODES } from '../../features/room/modes'

type Tab = 'score' | 'history' | 'totals'
function RoomContent({ entry }: { entry: RoomVisit }) {
  const { params } = useRouter()
  const roomId = params.roomId ?? ''
  const session = useStore(stores.room)
  const recent = useStore(stores.recent)
  const me = useStore(stores.identity, (state) => state.me)
  const [entryError, setEntryError] = useState(entry.current && !entry.confirmed)
  const [tab, setTab] = useState<Tab>('score')
  const [copyError, setCopyError] = useState<string | null>(null)
  useEffect(() => {
    if (roomId)
      void enterRoomOnce(entry, () => stores.recentSession.run('enter', roomId)).then((ok) =>
        setEntryError(!ok),
      )
  }, [roomId])
  const reads = useRef<ReturnType<typeof createRoomReadLifecycle> | null>(null)
  if (!reads.current) {
    reads.current = createRoomReadLifecycle(
      (id) => {
        void stores.openRoom(id)
      },
      () => stores.leaveView(),
    )
  }
  useEffect(() => {
    reads.current!.mount(roomId)
  }, [roomId])
  useEffect(() => () => reads.current!.leave(), [])
  useDidShow(() => reads.current!.show(roomId))
  useDidHide(() => reads.current!.hide())
  useUnload(() => reads.current!.leave())
  const snapshot = session.roomId === roomId ? session.snapshot : null
  useShareAppMessage(() => ({
    title: snapshot ? `${MODE_LABELS[snapshot.selectedMode]} · 一起记分` : '把分记好',
    path: snapshot?.joinCode ? `/pages/join/index?code=${snapshot.joinCode}` : '/pages/index/index',
  }))
  async function copy() {
    if (!snapshot?.joinCode) return
    try {
      await Taro.setClipboardData({ data: snapshot.joinCode })
      setCopyError(null)
    } catch {
      setCopyError('复制失败，可以直接将房间码告诉朋友')
    }
  }
  if (!roomId)
    return (
      <View className="page">
        <StatePanel title="房间地址不正确" />
        <ActionButton
          onClick={() => {
            void Taro.reLaunch({ url: '/pages/index/index' })
          }}
        >
          回到首页
        </ActionButton>
      </View>
    )
  return (
    <View className="page room-page">
      {entryError && recent.phase === 'idle' && (
        <Notice danger>
          进入记录尚未确认。
          <ActionButton
            secondary
            compact
            onClick={() => {
              void stores.recentSession.run('enter', roomId).then((ok) => {
                entry.confirmed = ok
                setEntryError(!ok)
              })
            }}
          >
            更新进入记录
          </ActionButton>
        </Notice>
      )}
      {(recent.phase === 'unknown' || recent.phase === 'failed') && (
        <Notice danger>
          {recent.message} · {recent.error}
          <ActionButton
            secondary
            compact
            onClick={() => {
              void stores.recentSession.recover().then((ok) => {
                if (
                  ok &&
                  recent.operation?.kind === 'enter' &&
                  recent.operation.roomId === roomId
                ) {
                  entry.confirmed = true
                  setEntryError(false)
                }
              })
            }}
          >
            确认原操作
          </ActionButton>
        </Notice>
      )}
      {(session.status === 'loading' || session.status === 'idle' || session.roomId !== roomId) && (
        <StatePanel title="正在进入房间…" />
      )}
      {session.status === 'error' && (
        <StatePanel
          title="暂时无法进入房间"
          description={session.error ?? ''}
          retry={() => {
            void stores.openRoom(roomId)
          }}
        />
      )}
      {snapshot && (
        <>
          <View className="room-header">
            <View className="room-header__copy">
              <Text className="page-title">{snapshot.name}</Text>
              <Text className="muted caption">
                房间码 {snapshot.joinCode || '待接口提供'} · {snapshot.memberCount}人 ·{' '}
                {snapshot.selectedMode === 'da_a'
                  ? '打大A'
                  : isPoker(snapshot.selectedMode)
                    ? snapshot.pokerBase
                      ? `底分 ×${snapshot.pokerBase}`
                      : '底分待读取'
                    : MODE_LABELS[snapshot.selectedMode]}
              </Text>
            </View>
            <ActionButton compact secondary disabled={!snapshot.joinCode} openType="share">
              分享 ↗
            </ActionButton>
          </View>
          {isMock && (
            <View className="demo-label">
              <View className="status-dot" />
              <Text>本地演示 · 分享码无法跨设备同步</Text>
            </View>
          )}
          <View className="room-tabs">
            {(
              [
                { id: 'score', label: '记分' },
                { id: 'history', label: '记录' },
                { id: 'totals', label: '累计' },
              ] as const
            ).map((item) => (
              <BaseButton
                key={item.id}
                className={`room-tab ${tab === item.id ? 'room-tab--active' : ''}`}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </BaseButton>
            ))}
          </View>
          {snapshot.selectedMode === 'point_ball' && me && (
            <PointFeature room={snapshot} meId={me.userId} tab={tab} />
          )}
          {snapshot.selectedMode === 'da_a' && me && (
            <DaAFeature room={snapshot} meId={me.userId} tab={tab} />
          )}
          {snapshot.selectedMode === 'dui_jia' && me && (
            <PokerFeature room={snapshot} meId={me.userId} tab={tab} />
          )}
          {snapshot.selectedMode === 'kill_ball' && me && (
            <KillFeature room={snapshot} meId={me.userId} tab={tab} />
          )}
          {snapshot.selectedMode !== 'point_ball' &&
            snapshot.selectedMode !== 'kill_ball' &&
            !isPoker(snapshot.selectedMode) &&
            tab === 'score' && (
              <>
                <View className="section-heading">
                  <Text className="section-title">房间成员</Text>
                  <Text className="caption muted">加入者均为参赛者</Text>
                </View>
                <View className="member-list">
                  {snapshot.members.map((member, index) => (
                    <View key={member.userId} className="member-row">
                      <Avatar user={member} />
                      <Text className="member-name">
                        {member.userId === me?.userId ? '我' : member.displayName}
                      </Text>
                      <Text className="caption muted">{index === 0 ? '已入房' : '已加入'}</Text>
                    </View>
                  ))}
                </View>
                <View className="panel preparation">
                  <Text className="eyebrow">当前玩法</Text>
                  <Text className="section-title">{MODE_LABELS[snapshot.selectedMode]}</Text>
                  <Text className="muted">
                    {MODES.find((item) => item.mode === snapshot.selectedMode)?.detail}
                  </Text>
                  <Text className="caption muted">
                    {snapshot.memberCount === 1
                      ? '邀请朋友加入后，再确认本次参与名单。'
                      : '房间成员已恢复，玩法记分将在下一步接入。'}
                  </Text>
                  <ActionButton disabled={!snapshot.joinCode} openType="share">
                    邀请朋友加入
                  </ActionButton>
                  <ActionButton
                    secondary
                    disabled={!snapshot.joinCode}
                    onClick={() => {
                      void copy()
                    }}
                  >
                    复制房间码
                  </ActionButton>
                </View>
              </>
            )}
          {snapshot.selectedMode !== 'point_ball' &&
            snapshot.selectedMode !== 'kill_ball' &&
            !isPoker(snapshot.selectedMode) &&
            tab === 'history' && (
              <StatePanel
                title="还没有记分记录"
                description="当前已完成房间流程；记分与记录查询将在后续接入。"
              />
            )}
          {snapshot.selectedMode !== 'point_ball' &&
            snapshot.selectedMode !== 'kill_ball' &&
            !isPoker(snapshot.selectedMode) &&
            tab === 'totals' && (
              <StatePanel
                title="还没有累计成绩"
                description="已保存的记分将按玩法分别累计，不混合分与颗。"
              />
            )}
          {copyError && <Notice danger>{copyError}</Notice>}
        </>
      )}
      <View className="room-home">
        <ActionButton
          secondary
          compact
          onClick={() => {
            void Taro.reLaunch({ url: '/pages/index/index' })
          }}
        >
          回到首页
        </ActionButton>
      </View>
    </View>
  )
}

export default function Room() {
  const entry = useRef(false)
  return (
    <ProfileGate>
      <RoomContent entry={entry} />
    </ProfileGate>
  )
}
