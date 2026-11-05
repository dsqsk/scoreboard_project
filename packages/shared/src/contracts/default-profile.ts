import type { DefaultAvatar } from './room'

export const DEFAULT_PROFILE_ADJECTIVES = [
  '开心',
  '困倦',
  '悠闲',
  '机灵',
  '认真',
  '勇敢',
  '自在',
  '好奇',
  '慢热',
  '温柔',
  '快乐',
  '元气',
] as const
export const DEFAULT_PROFILE_ANIMALS = [
  '狗',
  '猫',
  '龙',
  '狐狸',
  '熊猫',
  '海豚',
  '企鹅',
  '兔子',
  '小鹿',
  '老虎',
  '水獭',
  '松鼠',
] as const

export function isDefaultAvatar(value: unknown): value is DefaultAvatar {
  return (
    !!value &&
    typeof value === 'object' &&
    'template' in value &&
    value.template === 'person-v1' &&
    'color' in value &&
    typeof value.color === 'string' &&
    /^#[0-9A-Fa-f]{6}$/.test(value.color)
  )
}

/** Pure generator for server assignment and isolated Mock. Never call during rendering. */
export function createDefaultProfile(random: () => number = Math.random): {
  displayName: string
  defaultAvatar: DefaultAvatar
} {
  const index = (length: number) => {
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new RangeError('random must return a number in [0, 1)')
    return Math.floor(value * length)
  }
  let color = '#72B9A6'
  for (let attempt = 0; attempt < 32; attempt++) {
    const rgb = [64 + index(161), 64 + index(161), 64 + index(161)]
    const brightness = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    if (brightness >= 110 && brightness <= 200) {
      color = `#${rgb
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`
      break
    }
  }
  return {
    displayName: `${DEFAULT_PROFILE_ADJECTIVES[index(DEFAULT_PROFILE_ADJECTIVES.length)]}的${DEFAULT_PROFILE_ANIMALS[index(DEFAULT_PROFILE_ANIMALS.length)]}`,
    defaultAvatar: { template: 'person-v1', color },
  }
}
