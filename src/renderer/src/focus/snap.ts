import { settingsStore } from '../appState'
import type { Box } from './types'

// 吸附强度：一个 0~1 的旋钮（设置 → 眼动），统一决定
// - 视线光环吸词：在多大范围里找词、多普通的词也吸、吸得多牢、扫视多快才松开、换词要多明显更好
// - 软焦点：视线出了当前这段、但没超过多远，还算在这段里（不轻易跳段）
// 0.4 大约是最早的手感，默认 0.7

export const DEFAULT_SNAP = 0.7

export function snapK(): number {
  const k = settingsStore.get().s?.gaze.magnet
  return Math.max(0, Math.min(1, typeof k === 'number' ? k : DEFAULT_SNAP))
}

export interface SnapParams {
  /** 视线周围多大范围（点）里找词 */
  radius: number
  /** 「像关键词」的程度到多少才吸（越低，普通词也会吸） */
  threshold: number
  /** 吸附力度 = base + 词的分数 × slope，封顶 cap */
  base: number
  slope: number
  cap: number
  /** 视线移动快过这个（点/秒）就当在扫视，先不吸 */
  saccade: number
  /** 新词的分数要比当前吸着的词高这么多倍才换过去 */
  switchRatio: number
  /** 视线离开当前吸着的词这么远（点）就松开 */
  release: number
  /** 软焦点：视线出了当前这段但没超过这么远（点），还算这段 */
  stick: number
}

export function snapParams(k = snapK()): SnapParams {
  return {
    radius: 40 + 100 * k,
    threshold: 0.65 - 0.5 * k,
    base: 0.1 + 0.5 * k,
    slope: 0.55 + 0.5 * k,
    cap: Math.min(1, 0.8 + 0.3 * k),
    saccade: 900 * (0.5 + 1.25 * k),
    switchRatio: 1.3 + (k - 0.4),
    release: 110 * (0.5 + 1.25 * k),
    stick: 10 + 50 * k
  }
}

/** 光环此刻吸着的词（视线图层每帧更新，窗口坐标）：推 / 按右摇杆时硬焦点直接落在这个词上 */
export const magnetNow: { box: Box | null; text: string; strength: number; at: number } = { box: null, text: '', strength: 0, at: 0 }
