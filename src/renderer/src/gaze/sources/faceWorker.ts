import { FaceDetector, extractCombinedFeatures, type FaceLandmarkerResult } from '@realeye-io/webcam-eyetracker-light-open'

// 平板版的人脸检测放在 worker 里：平板只能用 CPU 推理，一帧几十毫秒，放主线程整个界面都跟着掉帧。
// 收一帧 ImageBitmap，回关键点和特征；姿态、表情这些轻量计算还在主线程，和桌面版同一份代码

let base = ''
let detector: FaceDetector | null = null
let rebuilding = false

async function build(): Promise<void> {
  const d = new FaceDetector({
    modelPath: base + 'face_landmarker.task',
    wasmPath: base.replace(/\/$/, ''),
    mode: 'landmarker',
    // 平板（Adreno + WebView）上 GPU 推理出来的关键点是坏的，几何解算每帧都失败
    delegate: 'CPU',
    runningMode: 'VIDEO'
  })
  await d.initialize()
  detector = d
}

/** MediaPipe 的图出过一次错就一直坏，只能重建 */
function recover(e: unknown): void {
  if (!/Graph has errors|CalculatorGraph/.test(String(e)) || !detector || rebuilding) return
  rebuilding = true
  const old = detector
  detector = null
  try {
    old.close()
  } catch {
    /* 旧图已经坏了 */
  }
  build()
    .catch((err) => console.warn('[gaze] 重建失败', err))
    .finally(() => {
      rebuilding = false
    })
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

self.onmessage = async (e: MessageEvent<{ base?: string; bitmap?: ImageBitmap }>) => {
  if (e.data.base) {
    base = e.data.base
    try {
      await build()
      self.postMessage({ ready: true })
    } catch (err) {
      self.postMessage({ ready: false, error: String(err) })
    }
    return
  }
  const bitmap = e.data.bitmap!
  const vw = bitmap.width
  const vh = bitmap.height
  let det: FaceLandmarkerResult | null = null
  let features: Float64Array | null = null
  try {
    if (detector) {
      if (!canvas || canvas.width !== vw || canvas.height !== vh) {
        canvas = new OffscreenCanvas(vw, vh)
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      }
      ctx!.drawImage(bitmap, 0, 0)
      const img = ctx!.getImageData(0, 0, vw, vh)
      det = detector.detectWithLandmarks(img) as FaceLandmarkerResult | null
      if (det && det.allLandmarks?.length >= 478) {
        features = Float64Array.from(
          extractCombinedFeatures(img, det.boundingBox, det.keypoints, true, det.allLandmarks, vw, vh, 40, 20, det.blendshapes, det.headPose)
        )
      }
    }
  } catch (err) {
    console.warn('[gaze] 处理帧出错', err)
    recover(err)
    det = null
    features = null
  } finally {
    bitmap.close()
  }
  ;(self as unknown as Worker).postMessage({ vw, vh, det, features }, features ? [features.buffer] : [])
}
