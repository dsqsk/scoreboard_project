import { ProfileGate } from '../../features/profile/ProfileGate'
import { useEffect, useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import { stores, isMock } from '../../runtime'
import { ActionButton, Notice, StatePanel } from '../../components/ui'
import { BasePicker } from '../../features/poker/BasePicker'
import type { BaseSelection } from '../../features/poker/BasePicker'
import {
  isPoker,
  isPresetBase,
  pokerCreateValue,
  requiredPlayers,
} from '../../features/poker/model'
import { MODE_LABELS } from '../../modules/room-api/types'
function CreatePokerContent() {
  const mode = useRouter().params.mode ?? ''
  const mutation = useStore(stores.mutation)
  const [base, setBase] = useState<BaseSelection>(null)
  const [custom, setCustom] = useState('')
  const [checking, setChecking] = useState(true)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  useEffect(() => {
    setChecking(true)
    void stores.restorePending().finally(() => setChecking(false))
  }, [])
  useDidShow(() => {
    setChecking(true)
    void stores.restorePending().finally(() => setChecking(false))
  })
  const busy = mutation.phase === 'pending'
  const unknown = mutation.phase === 'unknown'
  const valid = typeof base === 'number' && isPresetBase(base)
  async function create() {
    if (!isPoker(mode)) return
    const original = mutation.command?.signature
    if (unknown && !original?.startsWith('create:')) return
    const value = unknown
      ? original!.slice('create:'.length)
      : valid
        ? pokerCreateValue(mode, base as number)
        : null
    if (!value) return
    const roomId = await stores.submit('create', value)
    if (!roomId) return
    void stores.loadRecent()
    try {
      await Taro.redirectTo({ url: `/pages/room/index?roomId=${encodeURIComponent(roomId)}` })
    } catch {
      setNavigationError('房间已创建，请回到首页，从最近房间进入。')
    }
  }
  if (!isPoker(mode))
    return (
      <View className="page">
        <StatePanel title="请选择扑克玩法" />
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
    <View className="page poker-create-page">
      <View>
        <Text className="page-title">创建房间</Text>
        <Text className="poker-create-subtitle muted caption">选择玩法后确认底分倍数</Text>
        {isMock && <Text className="poker-create-mock caption muted">本地演示 · 未连接后端</Text>}
        <View className="poker-create-mode panel">
          <Text className="section-title">扑克 / {MODE_LABELS[mode]}</Text>
          <Text className="caption muted">{requiredPlayers(mode)}人 · 每人只记录自己的得失分</Text>
        </View>
        <BasePicker
          allowCustom={mode !== 'da_a'}
          value={base}
          custom={custom}
          onChange={setBase}
          onCustom={setCustom}
          disabled={busy || unknown || checking || mutation.phase === 'success'}
        />
        {mutation.error && <Notice danger>{mutation.error}</Notice>}
        {navigationError && <Notice danger>{navigationError}</Notice>}
        {unknown && !mutation.command?.signature.startsWith('create:') && (
          <Notice>请回到首页确认上次加入请求，再创建房间。</Notice>
        )}
      </View>
      <View className="poker-create-actions">
        <ActionButton
          disabled={
            checking ||
            busy ||
            mutation.phase === 'success' ||
            (unknown ? !mutation.command?.signature.startsWith('create:') : !valid)
          }
          onClick={() => {
            void create()
          }}
        >
          {busy ? '创建中…' : unknown ? '确认上次创建请求' : '创建房间'}
        </ActionButton>
        <ActionButton
          secondary
          disabled={busy || unknown}
          onClick={() => {
            stores.resetMutation()
            void Taro.reLaunch({ url: '/pages/index/index' })
          }}
        >
          取消
        </ActionButton>
      </View>
    </View>
  )
}

export default function CreatePoker() {
  return (
    <ProfileGate>
      <CreatePokerContent />
    </ProfileGate>
  )
}
