import { app, nativeImage, net } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings } from './settings'

// 实时小人：把拍的大头照交给图生图接口（默认 OpenLux 中转的 gpt-image-2，走 OpenAI 兼容的 images/edits），
// 变成一个 Q 版卡通形象，缩到 512 存在 userData/avatar.png。照片本身不落盘

const PROMPT = [
  'Turn the person in this photo into a cute chibi 3D cartoon avatar, in the style of a Pixar character / Pop Mart blind-box vinyl figure:',
  'oversized round head, small shoulders, big friendly eyes, soft clean shading, smooth toy-like finish.',
  'Keep the person recognizable: same hairstyle and hair color, face shape, skin tone, glasses and accessories if any, and the same clothing color.',
  'Facing the camera straight on, relaxed friendly expression, head and shoulders only, centered, the head fills most of the frame.',
  'Plain very light gray background (#F2F2F7). No text, no border, no extra objects.'
].join(' ')

const OUT_SIZE = 512

let running = false

export function avatarPath(): string {
  return join(app.getPath('userData'), 'avatar.png')
}

export function loadAvatar(): string | null {
  const p = avatarPath()
  if (!existsSync(p)) return null
  try {
    return `data:image/png;base64,${readFileSync(p).toString('base64')}`
  } catch {
    return null
  }
}

export function clearAvatar(): void {
  try {
    unlinkSync(avatarPath())
  } catch {
    /* 本来就没有 */
  }
}

/** 手拼 multipart/form-data：net.fetch 对 FormData 的支持因版本而异，自己拼最稳 */
function multipart(fields: Record<string, string>, file: { name: string; filename: string; type: string; data: Buffer }): { body: Buffer; boundary: string } {
  const boundary = `----LookAsk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`, 'utf8'))
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), boundary }
}

/** 大头照（PNG dataURL）→ 卡通小人（PNG dataURL），同时存盘；约 40～60 秒 */
export async function generateAvatar(photo: string): Promise<{ dataUrl: string; ms: number } | { error: string }> {
  if (running) return { error: '上一个小人还在生成，等它画完' }
  const t0 = Date.now()
  const s = loadSettings()
  const cfg = s.avatar
  const p = s.providers.find((x) => x.id === cfg.providerId)
  if (!p) return { error: `找不到图生图服务商「${cfg.providerId}」，去设置 → 眼动 → 实时小人里选一个` }
  if (p.kind !== 'openai') return { error: `「${p.name}」不是 OpenAI 兼容接口，图生图用不了` }
  if (!p.apiKey) return { error: `「${p.name}」还没填 API Key` }
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(photo)
  if (!m) return { error: '照片格式不对' }

  running = true
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 240_000)
  try {
    const { body, boundary } = multipart(
      { model: cfg.model, prompt: PROMPT, size: '1024x1024', quality: cfg.quality, n: '1' },
      { name: 'image[]', filename: 'headshot.png', type: 'image/png', data: Buffer.from(m[1], 'base64') }
    )
    const res = await net.fetch(p.baseUrl.replace(/\/+$/, '') + '/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: ac.signal
    })
    const text = await res.text()
    if (!res.ok) return { error: `HTTP ${res.status}：${text.slice(0, 300)}` }
    let j: any
    try {
      j = JSON.parse(text)
    } catch {
      return { error: `接口返回的不是 JSON：${text.slice(0, 200)}` }
    }
    const item = j?.data?.[0]
    let buf: Buffer
    if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    else if (item?.url) {
      // 个别中转偶尔回 url 不回 base64
      const r = await net.fetch(item.url, { signal: ac.signal })
      if (!r.ok) return { error: `下载生成的图失败：HTTP ${r.status}` }
      buf = Buffer.from(await r.arrayBuffer())
    } else return { error: `接口没返回图片：${JSON.stringify(j?.error || j).slice(0, 300)}` }
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return { error: '生成的图片解不开' }
    const png = img.resize({ width: OUT_SIZE, height: OUT_SIZE, quality: 'best' }).toPNG()
    writeFileSync(avatarPath(), png)
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, ms: Date.now() - t0 }
  } catch (e: any) {
    return { error: ac.signal.aborted ? '等了 4 分钟还没画完，稍后再试' : e?.message || String(e) }
  } finally {
    clearTimeout(timer)
    running = false
  }
}
