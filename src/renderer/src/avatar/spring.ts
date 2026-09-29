// 实时小人的弹簧：目标一变，值像挂在弹簧上一样追过去（带一点过冲再回来），比线性插值有生气得多
// omega 越大追得越快；zeta < 1 会过冲（0.3 甩得很明显，0.7 轻微），= 1 不过冲

export interface Spring {
  x: number
  v: number
}

export function spring(x = 0): Spring {
  return { x, v: 0 }
}

/** 半隐式欧拉：dt 秒；dt 大了拆成小步，切到后台回来时不会弹飞 */
export function step(s: Spring, target: number, omega: number, zeta: number, dt: number): number {
  let left = Math.min(dt, 0.1)
  while (left > 0) {
    const h = Math.min(left, 1 / 120)
    const a = -2 * zeta * omega * s.v - omega * omega * (s.x - target)
    s.v += a * h
    s.x += s.v * h
    left -= h
  }
  return s.x
}
