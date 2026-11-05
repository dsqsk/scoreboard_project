import { ProfileGate } from '../../features/profile/ProfileGate'
import { useEffect, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter, useUnload } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import type { RoomPreview } from '../../modules/room-api/types'
import { MODE_LABELS } from '../../modules/room-api/types'
import { ActionButton, Notice, StatePanel } from '../../components/ui'
import { errorMessage } from '../../modules/room-api/errors'
import { isMock, roomApi, stores } from '../../runtime'

function JoinContent() {
  const router = useRouter()
  const code = (router.params.code ?? '').trim()
  const [preview, setPreview] = useState<RoomPreview | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const alive = useRef(true)
  const mutation = useStore(stores.mutation)
  const busy = mutation.phase === 'pending'
  const blocked = mutation.phase === 'unknown' && mutation.command?.signature !== `join:${code}`
  async function load() {
    const current = ++generation.current
    setStatus('loading')
    setError(null)
    if (!/^\d{6}$/.test(code)) {
      setError('房间码格式不正确，请返回重新输入')
      setStatus('error')
      return
    }
    try {
      await stores.ensureIdentity()
      const next = await roomApi.previewRoom(code)
      if (alive.current && current === generation.current) {
        setPreview(next)
        setStatus('ready')
      }
    } catch (reason) {
      if (alive.current && current === generation.current) {
        setError(errorMessage(reason))
        setStatus('error')
      }
    }
  }
  useEffect(() => {
    alive.current = true
    void stores.restorePending()
    void load()
  }, [code])
  useDidShow(() => {
    alive.current = true
    void stores.restorePending()
    void load()
  })
  useUnload(() => {
    alive.current = false
    generation.current++
  })
  async function join() {
    const roomId = await stores.submit('join', code)
    if (roomId && alive.current) {
      try {
        await Taro.redirectTo({ url: `/pages/room/index?roomId=${encodeURIComponent(roomId)}` })
      } catch {
        setError('加入成功，页面打开失败，请再次点击进入')
      }
    }
  }
  return (
    <View className="page join-page">
      <Text className="eyebrow">加入朋友的房间</Text>
      <Text className="page-title">确认房间</Text>
      {isMock && <Notice>本地演示，成员与房间只保存在当前设备。</Notice>}
      {status === 'loading' && <StatePanel title="正在查找房间…" />}
      {status === 'error' && (
        <StatePanel
          title="暂时无法打开房间"
          description={error ?? ''}
          retry={() => {
            void load()
          }}
        />
      )}
      {status === 'ready' && preview && (
        <View className="panel join-summary">
          <View className="room-badge">{preview.joinCode.slice(-2)}</View>
          <Text className="room-card__title">{preview.name}</Text>
          <Text className="muted">房间码 {preview.joinCode}</Text>
          <View className="join-summary__mode">{MODE_LABELS[preview.selectedMode]}</View>
          <Text className="muted">{preview.memberCount}位朋友已在房间</Text>
          <Text className="caption muted">加入后都是参赛者，不需要重新选择玩法。</Text>
          {preview.status === 'closed' && <Notice danger>这个房间已关闭</Notice>}
          {mutation.error && <Notice danger>{mutation.error}</Notice>}
          {error && <Notice danger>{error}</Notice>}
          {blocked && <Notice danger>你还有其他待确认请求，请先回首页确认。</Notice>}
          <ActionButton
            loading={busy}
            disabled={blocked || preview.status !== 'active'}
            onClick={() => {
              void join()
            }}
          >
            {mutation.phase === 'unknown' ? '确认原加入请求' : '加入房间'}
          </ActionButton>
        </View>
      )}
      <ActionButton
        secondary
        onClick={() => {
          void Taro.reLaunch({ url: '/pages/index/index' })
        }}
      >
        回到首页
      </ActionButton>
    </View>
  )
}

export default function Join() {
  return (
    <ProfileGate>
      <JoinContent />
    </ProfileGate>
  )
}
