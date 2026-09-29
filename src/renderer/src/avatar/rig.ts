import Delaunator from 'delaunator'

// 2.5D 小人（自动绑定）：一张正脸卡通图 → 能真转头、眨眼、张嘴、转眼珠的三角网格，思路和 Live2D 一样但不用手工绑骨
// - 顶点 = 卡通图上 MediaPipe 找到的 478 个脸部关键点（自带深度）+ 头发 / 耳朵 / 身体 / 轮廓外补的点
// - 头按三维转角绕脖子上端转，再带一点透视投影：转过去的一侧自然压扁、被鼻子挡住（画的时候开深度测试）
// - 头发跟一个更慢、更软的弹簧转（甩一下再回来），身体只跟一小部分，脖子处平滑过渡
// - 眨眼 = 上眼皮往下盖（上面的皮肤跟着拉下来）、眼珠收成一条线；张嘴 = 下唇和下巴往下拉，唇缝里补一块深色口腔
// 前 478 个顶点就是 MediaPipe 的关键点编号，后面是补的点。坐标系：x 朝右、y 朝下、z 朝屏幕里（越小越靠近观众）

/** 每一帧驱动小人的量：转角是弧度（yaw 正 = 转向画面右边，pitch 正 = 抬头，roll 正 = 顺时针歪），其余 0~1 */
export interface RigPose {
  yaw: number
  pitch: number
  roll: number
  /** 头发跟着的转角（比头慢半拍） */
  hairYaw: number
  hairPitch: number
  hairRoll: number
  blink: number
  /** 眼珠往哪看，-1~1（右 / 下为正） */
  lookX: number
  lookY: number
  jaw: number
  brow: number
  /** 呼吸 -1~1 */
  breath: number
}

/** 关节：竖轴过 (x, z)；抬低头的横轴高度 pitchY；歪头的轴高度 rollY */
interface Joint {
  x: number
  z: number
  pitchY: number
  rollY: number
}

interface EyeRig {
  upper: number[]
  lower: number[]
  iris: number[]
  /** 眼睛宽度（像素） */
  w: number
}

export interface AvatarRig {
  w: number
  h: number
  n: number
  /** 静止姿态：每个顶点 x, y, z（像素） */
  rest: Float32Array
  uv: Float32Array
  /** 贴图的三角形 */
  tris: Uint16Array
  /** 口腔（张嘴时露出来，涂深色） */
  mouthTris: Uint16Array
  /** 每个顶点跟头 / 头发 / 身体走的比例（加起来是 1） */
  wHead: Float32Array
  wHair: Float32Array
  wBody: Float32Array
  /** 张嘴时往下拉的比例 */
  wJaw: Float32Array
  /** 头的关节：点头绕高一点的横轴，歪头绕低一点的轴（整段脖子在弯），左右转绕竖轴 */
  headJoint: Joint
  bodyJoint: Joint
  /** 透视焦距（像素） */
  f: number
  depthScale: number
  /** 背景色（0~1），清屏用 */
  bg: [number, number, number]
  eyes: EyeRig[]
  brows: number[]
  browLift: number
  jawOpen: number
  /** 呼吸时身体 / 头往上抬多少像素 */
  breathLift: number
  work: Float32Array
}

// ---------- MediaPipe 关键点编号 ----------

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
// 上下眼皮一一配对（外眼角 → 内眼角）；画面左边那只眼睛（人的右眼）配 468 号虹膜
const EYES = [
  { upper: [246, 161, 160, 159, 158, 157, 173], lower: [7, 163, 144, 145, 153, 154, 155], corners: [33, 133], iris: [468, 469, 470, 471, 472] },
  { upper: [466, 388, 387, 386, 385, 384, 398], lower: [249, 390, 373, 374, 380, 381, 382], corners: [263, 362], iris: [473, 474, 475, 476, 477] }
]
const LIP_INNER_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
const LIP_INNER_LOW = [95, 88, 178, 87, 14, 317, 402, 318, 324]
const LIP_UP_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
const MOUTH_CORNERS = [61, 291, 78, 308]
const BROWS = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276]

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function inPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distToPoly(x: number, y: number, poly: Array<[number, number]>): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]
    const [bx, by] = poly[i]
    const dx = bx - ax
    const dy = by - ay
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1)
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return best
}

/**
 * 前景掩码（头 + 身体）：图生图时要求背景是纯浅灰，按和边上颜色的差分出来，再从上 / 左 / 右边往里灌水，
 * 连得上边框的才算背景（脸上的浅色高光不会被当成背景）
 */
function foreground(img: CanvasImageSource, G: number): { fg: Uint8Array; bg: [number, number, number] } {
  const cv = document.createElement('canvas')
  cv.width = G
  cv.height = G
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0, G, G)
  const px = g.getImageData(0, 0, G, G).data
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * G + x) * 4
    return [px[i], px[i + 1], px[i + 2]]
  }
  // 边上的颜色（不含底边：底下是衣服）取中位数当背景色
  const edge: Array<[number, number, number]> = []
  for (let i = 0; i < G; i++) edge.push(at(i, 0))
  for (let i = 0; i < (G * 3) / 5; i++) edge.push(at(0, i), at(G - 1, i))
  const med = (k: number) => edge.map((c) => c[k]).sort((a, b) => a - b)[edge.length >> 1]
  const bg: [number, number, number] = [med(0), med(1), med(2)]
  const near = (x: number, y: number) => {
    const c = at(x, y)
    return Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) < 26
  }
  const isBg = new Uint8Array(G * G)
  const stack: number[] = []
  const seed = (x: number, y: number) => {
    const i = y * G + x
    if (!isBg[i] && near(x, y)) {
      isBg[i] = 1
      stack.push(i)
    }
  }
  for (let i = 0; i < G; i++) seed(i, 0)
  for (let i = 0; i < G; i++) {
    seed(0, i)
    seed(G - 1, i)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % G
    const y = (i / G) | 0
    if (x > 0) seed(x - 1, y)
    if (x < G - 1) seed(x + 1, y)
    if (y > 0) seed(x, y - 1)
    if (y < G - 1) seed(x, y + 1)
  }
  const fg = new Uint8Array(G * G)
  for (let i = 0; i < G * G; i++) fg[i] = isBg[i] ? 0 : 1
  return { fg, bg: [bg[0] / 255, bg[1] / 255, bg[2] / 255] }
}

/** 卡通图 + 它的 478 个关键点（MediaPipe 的归一化坐标）→ 网格；关键点明显不对（比如没找到脸）返回 null */
export function buildRig(img: CanvasImageSource & { width: number; height: number }, lm: ArrayLike<ArrayLike<number>>): AvatarRig | null {
  if (!lm || lm.length < 478) return null
  const W = img.width
  const H = img.height
  const P: Array<[number, number, number]> = []
  for (let i = 0; i < 478; i++) P.push([lm[i][0] * W, lm[i][1] * H, lm[i][2] * W])

  const G = 64
  const { fg, bg } = foreground(img, G)
  const cell = (x: number, y: number) => clamp(Math.floor((y / H) * G), 0, G - 1) * G + clamp(Math.floor((x / W) * G), 0, G - 1)
  const fgAt = (x: number, y: number) => fg[cell(x, y)] === 1
  // 往外扩 r 格：轮廓上的抗锯齿像素也包进网格
  const fgNear = (x: number, y: number, r = 1) => {
    const cx = clamp(Math.floor((x / W) * G), 0, G - 1)
    const cy = clamp(Math.floor((y / H) * G), 0, G - 1)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const X = cx + dx
        const Y = cy + dy
        if (X >= 0 && Y >= 0 && X < G && Y < G && fg[Y * G + X]) return true
      }
    return false
  }

  // ---------- 脸和头的尺寸 ----------
  const chinY = P[152][1]
  const faceW = Math.abs(P[454][0] - P[234][0])
  const faceH = chinY - P[10][1]
  if (!(faceW > W * 0.12 && faceH > H * 0.12)) return null
  const cx = (P[234][0] + P[454][0]) / 2
  let headTop = P[10][1] - faceH * 0.2
  for (let y = 0; y < P[10][1]; y += H / G) {
    if (fgAt(cx, y)) {
      headTop = y
      break
    }
  }
  const eyeRowY = P[168][1]
  let left = P[234][0]
  let right = P[454][0]
  for (let x = P[234][0]; x > Math.max(0, cx - faceW * 1.3); x -= W / G) if (fgAt(x, eyeRowY)) left = x
  for (let x = P[454][0]; x < Math.min(W, cx + faceW * 1.3); x += W / G) if (fgAt(x, eyeRowY)) right = x
  const rx = Math.max(faceW * 0.55, (right - left) / 2)
  const cy = (headTop + chinY) / 2
  const ry = Math.max(faceH * 0.55, (chinY - headTop) / 2)
  const rz = rx * 0.95
  const zc = (P[234][2] + P[454][2]) / 2 + rx * 0.12
  const neckY = chinY + faceH * 0.08
  const ellipsoidZ = (x: number, y: number) => {
    const u2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
    return zc - rz * Math.sqrt(Math.max(0.03, 1 - u2))
  }

  // ---------- 补点：头发、耳朵、脖子、身体、轮廓外一圈 ----------
  const oval = FACE_OVAL.map((i) => [P[i][0], P[i][1]] as [number, number])
  const extra: Array<[number, number]> = []
  const stepPx = W / 14
  const farFromExtra = (x: number, y: number, d: number) => extra.every((e) => Math.hypot(e[0] - x, e[1] - y) >= d)
  for (let gy = 0; gy <= 14; gy++) {
    for (let gx = 0; gx <= 14; gx++) {
      const x = Math.min(W - 1, gx * stepPx)
      const y = Math.min(H - 1, gy * stepPx)
      if (!fgNear(x, y)) continue
      if (inPoly(x, y, oval) || distToPoly(x, y, oval) < stepPx * 0.45) continue
      extra.push([x, y])
    }
  }
  // 脸轮廓外面贴一圈（沿法线往外 6% 脸宽）：下巴、腮帮子外沿那一窄条皮肤也有顶点，不会被切成锯齿
  for (let k = 0; k < oval.length; k++) {
    const [x0, y0] = oval[(k + oval.length - 1) % oval.length]
    const [x1, y1] = oval[k]
    const [x2, y2] = oval[(k + 1) % oval.length]
    let nx = y2 - y0
    let ny = -(x2 - x0)
    const len = Math.hypot(nx, ny) || 1
    nx /= len
    ny /= len
    // 法线朝外：离脸中心更远的那一侧
    if ((x1 - cx) * nx + (y1 - (P[10][1] + chinY) / 2) * ny < 0) {
      nx = -nx
      ny = -ny
    }
    const px = x1 + nx * faceW * 0.06
    const py = y1 + ny * faceW * 0.06
    if (px < 0 || py < 0 || px >= W || py >= H || !fgNear(px, py)) continue
    if (farFromExtra(px, py, faceW * 0.05)) extra.push([px, py])
  }
  // 轮廓正外面一圈（背景格子里挨着前景的）
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      if (fg[y * G + x] || (x + y) % 2) continue
      const touch = (x > 0 && fg[y * G + x - 1]) || (x < G - 1 && fg[y * G + x + 1]) || (y > 0 && fg[(y - 1) * G + x]) || (y < G - 1 && fg[(y + 1) * G + x])
      if (!touch) continue
      const px = ((x + 0.5) / G) * W
      const py = ((y + 0.5) / G) * H
      if (farFromExtra(px, py, stepPx * 0.35)) extra.push([px, py])
    }
  }

  const n = 478 + extra.length
  const rest = new Float32Array(n * 3)
  for (let i = 0; i < 478; i++) rest.set(P[i], i * 3)
  const wHead = new Float32Array(n)
  const wHair = new Float32Array(n)
  const wBody = new Float32Array(n)
  for (let i = 0; i < 478; i++) wHead[i] = 1
  extra.forEach(([x, y], k) => {
    const i = 478 + k
    // 下巴正下方是脖子：一出下巴就开始少跟头转（不然一转头，脖子被下巴拖走、露出一块背景）；
    // 两边（耳朵、垂下来的头发）到肩膀才换成跟身体
    const under = 1 - smoothstep(faceW * 0.24, faceW * 0.4, Math.abs(x - cx))
    const neckHead = 1 - smoothstep(chinY - faceH * 0.02, chinY + faceH * 0.22, y)
    const sideHead = 1 - smoothstep(neckY - faceH * 0.02, neckY + faceH * 0.28, y)
    const headness = under * neckHead + (1 - under) * sideHead
    const hair = y < chinY ? clamp(distToPoly(x, y, oval) / (faceW * 0.35), 0, 1) * 0.85 : 0
    wHead[i] = headness * (1 - hair)
    wHair[i] = headness * hair
    wBody[i] = 1 - headness
    const zBody = zc + rz * 0.25
    // 贴着脸的点深度要和最近的脸轮廓点接上（MediaPipe 的深度和假想的头椭球对不齐，
    // 直接用椭球，一转头脸边和头发之间就会折出一道缝），离脸越远越接近椭球
    let near = FACE_OVAL[0]
    let nd = Infinity
    for (const j of FACE_OVAL) {
      const d = Math.hypot(P[j][0] - x, P[j][1] - y)
      if (d < nd) {
        nd = d
        near = j
      }
    }
    const tz = smoothstep(0, faceW * 0.4, nd)
    const zHead = P[near][2] * (1 - tz) + ellipsoidZ(x, y) * tz
    rest[i * 3] = x
    rest[i * 3 + 1] = y
    rest[i * 3 + 2] = headness * zHead + (1 - headness) * zBody
  })

  // ---------- 张嘴：下唇、下巴往下拉，越往下巴、越往脸边拉得越少 ----------
  const mouthW = Math.abs(P[291][0] - P[61][0])
  const jawOpen = mouthW * 0.3
  const wJaw = new Float32Array(n)
  const mouthY = (P[13][1] + P[14][1]) / 2
  const upper = new Set([...LIP_INNER_UP, ...LIP_UP_OUTER])
  // 「下半张脸」= 在上唇内缘这条线下面的点（按线判断，不按高度：嘴角附近上唇很薄，按高度会把上唇的点也拉下去）
  const lipLine = LIP_INNER_UP.map((i) => [P[i][0], P[i][1]] as [number, number]).sort((a, b) => a[0] - b[0])
  const lineY = (x: number) => {
    if (x <= lipLine[0][0]) return lipLine[0][1]
    for (let k = 1; k < lipLine.length; k++) {
      const [x1, y1] = lipLine[k]
      if (x <= x1) {
        const [x0, y0] = lipLine[k - 1]
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1)
      }
    }
    return lipLine[lipLine.length - 1][1]
  }
  for (let i = 0; i < 478; i++) {
    const [x, y] = P[i]
    if (upper.has(i) || y <= lineY(x) + 0.3) continue
    const d = clamp((y - mouthY) / (chinY - mouthY || 1), 0, 1)
    const hx = 1 - smoothstep(faceW * 0.28, faceW * 0.52, Math.abs(x - cx))
    wJaw[i] = (1 - 0.45 * d) * hx
  }
  for (const i of LIP_INNER_LOW) wJaw[i] = 1
  for (const i of MOUTH_CORNERS) wJaw[i] = 0.3

  // ---------- 三角剖分：按「嘴张到最大」的样子连，唇缝里只会连出口腔的三角形 ----------
  // 闭着嘴时上下唇几乎重合，直接剖分会有三角形横跨唇缝连到下唇外沿，一张嘴就把嘴唇的贴图拉成一道道竖条
  const coords = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    coords[i * 2] = rest[i * 3]
    coords[i * 2 + 1] = rest[i * 3 + 1] + (i < 478 ? wJaw[i] * jawOpen : 0)
  }
  const del = new Delaunator(coords)
  // 口腔 = 张开时落在内唇圈里的三角形（按位置判断：嘴角那几块三角形带着唇外的点，按顶点判断会漏成一道道亮缝）
  const innerPoly = [...LIP_INNER_UP, ...[...LIP_INNER_LOW].reverse()].map((i) => [coords[i * 2], coords[i * 2 + 1]] as [number, number])
  const tris: number[] = []
  const mouth: number[] = []
  for (let t = 0; t < del.triangles.length; t += 3) {
    const a = del.triangles[t]
    const b = del.triangles[t + 1]
    const c = del.triangles[t + 2]
    const ox = (coords[a * 2] + coords[b * 2] + coords[c * 2]) / 3
    const oy = (coords[a * 2 + 1] + coords[b * 2 + 1] + coords[c * 2 + 1]) / 3
    if (inPoly(ox, oy, innerPoly)) {
      mouth.push(a, b, c)
      continue
    }
    if (a >= 478 || b >= 478 || c >= 478) {
      const mx = (rest[a * 3] + rest[b * 3] + rest[c * 3]) / 3
      const my = (rest[a * 3 + 1] + rest[b * 3 + 1] + rest[c * 3 + 1]) / 3
      // 挨着脸的三角形都留着（里面多出来的只是背景色，和清屏色一样看不出）；离轮廓远的纯背景才丢
      const touchesFace = a < 478 || b < 478 || c < 478
      if (!touchesFace && !fgNear(mx, my, 2)) continue
      const edge = (p: number, q: number) => Math.hypot(rest[p * 3] - rest[q * 3], rest[p * 3 + 1] - rest[q * 3 + 1])
      if (Math.max(edge(a, b), edge(b, c), edge(c, a)) > stepPx * 2.6) continue
    }
    tris.push(a, b, c)
  }

  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = rest[i * 3] / W
    uv[i * 2 + 1] = rest[i * 3 + 1] / H
  }
  return {
    w: W,
    h: H,
    n,
    rest,
    uv,
    tris: Uint16Array.from(tris),
    mouthTris: Uint16Array.from(mouth),
    wHead,
    wHair,
    wBody,
    wJaw,
    // 真人是绕脖子转的，不是绕头的中心：点头是颈椎最上面一节在动（轴在鼻子底下那个高度、头中心往后），
    // 歪头是整段脖子在弯（轴在下巴那么低）。绕头的中心转，一歪头下巴就被甩出去、脖子被挤没了
    headJoint: { x: cx, z: zc, pitchY: P[2][1], rollY: chinY - faceH * 0.05 },
    bodyJoint: { x: cx, z: zc + rz * 0.25, pitchY: neckY + faceH * 0.35, rollY: neckY + faceH * 0.35 },
    f: rx * 5,
    depthScale: 1 / (rx * 2.4),
    bg,
    eyes: EYES.map((e) => ({ upper: e.upper, lower: e.lower, iris: e.iris, w: Math.abs(P[e.corners[0]][0] - P[e.corners[1]][0]) })),
    brows: BROWS,
    browLift: faceH * 0.05,
    jawOpen,
    breathLift: H * 0.006,
    work: new Float32Array(n * 3)
  }
}

/** 三个转角的正余弦 */
interface Turn {
  cy: number
  sy: number
  cp: number
  sp: number
  cr: number
  sr: number
}

function turn(yaw: number, pitch: number, roll: number): Turn {
  return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), cr: Math.cos(roll), sr: Math.sin(roll) }
}

/**
 * 一个点按关节转，结果写进 o：先绕抬低头的横轴，再绕竖轴左右转，最后绕歪头的轴
 * （抬低头 y' = y·cp + z·sp、z' = −y·sp + z·cp；左右转 x' = x·cy − z·sy、z' = x·sy + z·cy；歪头 x' = x·cr − y·sr、y' = x·sr + y·cr）
 */
function turnPoint(t: Turn, j: Joint, x: number, y: number, z: number, o: number[]): void {
  let dy = y - j.pitchY
  let dz = z - j.z
  const y1 = j.pitchY + dy * t.cp + dz * t.sp
  const z1 = j.z - dy * t.sp + dz * t.cp
  let dx = x - j.x
  dz = z1 - j.z
  const x2 = j.x + dx * t.cy - dz * t.sy
  o[2] = j.z + dx * t.sy + dz * t.cy
  dx = x2 - j.x
  dy = y1 - j.rollY
  o[0] = j.x + dx * t.cr - dy * t.sr
  o[1] = j.rollY + dx * t.sr + dy * t.cr
}

/** 按这一帧的姿态算每个顶点的屏幕位置（裁剪坐标 x, y 和深度），写进 out（长度 n × 3） */
export function deformRig(r: AvatarRig, p: RigPose, out: Float32Array): void {
  const X = r.work
  X.set(r.rest)
  const rest = r.rest

  // ---------- 表情：在正脸静止姿态里挪点 ----------
  const blink = clamp(p.blink, 0, 1)
  for (const e of r.eyes) {
    let yc = 0
    for (let k = 0; k < e.upper.length; k++) {
      const u = e.upper[k]
      const l = e.lower[k]
      const uy = rest[u * 3 + 1]
      const ly = rest[l * 3 + 1]
      const target = uy + (ly - uy) * 0.78
      X[u * 3 + 1] = uy + (target - uy) * blink
      X[l * 3 + 1] = ly + (target - ly) * blink * 0.25
      yc += target
    }
    yc /= e.upper.length
    const open = 1 - blink
    const dx = clamp(p.lookX, -1, 1) * 0.16 * e.w * open
    const dy = clamp(p.lookY, -1, 1) * 0.1 * e.w * open
    for (const i of e.iris) {
      X[i * 3] += dx
      const y = rest[i * 3 + 1] + dy
      X[i * 3 + 1] = y + (yc - y) * blink
    }
  }
  const brow = clamp(p.brow, 0, 1) * r.browLift
  if (brow) for (const i of r.brows) X[i * 3 + 1] -= brow
  const jaw = clamp(p.jaw, 0, 1) * r.jawOpen
  if (jaw) for (let i = 0; i < 478; i++) if (r.wJaw[i]) X[i * 3 + 1] += jaw * r.wJaw[i]

  // ---------- 转头：头、头发、身体各转各的，按比例混 ----------
  const th = turn(p.yaw, p.pitch, p.roll)
  const tr = turn(p.hairYaw, p.hairPitch, p.hairRoll)
  // 身体只跟一点：歪头时肩膀基本是平的
  const tb = turn(p.yaw * 0.3, 0, p.roll * 0.12)
  const hj = r.headJoint
  const bj = r.bodyJoint
  const lift = p.breath * r.breathLift
  const { f, depthScale, w, h } = r
  const q = [0, 0, 0]
  for (let i = 0; i < r.n; i++) {
    const x = X[i * 3]
    const y = X[i * 3 + 1]
    const z = X[i * 3 + 2]
    const wh = r.wHead[i]
    const wr = r.wHair[i]
    const wb = r.wBody[i]
    let ox = 0
    let oy = 0
    let oz = 0
    if (wh) {
      turnPoint(th, hj, x, y, z, q)
      ox += wh * q[0]
      oy += wh * q[1]
      oz += wh * q[2]
    }
    if (wr) {
      turnPoint(tr, hj, x, y, z, q)
      ox += wr * q[0]
      oy += wr * q[1]
      oz += wr * q[2]
    }
    if (wb) {
      turnPoint(tb, bj, x, y, z, q)
      ox += wb * q[0]
      oy += wb * q[1]
      oz += wb * q[2]
    }
    // 吸气：身体抬得多、头跟着抬一点
    oy -= lift * (wb + (wh + wr) * 0.6)
    // 透视只算「转出来的深度变化」：原图本身已经带着透视，静止时要和原图一模一样
    const s = f / (f + (oz - z))
    const sx = hj.x + (ox - hj.x) * s
    const sy = hj.rollY + (oy - hj.rollY) * s
    out[i * 3] = (sx / w) * 2 - 1
    out[i * 3 + 1] = 1 - (sy / h) * 2
    out[i * 3 + 2] = clamp((oz - hj.z) * depthScale, -0.99, 0.99)
  }
}
