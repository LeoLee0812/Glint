// Glint Eye 在平板上的取流：系统不认外接摄像头，原生层（UvcCamera.kt）自己读 USB，页面按序号取 JPEG，画到画布上再当摄像头流用。
// 这样后面的旋转、人脸检测、校准预览都和桌面版走同一条路

interface UvcResult {
  state: 'open' | 'none' | 'denied' | 'error'
  w: number
  h: number
  error: string
}

/** 只有最新的一路才能关原生层：重连时旧循环会晚一点才退出，不能把新开的关掉 */
let session = 0

export async function openUvcStream(): Promise<MediaStream> {
  const me = ++session
  const la = window.lookask as unknown as { uvc: { open: () => Promise<UvcResult>; close: () => void; onLost: (f: () => void) => () => void } }
  const r = await la.uvc.open()
  const fail = (msg: string): Error => Object.assign(new Error(msg), { name: 'NotFoundError', custom: true })
  if (r.state === 'none') throw fail('没找到 Glint Eye，插上了吗')
  if (r.state === 'denied') throw fail('没给 USB 权限，重新插一下 Glint Eye 再点允许')
  if (r.state === 'error') throw fail(`Glint Eye 打不开：${r.error}`)

  const canvas = document.createElement('canvas')
  canvas.width = r.w
  canvas.height = r.h
  const ctx = canvas.getContext('2d')!
  // 先铺一帧，captureStream 才有画面
  ctx.fillRect(0, 0, r.w, r.h)
  const stream = canvas.captureStream(30)
  const track = stream.getVideoTracks()[0]
  const offLost = la.uvc.onLost(() => track.dispatchEvent(new Event('ended')))

  void (async () => {
    let seq = 0
    while (track.readyState === 'live') {
      try {
        const res = await fetch(`/uvc/frame?after=${seq}`, { cache: 'no-store' })
        if (res.status !== 200) continue
        seq = Number(res.headers.get('x-seq')) || seq + 1
        const bmp = await createImageBitmap(await res.blob())
        ctx.drawImage(bmp, 0, 0, r.w, r.h)
        bmp.close()
      } catch (e) {
        // 个别帧 JPEG 不完整，跳过
        console.warn('[uvc] 丢一帧', e)
      }
    }
    offLost()
    if (me === session) la.uvc.close()
  })()
  return stream
}
