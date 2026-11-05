import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { Meta } from '../domain/models'

export const stableId = (kind: string, ...parts: string[]) =>
  `${kind}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
export const newId = (kind: string) => `${kind}_${randomUUID()}`
export const newJoinCode = () => String(randomInt(100000, 1000000))
export const meta = (id: string, now: number): Meta => ({
  _id: id,
  schemaVersion: 1,
  createdAt: now,
  updatedAt: now,
  revision: 0,
})
export function canonicalHash(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, sort(value)]),
      )
    return item
  }
  return createHash('sha256')
    .update(JSON.stringify(sort(value)))
    .digest('hex')
}
