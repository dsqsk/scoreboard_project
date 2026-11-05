import type { PointResult } from '@scoreboard/shared'
import { AppError } from '../infrastructure/errors'

export const POINT_RULES_VERSION = 'point-ball-v2'

export function pointBaseline(count: number): number {
  if (count !== 2 && count !== 3) throw new AppError('INTERNAL_ERROR', '打分参与人数资料不正确')
  return 120 / count
}

// Validate each saved result against its own fixed roster, never the current room/activity.
export function validatePointResult(result: PointResult): void {
  const ids = result.participants.map((p) => p.userId)
  const baseline = pointBaseline(ids.length)
  if (
    new Set(ids).size !== ids.length ||
    Object.keys(result.earnedPoints).length !== ids.length ||
    Object.keys(result.deltas).length !== ids.length ||
    ids.some(
      (id) =>
        !Object.hasOwn(result.earnedPoints, id) ||
        !Object.hasOwn(result.deltas, id) ||
        !Number.isInteger(result.earnedPoints[id]) ||
        result.earnedPoints[id] < 0 ||
        result.earnedPoints[id] > 120 ||
        result.deltas[id] !== result.earnedPoints[id] - baseline,
    ) ||
    ids.reduce((sum, id) => sum + result.earnedPoints[id], 0) !== 120
  )
    throw new AppError('INTERNAL_ERROR', '打分历史结果资料不完整')
}
