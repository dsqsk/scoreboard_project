import { useEffect, useState, type PropsWithChildren } from 'react'
import { Input, Text, View } from '@tarojs/components'
import { useStore } from 'zustand'
import { stores, isMock } from '../../runtime'
import { ActionButton, BaseButton, Notice, StatePanel } from '../../components/ui'
import { profileSession } from './runtime'
import './profile.css'
import { Avatar } from './ProfileAvatar'
export function ProfileGate({ children }: PropsWithChildren) {
  const identity = useStore(stores.identity)
  const state = useStore(profileSession.store)
  const [editing, setEditing] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [nicknameFocused, setNicknameFocused] = useState(false)
  const me = identity.me
  useEffect(() => {
    void stores.ensureIdentity().catch(() => {})
  }, [])
  useEffect(() => {
    if (me) profileSession.open(me)
  }, [me?.userId])
  if (!me)
    return (
      <View className="page">
        <StatePanel
          title={identity.status === 'error' ? '暂时无法识别微信身份' : '正在读取微信身份…'}
          description={identity.error ?? undefined}
          retry={
            identity.status === 'error'
              ? () => {
                  void stores.ensureIdentity().catch(() => {})
                }
              : undefined
          }
        />
      </View>
    )
  const busy = state.phase === 'uploading' || state.phase === 'saving'
  const unknown = state.phase === 'unknown'
  const needsConfirmation = state.phase === 'unknown' || state.phase === 'saving'
  if ((needsConfirmation && !cancelled) || editing)
    return (
      <View className="page profile-page">
        <Text className="eyebrow">让朋友认出你</Text>
        <Text className="page-title">编辑个人资料</Text>
        <Text className="muted profile-description">
          已为你分配默认昵称和头像，可以直接使用，也可以修改。
        </Text>
        {isMock && <Notice>本地演示，资料仅保存在当前设备。</Notice>}
        <View className="panel">
          <View className="profile-avatar-preview">
            <Avatar
              user={{
                displayName: state.name,
                avatarFileId: state.avatar,
                defaultAvatar: state.defaultAvatar,
              }}
              localPath={state.localPath}
              size={88}
            />
          </View>
          <BaseButton
            className="action profile-wechat-button"
            openType="chooseAvatar"
            disabled={busy || unknown}
            onClick={() => setNicknameFocused(false)}
            onChooseAvatar={(event) => {
              if (!event.detail.avatarUrl) return
              profileSession.choose(event.detail.avatarUrl)
              setNicknameFocused(true)
            }}
          >
            <Text>使用微信头像和昵称</Text>
          </BaseButton>
          <Text className="caption muted profile-description">
            先选择头像，再点键盘上方的微信昵称；也可以手动填写。头像最大2MB。
          </Text>
          <Text className="profile-label">昵称</Text>
          <Input
            className="profile-input"
            type="nickname"
            focus={nicknameFocused}
            value={state.name}
            maxlength={32}
            placeholder="选择微信昵称或手动填写"
            disabled={busy || unknown}
            onInput={(event) => profileSession.name(event.detail.value)}
            onBlur={(event) => {
              setNicknameFocused(false)
              profileSession.name(event.detail.value)
            }}
          />
        </View>
        {state.error && <Notice danger>{state.error}</Notice>}
        {unknown && <Notice>上次保存结果待确认，请使用原请求重试，头像不会重复上传。</Notice>}
        <ActionButton
          loading={busy}
          disabled={
            unknown
              ? !state.pending
              : !state.name.trim() || !(state.avatar || state.localPath || state.defaultAvatar)
          }
          onClick={() => {
            void profileSession.save().then((success) => {
              if (success) {
                setEditing(false)
                setCancelled(false)
                void stores.loadRecent()
              }
            })
          }}
        >
          {state.phase === 'uploading' ? '上传头像中…' : unknown ? '确认原保存结果' : '保存资料'}
        </ActionButton>
        <ActionButton
          secondary
          disabled={busy}
          onClick={() => {
            setEditing(false)
            setCancelled(true)
          }}
        >
          取消
        </ActionButton>
      </View>
    )
  return (
    <>
      <View className="profile-entry">
        <BaseButton
          className="profile-edit"
          onClick={() => {
            profileSession.open(me)
            setEditing(true)
          }}
        >
          <Avatar user={me} />
          <Text>{me.displayName} · 编辑资料</Text>
        </BaseButton>
      </View>
      {children}
    </>
  )
}
