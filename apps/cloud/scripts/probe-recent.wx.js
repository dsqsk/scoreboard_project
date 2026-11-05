/* exported verifyRecentRooms */
async function verifyRecentRooms() {
  const cloud = new wx.cloud.Cloud({ resourceEnv: 'scoreboard-d7giv4iri8369fe43' })
  await cloud.init()
  // One-shot probe ID: after an unknown result inspect these receipts before any rerun.
  const runId = 'recent_probe_backend_20261022_v1'
  const requests = []
  let roomId
  let unknown = false
  let stage = 'create'
  const call = async (action, payload, suffix) => {
    let response
    try {
      response = await cloud.callFunction({
        name: 'api',
        data: { action, payload, ...(suffix ? { requestId: runId + '_' + suffix } : {}) },
      })
    } catch {
      unknown = true
      throw new Error('UNKNOWN_RESULT_' + action)
    }
    requests.push({ action, requestId: response.requestID })
    if (!response.result || !response.result.ok)
      throw new Error(response.result?.error?.code || 'INVALID_RESPONSE')
    return response.result.data
  }
  const all = async () => {
    const rooms = []
    const cursors = new Set()
    let cursor
    do {
      const page = await call('room.listRecentPage', { limit: 20, ...(cursor ? { cursor } : {}) })
      rooms.push(...page.rooms)
      cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('NON_PROGRESSING_CURSOR')
      if (cursor) cursors.add(cursor)
      if (cursors.size > 20) throw new Error('PROBE_SCAN_LIMIT')
    } while (cursor)
    return rooms
  }
  const check = (condition, label) => {
    if (!condition) throw new Error(label)
  }
  const checks = {}
  try {
    const created = await call('room.create', { mode: 'point_ball' }, 'create')
    roomId = created.roomId
    const entered = await call('room.enter', { roomId }, 'enter')
    const before = (await all()).find((room) => room.roomId === roomId)
    check(before, 'NEW_ROOM_MISSING')
    const snapshot = await call('room.getSnapshot', { roomId })
    const afterRead = (await all()).find((room) => room.roomId === roomId)
    checks.snapshotKeepsOrder = afterRead?.lastEnteredAt === before.lastEnteredAt
    check(checks.snapshotKeepsOrder, 'SNAPSHOT_CHANGED_RECENT')
    stage = 'dismiss'
    await call('room.dismissRecent', { roomId }, 'dismiss')
    checks.dismissed = !(await all()).some((room) => room.roomId === roomId)
    check(checks.dismissed, 'DISMISS_NOT_PERSISTED')
    await call('room.getSnapshot', { roomId })
    const replay = await call('room.enter', { roomId }, 'enter')
    checks.originalReceipt = JSON.stringify(replay) === JSON.stringify(entered)
    checks.oldEnterDoesNotRestore = !(await all()).some((room) => room.roomId === roomId)
    check(checks.originalReceipt && checks.oldEnterDoesNotRestore, 'OLD_ENTER_REPEATED')
    stage = 'restore'
    await call('room.enter', { roomId }, 'restore')
    const restored = (await all()).find((room) => room.roomId === roomId)
    checks.activeEnterRestores = !!restored && restored.lastEnteredAt > before.lastEnteredAt
    check(checks.activeEnterRestores, 'ACTIVE_ENTER_NOT_RESTORED')
    const after = await call('room.getSnapshot', { roomId })
    checks.membershipUnchanged =
      after.memberCount === snapshot.memberCount &&
      after.revision === snapshot.revision &&
      after.members.length === snapshot.members.length &&
      after.activeActivityId === snapshot.activeActivityId
    check(checks.membershipUnchanged, 'ROOM_CHANGED')
    stage = 'cleanup'
    await call('room.dismissRecent', { roomId }, 'cleanup')
    checks.hiddenAtEnd = !(await all()).some((room) => room.roomId === roomId)
    checks.roomStillReadable = (await call('room.getSnapshot', { roomId })).roomId === roomId
    check(checks.hiddenAtEnd && checks.roomStillReadable, 'CLEANUP_FAILED')
    return { passed: true, runId, roomId, checks, requests }
  } catch (error) {
    return { passed: false, stage, runId, roomId, unknown, error: error.message, checks, requests }
  }
}
