export const GAME_MODES = ['nine_ball', 'kill_ball', 'point_ball', 'da_a', 'dui_jia'] as const
export type GameMode = (typeof GAME_MODES)[number]

export const MODE_LABELS: Record<GameMode, string> = {
  nine_ball: '中式九球',
  kill_ball: '杀球',
  point_ball: '打分',
  da_a: '打大A',
  dui_jia: '打对家',
}
