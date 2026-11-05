import { RecentRooms } from '../../features/recent/RecentRooms'
import { ProfileGate } from '../../features/profile/ProfileGate'
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import Taro, { useDidShow } from '@tarojs/taro'
import { Image, Input, Text, View } from '@tarojs/components'
import type { GameMode } from '@scoreboard/shared'
import { MODE_LABELS } from '../../modules/room-api/types'
import { BaseButton, ActionButton, BottomSheet, Notice, StatePanel } from '../../components/ui'
import { isPoker } from '../../features/poker/model'
import { ModePicker } from '../../features/room/ModePicker'
import { MODES } from '../../features/room/modes'
import { isMock, stores } from '../../runtime'
import heroAce from '../../assets/cards/card-01.svg'
import heroFive from '../../assets/cards/card-05.svg'

function HomeContent() {
  const recent = useStore(stores.recent)
  const mutation = useStore(stores.mutation)
  const [openedRecent, setOpenedRecent] = useState<string | null>(null)
  const [checkingRecovery, setCheckingRecovery] = useState(true)
  const [sheet, setSheet] = useState<'create' | 'join' | 'recent' | null>(null)
  const [mode, setMode] = useState<GameMode | null>(null)
  const [code, setCode] = useState('')
  const [navError, setNavError] = useState<string | null>(null)
  function restoreHome() {
    void stores.loadRecent()
    setCheckingRecovery(true)
    void stores.restorePending().finally(() => setCheckingRecovery(false))
  }
  useEffect(restoreHome, [])
  useDidShow(restoreHome)
  const recentBlocked = recent.phase === 'pending' || recent.phase === 'unknown'
  const busy = mutation.phase === 'pending' || recent.phase === 'pending'
  const unresolved = mutation.phase === 'unknown'
  async function navigate(roomId: string) {
    try {
      await Taro.navigateTo({ url: `/pages/room/index?roomId=${encodeURIComponent(roomId)}` })
    } catch {
      setNavError('房间已保存，但页面打开失败，请点击最近房间继续')
    }
  }
  function openCreate(initialMode: GameMode | null = null) {
    if (!stores.resetMutation()) return
    setNavError(null)
    if (initialMode && isPoker(initialMode)) {
      void Taro.navigateTo({ url: `/pages/create-poker/index?mode=${initialMode}` }).catch(() =>
        setNavError('页面打开失败，请重试'),
      )
      return
    }
    setMode(initialMode)
    setSheet('create')
  }
  function closeSheet() {
    if (busy || unresolved) return
    setSheet(null)
    stores.resetMutation()
  }
  async function create() {
    if (!mode) return
    if (isPoker(mode)) {
      try {
        await Taro.navigateTo({ url: `/pages/create-poker/index?mode=${mode}` })
        setSheet(null)
      } catch {
        setNavError('页面打开失败，请重试')
      }
      return
    }
    const roomId = await stores.submit('create', mode)
    if (roomId) {
      setSheet(null)
      void stores.loadRecent()
      await navigate(roomId)
    }
  }
  async function recover() {
    const command = stores.mutation.getState().command
    if (!command) return
    const [kind, value] = command.signature.split(':')
    if (kind !== 'create' && kind !== 'join') return
    const roomId = await stores.submit(kind, value)
    if (roomId) {
      setSheet(null)
      void stores.loadRecent()
      await navigate(roomId)
    }
  }
  return (
    <View className="page home-page" onClick={() => setOpenedRecent(null)}>
      <View className="hero">
        <View className="hero__copy">
          <Text className="brand">把分记好</Text>
          <Text className="muted hero__subtitle">和朋友一起，轻松记分</Text>
        </View>
        <View className="hero-cards" ariaHidden>
          <Image className="hero-card-image hero-card-image--one" src={heroAce} mode="aspectFit" />
          <Image className="hero-card-image hero-card-image--two" src={heroFive} mode="aspectFit" />
        </View>
      </View>
      {isMock && (
        <View className="demo-label">
          <View className="status-dot" />
          <Text>本地演示 · 未连接后端</Text>
        </View>
      )}
      {navError && <Notice danger>{navError}</Notice>}
      {(unresolved || (mutation.phase === 'pending' && !sheet)) && (
        <Notice>
          <Text>{mutation.phase === 'pending' ? '正在确认上次请求…' : mutation.error}</Text>
          {!busy && (
            <ActionButton
              secondary
              compact
              onClick={() => {
                void recover()
              }}
            >
              确认上次请求
            </ActionButton>
          )}
        </Notice>
      )}
      <View className="entry-actions">
        <ActionButton
          onClick={() => openCreate()}
          disabled={busy || unresolved || recentBlocked || checkingRecovery}
        >
          <Text>＋ 创建房间</Text>
          <Text className="button-arrow">→</Text>
        </ActionButton>
        <ActionButton
          secondary
          onClick={() => {
            if (stores.resetMutation()) {
              setCode('')
              setSheet('join')
            }
          }}
          disabled={busy || unresolved || recentBlocked || checkingRecovery}
        >
          ⌗ 房间码加入
        </ActionButton>
      </View>
      <View className="section-heading">
        <Text className="section-title">最近房间</Text>
        <BaseButton
          className="text-button"
          onClick={() => {
            setSheet('recent')
            void stores.loadRecent()
          }}
          disabled={recent.status === 'loading'}
        >
          全部 ›
        </BaseButton>
      </View>
      {recent.status === 'loading' && <StatePanel title="正在读取最近房间…" />}
      {recent.status === 'error' && (
        <StatePanel
          title="暂时无法读取房间"
          description={recent.error ?? ''}
          retry={() => {
            void stores.loadRecent()
          }}
        />
      )}
      {recent.status === 'ready' && recent.rooms.length === 0 && (
        <View className="empty-card">
          <Text className="empty-card__title">暂无最近房间</Text>
          <Text className="muted">创建一个房间，或加入朋友的房间。</Text>
        </View>
      )}
      {recent.message && (
        <Notice danger={recent.phase === 'failed' || recent.phase === 'unknown'}>
          {recent.message}
          {recent.error ? `：${recent.error}` : ''}
          {(recent.phase === 'unknown' || recent.phase === 'failed') && recent.operation && (
            <ActionButton
              compact
              secondary
              disabled={busy}
              onClick={() => {
                const op = recent.operation
                void stores.recentSession.recover().then((ok) => {
                  if (ok && op?.kind === 'enter') void navigate(op.roomId)
                })
              }}
            >
              确认原操作
            </ActionButton>
          )}
        </Notice>
      )}
      {recent.status === 'ready' && (
        <RecentRooms
          rooms={recent.rooms.slice(0, 3)}
          opened={openedRecent}
          setOpened={setOpenedRecent}
          busy={busy || unresolved || recentBlocked}
          pendingRoomId={recent.phase === 'pending' ? recent.operation?.roomId : undefined}
          onDismiss={(id) => {
            void stores.recentSession.run('dismiss', id).then((ok) => {
              if (ok) setOpenedRecent(null)
            })
          }}
          onEnter={(id) => {
            void navigate(id)
          }}
        />
      )}
      <View className="section-heading">
        <Text className="section-title">支持的记分模式</Text>
      </View>
      <View className="mode-entries">
        {MODES.map((item) => (
          <BaseButton
            className="mode-entry"
            key={item.mode}
            onClick={() => openCreate(item.mode)}
            disabled={busy || unresolved || recentBlocked || checkingRecovery}
          >
            <Text className="mode-entry__mark">{item.mark}</Text>
            <Text className="mode-entry__label">{MODE_LABELS[item.mode]}</Text>
          </BaseButton>
        ))}
      </View>
      {sheet === 'create' && (
        <BottomSheet title="选择记分模式" onClose={closeSheet} busy={busy || unresolved}>
          <Text className="muted sheet-description">选好玩法后创建房间，再邀请朋友加入。</Text>
          <ModePicker
            value={mode}
            onChange={setMode}
            disabled={busy || unresolved || recentBlocked || checkingRecovery}
          />
          {mutation.error && <Notice danger>{mutation.error}</Notice>}
          <ActionButton
            disabled={!mode}
            loading={busy}
            onClick={() => {
              if (unresolved) void recover()
              else void create()
            }}
          >
            {unresolved
              ? '确认原创建请求'
              : mode
                ? isPoker(mode)
                  ? '下一步：确认底分'
                  : `创建${MODE_LABELS[mode]}房间`
                : '请先选择模式'}
          </ActionButton>
        </BottomSheet>
      )}
      {sheet === 'recent' && (
        <BottomSheet title="最近房间" onClose={closeSheet}>
          {recent.status === 'loading' && <StatePanel title="正在读取最近房间…" />}
          {recent.status === 'error' && (
            <StatePanel
              title="暂时无法读取房间"
              description={recent.error ?? ''}
              retry={() => {
                void stores.loadRecent()
              }}
            />
          )}
          {recent.status === 'ready' && recent.rooms.length === 0 && (
            <StatePanel title="暂无最近房间" description="创建或加入后，房间会保留在这里。" />
          )}
          {recent.message && (
            <Notice danger={recent.phase === 'failed' || recent.phase === 'unknown'}>
              {recent.message}
            </Notice>
          )}
          {recent.status === 'ready' && (
            <RecentRooms
              rooms={recent.rooms}
              opened={openedRecent}
              setOpened={setOpenedRecent}
              busy={busy || unresolved || recentBlocked}
              pendingRoomId={recent.phase === 'pending' ? recent.operation?.roomId : undefined}
              onDismiss={(id) => {
                void stores.recentSession.run('dismiss', id).then((ok) => {
                  if (ok) setOpenedRecent(null)
                })
              }}
              onEnter={(id) => {
                setSheet(null)
                void navigate(id)
              }}
            />
          )}
          {recent.nextCursor && (
            <ActionButton
              secondary
              disabled={recent.loadingMore || recentBlocked}
              onClick={() => {
                void stores.recentSession.loadMore()
              }}
            >
              {recent.loadingMore ? '读取中…' : '加载更多房间'}
            </ActionButton>
          )}
        </BottomSheet>
      )}
      {sheet === 'join' && (
        <BottomSheet title="房间码加入" onClose={closeSheet}>
          <Text className="muted sheet-description">输入朋友分享的6位房间码。</Text>
          <Input
            className="code-input"
            type="number"
            maxlength={6}
            value={code}
            placeholder="请输入6位房间码"
            placeholderStyle="color: #b2bfbd; letter-spacing: 0;"
            onInput={(event) => setCode(event.detail.value.replace(/\D/g, '').slice(0, 6))}
            confirmType="search"
          />
          {isMock && (
            <Text className="caption muted input-hint">
              演示码：打分628388 / 杀球628391 / 大A628389 / 对家628390
            </Text>
          )}
          <ActionButton
            disabled={!/^\d{6}$/.test(code)}
            onClick={() => {
              const current = code
              setSheet(null)
              void Taro.navigateTo({ url: `/pages/join/index?code=${current}` }).catch(() =>
                setNavError('页面打开失败，请重试'),
              )
            }}
          >
            查找房间
          </ActionButton>
        </BottomSheet>
      )}
    </View>
  )
}

export default function Home() {
  return (
    <ProfileGate>
      <HomeContent />
    </ProfileGate>
  )
}
