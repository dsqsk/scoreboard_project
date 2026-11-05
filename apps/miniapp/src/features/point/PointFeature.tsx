import { createPointNetworkHandler } from './network'
import { useEffect, useRef, useState } from 'react'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import type { RoomSnapshot } from '../../modules/room-api/types'
import { ActionButton, BaseButton, BottomSheet, Notice, StatePanel } from '../../components/ui'
import { roomApi } from '../../runtime'
import { errorMessage } from '../../modules/room-api/errors'
import type { Participant, PointCard, PointResult } from './api'
import { pointSession } from './runtime'
import './point.css'
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
function time(value: number) {
  const d = new Date(value)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function ResultCard({ result }: { result: PointResult }) {
  return (
    <View className="point-result panel">
      <Text className="section-title point-block">已保存完整结果</Text>
      <Text className="caption muted point-block">
        {time(result.savedAt)} · 每人基准{120 / result.participants.length}分
      </Text>
      {result.participants.map((p) => (
        <View className="point-result-row" key={p.userId}>
          <Text>{p.displayName}</Text>
          <Text className="caption muted">进球 {result.earnedPoints[p.userId]} 分</Text>
          <Text className="point-net">{signed(result.deltas[p.userId] ?? 0)} 分</Text>
        </View>
      ))}
    </View>
  )
}
function PublicCard({
  card,
  ownerName,
  mine,
  busy,
  unknown,
  disabled,
  onClick,
}: {
  card: PointCard
  ownerName: string | null
  mine: boolean
  busy: boolean
  unknown: boolean
  disabled: boolean
  onClick: () => void
}) {
  const red = card.number === 14 || (card.number < 14 && [0, 2].includes(card.number % 4))
  const rank =
    card.number === 1
      ? 'A'
      : card.number <= 10
        ? String(card.number)
        : card.number <= 13
          ? ['J', 'Q', 'K'][card.number - 11]
          : 'JOKER'
  const suit = card.number >= 14 ? '★' : ['♦', '♠', '♥', '♣'][card.number % 4]
  return (
    <BaseButton
      ariaLabel={`${card.number}号，${ownerName ? `当前归${ownerName}，修改归属` : '未记录，记给自己'}`}
      disabled={disabled || busy}
      className={`point-card ${red ? 'point-card--red' : ''} ${card.ownerUserId ? (mine ? 'point-card--mine' : 'point-card--other') : ''}`}
      onClick={onClick}
    >
      <Text className={`point-rank ${card.number > 13 ? 'point-rank--joker' : ''}`}>
        {rank}
        <Text className="point-suit">{suit}</Text>
      </Text>
      <Text className="point-card-number">{card.number}</Text>
      {!card.ownerUserId && (
        <Text
          className={`point-rank point-rank--bottom ${card.number > 13 ? 'point-rank--joker' : ''}`}
        >
          {rank}
          <Text className="point-suit">{suit}</Text>
        </Text>
      )}
      {(busy || ownerName) && (
        <Text className="point-owner">{busy ? (unknown ? '待确认' : '保存中') : ownerName}</Text>
      )}
    </BaseButton>
  )
}
export function PointFeature({
  room,
  meId,
  tab,
}: {
  room: RoomSnapshot
  meId: string
  tab: 'score' | 'history' | 'totals'
}) {
  const state = useStore(pointSession.store)
  const [correction, setCorrection] = useState<{ card: PointCard; activityId: string } | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [preparation, setPreparation] = useState<{
    revision: number
    members: Participant[]
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [preparing, setPreparing] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [historyKind, setHistoryKind] = useState<'results' | 'changes'>('results')
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const hidden = useRef(false)
  function stopTimer() {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }
  function startTimer() {
    stopTimer()
    if (!hidden.current && tab !== 'history')
      timer.current = setInterval(() => {
        void pointSession.refresh()
      }, 4000)
  }
  useEffect(() => {
    alive.current = true
    let listening = true
    void pointSession.open(room.roomId, meId)
    const network = createPointNetworkHandler({
      isAlive: () => listening && alive.current,
      isVisible: () => !hidden.current,
      setOnline: (online) => pointSession.setOnline(online),
      refresh: () => pointSession.refresh(),
    })
    Taro.onNetworkStatusChange(network)
    void Taro.getNetworkType()
      .then(({ networkType }) => {
        if (listening && alive.current) pointSession.setOnline(networkType !== 'none')
      })
      .catch(() => {})
    return () => {
      listening = false
      alive.current = false
      stopTimer()
      Taro.offNetworkStatusChange(network)
      pointSession.leave()
    }
  }, [room.roomId, meId])
  useEffect(() => {
    startTimer()
    if (tab === 'history') void pointSession.refresh()
    return stopTimer
  }, [tab])
  useDidHide(() => {
    hidden.current = true
    stopTimer()
  })
  useDidShow(() => {
    hidden.current = false
    startTimer()
    void pointSession.refresh()
  })
  const snapshot = state.roomId === room.roomId ? state.snapshot : null
  const activity = snapshot?.activity
  const participating = !!activity?.participants.some((p) => p.userId === meId)
  const unknown = state.requests.some((r) => r.phase === 'unknown')
  const exclusive = state.requests.some(
    (r) => r.command.kind === 'prepare' || r.command.kind === 'post',
  )
  const locked =
    state.loading || !state.online || unknown || exclusive || activity?.status === 'posted'
  const exclusivePending = state.requests.some(
    (r) => r.phase === 'pending' && (r.command.kind === 'prepare' || r.command.kind === 'post'),
  )
  const cardInFlight = (number: number) =>
    state.requests.some(
      (r) =>
        r.phase === 'pending' &&
        r.roomId === room.roomId &&
        'number' in r.command &&
        r.command.number === number,
    )
  const displayParticipants = [...(activity?.participants ?? [])].sort(
    (a, b) => Number(b.userId === meId) - Number(a.userId === meId),
  )
  const pendingCard = (number: number) =>
    state.requests.some(
      (r) => r.roomId === room.roomId && 'number' in r.command && r.command.number === number,
    )
  const owned = activity?.cards.filter((c) => c.ownerUserId !== null).length ?? 0
  const totalPoints = Object.values(activity?.earnedPoints ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  )
  const name = (id: string | null) =>
    id === null
      ? '公共区'
      : id === meId
        ? '我'
        : (activity?.participants.find((p) => p.userId === id)?.displayName ??
          room.members.find((p) => p.userId === id)?.displayName ??
          '房间成员')
  async function openPreparation() {
    setPreparing(true)
    setLocalError(null)
    try {
      await pointSession.refresh()
      const freshRoom = await roomApi.getRoomSnapshot(room.roomId)
      if (!alive.current) return
      const current = pointSession.store.getState().snapshot
      if (!current || current.activity?.status === 'open') {
        setLocalError('已有进行中的打分或状态尚未恢复，请刷新查看')
        return
      }
      setSelectedIds(
        freshRoom.members.length === 2 || freshRoom.members.length === 3
          ? freshRoom.members.map((m) => m.userId)
          : [meId],
      )
      setPreparation({ revision: current.roomRevision, members: freshRoom.members })
    } catch (error) {
      if (alive.current) setLocalError(errorMessage(error))
    } finally {
      if (alive.current) setPreparing(false)
    }
  }
  async function prepare() {
    if (!preparation) return
    const success = await pointSession.submit({
      kind: 'prepare',
      expectedRoomRevision: preparation.revision,
      participantIds: selectedIds,
    })
    if (success && alive.current) setPreparation(null)
  }
  async function cardClick(card: PointCard) {
    if (!activity || !pointSession.beginCardInteraction(activity.activityId, card.number)) return
    if (card.ownerUserId === null)
      await pointSession.submit({
        kind: 'claim',
        activityId: activity.activityId,
        number: card.number,
        expectedCardRevision: card.revision,
      })
    else {
      setCorrection({ card: { ...card }, activityId: activity.activityId })
      setTarget(null)
      setLocalError(null)
    }
  }
  async function correct() {
    if (!correction || !activity) return
    if (
      await pointSession.submit({
        kind: 'correct',
        activityId: correction.activityId,
        number: correction.card.number,
        expectedCardRevision: correction.card.revision,
        ownerUserId: target,
      })
    )
      setCorrection(null)
  }
  const correctionLatest =
    correction && activity?.cards.find((c) => c.number === correction.card.number)
  const staleCorrection =
    !!correction &&
    (!activity ||
      activity.activityId !== correction.activityId ||
      correctionLatest?.revision !== correction.card.revision ||
      activity.status === 'posted')
  return (
    <View className="point-feature">
      {!state.online && (
        <Notice danger>网络已断开，暂停保存；恢复网络后重新读取。未确认操作不会自动重发。</Notice>
      )}
      {state.loading && <StatePanel title="正在恢复打分…" />}
      {(state.error || localError) && <Notice danger>{state.error ?? localError}</Notice>}
      {unknown ? (
        <ActionButton
          secondary
          compact
          disabled={!state.online || state.requests.some((r) => r.phase === 'pending')}
          onClick={() => {
            void pointSession.recover()
          }}
        >
          确认待处理操作
        </ActionButton>
      ) : (
        (state.error || localError) && (
          <ActionButton
            secondary
            compact
            onClick={() => {
              setLocalError(null)
              void pointSession.open(room.roomId, meId)
            }}
          >
            刷新打分
          </ActionButton>
        )
      )}
      {snapshot && !activity && tab === 'score' && (
        <View className="panel preparation">
          <Text className="section-title">准备本场打分</Text>
          <Text className="muted">
            确认2～3名参与者后开始。15张公共牌合计120分，两人各60分，三人各40分。
          </Text>
          <ActionButton
            disabled={state.loading || !state.online || unknown || exclusive || preparing}
            onClick={() => {
              void openPreparation()
            }}
          >
            {preparing ? '正在读取名单…' : '确认参与名单'}
          </ActionButton>
          <ActionButton secondary openType="share">
            邀请朋友加入
          </ActionButton>
          <Text className="caption muted">支持2～3人；本场名单固定，新成员下一场参与。</Text>
        </View>
      )}
      {activity && tab === 'score' && (
        <>
          <View
            className={`point-scores ${activity.participants.length === 2 ? 'point-scores--two' : ''}`}
          >
            {displayParticipants.map((p) => (
              <View
                className={`point-score ${p.userId === meId ? 'point-score--mine' : ''}`}
                key={p.userId}
              >
                <Text className="point-player-name">
                  {p.userId === meId ? '我' : p.displayName}
                </Text>
                <View>
                  <Text className="point-earned">{activity.earnedPoints[p.userId]}</Text>
                  <Text className="caption"> 分</Text>
                </View>
              </View>
            ))}
          </View>
          <Text className="point-description caption muted">
            当前进球分 · 每人基准{120 / activity.participants.length}分
          </Text>
          {!participating && (
            <Notice>你未参加本场，可以查看和修正已有归属，不能认领给自己或保存结果。</Notice>
          )}
          <View className="point-progress-text">
            <Text>已记录 {owned}/15张</Text>
            <Text>进球总分 {totalPoints}/120</Text>
          </View>
          <View className="point-progress">
            <View className="point-progress-fill" style={{ width: `${(owned / 15) * 100}%` }} />
          </View>
          <View className="point-public-grid">
            {activity.cards.map((card) => (
              <PublicCard
                key={card.number}
                card={card}
                ownerName={card.ownerUserId === null ? null : name(card.ownerUserId)}
                mine={card.ownerUserId === meId}
                busy={pendingCard(card.number)}
                unknown={state.requests.some(
                  (r) =>
                    r.phase === 'unknown' &&
                    r.roomId === room.roomId &&
                    'number' in r.command &&
                    r.command.number === card.number,
                )}
                disabled={!!locked || (!participating && card.ownerUserId === null)}
                onClick={() => {
                  void cardClick(card)
                }}
              />
            ))}
          </View>
          <Text className="point-helper">点未选牌记给自己；点已选牌可退回或改归属。</Text>
          {activity.status === 'open' && (
            <>
              {owned === 15 && (
                <View className="panel point-preview">
                  <Text className="section-title">本次结果预览</Text>
                  <Text className="point-description caption muted">尚未计入累计</Text>
                  {activity.participants.map((p) => (
                    <View className="point-result-row" key={p.userId}>
                      <Text>{p.displayName}</Text>
                      <Text className="point-net">
                        {signed(
                          (activity.earnedPoints[p.userId] ?? 0) -
                            120 / activity.participants.length,
                        )}{' '}
                        分
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              <ActionButton
                disabled={
                  !!locked ||
                  !participating ||
                  owned !== 15 ||
                  totalPoints !== 120 ||
                  state.requests.length > 0
                }
                onClick={() => {
                  void pointSession.submit({
                    kind: 'post',
                    activityId: activity.activityId,
                    expectedActivityRevision: activity.revision,
                  })
                }}
              >
                {exclusive ? '保存中…' : '保存本次结果'}
              </ActionButton>
              <Text className="point-helper">
                {owned < 15
                  ? `还有${15 - owned}张未记录，当前进球分不会计入累计。`
                  : '确认完整结果后保存，已保存结果不支持修改。'}
              </Text>
            </>
          )}
          {activity.result && (
            <>
              <ResultCard result={activity.result} />
              <ActionButton
                disabled={!state.online || unknown || state.requests.length > 0 || preparing}
                onClick={() => {
                  void openPreparation()
                }}
              >
                {preparing ? '正在读取名单…' : '再来一次'}
              </ActionButton>
            </>
          )}
        </>
      )}
      {snapshot && tab === 'history' && (
        <>
          <View className="point-history-tabs">
            <BaseButton
              className={`point-history-tab ${historyKind === 'results' ? 'point-history-tab--selected' : ''}`}
              onClick={() => setHistoryKind('results')}
            >
              完整结果
            </BaseButton>
            <BaseButton
              className={`point-history-tab ${historyKind === 'changes' ? 'point-history-tab--selected' : ''}`}
              onClick={() => setHistoryKind('changes')}
            >
              本场修改记录
            </BaseButton>
          </View>
          {historyKind === 'results' ? (
            <>
              {snapshot.results.length ? (
                snapshot.results.map((result) => (
                  <ResultCard key={result.activityId} result={result} />
                ))
              ) : (
                <StatePanel
                  title="还没有完整结果"
                  description="号码牌过程持续保存；完整结果经主动保存后才计入累计。"
                />
              )}
              {snapshot.nextResultCursor && (
                <ActionButton
                  secondary
                  disabled={state.loadingMore}
                  onClick={() => {
                    void pointSession.loadMore('results')
                  }}
                >
                  {state.loadingMore ? '读取中…' : '加载更多结果'}
                </ActionButton>
              )}
            </>
          ) : (
            <>
              {activity?.changes.length ? (
                activity.changes.map((change) => (
                  <View className="point-change panel" key={change.requestId}>
                    <Text className="point-block">
                      {change.number}号 · {name(change.fromUserId)} → {name(change.toUserId)}
                    </Text>
                    <Text className="caption muted">
                      {change.actorName} · {time(change.createdAt)}
                    </Text>
                  </View>
                ))
              ) : (
                <StatePanel title="本场还没有修改记录" />
              )}
              {snapshot.nextChangeCursor && (
                <ActionButton
                  secondary
                  disabled={state.loadingMore}
                  onClick={() => {
                    void pointSession.loadMore('changes')
                  }}
                >
                  {state.loadingMore ? '读取中…' : '加载更多修改记录'}
                </ActionButton>
              )}
            </>
          )}
        </>
      )}
      {snapshot && tab === 'totals' && (
        <View className="panel">
          <Text className="section-title">本房间打分累计</Text>
          <Text className="point-description caption muted">仅包含已保存完整结果</Text>
          {Object.entries(snapshot.totals).map(([id, total]) => (
            <View className="point-result-row" key={id}>
              <Text>{name(id)}</Text>
              <Text className="point-net">{signed(total)} 分</Text>
            </View>
          ))}
          {Object.keys(snapshot.totals).length === 0 && (
            <Text className="muted">还没有已保存成绩。</Text>
          )}
        </View>
      )}
      {preparation && (
        <BottomSheet
          title="确认2～3名参与者"
          busy={exclusivePending}
          onClose={() => setPreparation(null)}
        >
          <Text className="point-description muted">
            {selectedIds.length >= 2
              ? `已选${selectedIds.length}人，每人基准${120 / selectedIds.length}分。`
              : '请选择2～3人，两人各60分，三人各40分。'}
            本场开始后名单固定。
          </Text>
          {preparation.members.map((p) => (
            <BaseButton
              key={p.userId}
              disabled={
                exclusive ||
                unknown ||
                p.userId === meId ||
                (!selectedIds.includes(p.userId) && selectedIds.length >= 3)
              }
              className={`point-person ${selectedIds.includes(p.userId) ? 'point-person--selected' : ''}`}
              onClick={() =>
                setSelectedIds((ids) =>
                  ids.includes(p.userId) ? ids.filter((id) => id !== p.userId) : [...ids, p.userId],
                )
              }
            >
              <Text>{p.userId === meId ? '我' : p.displayName}</Text>
              <Text>{selectedIds.includes(p.userId) ? '已选' : '选择'}</Text>
            </BaseButton>
          ))}
          {state.error && (
            <Notice danger>
              {state.error}
              {unknown ? '请关闭面板，先确认原操作。' : '请关闭面板重新确认名单。'}
            </Notice>
          )}
          <ActionButton
            disabled={
              !state.online ||
              exclusive ||
              unknown ||
              (selectedIds.length !== 2 && selectedIds.length !== 3)
            }
            onClick={() => {
              void prepare()
            }}
          >
            开始本场打分（已选{selectedIds.length}人）
          </ActionButton>
        </BottomSheet>
      )}
      {correction && (
        <BottomSheet
          title={`${correction.card.number}号 · 修改归属`}
          busy={cardInFlight(correction.card.number)}
          onClose={() => setCorrection(null)}
        >
          <Text className="point-description muted">
            当前归{name(correctionLatest?.ownerUserId ?? null)} · 最近由
            {name(correctionLatest?.lastModifiedBy ?? null)}修改
          </Text>
          {staleCorrection && <Notice danger>这张牌或本场状态已变化，请关闭面板重新选择。</Notice>}
          <BaseButton
            className={`point-person ${target === null ? 'point-person--selected' : ''}`}
            disabled={!!locked || staleCorrection}
            onClick={() => setTarget(null)}
          >
            <Text>退回公共区</Text>
            <Text>{target === null ? '✓' : ''}</Text>
          </BaseButton>
          {activity?.participants.map((p) => (
            <BaseButton
              className={`point-person ${target === p.userId ? 'point-person--selected' : ''}`}
              disabled={!!locked || staleCorrection || p.userId === correctionLatest?.ownerUserId}
              key={p.userId}
              onClick={() => setTarget(p.userId)}
            >
              <Text>改归{p.userId === meId ? '我' : p.displayName}</Text>
              <Text>{target === p.userId ? '✓' : ''}</Text>
            </BaseButton>
          ))}
          {state.error && <Notice danger>{state.error}</Notice>}
          {unknown && (
            <Notice>
              可关闭面板，或在此确认原操作。
              <ActionButton
                secondary
                compact
                disabled={!state.online || cardInFlight(correction.card.number)}
                onClick={() => {
                  void pointSession.recover()
                }}
              >
                确认待处理操作
              </ActionButton>
            </Notice>
          )}
          <ActionButton
            disabled={
              !!locked ||
              staleCorrection ||
              pendingCard(correction.card.number) ||
              target === correctionLatest?.ownerUserId
            }
            onClick={() => {
              void correct()
            }}
          >
            {pendingCard(correction.card.number) ? '保存中…' : '确认修改'}
          </ActionButton>
        </BottomSheet>
      )}
    </View>
  )
}
