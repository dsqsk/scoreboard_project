import { useEffect } from 'react'
import Taro from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import type { RoomSnapshot } from '../../modules/room-api/types'
import { ActionButton, BaseButton, Notice, StatePanel } from '../../components/ui'
import { AA_VALUES, requiredPlayers } from './model'
import type { PokerMode } from './model'
import type { PokerSnapshot } from './api'
import { pokerSession } from './runtime'
import './poker.css'
const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`)
function displayTime(value: string) {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
export function PlayerTotals({
  snapshot,
  meId,
  scoreText = signed,
}: {
  snapshot: PokerSnapshot
  meId: string
  scoreText?: (value: number) => string
}) {
  const players = [...snapshot.participants].sort(
    (a, b) => Number(b.userId === meId) - Number(a.userId === meId),
  )
  const vacant = Math.max(0, requiredPlayers(snapshot.mode) - players.length)
  return (
    <View className="poker-players-panel">
      <Text className="poker-players-title">入局玩家</Text>
      <View className="poker-players">
        {players.map((player) => (
          <BaseButton
            key={player.userId}
            className={`poker-player ${player.userId === meId ? 'poker-player--me' : ''}`}
            ariaLabel={`${player.displayName}，累计${scoreText(snapshot.totals[player.userId] ?? 0)}分`}
            onClick={() => {
              void Taro.showModal({
                title: '入局玩家',
                content: player.displayName,
                showCancel: false,
              })
            }}
          >
            <Text className="poker-player-name">
              {player.userId === meId ? '我' : player.displayName}
            </Text>
            <Text
              className={`poker-player-score ${(snapshot.totals[player.userId] ?? 0) < 0 ? 'poker-player-score--negative' : ''} ${String(snapshot.totals[player.userId] ?? 0).length > 4 ? 'poker-player-score--long' : ''}`}
            >
              {scoreText(snapshot.totals[player.userId] ?? 0)}
            </Text>
          </BaseButton>
        ))}
        {Array.from({ length: vacant }, (_, i) => (
          <View key={`vacant-${i}`} className="poker-player poker-player--vacant">
            <Text className="poker-player-name">待加入</Text>
            <Text className="poker-player-score">—</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
export function ScoreControls({
  mode,
  direction,
  mingA,
  disabled,
  onDirection,
  onMingA,
}: {
  mode: PokerMode
  direction: 1 | -1
  mingA: boolean
  disabled: boolean
  onDirection: (value: 1 | -1) => void
  onMingA: () => void
}) {
  return (
    <View className="poker-controls">
      {([1, -1] as const).map((value) => (
        <BaseButton
          key={value}
          disabled={disabled}
          ariaLabel={value === 1 ? '加分' : '减分'}
          className={`poker-control ${direction === value ? 'poker-control--selected' : ''}`}
          onClick={() => onDirection(value)}
        >
          <Text>{value === 1 ? '＋' : '−'}</Text>
          {direction === value && <Text className="poker-control-check">✓</Text>}
        </BaseButton>
      ))}
      {mode === 'da_a' && (
        <BaseButton
          disabled={disabled}
          ariaLabel={`本次明A${mingA ? '已开启' : '未开启'}`}
          className={`poker-control poker-control--ming ${mingA ? 'poker-control--selected' : ''}`}
          onClick={onMingA}
        >
          <Text>明A</Text>
          <Text>×2</Text>
          {mingA && <Text className="poker-control-check">✓</Text>}
        </BaseButton>
      )}
    </View>
  )
}
export function PokerFeature({
  room,
  meId,
  tab,
}: {
  room: RoomSnapshot
  meId: string
  tab: 'score' | 'history' | 'totals'
}) {
  const state = useStore(pokerSession.store)
  useEffect(() => {
    void pokerSession.open(room.roomId, meId)
    return () => pokerSession.leave()
  }, [room.roomId, room.revision, meId])
  const snapshot = state.roomId === room.roomId && state.userId === meId ? state.snapshot : null
  const disabled = state.busy || state.loading || !!state.pending || !snapshot?.canRecord
  const draft = state.draft
  return (
    <View className="poker-feature">
      {state.loading && <StatePanel title="正在读取扑克记分…" />}
      {state.error && <Notice danger>{state.error}</Notice>}
      {state.pending ? (
        <ActionButton
          secondary
          compact
          disabled={state.busy || state.loading}
          onClick={() => {
            void pokerSession.submit()
          }}
        >
          确认上次记分
        </ActionButton>
      ) : (
        state.error && (
          <ActionButton
            secondary
            compact
            disabled={state.busy || state.loading}
            onClick={() => {
              void pokerSession.open(room.roomId, meId)
            }}
          >
            刷新房间
          </ActionButton>
        )
      )}
      {snapshot && tab === 'score' && (
        <>
          <PlayerTotals snapshot={snapshot} meId={meId} />
          {!snapshot.canRecord && <Notice>{snapshot.blockedReason}</Notice>}
          <View className="poker-entry-panel">
            <View className="poker-entry">
              <ScoreControls
                mode={snapshot.mode}
                direction={draft.direction}
                mingA={draft.mingA}
                disabled={disabled}
                onDirection={(direction) => pokerSession.select({ direction })}
                onMingA={() => pokerSession.select({ mingA: !draft.mingA })}
              />
              <View className="poker-entry-values">
                <Text className="poker-values-title">选择记分值</Text>
                <View
                  className={`poker-values ${snapshot.mode === 'dui_jia' ? 'poker-values--duijia' : ''}`}
                >
                  {(snapshot.mode === 'da_a' ? AA_VALUES : [1, 2]).map((value) => {
                    const amount =
                      value * snapshot.base * (snapshot.mode === 'da_a' && draft.mingA ? 2 : 1)
                    return (
                      <BaseButton
                        key={value}
                        disabled={disabled}
                        ariaLabel={
                          snapshot.mode === 'da_a'
                            ? `${amount}分`
                            : `抓${value === 1 ? '一个' : '两个'}，${amount}分`
                        }
                        className={`poker-value ${snapshot.mode === 'dui_jia' ? 'poker-value--duijia' : ''} ${draft.value === value ? 'poker-value--selected' : ''}`}
                        onClick={() => pokerSession.select({ value })}
                      >
                        <Text className="poker-value-number">{amount}</Text>
                        {draft.value === value && <Text className="poker-value-check">✓</Text>}
                      </BaseButton>
                    )
                  })}
                </View>
                {snapshot.mode === 'da_a' && (
                  <Text className="poker-ming-hint">明A仅本次生效，记分后恢复</Text>
                )}
              </View>
            </View>
          </View>
          <View className="poker-confirm">
            <ActionButton
              disabled={disabled || draft.value === null}
              onClick={() => {
                void pokerSession.submit()
              }}
            >
              {state.busy ? '保存中…' : '确认记分'}
            </ActionButton>
          </View>
          <Text className="poker-own-only">仅更新我的分数</Text>
          {state.feedback && <Text className="poker-feedback">{state.feedback}</Text>}
          {!state.loading && snapshot.canRecord && draft.value === null && !state.feedback && (
            <Text className="poker-empty-hint">请选择记分值后确认</Text>
          )}
        </>
      )}
      {snapshot && tab === 'history' && (
        <>
          {snapshot.entries.length === 0 ? (
            <StatePanel
              title="还没有扑克记录"
              description="确认记分后保存本人流水，未确认的选择不会记录。"
            />
          ) : (
            snapshot.entries.map((entry) => (
              <View className="poker-history-entry" key={entry.requestId}>
                <View className="poker-history-heading">
                  <Text>{entry.userId === meId ? '我' : entry.displayName}</Text>
                  <Text
                    className={`poker-history-delta ${entry.delta < 0 ? 'poker-player-score--negative' : ''}`}
                  >
                    {signed(entry.delta)} 分
                  </Text>
                </View>
                <Text className="poker-history-detail">
                  底分 ×{entry.base} ·{' '}
                  {entry.mode === 'da_a'
                    ? `基础${entry.value} · ${entry.mingA ? '明A ×2' : '普通'}`
                    : `抓${entry.value === 1 ? '一个' : '两个'} · ${entry.value}倍`}
                </Text>
                <Text className="poker-history-detail">
                  {entry.direction === 1 ? '加分' : '减分'} · {displayTime(entry.savedAt)}
                </Text>
              </View>
            ))
          )}
        </>
      )}
      {snapshot && tab === 'totals' && (
        <>
          <PlayerTotals snapshot={snapshot} meId={meId} />
          <Text className="poker-own-only">
            本房间{snapshot.mode === 'da_a' ? '打大A' : '打对家'}累计 · 已保存
            {snapshot.entries.length}笔
          </Text>
        </>
      )}
    </View>
  )
}
