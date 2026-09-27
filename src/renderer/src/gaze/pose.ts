// 头位置、脸上小动作的数据结构和换算（摄像头、原深感两种输入源共用，实时小人和坐姿提醒读它）

/** 头在摄像头画面里的位置（已镜像成「照镜子」的方向，0~1）；w = 脸宽占画面宽度，越大越近 */
export interface HeadPos {
  cx: number
  cy: number
  w: number
  /** 歪头（弧度，镜子里顺时针为正） */
  roll?: number
  /** 左右转头（≈ 1.4 × tan(转角)，转向镜子里的右边为正） */
  yaw?: number
  /** 抬头低头：鼻尖在「两眼连线 → 下巴」之间的位置，越大越低头 */
  pitch?: number
}

/** 脸上的小动作（给实时小人用）：眨眼、张嘴、眼珠往哪看（-1~1，镜子方向） */
export interface FaceExpr {
  blink: number
  mouth: number
  lookX: number
  lookY: number
}

/** 人脸框 → 镜像后的头位置（和校准预览、照镜子的方向一致） */
export function poseOf(b: { x: number; y: number; w: number; h: number }): HeadPos {
  return { cx: 1 - (b.x + b.w / 2), cy: b.y + b.h / 2, w: b.w }
}

/**
 * 从 478 个关键点估头的转角，已镜像成照镜子的方向
 * 33 / 263 = 右眼 / 左眼外眼角，1 = 鼻尖，234 / 454 = 右 / 左脸颊边缘，152 = 下巴
 */
export function rotationOf(lm: Array<{ x: number; y: number }>, vw: number, vh: number): Pick<HeadPos, 'roll' | 'yaw' | 'pitch'> | null {
  const rEye = lm[33]
  const lEye = lm[263]
  const nose = lm[1]
  const rEdge = lm[234]
  const lEdge = lm[454]
  const chin = lm[152]
  if (!rEye || !lEye || !nose || !rEdge || !lEdge || !chin) return null
  // 画面里从人的右眼（在画面左边）指向左眼；镜像后左右翻过来，角度取反
  const roll = -Math.atan2((lEye.y - rEye.y) * vh, (lEye.x - rEye.x) * vw)
  // 鼻尖在两颊之间的位置：正对时约 0.5；人往自己左边转，鼻尖在画面里往右，镜子里是往左转
  const span = lEdge.x - rEdge.x
  const yaw = Math.abs(span) > 1e-4 ? (0.5 - (nose.x - rEdge.x) / span) * 2 : 0
  const eyeY = (rEye.y + lEye.y) / 2
  const down = chin.y - eyeY
  const pitch = Math.abs(down) > 1e-4 ? (nose.y - eyeY) / down : 0.5
  return { roll, yaw, pitch }
}

export function meanPose(list: HeadPos[]): HeadPos | null {
  if (!list.length) return null
  const n = list.length
  const avg = (f: (p: HeadPos) => number) => list.reduce((a, p) => a + f(p), 0) / n
  const out: HeadPos = { cx: avg((p) => p.cx), cy: avg((p) => p.cy), w: avg((p) => p.w) }
  // 转角只在每一帧都有时才平均（老数据没有）
  if (list.every((p) => p.roll != null && p.yaw != null && p.pitch != null)) {
    out.roll = avg((p) => p.roll!)
    out.yaw = avg((p) => p.yaw!)
    out.pitch = avg((p) => p.pitch!)
  }
  return out
}

export function lerpPose(e: HeadPos, p: HeadPos, k: number): HeadPos {
  const out: HeadPos = { cx: e.cx + (p.cx - e.cx) * k, cy: e.cy + (p.cy - e.cy) * k, w: e.w + (p.w - e.w) * k }
  if (p.roll != null) out.roll = e.roll != null ? e.roll + (p.roll - e.roll) * k : p.roll
  if (p.yaw != null) out.yaw = e.yaw != null ? e.yaw + (p.yaw - e.yaw) * k : p.yaw
  if (p.pitch != null) out.pitch = e.pitch != null ? e.pitch + (p.pitch - e.pitch) * k : p.pitch
  return out
}
