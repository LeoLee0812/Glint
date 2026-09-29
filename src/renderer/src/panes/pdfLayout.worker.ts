// 扫描页的版面切块放在 worker 里做（一页几十毫秒），翻页、滚动时不卡视线光环
import { analyzeLayout, toGray } from './pdfLayout'

self.onmessage = (e: MessageEvent<{ id: number; bitmap: ImageBitmap }>) => {
  const { id, bitmap } = e.data
  try {
    const cv = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = cv.getContext('2d', { willReadFrequently: true })!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, cv.width, cv.height)
    g.drawImage(bitmap, 0, 0)
    bitmap.close()
    const img = g.getImageData(0, 0, cv.width, cv.height)
    const layout = analyzeLayout(toGray(img.data), cv.width, cv.height)
    self.postMessage({ id, layout })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message || err) })
  }
}
