import type { Btn } from '../input/joycon'

// Joy-Con 键帽：按键说明、新手引导、校准小游戏共用。左手柄的键是电光蓝，右手柄的是电光红

export type JoySide = 'L' | 'R'
export type Dir = 'up' | 'down' | 'left' | 'right'

/** 两只手柄上各四颗圆键，按真手柄的菱形位置排：左手柄是十字键，右手柄是 X / A / B / Y */
export const DIAMOND: Record<Dir, Record<JoySide, Btn>> = {
  up: { L: 'Up', R: 'X' },
  right: { L: 'Right', R: 'A' },
  down: { L: 'Down', R: 'B' },
  left: { L: 'Left', R: 'Y' }
}

/** 校准小游戏用的 8 颗键 */
export const FACE_KEYS: Btn[] = ['Up', 'Right', 'Down', 'Left', 'X', 'A', 'B', 'Y']

const LEFT_KEYS = new Set<Btn>(['Up', 'Down', 'Left', 'Right', 'L', 'ZL', 'Minus', 'Capture', 'LS', 'SL_L', 'SR_L'])

export function sideOf(b: Btn): JoySide {
  return LEFT_KEYS.has(b) ? 'L' : 'R'
}

export function dirOf(b: Btn): Dir | null {
  for (const d of Object.keys(DIAMOND) as Dir[]) if (DIAMOND[d].L === b || DIAMOND[d].R === b) return d
  return null
}

// 三角后面跟 U+FE0E：强制按文字画，不然 macOS 会把 ▶ ◀ 画成彩色 emoji
const GLYPH: Partial<Record<Btn, string>> = {
  Up: '▲\uFE0E',
  Down: '▼\uFE0E',
  Left: '◀\uFE0E',
  Right: '▶\uFE0E',
  Minus: '−',
  Plus: '+',
  LS: '左摇杆',
  RS: '右摇杆',
  Capture: '截图键',
  Home: 'HOME'
}

export function glyphOf(b: Btn): string {
  return GLYPH[b] ?? b
}

/** 画成圆的键：ABXY、十字键、− + */
const ROUND = new Set<Btn>(['A', 'B', 'X', 'Y', 'Up', 'Down', 'Left', 'Right', 'Minus', 'Plus'])

/**
 * 一颗键帽。单个字符的键（A B X Y、十字键、− +）画成圆的，其余（L ZL 摇杆 HOME…）画成圆角条；
 * lit = 实心点亮（「就按这个」）
 */
export function KeyCap({ k, lit, size = 'md', side }: { k: Btn; lit?: boolean; size?: 'sm' | 'md' | 'lg'; side?: JoySide }): React.JSX.Element {
  const s = side ?? sideOf(k)
  return <span className={`keycap kc-${s} kc-${size}${ROUND.has(k) ? ' round' : ''}${lit ? ' lit' : ''}`}>{glyphOf(k)}</span>
}

/** 键盘上的键：灰色圆角方块 */
export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="keycap kc-kb">{children}</span>
}

/**
 * 一只手柄上的四颗圆键摆成菱形，亮起其中一颗（引导里「按这个」、小游戏里的目标都用它）；
 * anchor = 'lit' 时以亮着的那颗为中心摆放（小游戏：眼睛要盯的是亮着的键本身）
 */
export function Diamond({ side, lit, anchor = 'center', pressed }: { side: JoySide; lit: Dir | null; anchor?: 'center' | 'lit'; pressed?: Dir | null }): React.JSX.Element {
  const off: Record<Dir, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] }
  const shift = anchor === 'lit' && lit ? off[lit] : [0, 0]
  return (
    <span className={`diamond dm-${side}`}>
      {(Object.keys(off) as Dir[]).map((d) => {
        const [x, y] = off[d]
        const b = DIAMOND[d][side]
        return (
          <span
            key={d}
            className={`dm-key${d === lit ? ' lit' : ''}${d === pressed ? ' pressed' : ''}`}
            style={{ left: `calc(50% + ${(x - shift[0]) * 1.3}em)`, top: `calc(50% + ${(y - shift[1]) * 1.3}em)` }}
          >
            <b>{glyphOf(b)}</b>
          </span>
        )
      })}
    </span>
  )
}
