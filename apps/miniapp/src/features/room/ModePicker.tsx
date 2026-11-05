import { Text, View } from '@tarojs/components'
import type { GameMode } from '@scoreboard/shared'
import { MODE_LABELS } from '../../modules/room-api/types'
import { MODES } from './modes'
import { BaseButton } from '../../components/ui'

export function ModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: GameMode | null
  onChange: (mode: GameMode) => void
  disabled?: boolean
}) {
  return (
    <View>
      {(['台球', '扑克'] as const).map((category) => (
        <View className="mode-category" key={category}>
          <Text className="eyebrow">{category}</Text>
          {MODES.filter((item) => item.category === category).map((item) => (
            <BaseButton
              key={item.mode}
              className={`mode-option ${value === item.mode ? 'mode-option--selected' : ''}`}
              disabled={disabled}
              onClick={() => onChange(item.mode)}
            >
              <View className="mode-option__symbol">{item.mark}</View>
              <View className="mode-option__copy">
                <Text className="mode-option__title">{MODE_LABELS[item.mode]}</Text>
                <Text className="muted caption">{item.detail}</Text>
              </View>
              <Text className="mode-option__check">{value === item.mode ? '✓' : ''}</Text>
            </BaseButton>
          ))}
        </View>
      ))}
    </View>
  )
}
