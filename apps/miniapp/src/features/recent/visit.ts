export interface RoomVisit {
  current: boolean
  confirmed?: boolean
  flight?: Promise<boolean>
}
// Owned by the page wrapper, outside ProfileGate, so editing does not start a second visit.
export function enterRoomOnce(visit: RoomVisit, enter: () => Promise<boolean>): Promise<boolean> {
  if (visit.confirmed) return Promise.resolve(true)
  if (visit.flight) return visit.flight
  if (visit.current) return Promise.resolve(false)
  visit.current = true
  visit.flight = enter().then((ok) => {
    visit.confirmed = ok
    return ok
  })
  return visit.flight
}
