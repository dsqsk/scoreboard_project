import { isHttp } from '../../platform/backend'
import { httpAvatars } from './avatar-runtime'
import { useEffect, useState, useRef } from 'react'
import { Image, Text, View } from '@tarojs/components'
import type { Me } from '../../modules/room-api/types'
import { personAvatarSource } from './avatar-source'
import './profile.css'
export function Avatar({
  user,
  size = 36,
  localPath,
}: {
  user: Pick<Me, 'displayName' | 'avatarFileId' | 'defaultAvatar'>
  size?: number
  localPath?: string
}) {
  const [resolved, setResolved] = useState<{ id: string; url: string | undefined }>()
  const retried = useRef(false)
  const remoteId = isHttp && !localPath ? user.avatarFileId : null
  const activeRemote = useRef(remoteId)
  activeRemote.current = remoteId
  useEffect(() => {
    let alive = true
    setResolved(undefined)
    retried.current = false
    if (!remoteId) return
    const read = () => {
      void httpAvatars
        .resolve(remoteId)
        .then((url) => {
          if (alive) setResolved({ id: remoteId, url })
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, 55 * 60 * 1000)
    return () => {
      alive = false
      if (activeRemote.current === remoteId) activeRemote.current = null
      clearInterval(timer)
    }
  }, [remoteId])
  const signedUrl = resolved?.id === remoteId ? resolved?.url : undefined
  const source =
    localPath || (isHttp ? signedUrl : user.avatarFileId) || personAvatarSource(user.defaultAvatar)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const style = { width: `${size}px`, height: `${size}px` }
  return (
    <View className="user-avatar" style={style}>
      {failed ? (
        <Text>{user.displayName.slice(0, 1)}</Text>
      ) : (
        <Image
          className="user-avatar-image"
          style={style}
          src={source}
          mode="aspectFill"
          onError={() => {
            if (remoteId && signedUrl && !retried.current) {
              retried.current = true
              void httpAvatars
                .resolve(remoteId, true)
                .then((url) => {
                  if (activeRemote.current === remoteId)
                    setResolved({ id: remoteId, url: url === signedUrl ? undefined : url })
                })
                .catch(() => {
                  if (activeRemote.current === remoteId) setResolved(undefined)
                })
            } else setFailed(true)
          }}
        />
      )}
    </View>
  )
}
