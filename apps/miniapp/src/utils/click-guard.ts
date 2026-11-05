// Leading-edge protection: accepted clicks run now; nothing is queued or replayed.
export function createClickGuard(now: () => number = Date.now) {
  const accepted = new Map<string, number>()
  return (key: string) => {
    const time = now()
    const previous = accepted.get(key)
    if (previous !== undefined && time - previous < 400) return false
    for (const [oldKey, at] of accepted) if (time - at >= 400) accepted.delete(oldKey)
    accepted.set(key, time)
    return true
  }
}
