import type { Collections } from '../domain/models'

export type Collection = keyof Collections
export interface RecentPosition {
  lastVisitedAt: number
  id: string
}
export interface ReadStore {
  listPointCards(activityId: string): Promise<Collections['activity_cards'][]>
  get<K extends Collection>(collection: K, id: string): Promise<Collections[K] | null>
  listRecent(
    userId: string,
    limit: number,
    after?: RecentPosition,
  ): Promise<Collections['room_members'][]>
  listMembers(
    roomId: string,
    after: string | undefined,
    limit: number,
  ): Promise<Collections['room_members'][]>
}
export interface Transaction extends ReadStore {
  set<K extends Collection>(collection: K, document: Collections[K]): Promise<void>
}
export interface Store {
  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T>
}
