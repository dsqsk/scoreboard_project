import type { GameMode } from '@scoreboard/shared'
export const MODES: { mode: GameMode; mark: string; detail: string; category: '台球' | '扑克' }[] =
  [
    { mode: 'nine_ball', mark: 'Ⅸ', detail: '2—3人 · 持续记分', category: '台球' },
    { mode: 'kill_ball', mark: '♠︎', detail: '3—4人 · 号码球记分', category: '台球' },
    { mode: 'point_ball', mark: '▤', detail: '2～3人 · 公共牌计分', category: '台球' },
    { mode: 'da_a', mark: '♣︎', detail: '5人 · 底分计算器', category: '扑克' },
    { mode: 'dui_jia', mark: '♧', detail: '4人 · 底分计算器', category: '扑克' },
  ]
