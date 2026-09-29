import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// 在卡通小人图上找 478 个脸部关键点（2.5D 网格的骨架）。MediaPipe 对这种皮克斯风的卡通脸也认得准。
// 只在换了小人时跑一次：单独开一个图片模式的识别器，用完就关；结果按图片指纹存 localStorage

const CACHE_KEY = 'lookask.avatarLandmarks.v1'

/** 图片 dataURL 的指纹：长度 + 抽样哈希，够区分不同的小人 */
function signature(src: string): string {
  let h = 0x811c9dc5
  const stride = Math.max(1, Math.floor(src.length / 4096))
  for (let i = 0; i < src.length; i += stride) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${src.length}:${h.toString(16)}`
}

export async function avatarLandmarks(src: string, img: HTMLImageElement): Promise<number[][] | null> {
  const sig = signature(src)
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (hit?.sig === sig && Array.isArray(hit.lm)) return hit.lm.length >= 478 ? hit.lm : null
  } catch {
    /* 缓存坏了就重算 */
  }
  const base = new URL('./mediapipe/', window.location.href).href
  const fileset = await FilesetResolver.forVisionTasks(base.replace(/\/$/, ''))
  const det = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.3,
    minFacePresenceConfidence: 0.3
  })
  try {
    const r = det.detect(img)
    const lm = r.faceLandmarks?.[0]
    const out = lm && lm.length >= 478 ? lm.map((p) => [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]) : null
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ sig, lm: out ?? [] }))
    } catch {
      /* 存不下就下次再算 */
    }
    return out
  } finally {
    det.close()
  }
}
