import { Children, type PropsWithChildren } from 'react'
import { Button as NativeButton, ScrollView, Text, View } from '@tarojs/components'
import type { ButtonProps } from '@tarojs/components'

// Class-based reset survives Taro's native-tag selector rewriting.
export function BaseButton({ className = '', disabled, hoverClass, ...props }: ButtonProps) {
  return (
    <NativeButton
      {...props}
      disabled={disabled}
      className={`ui-button ${disabled ? 'ui-button--disabled' : ''} ${className}`}
      hoverClass={hoverClass ?? 'ui-button--pressed'}
    />
  )
}

export function ActionButton({
  children,
  onClick,
  disabled = false,
  loading = false,
  secondary = false,
  compact = false,
  openType,
}: PropsWithChildren<{
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  secondary?: boolean
  compact?: boolean
  openType?: 'share'
}>) {
  return (
    <BaseButton
      className={`action ${secondary ? 'action--secondary' : ''} ${compact ? 'action--compact' : ''}`}
      disabled={disabled || loading}
      loading={loading}
      onClick={onClick}
      openType={openType}
    >
      {children}
    </BaseButton>
  )
}
export function Notice({ children, danger = false }: PropsWithChildren<{ danger?: boolean }>) {
  return (
    <View className={`notice ${danger ? 'notice--danger' : ''}`}>
      {Children.map(children, (child) =>
        typeof child === 'string' || typeof child === 'number' ? <Text>{child}</Text> : child,
      )}
    </View>
  )
}
export function StatePanel({
  title,
  description,
  retry,
}: {
  title: string
  description?: string
  retry?: () => void
}) {
  return (
    <View className="state-panel">
      <Text className="state-panel__title">{title}</Text>
      {description && <Text className="muted state-panel__description">{description}</Text>}
      {retry && (
        <ActionButton secondary compact onClick={retry}>
          重试
        </ActionButton>
      )}
    </View>
  )
}
export function BottomSheet({
  title,
  children,
  onClose,
  busy = false,
}: PropsWithChildren<{ title: string; onClose: () => void; busy?: boolean }>) {
  return (
    <View className="sheet-overlay" onTouchMove={(event) => event.stopPropagation()}>
      <View
        className="sheet-backdrop"
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <View className="sheet">
        <View className="sheet__header">
          <Text className="section-title">{title}</Text>
          <BaseButton
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            ariaLabel="关闭面板"
          >
            ×
          </BaseButton>
        </View>
        <ScrollView scrollY className="sheet__content">
          <View className="sheet__inner">{children}</View>
        </ScrollView>
      </View>
    </View>
  )
}
