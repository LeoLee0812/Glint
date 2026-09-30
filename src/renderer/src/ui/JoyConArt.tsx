import type { Btn } from '../input/joycon'

// 一只 Joy-Con 的示意图（新手引导「连上手柄」那一步用）：
// 没连上时是灰的，侧面导轨上的同步键一圈圈闪、四颗指示灯来回跑（和真手柄配对时一样）；
// 连上了变成电光蓝 / 电光红，按哪个键哪个键亮一下

const DARK = '#2c2c2e'

function key(lit: ReadonlySet<Btn>, b: Btn | Btn[]): string {
  const bs = Array.isArray(b) ? b : [b]
  return `jc-key${bs.some((x) => lit.has(x)) ? ' lit' : ''}`
}

export function JoyConArt({ side, connected, lit }: { side: 'L' | 'R'; connected: boolean; lit: ReadonlySet<Btn> }): React.JSX.Element {
  const L = side === 'L'
  // 导轨在靠里的一侧：左手柄在右边，右手柄在左边
  const railX = L ? 86 : 8
  const body = L
    ? 'M88 8 L48 8 C24 8 10 24 10 48 L10 172 C10 196 24 212 48 212 L88 212 Z'
    : 'M12 8 L52 8 C76 8 90 24 90 48 L90 172 C90 196 76 212 52 212 L12 212 Z'
  const shoulder = L ? 'M15 40 C17 23 28 13 46 12' : 'M54 12 C72 13 83 23 85 40'
  const stick = L ? { x: 48, y: 62 } : { x: 52, y: 118 }
  const dia = L ? { x: 48, y: 122 } : { x: 52, y: 62 }
  const d = 18
  const face: Array<{ b: Btn; x: number; y: number; g: string }> = L
    ? [
        { b: 'Up', x: dia.x, y: dia.y - d, g: '▲\uFE0E' },
        { b: 'Right', x: dia.x + d, y: dia.y, g: '▶\uFE0E' },
        { b: 'Down', x: dia.x, y: dia.y + d, g: '▼\uFE0E' },
        { b: 'Left', x: dia.x - d, y: dia.y, g: '◀\uFE0E' }
      ]
    : [
        { b: 'X', x: dia.x, y: dia.y - d, g: 'X' },
        { b: 'A', x: dia.x + d, y: dia.y, g: 'A' },
        { b: 'B', x: dia.x, y: dia.y + d, g: 'B' },
        { b: 'Y', x: dia.x - d, y: dia.y, g: 'Y' }
      ]
  return (
    <svg className={`joycon-art jc-${side}${connected ? ' on' : ''}`} viewBox="0 0 100 220" aria-hidden>
      <path className="jc-body" d={body} />
      <path className={key(lit, L ? ['L', 'ZL'] : ['R', 'ZR'])} d={shoulder} fill="none" strokeWidth="6" strokeLinecap="round" stroke={DARK} />
      <rect className="jc-rail" x={railX} y="8" width="6" height="204" rx="2" />
      {/* 指示灯：配对时来回跑 */}
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} className={`jc-led jc-led${i}`} x={railX + 1.5} y={26 + i * 9} width="3" height="5" rx="1" />
      ))}
      {/* 同步键 */}
      <circle className="jc-sync-ring" cx={railX + 3} cy="112" r="6" />
      <circle className="jc-sync" cx={railX + 3} cy="112" r="2.6" />
      {/* − / + */}
      {L ? (
        <g className={key(lit, 'Minus')}>
          <circle cx="72" cy="26" r="5.5" fill={DARK} />
          <path d="M69 26h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      ) : (
        <g className={key(lit, 'Plus')}>
          <circle cx="28" cy="26" r="5.5" fill={DARK} />
          <path d="M25 26h6M28 23v6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}
      {/* 摇杆 */}
      <g className={key(lit, L ? 'LS' : 'RS')}>
        <circle cx={stick.x} cy={stick.y} r="15" fill={DARK} />
        <circle cx={stick.x} cy={stick.y} r="9.5" fill="#48484a" />
      </g>
      {face.map((f) => (
        <g key={f.b} className={key(lit, f.b)}>
          <circle cx={f.x} cy={f.y} r="7.5" fill={DARK} />
          <text x={f.x} y={f.y + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={L ? 6 : 8} fontWeight="700" fill="#fff">
            {f.g}
          </text>
        </g>
      ))}
      {L ? (
        <rect className={key(lit, 'Capture')} x="58" y="162" width="11" height="11" rx="2.5" fill={DARK} />
      ) : (
        <g className={key(lit, 'Home')}>
          <circle cx="38" cy="168" r="6.5" fill={DARK} />
          <circle cx="38" cy="168" r="3.4" fill="none" stroke="#8e8e93" strokeWidth="1.2" />
        </g>
      )}
    </svg>
  )
}
