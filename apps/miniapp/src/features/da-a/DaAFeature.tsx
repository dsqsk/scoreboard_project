import { useEffect, useRef, useState } from 'react'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import { DA_A_VALUES } from '@scoreboard/shared'
import type { RoomSnapshot } from '../../modules/room-api/types'
import { roomApi } from '../../runtime'
import { ActionButton, BaseButton, BottomSheet, Notice, StatePanel } from '../../components/ui'
import { errorMessage } from '../../modules/room-api/errors'
import { PlayerTotals, ScoreControls } from '../poker/PokerFeature'
import type { PokerSnapshot } from '../poker/api'
import { daASession } from './runtime'
import { formatUnits, signedUnits } from './api'
import '../poker/poker.css'
import './da-a.css'
export function DaAFeature({
  room,
  meId,
  tab,
}: {
  room: RoomSnapshot
  meId: string
  tab: 'score' | 'history' | 'totals'
}) {
  const state = useStore(daASession.store)
  const [selection, setSelection] = useState<{
    ids: string[]
    members: RoomSnapshot['members']
    revision: number
  } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const alive = useRef(true),
    hidden = useRef(false)
  const currentContext = useRef({ roomId: room.roomId, meId })
  currentContext.current = { roomId: room.roomId, meId }
  function isCurrentRoom() {
    return (
      alive.current &&
      currentContext.current.roomId === room.roomId &&
      currentContext.current.meId === meId &&
      daASession.store.getState().roomId === room.roomId &&
      daASession.store.getState().userId === meId
    )
  }
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  function stop() {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }
  function start() {
    stop()
    if (!hidden.current)
      timer.current = setInterval(() => {
        void daASession.refresh()
      }, 5000)
  }
  useEffect(() => {
    alive.current = true
    setSelection(null)
    setLocalError(null)
    setPreparing(false)
    void daASession.open(room.roomId, meId)
    start()
    const network = ({ isConnected }: { isConnected: boolean }) => {
      if (!alive.current) return
      daASession.setOnline(isConnected)
      if (isConnected && !hidden.current) void daASession.refresh()
    }
    Taro.onNetworkStatusChange(network)
    void Taro.getNetworkType()
      .then(({ networkType }) => {
        if (alive.current) daASession.setOnline(networkType !== 'none')
      })
      .catch(() => {})
    return () => {
      alive.current = false
      stop()
      Taro.offNetworkStatusChange(network)
      daASession.leave()
    }
  }, [room.roomId, meId])
  useDidHide(() => {
    hidden.current = true
    stop()
  })
  useDidShow(() => {
    hidden.current = false
    start()
    void daASession.refresh()
  })
  useEffect(() => {
    void daASession.refresh()
  }, [tab])
  const snapshot = state.roomId === room.roomId && state.userId === meId ? state.snapshot : null
  const disabled =
    state.busy ||
    state.loading ||
    !state.online ||
    !!state.pending ||
    !state.journalReady ||
    !snapshot?.canRecord ||
    !snapshot.activity?.participants.some((p) => p.userId === meId)
  const draft = state.draft
  const presentation: PokerSnapshot | null = snapshot
    ? {
        roomId: room.roomId,
        mode: 'da_a',
        base: snapshot.baseStake,
        configRevision: snapshot.activity?.configRevision ?? 0,
        participants: snapshot.activity?.participants ?? [],
        totals: snapshot.totalsUnits,
        entries: [],
        canRecord: snapshot.canRecord,
        blockedReason: null,
      }
    : null
  async function prepareSelection() {
    setPreparing(true)
    setLocalError(null)
    try {
      await daASession.refresh()
      const fresh = await roomApi.getRoomSnapshot(room.roomId)
      if (!isCurrentRoom()) return
      const current = daASession.store.getState().snapshot
      if (!current || current.activity) throw new Error('已有固定名单或状态尚未恢复，请刷新查看')
      setSelection({
        ids: fresh.members.length === 5 ? fresh.members.map((p) => p.userId) : [meId],
        members: fresh.members,
        revision: current.roomRevision,
      })
    } catch (error) {
      if (isCurrentRoom()) setLocalError(errorMessage(error))
    } finally {
      if (isCurrentRoom()) setPreparing(false)
    }
  }
  const amount =
    draft.value === null || !snapshot
      ? null
      : draft.direction * draft.value * snapshot.baseStake * (draft.mingA ? 2 : 1) * 100
  return (
    <View className="poker-feature">
      {!state.online && (
        <Notice danger>网络已断开，暂停保存；恢复后读取最新状态，未确认操作不会自动重发。</Notice>
      )}
      {state.loading && <StatePanel title="正在读取打大A…" />}
      {(state.error || localError) && <Notice danger>{state.error ?? localError}</Notice>}
      {state.pending ? (
        <ActionButton
          secondary
          compact
          disabled={state.busy || state.loading || !state.online}
          onClick={() => {
            void daASession.submit()
          }}
        >
          确认上次{state.pending.command.kind === 'prepare' ? '名单' : '记分'}
        </ActionButton>
      ) : (
        state.error && (
          <ActionButton
            secondary
            compact
            disabled={state.busy || !state.online}
            onClick={() => {
              setLocalError(null)
              void daASession.open(room.roomId, meId)
            }}
          >
            刷新打大A
          </ActionButton>
        )
      )}
      {snapshot && <Text className="poker-own-only">底分 ×{snapshot.baseStake}</Text>}
      {snapshot && tab === 'score' && !snapshot.activity && (
        <View className="panel preparation">
          <Text className="section-title">确认本场五名参与者</Text>
          <Text className="muted">选择包括本人在内的5名房间成员，开始后名单与底分固定。</Text>
          <ActionButton
            disabled={
              state.loading ||
              state.busy ||
              !!state.pending ||
              !state.online ||
              !state.journalReady ||
              preparing
            }
            onClick={() => {
              void prepareSelection()
            }}
          >
            {preparing ? '读取名单中…' : '确认参与名单'}
          </ActionButton>
          <ActionButton secondary openType="share">
            邀请朋友加入
          </ActionButton>
        </View>
      )}
      {snapshot?.activity && presentation && tab === 'score' && (
        <>
          <PlayerTotals snapshot={presentation} meId={meId} scoreText={signedUnits} />
          {!snapshot.canRecord && (
            <Notice>
              你未参加本场或本场已只读，可以查看记录和累计，不能记分。晚加入不会改变本场五人名单。
            </Notice>
          )}
          <View className="poker-entry-panel">
            <View className="poker-entry">
              <ScoreControls
                mode="da_a"
                direction={draft.direction}
                mingA={draft.mingA}
                disabled={disabled}
                onDirection={(direction) => daASession.select({ direction })}
                onMingA={() => daASession.select({ mingA: !draft.mingA })}
              />
              <View className="poker-entry-values">
                <Text className="poker-values-title">选择记分值</Text>
                <View className="poker-values">
                  {DA_A_VALUES.map((value) => {
                    const units = value * snapshot.baseStake * (draft.mingA ? 2 : 1) * 100
                    return (
                      <BaseButton
                        key={value}
                        disabled={disabled}
                        ariaLabel={`${formatUnits(units)}分`}
                        className={`poker-value ${draft.value === value ? 'poker-value--selected' : ''}`}
                        onClick={() => daASession.select({ value })}
                      >
                        <Text className="poker-value-number">{formatUnits(units)}</Text>
                        {draft.value === value && <Text className="poker-value-check">✓</Text>}
                      </BaseButton>
                    )
                  })}
                </View>
                <Text className="poker-ming-hint">明A仅本次生效，记分后恢复</Text>
              </View>
            </View>
          </View>
          <View className="poker-confirm">
            <ActionButton
              disabled={disabled || amount === null}
              onClick={() => {
                void daASession.submit()
              }}
            >
              {state.busy ? '保存中…' : '确认记分'}
            </ActionButton>
          </View>
          <Text className="poker-own-only">仅更新我的分数</Text>
        </>
      )}
      {state.feedback && <Text className="poker-feedback">{state.feedback}</Text>}
      {snapshot && tab === 'history' && (
        <>
          {snapshot.entries.length === 0 ? (
            <StatePanel
              title="还没有打大A记录"
              description="确认记分后保存本人流水，未确认的选择不会记录。"
            />
          ) : (
            snapshot.entries.map((e) => (
              <View className="poker-history-entry" key={e.entryId}>
                <View className="poker-history-heading">
                  <Text>{e.userId === meId ? '我' : e.displayName}</Text>
                  <Text
                    className={`poker-history-delta ${e.deltaUnits < 0 ? 'poker-player-score--negative' : ''}`}
                  >
                    {signedUnits(e.deltaUnits)} 分
                  </Text>
                </View>
                <Text className="poker-history-detail">
                  底分 ×{e.baseStake} · 基础{e.value} · {e.mingA ? '明A ×2' : '普通'}
                </Text>
                <Text className="poker-history-detail">
                  {e.direction === 1 ? '加分' : '减分'} · {new Date(e.savedAt).toLocaleString()}
                </Text>
              </View>
            ))
          )}
          {snapshot.nextCursor && (
            <ActionButton
              secondary
              disabled={state.loadingMore || state.busy || !state.online}
              onClick={() => {
                void daASession.loadMore()
              }}
            >
              {state.loadingMore ? '读取中…' : '加载更多记录'}
            </ActionButton>
          )}
        </>
      )}
      {snapshot && tab === 'totals' && (
        <View className="panel">
          <Text className="section-title">本房间打大A累计</Text>
          <Text className="poker-own-only">完整累计，不根据当前页记录计算</Text>
          {[
            ...new Set([
              ...(snapshot.activity?.participants.map((p) => p.userId) ??
                room.members.map((p) => p.userId)),
              ...Object.keys(snapshot.totalsUnits),
            ]),
          ].map((id) => (
            <View className="daa-total-row" key={id}>
              <Text>
                {id === meId
                  ? '我'
                  : (snapshot.activity?.participants.find((p) => p.userId === id)?.displayName ??
                    room.members.find((p) => p.userId === id)?.displayName ??
                    snapshot.entries.find((e) => e.userId === id)?.displayName ??
                    '历史成员')}
              </Text>
              <Text>{signedUnits(snapshot.totalsUnits[id] ?? 0)} 分</Text>
            </View>
          ))}
        </View>
      )}
      {selection && (
        <BottomSheet
          title="确认本场五名参与者"
          busy={state.busy}
          onClose={() => setSelection(null)}
        >
          <Text className="muted">本场名单固定；请选本人在内的5名不同成员。</Text>
          {selection.members.map((p) => (
            <BaseButton
              key={p.userId}
              className={`daa-person ${selection.ids.includes(p.userId) ? 'daa-person--selected' : ''}`}
              disabled={
                state.busy ||
                !!state.pending ||
                p.userId === meId ||
                (!selection.ids.includes(p.userId) && selection.ids.length >= 5)
              }
              onClick={() =>
                setSelection((s) =>
                  s
                    ? {
                        ...s,
                        ids: s.ids.includes(p.userId)
                          ? s.ids.filter((id) => id !== p.userId)
                          : [...s.ids, p.userId],
                      }
                    : null,
                )
              }
            >
              <Text>{p.userId === meId ? '我' : p.displayName}</Text>
              <Text>{selection.ids.includes(p.userId) ? '已选' : '选择'}</Text>
            </BaseButton>
          ))}
          {state.error && <Notice danger>{state.error}</Notice>}
          {state.pending && (
            <ActionButton
              secondary
              disabled={state.busy || !state.online}
              onClick={() => {
                void daASession.submit().then((ok) => {
                  if (ok && isCurrentRoom()) setSelection(null)
                })
              }}
            >
              确认原准备操作
            </ActionButton>
          )}
          <ActionButton
            disabled={selection.ids.length !== 5 || state.busy || !!state.pending || !state.online}
            onClick={() => {
              void daASession
                .submit({
                  kind: 'prepare',
                  expectedRoomRevision: selection.revision,
                  participantIds: selection.ids,
                })
                .then((ok) => {
                  if (ok && isCurrentRoom()) setSelection(null)
                })
            }}
          >
            开始本场（{selection.ids.length}/5）
          </ActionButton>
        </BottomSheet>
      )}
    </View>
  )
}
