import { useEffect, useState } from 'react'
import { Image, Input, Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import type { RoomSnapshot } from '../../modules/room-api/types'
import { BaseButton, ActionButton, BottomSheet, Notice, StatePanel } from '../../components/ui'
import { killSession } from './runtime'
import { cardImages } from '../cards/images'
import type { KillSnapshot } from './api'
import './kill.css'

function savedTime(value: string) {
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function signed(value: number) {
  return value > 0 ? `+${value}` : `${value}`
}
function ResultSummary({ snapshot }: { snapshot: KillSnapshot }) {
  return (
    <View className="panel kill-result">
      <Text className="kill-result-title section-title">杀球结果 · 已保存</Text>
      <Text className="kill-result-date caption muted">
        {snapshot.result ? savedTime(snapshot.result.savedAt) : ''}
      </Text>
      {snapshot.participants.map((p) => (
        <View className="kill-result-row" key={p.userId}>
          <Text>
            {p.displayName}
            {snapshot.result?.winnerId === p.userId ? ' · 赢家' : ''}
          </Text>
          <Text className="kill-result-score">
            {signed(snapshot.result?.scores[p.userId] ?? 0)} 颗
          </Text>
        </View>
      ))}
    </View>
  )
}
export function KillFeature({
  room,
  meId,
  tab,
}: {
  room: RoomSnapshot
  meId: string
  tab: 'score' | 'history' | 'totals'
}) {
  const state = useStore(killSession.store)
  const [participants, setParticipants] = useState<string[]>([])
  const [sheet, setSheet] = useState<'transfer' | 'result' | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [winner, setWinner] = useState('')
  const [counts, setCounts] = useState<Record<string, string>>({})
  useEffect(() => {
    void killSession.open(room.roomId)
    return () => killSession.leave()
  }, [room.roomId, room.revision])
  useEffect(() => {
    setParticipants(room.members.length === 3 ? room.members.map((m) => m.userId) : [meId])
  }, [room.roomId, room.revision, meId])
  const snapshot = state.roomId === room.roomId ? state.snapshot : null
  const locked = state.busy || !!state.pending || state.loading || !!snapshot?.result
  const playing = snapshot?.participants.some((p) => p.userId === meId) ?? false
  async function transfer() {
    if (!snapshot || selected === null) return
    if (
      await killSession.submit(room.roomId, {
        kind: 'transfer',
        number: selected,
        revision: snapshot.revision,
      })
    )
      setSheet(null)
  }
  function openResult() {
    if (!snapshot) return
    setWinner('')
    setCounts(
      Object.fromEntries(
        snapshot.participants.map((p) => [p.userId, `${snapshot.remaining[p.userId] ?? 0}`]),
      ),
    )
    setSheet('result')
  }
  const validResult =
    !!winner &&
    !!snapshot &&
    snapshot.participants
      .filter((p) => p.userId !== winner)
      .every((p) => /^\d+$/.test(counts[p.userId] ?? '') && Number(counts[p.userId]) <= 15)
  async function save() {
    if (!snapshot || !validResult) return
    if (
      await killSession.submit(room.roomId, {
        kind: 'save',
        winnerId: winner,
        remaining: Object.fromEntries(
          Object.entries(counts).map(([id, value]) => [id, Number(value)]),
        ),
        revision: snapshot.revision,
      })
    )
      setSheet(null)
  }
  return (
    <View className="kill-feature">
      {state.loading && <StatePanel title="正在恢复杀球牌局…" />}
      {state.error && (
        <Notice danger>
          {state.error}
          {state.pending ? (
            <ActionButton
              secondary
              compact
              disabled={state.busy}
              onClick={() => {
                void killSession.submit(room.roomId)
              }}
            >
              重试原操作
            </ActionButton>
          ) : (
            <ActionButton
              secondary
              compact
              disabled={state.busy}
              onClick={() => {
                void killSession.open(room.roomId)
              }}
            >
              刷新房间
            </ActionButton>
          )}
        </Notice>
      )}
      {!state.loading && !state.error && !snapshot && tab === 'score' && (
        <View className="panel preparation">
          <Text className="section-title">确认参与名单</Text>
          <Text className="muted">三人各分5张号码牌，发牌后名单固定。请与朋友确认后开始。</Text>
          {room.members.map((member) => (
            <BaseButton
              key={member.userId}
              className={`kill-person ${participants.includes(member.userId) ? 'kill-person--selected' : ''}`}
              disabled={locked || member.userId === meId}
              onClick={() =>
                setParticipants((ids) =>
                  ids.includes(member.userId)
                    ? ids.filter((id) => id !== member.userId)
                    : [...ids, member.userId],
                )
              }
            >
              <Text>
                {member.displayName}
                {member.userId === meId ? '（我）' : ''}
              </Text>
              <Text>{participants.includes(member.userId) ? '已选' : '选择'}</Text>
            </BaseButton>
          ))}
          <ActionButton
            disabled={locked || participants.length !== 3}
            loading={state.busy}
            onClick={() => {
              void killSession.submit(room.roomId, { kind: 'deal', participantIds: participants })
            }}
          >
            确认名单并发牌（{participants.length}/3）
          </ActionButton>
          <Text className="caption muted">
            四人少牌者与新一轮规则待确定，本次暂不开放。未满三人请先邀请朋友入房。
          </Text>
        </View>
      )}
      {snapshot && tab === 'score' && (
        <>
          <View className="kill-opponents">
            {snapshot.participants
              .filter((p) => p.userId !== meId)
              .map((p, index) => (
                <View className="kill-opponent" key={p.userId}>
                  <View className={`kill-avatar ${index % 2 ? 'kill-avatar--blue' : ''}`}>
                    {p.displayName.slice(0, 1)}
                  </View>
                  <View className="kill-opponent-copy">
                    <Text className="kill-opponent-name">{p.displayName}</Text>
                    <Text className="kill-opponent-remaining caption muted">
                      剩余 <Text className="kill-count">{snapshot.remaining[p.userId]}</Text> 颗
                    </Text>
                  </View>
                </View>
              ))}
          </View>
          {playing ? (
            <>
              <View className="kill-hand-title">
                <Text className="section-title">我的号码牌</Text>
                <Text className="muted">剩余 {snapshot.remaining[meId]} 颗</Text>
              </View>
              <View className="kill-hand">
                {snapshot.ownBalls.map((ball) => (
                  <View className="kill-card-wrap" key={ball.number}>
                    {ball.potted && (
                      <BaseButton
                        disabled={locked}
                        className="kill-undo"
                        onClick={() => {
                          void killSession.submit(room.roomId, {
                            kind: 'pot',
                            number: ball.number,
                            potted: false,
                            revision: snapshot.revision,
                          })
                        }}
                      >
                        <Text className="kill-undo-label">↶ 撤销</Text>
                      </BaseButton>
                    )}
                    <BaseButton
                      ariaLabel={`${ball.number}号${ball.potted ? '已进' : '，记录进球'}`}
                      disabled={locked}
                      className={`kill-card ${ball.potted ? 'kill-card--potted' : ''}`}
                      onClick={() => {
                        if (!ball.potted)
                          void killSession.submit(room.roomId, {
                            kind: 'pot',
                            number: ball.number,
                            potted: true,
                            revision: snapshot.revision,
                          })
                      }}
                    >
                      <Image
                        className="kill-card-image"
                        src={cardImages[ball.number]!}
                        mode="aspectFit"
                      />
                      {ball.potted && <Text className="kill-potted-label">已进</Text>}
                    </BaseButton>
                  </View>
                ))}
                <BaseButton
                  disabled={locked}
                  className="kill-add-card"
                  onClick={() => {
                    setSelected(null)
                    setSheet('transfer')
                  }}
                >
                  <Text className="kill-plus">＋</Text>
                  <Text className="caption">添加惩罚球</Text>
                </BaseButton>
              </View>
              <Text className="kill-helper">
                点号码牌记录进球，已进牌上方可单独撤销。
                {snapshot.result ? '本次结果已保存，号码牌只读。' : '惩罚转入请先在线下确认。'}
              </Text>
              {!snapshot.result && (
                <ActionButton disabled={locked} onClick={openResult}>
                  记录本次结果
                </ActionButton>
              )}
            </>
          ) : (
            <Notice>你未参加本次牌局，不能操作号码牌；下一轮入口待确定。</Notice>
          )}
          {snapshot.result && <ResultSummary snapshot={snapshot} />}
        </>
      )}
      {tab === 'history' &&
        !state.loading &&
        (snapshot?.result ? (
          <ResultSummary snapshot={snapshot} />
        ) : (
          <StatePanel title="还没有杀球记录" description="确认并保存完整结果后显示。" />
        ))}
      {tab === 'totals' &&
        !state.loading &&
        (snapshot?.result ? (
          <View className="panel">
            <Text className="section-title">本房间杀球累计</Text>
            {snapshot.participants.map((p) => (
              <View className="kill-result-row" key={p.userId}>
                <Text>{p.displayName}</Text>
                <Text className="kill-result-score">
                  {signed(snapshot.result!.scores[p.userId] ?? 0)} 颗
                </Text>
              </View>
            ))}
            <Text className="caption muted">当前已保存1次结果；新一轮入口待确定。</Text>
          </View>
        ) : (
          <StatePanel title="还没有杀球累计" description="已保存的杀球结果按颗累计。" />
        ))}
      {sheet === 'transfer' && snapshot && (
        <BottomSheet title="添加惩罚球" busy={state.busy} onClose={() => setSheet(null)}>
          <Text className="sheet-description muted">
            选择要转入的号码，确认后归你并恢复为未进。自己的号码不可选。
          </Text>
          {state.error && (
            <Notice danger>
              {state.error}
              {state.pending && (
                <ActionButton
                  secondary
                  compact
                  disabled={state.busy}
                  onClick={() => {
                    void killSession.submit(room.roomId)
                  }}
                >
                  重试原操作
                </ActionButton>
              )}
            </Notice>
          )}
          <View className="kill-picker">
            {Array.from({ length: 15 }, (_, i) => i + 1).map((number) => (
              <BaseButton
                key={number}
                disabled={locked || snapshot.ownBalls.some((b) => b.number === number)}
                className={`kill-pick ${selected === number ? 'kill-pick--selected' : ''}`}
                onClick={() => setSelected(number)}
              >
                {number}
                {number === 14 ? ' 红Joker' : number === 15 ? ' 黑Joker' : ''}
              </BaseButton>
            ))}
          </View>
          <ActionButton
            disabled={locked || selected === null}
            loading={state.busy}
            onClick={() => {
              void transfer()
            }}
          >
            确认转入{selected === null ? '' : ` ${selected} 号`}
          </ActionButton>
        </BottomSheet>
      )}
      {sheet === 'result' && snapshot && (
        <BottomSheet title="记录本次结果" busy={state.busy} onClose={() => setSheet(null)}>
          <Text className="sheet-description muted">
            选择赢家，再核对输家的剩余球数。赢家得分为其余负分之和。
          </Text>
          {state.error && (
            <Notice danger>
              {state.error}
              {state.pending && (
                <ActionButton
                  secondary
                  compact
                  disabled={state.busy}
                  onClick={() => {
                    void killSession.submit(room.roomId)
                  }}
                >
                  重试原操作
                </ActionButton>
              )}
            </Notice>
          )}
          {snapshot.participants.map((p) => (
            <BaseButton
              key={p.userId}
              disabled={locked}
              className={`kill-person ${winner === p.userId ? 'kill-person--selected' : ''}`}
              onClick={() => setWinner(p.userId)}
            >
              <Text>{p.displayName}</Text>
              <Text>{winner === p.userId ? '赢家 ✓' : '设为赢家'}</Text>
            </BaseButton>
          ))}
          {winner &&
            snapshot.participants
              .filter((p) => p.userId !== winner)
              .map((p) => (
                <View className="kill-form-row" key={p.userId}>
                  <Text>{p.displayName} 剩余颗数</Text>
                  <Input
                    disabled={locked}
                    className="kill-count-input"
                    type="number"
                    maxlength={2}
                    value={counts[p.userId] ?? ''}
                    onInput={(event) =>
                      setCounts((values) => ({ ...values, [p.userId]: event.detail.value }))
                    }
                  />
                </View>
              ))}
          {validResult && (
            <Notice>
              赢家 +
              {snapshot.participants
                .filter((p) => p.userId !== winner)
                .reduce((sum, p) => sum + Number(counts[p.userId]), 0)}{' '}
              颗，合计差额 0 颗。
            </Notice>
          )}
          <ActionButton
            disabled={locked || !validResult}
            loading={state.busy}
            onClick={() => {
              void save()
            }}
          >
            确认并保存结果
          </ActionButton>
          <Text className="kill-helper">保存后本次牌局只读，不自动重新发牌。</Text>
        </BottomSheet>
      )}
    </View>
  )
}
