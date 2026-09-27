import type { HeadPos } from './engine'
import { createStore } from '../store'

// 头位置提醒：拿当前头位置和校准时的比，算出该往哪边挪
// 普通摄像头眼动对头的位置很敏感：离远了 / 挪开了，校准出来的映射就整体偏了

export type Axis = 'z' | 'x' | 'y' | 'roll' | 'yaw'

export interface HeadIssue {
  axis: Axis
  /** 偏离量 / 阈值，≥1 算偏了 */
  level: number
  text: string
}

export interface HeadAdvice {
  issues: HeadIssue[]
  /** 最该先改的一条 */
  main: string | null
  /** 剩下的，拼成一句 */
  sub: string | null
}

// 阈值：前后按脸宽变化比例；左右、上下按「挪了几个脸宽」；歪头按弧度（约 14°）；
// 转头量 ≈ 1.4 × tan(角度)，放得很宽（约 25°）：看屏幕两边时自然会带一点转头，别一转就唠叨
const THR: Record<Axis, number> = { z: 0.12, x: 0.4, y: 0.35, roll: 0.25, yaw: 0.65 }

export function adviseHead(cur: HeadPos, ref: HeadPos, slack = 1): HeadAdvice {
  const issues: HeadIssue[] = []
  const dz = cur.w / ref.w - 1
  const lz = Math.abs(dz) / (THR.z * slack)
  if (lz >= 1) issues.push({ axis: 'z', level: lz, text: dz > 0 ? (lz > 2.5 ? '往后靠多一些' : '往后靠一点') : lz > 2.5 ? '往前凑多一些' : '往前凑一点' })
  if (Number.isFinite(ref.cx) && Number.isFinite(ref.cy)) {
    // 坐标已镜像：cx 变大 = 人往自己的右边挪了
    const dx = (cur.cx - ref.cx) / ref.w
    const lx = Math.abs(dx) / (THR.x * slack)
    if (lx >= 1) issues.push({ axis: 'x', level: lx, text: dx > 0 ? '往左挪一点' : '往右挪一点' })
    const dy = (cur.cy - ref.cy) / ref.w
    const ly = Math.abs(dy) / (THR.y * slack)
    if (ly >= 1) issues.push({ axis: 'y', level: ly, text: dy > 0 ? '坐高一点' : '往下坐一点' })
  }
  // 转角：校准时记下了才比（老校准没有）；排在位置后面，同样偏多少时先提位置
  if (cur.roll != null && ref.roll != null) {
    const d = cur.roll - ref.roll
    const l = (Math.abs(d) / (THR.roll * slack)) * 0.9
    if (l >= 0.9) issues.push({ axis: 'roll', level: l, text: '头摆正一点，别歪着' })
  }
  if (cur.yaw != null && ref.yaw != null) {
    const d = cur.yaw - ref.yaw
    const l = (Math.abs(d) / (THR.yaw * slack)) * 0.9
    if (l >= 0.9) issues.push({ axis: 'yaw', level: l, text: '脸转回来，正对屏幕' })
  }
  issues.sort((a, b) => b.level - a.level)
  return {
    issues,
    main: issues[0]?.text ?? null,
    sub: issues.length > 1 ? '再' + issues.slice(1).map((i) => i.text).join('，') : null
  }
}

/** 当前提醒状态，给顶栏的小药丸读 */
export const headAdviceStore = createStore<{ advice: HeadAdvice | null; lost: boolean }>({ advice: null, lost: false })
