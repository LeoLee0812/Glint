import { fitRidge, type FitInput } from './ridge'

// 放在 Worker 里拟合，校准收尾时界面和摄像头循环不卡
self.onmessage = (e: MessageEvent<FitInput>) => {
  try {
    const t0 = performance.now()
    const model = fitRidge(e.data)
    ;(self as unknown as Worker).postMessage({ ok: true, model, ms: performance.now() - t0 })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: String(err) })
  }
}
