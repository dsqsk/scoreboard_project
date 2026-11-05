export const REVEAL_WIDTH = 80
export interface SwipeGesture {
  startX: number
  startY: number
  initial: number
  direction: 'undecided' | 'horizontal' | 'vertical'
  offset: number
  moved: boolean
}
export function beginSwipe(x: number, y: number, opened: boolean): SwipeGesture {
  return {
    startX: x,
    startY: y,
    initial: opened ? -REVEAL_WIDTH : 0,
    direction: 'undecided',
    offset: opened ? -REVEAL_WIDTH : 0,
    moved: false,
  }
}
export function moveSwipe(state: SwipeGesture, x: number, y: number): SwipeGesture {
  const dx = x - state.startX,
    dy = y - state.startY
  let direction = state.direction
  if (direction === 'undecided' && Math.max(Math.abs(dx), Math.abs(dy)) > 8)
    direction = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'horizontal' : 'vertical'
  return {
    ...state,
    direction,
    moved: state.moved || Math.max(Math.abs(dx), Math.abs(dy)) > 8,
    offset:
      direction === 'horizontal'
        ? Math.min(0, Math.max(-REVEAL_WIDTH, state.initial + dx))
        : state.initial,
  }
}
export function endSwipe(state: SwipeGesture) {
  return { opened: state.offset < -REVEAL_WIDTH / 2, suppressClick: state.moved }
}
