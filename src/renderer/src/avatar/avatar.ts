import { createStore } from '../store'
import { la, toast, rumble } from '../appState'
import { gaze } from '../gaze/engine'

// 实时小人的形象：启动时从本地读；拍一张大头照 → 主进程调图生图变成 Q 版卡通 → 存下来一直用

export const avatarStore = createStore<{
  /** 生成好的卡通形象（dataURL），还没有就用内置的默认小人 */
  img: string | null
  busy: boolean
  /** 这次生成从什么时候开始（Date.now），给进度显示用 */
  since: number
  error: string | null
}>({ img: null, busy: false, since: 0, error: null })

export async function loadAvatar(): Promise<void> {
  avatarStore.patch({ img: await la.avatar.get() })
}

/**
 * 从正在跑的摄像头画面里按人脸框裁一张方形大头照：以脸为中心稍微往上（带上头发），
 * 边长约 2.3 个脸高，镜像成照镜子的方向（和校准预览、小人的方向一致）。没看到脸就是 null
 */
export function takeHeadshot(size = 768): string | null {
  const v = gaze.video
  const box = gaze.lastFaceBox
  // 人脸检测偶尔掉一两帧不要紧，0.7 秒内看到过脸就按那一刻的框裁
  if (!box || performance.now() - gaze.lastFaceBoxAt > 700 || v.readyState < 2 || !v.videoWidth) return null
  const vw = v.videoWidth
  const vh = v.videoHeight
  const fw = box.w * vw
  const fh = box.h * vh
  const side = Math.min(Math.max(fw, fh) * 2.3, vw, vh)
  const cx = (box.x + box.w / 2) * vw
  const cy = (box.y + box.h / 2) * vh - fh * 0.12
  const x = Math.max(0, Math.min(vw - side, cx - side / 2))
  const y = Math.max(0, Math.min(vh - side, cy - side / 2))
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const g = cv.getContext('2d')!
  g.translate(size, 0)
  g.scale(-1, 1)
  g.drawImage(v, x, y, side, side, 0, 0, size, size)
  return cv.toDataURL('image/png')
}

/** 大头照 → 卡通小人（约半分钟）；生成期间可以关掉拍照窗口，画好了会提示 */
export async function generateAvatar(photo: string): Promise<boolean> {
  if (avatarStore.get().busy) return false
  avatarStore.patch({ busy: true, since: Date.now(), error: null })
  const r = await la.avatar.generate(photo)
  if ('error' in r) {
    avatarStore.patch({ busy: false, error: r.error })
    toast(`小人没画出来：${r.error.slice(0, 140)}`, 'error', { ttl: 9000 })
    return false
  }
  avatarStore.patch({ busy: false, img: r.dataUrl, error: null })
  toast(`你的小人画好了（用了 ${Math.round(r.ms / 1000)} 秒）`, 'ok')
  rumble('done')
  return true
}

export async function clearAvatar(): Promise<void> {
  await la.avatar.clear()
  avatarStore.patch({ img: null })
}
