import type { ActivityConfig, GameMode, Shortcut } from '@scoreboard/shared'
import type { Rules } from '../domain/models'
import { AppError } from '../infrastructure/errors'
import { pointBaseline } from './point-rules'

const basicNine: Shortcut[] = [
  { key: 'normal', label: '普胜', positiveUnits: 4, negativeUnits: -4 },
  { key: 'small_gold', label: '小金', positiveUnits: 7, negativeUnits: -7 },
  { key: 'foul', label: '犯规', positiveUnits: 1, negativeUnits: -1 },
]
export const defaultRules: Rules = {
  version: 'foundation-v1',
  pokerScale: 100,
  twoPlayerNineShortcuts: null,
  fourPlayerKillShortHand: 'not_configured',
}
export function prepareConfig(
  mode: GameMode,
  count: number,
  input: { baseStake?: string },
  rules: Rules,
): { scoreScale: number; config: ActivityConfig } {
  const valid =
    mode === 'nine_ball'
      ? [2, 3]
      : mode === 'kill_ball'
        ? [3, 4]
        : mode === 'point_ball'
          ? [2, 3]
          : mode === 'da_a'
            ? [5]
            : [4]
  if (!valid.includes(count)) throw new AppError('INVALID_ARGUMENT', '参与人数不符合当前玩法要求')
  const poker = mode === 'da_a' || mode === 'dui_jia'
  if (!poker && input.baseStake !== undefined)
    throw new AppError('INVALID_ARGUMENT', '台球模式不使用扑克底分')
  if (mode === 'nine_ball') {
    const shortcuts =
      count === 3
        ? [
            ...basicNine,
            { key: 'big_gold', label: '大金', positiveUnits: 20, negativeUnits: -10 },
            { key: 'concession_normal', label: '让杆普胜', positiveUnits: 8, negativeUnits: -8 },
            {
              key: 'concession_small_gold',
              label: '让杆小金',
              positiveUnits: 14,
              negativeUnits: -14,
            },
          ]
        : (rules.twoPlayerNineShortcuts ?? basicNine)
    return {
      scoreScale: 1,
      config: {
        mode,
        shortcuts,
        unavailableShortcutKeys:
          count === 2 && !rules.twoPlayerNineShortcuts
            ? ['big_gold', 'concession_normal', 'concession_small_gold']
            : [],
      },
    }
  }
  if (mode === 'kill_ball') {
    if (count === 4 && rules.fourPlayerKillShortHand === 'not_configured')
      throw new AppError('RULE_NOT_CONFIGURED', '四人少牌者策略尚未配置')
    return {
      scoreScale: 1,
      config: { mode, distribution: [5, 5, 5], shortHandUserId: null, dealStatus: 'undealt' },
    }
  }
  if (mode === 'point_ball')
    return {
      scoreScale: 1,
      config: {
        mode,
        cardNumbers: Array.from({ length: 15 }, (_, i) => i + 1),
        totalPoints: 120,
        baselineUnits: pointBaseline(count),
      },
    }
  if (!input.baseStake) throw new AppError('INVALID_ARGUMENT', '请先确认底分')
  // Decimal text to integer units, no binary floating point multiplication.
  const [whole, fraction = ''] = input.baseStake.split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError('INVALID_ARGUMENT', '底分必须为正数且不能超出精确范围')
  if (rules.pokerScale !== 100) throw new AppError('RULE_NOT_CONFIGURED', '底分精度配置不可用')
  const baseStakeUnits = Number(cents)
  return {
    scoreScale: 100,
    config:
      mode === 'da_a'
        ? { mode, baseStakeUnits, coefficientScale: 1, nonZeroSumPolicy: 'not_configured' }
        : { mode, baseStakeUnits, allowedMultipliers: [1, 2] },
  }
}
