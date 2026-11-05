import { RoomApiError } from '../../modules/room-api/errors'
export type PokerMode = 'da_a' | 'dui_jia'
export const AA_VALUES = [1, 2, 3, 4, 6, 8, 16, 32] as const
export const BASE_PRESETS = [1, 5, 10] as const
export const isPoker = (mode: string): mode is PokerMode => mode === 'da_a' || mode === 'dui_jia'
export const requiredPlayers = (mode: PokerMode) => (mode === 'da_a' ? 5 : 4)
export const isPresetBase = (base: number) => BASE_PRESETS.some((value) => value === base)
export interface PokerEntryInput {
  direction: 1 | -1
  value: number
  mingA: boolean
  configRevision: number
}
export function deltaFor(
  mode: PokerMode,
  base: number,
  input: Pick<PokerEntryInput, 'direction' | 'value' | 'mingA'>,
): number {
  if (
    !isPresetBase(base) ||
    ![1, -1].includes(input.direction) ||
    typeof input.mingA !== 'boolean' ||
    !(mode === 'da_a'
      ? AA_VALUES.includes(input.value as (typeof AA_VALUES)[number])
      : [1, 2].includes(input.value)) ||
    (mode === 'dui_jia' && input.mingA)
  )
    throw new RoomApiError('INVALID_ARGUMENT', '记分选项无效，请重新选择')
  return input.direction * input.value * base * (input.mingA ? 2 : 1)
}
export function pokerCreateValue(mode: PokerMode, base: number) {
  return `${mode}@${base}`
}
