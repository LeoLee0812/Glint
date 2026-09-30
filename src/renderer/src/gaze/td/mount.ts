import type { DisplayInfo, TdMount } from '../../../../shared/types'

// iPhone 摆放位置相关的几何：屏幕平面相对镜头的前后偏移、手机挡住屏幕的哪一块（校准点要避开）

/** iPhone 15 Pro 机身（毫米） */
const PHONE_W = 70.6
const PHONE_H = 146.6
/** 竖放在屏幕和键盘之间的缝里时，手机底边比屏幕可视区下沿低多少（下边框 + 转轴） */
const BOTTOM_SINK = 12
/** 挡住区域的余量：左右放歪一点、上沿往上多留一点 */
const MARGIN_X = 15
const MARGIN_Y = 10

export const MOUNT_LABEL: Record<TdMount, string> = {
  bottom: '竖放在屏幕和键盘之间',
  top: '挂在屏幕后面，镜头露出上沿',
  free: '其他位置'
}

/**
 * 屏幕平面在 D 里的 z（米）：
 * 竖放在缝里时手机贴在屏幕前面，镜头比屏幕往前约 1.2 厘米；挂在屏幕后面时镜头比屏幕往后约 0.8 厘米
 */
export function planeOffset(mount: TdMount): number {
  return mount === 'bottom' ? -0.012 : mount === 'top' ? 0.008 : 0
}

/** 屏幕每米多少点 */
export function pointsPerMeter(d: DisplayInfo): number {
  return d.ptW / (d.mmW / 1000)
}

/** 手机挡住的区域（相对显示器左上角的 0~1 坐标）；不挡就是 null */
export function occludedRegion(mount: TdMount, d: DisplayInfo | null): { x0: number; x1: number; y0: number; y1: number } | null {
  if (mount !== 'bottom' || !d || d.mmW <= 0 || d.mmH <= 0) return null
  const half = PHONE_W / 2 + MARGIN_X
  const top = d.mmH - (PHONE_H - BOTTOM_SINK) - MARGIN_Y
  return { x0: 0.5 - half / d.mmW, x1: 0.5 + half / d.mmW, y0: Math.max(0, top / d.mmH), y1: 1 }
}

export function isOccluded(r: ReturnType<typeof occludedRegion>, u: number, v: number): boolean {
  return !!r && u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1
}
