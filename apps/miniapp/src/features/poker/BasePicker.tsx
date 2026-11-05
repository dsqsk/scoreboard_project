import { Input, Text, View } from '@tarojs/components'
import { BaseButton } from '../../components/ui'
import { BASE_PRESETS } from './model'
import './poker.css'
export type BaseSelection = number | 'custom' | null
export function BasePicker({
  value,
  custom,
  onChange,
  onCustom,
  disabled,
  allowCustom = true,
}: {
  value: BaseSelection
  custom: string
  onChange: (value: BaseSelection) => void
  onCustom: (text: string) => void
  disabled: boolean
  allowCustom?: boolean
}) {
  return (
    <View className="poker-base-picker">
      <Text className="section-title">底分倍数</Text>
      <View className="poker-base-options">
        {[...BASE_PRESETS, ...(allowCustom ? ['custom' as const] : [])].map((base) => (
          <BaseButton
            key={base}
            disabled={disabled}
            className={`poker-base-option ${value === base ? 'poker-base-option--selected' : ''}`}
            onClick={() => onChange(base)}
          >
            {base === 'custom' ? '自定义' : base}
            {value === base && <Text className="poker-base-check">✓</Text>}
          </BaseButton>
        ))}
      </View>
      {value === 'custom' && (
        <>
          <Input
            className="poker-base-input"
            type="digit"
            value={custom}
            disabled={disabled}
            placeholder="请输入底分倍数"
            placeholderStyle="color: #b2bfbd"
            onInput={(event) => onCustom(event.detail.value)}
          />
          <Text className="caption muted">
            自定义范围与精度待确定，暂不能使用；请选择预设底分。
          </Text>
        </>
      )}
    </View>
  )
}
