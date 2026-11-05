import { stableId } from '../src/infrastructure/ids'
import type { Collections } from '../src/domain/models'
import type { Collection, Store, Transaction } from '../src/repositories/store'

type Document = Collections[Collection]
// Serial transaction Adapter for service tests. It models atomic commit/rollback, not cloud contention.
export class MemoryStore implements Store {
  private records = new Map<string, Document>()
  private tail = Promise.resolve()
  failCollection: Collection | null = null
  async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const copy = new Map(Array.from(this.records, ([key, value]) => [key, structuredClone(value)]))
    const allMembers = () =>
      Array.from(copy.entries())
        .filter(([key]) => key.startsWith('room_members/'))
        .map(([, record]) => record as Collections['room_members'])
    const tx: Transaction = {
      async listPointCards(activityId) {
        const ids = Array.from({ length: 15 }, (_, index) =>
          stableId('card', activityId, String(index + 1)),
        )
        return structuredClone(
          ids.flatMap((id) => {
            const card = copy.get(`activity_cards/${id}`)
            return card ? [card as Collections['activity_cards']] : []
          }),
        )
      },
      async get<K extends Collection>(collection: K, id: string) {
        const value = copy.get(`${collection}/${id}`)
        return value ? (structuredClone(value) as Collections[K]) : null
      },
      set: async (collection, document) => {
        if (this.failCollection === collection) {
          this.failCollection = null
          throw new Error('injected persistence failure')
        }
        copy.set(`${collection}/${document._id}`, structuredClone(document))
      },
      async listMembers(roomId, after, limit) {
        return structuredClone(
          allMembers()
            .filter(
              (item) =>
                item.roomId === roomId && item.status === 'active' && (!after || item._id > after),
            )
            .sort((a, b) => a._id.localeCompare(b._id))
            .slice(0, limit),
        )
      },
      async listRecent(userId, limit, after) {
        return structuredClone(
          allMembers()
            .filter(
              (item) =>
                item.userId === userId &&
                item.status === 'active' &&
                (!after ||
                  item.lastVisitedAt < after.lastVisitedAt ||
                  (item.lastVisitedAt === after.lastVisitedAt && item._id > after.id)),
            )
            .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt || a._id.localeCompare(b._id))
            .slice(0, limit),
        )
      },
    }
    try {
      const result = await operation(tx)
      this.records = copy
      return result
    } finally {
      release()
    }
  }
  documents<K extends Collection>(collection: K): Collections[K][] {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, value]) => structuredClone(value) as Collections[K])
  }
}
