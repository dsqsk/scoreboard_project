import React from 'react'

interface VisualProps {
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}
interface PreviewTouchEvent {
  touches: ArrayLike<{ clientX: number; clientY: number }>
  stopPropagation(): void
}
interface ViewProps extends VisualProps {
  onClick?: React.MouseEventHandler<HTMLDivElement>
  onTouchMove?: (event: PreviewTouchEvent) => void
  onTouchStart?: (event: PreviewTouchEvent) => void
  onTouchEnd?: () => void
  onTouchCancel?: () => void
}
interface ButtonProps extends VisualProps {
  disabled?: boolean
  loading?: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  ariaLabel?: string
  openType?: string
}
interface InputProps extends VisualProps {
  value?: string | number
  onInput: (event: { detail: { value: string } }) => void
  placeholder?: string
  maxlength?: number
  disabled?: boolean
}
interface ImageProps extends VisualProps {
  src?: string
  mode?: string
  onError?: React.ReactEventHandler<HTMLImageElement>
}

export function View({
  children,
  className,
  style,
  onClick,
  onTouchMove,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
}: ViewProps) {
  return (
    <div
      className={className}
      style={style}
      onClick={onClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onPointerDown={
        onTouchStart
          ? (event) => {
              if (event.pointerType !== 'touch')
                onTouchStart({
                  touches: [{ clientX: event.clientX, clientY: event.clientY }],
                  stopPropagation: () => event.stopPropagation(),
                })
            }
          : undefined
      }
      onPointerMove={
        onTouchMove
          ? (event) => {
              if (event.buttons && event.pointerType !== 'touch')
                onTouchMove({
                  touches: [{ clientX: event.clientX, clientY: event.clientY }],
                  stopPropagation: () => event.stopPropagation(),
                })
            }
          : undefined
      }
      onPointerUp={
        onTouchEnd
          ? (event) => {
              if (event.pointerType !== 'touch') onTouchEnd()
            }
          : undefined
      }
    >
      {children}
    </div>
  )
}
export function Text({ children, className, style }: VisualProps) {
  return (
    <span className={className} style={style}>
      {children}
    </span>
  )
}
export function Button({
  children,
  className,
  disabled,
  loading,
  onClick,
  ariaLabel,
  openType,
}: ButtonProps) {
  return (
    <button
      className={className}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      onClick={
        openType === 'share'
          ? () => alert('浏览器预览不模拟微信分享，请在微信开发者工具验证。')
          : onClick
      }
    >
      {loading ? '处理中…' : children}
    </button>
  )
}
export function Input({
  value,
  onInput,
  placeholder,
  maxlength,
  className = 'code-input',
  disabled,
}: InputProps) {
  return (
    <input
      className={className}
      disabled={disabled}
      inputMode="numeric"
      value={value}
      placeholder={placeholder}
      maxLength={maxlength}
      onChange={(event) => onInput({ detail: { value: event.target.value } })}
    />
  )
}
export function ScrollView({ children, className }: VisualProps) {
  return (
    <div className={className} style={{ overflowY: 'auto' }}>
      {children}
    </div>
  )
}

export function Image({ src, className, style, mode, onError }: ImageProps) {
  return (
    <img
      className={className}
      style={{ ...style, objectFit: mode === 'aspectFit' ? 'contain' : 'cover' }}
      src={src}
      onError={onError}
      alt=""
    />
  )
}
