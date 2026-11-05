import { DA_A_BASE_STAKES, DA_A_VALUES } from '../contracts/da-a'

export function daADeltaUnits(
  baseStake: number,
  direction: number,
  value: number,
  mingA: boolean,
): number {
  if (
    !DA_A_BASE_STAKES.some((n) => n === baseStake) ||
    ![1, -1].includes(direction) ||
    !DA_A_VALUES.some((n) => n === value) ||
    typeof mingA !== 'boolean'
  )
    throw new Error('打大A记分选项无效')
  return direction * value * baseStake * (mingA ? 2 : 1) * 100
}
