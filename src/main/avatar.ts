import { app, nativeImage, net } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings } from './settings'

// 实时小人：把拍的大头照交给阿里云百炼的千问图像编辑模型（默认 qwen-image-3.0-pro，走百炼原生的多模态生成接口），
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

/** 百炼原生接口的地址：从服务商的 OpenAI 兼容地址（…/compatible-mode/v1）取域名，老域名和按业务空间分的新域名都适用 */
function dashscopeUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    if (!/aliyuncs\.com$/.test(u.hostname)) return null
    return `${u.origin}/api/v1/services/aigc/multimodal-generation/generation`
  } catch {
    return null
  }
}

/** 大头照（PNG dataURL）→ 卡通小人（PNG dataURL），同时存盘；一般半分钟 */
export async function generateAvatar(photo: string): Promise<{ dataUrl: string; ms: number } | { error: string }> {
  if (running) return { error: '上一个小人还在生成，等它画完' }
  const t0 = Date.now()
  const s = loadSettings()
  const cfg = s.avatar
  const p = s.providers.find((x) => x.id === cfg.providerId)
  if (!p) return { error: `找不到服务商「${cfg.providerId}」，去设置 → 眼动 → 实时小人里选一个` }
  const url = dashscopeUrl(p.baseUrl)
  if (!url) return { error: `「${p.name}」不是阿里云百炼的地址，小人只能用百炼的千问图像模型画` }
  if (!p.apiKey) return { error: `「${p.name}」还没填 API Key` }
  if (!/^data:image\/\w+;base64,/.test(photo)) return { error: '照片格式不对' }

  running = true
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 180_000)
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        input: { messages: [{ role: 'user', content: [{ image: photo }, { text: PROMPT }] }] },
        // 提示词已经写得很细，不让百炼再改写；不加水印
        parameters: { n: 1, size: '1024*1024', prompt_extend: false, watermark: false }
      }),
      signal: ac.signal
    })
    const text = await res.text()
    let j: any
    try {
      j = JSON.parse(text)
    } catch {
      return { error: `HTTP ${res.status}：${text.slice(0, 200)}` }
    }
    if (!res.ok || j?.code) return { error: `${j?.code || `HTTP ${res.status}`}：${j?.message || text.slice(0, 200)}` }
    // 百炼只回一个 24 小时有效的图片链接，当场下载
    const imgUrl: string | undefined = j?.output?.choices?.[0]?.message?.content?.find((c: any) => c?.image)?.image
    if (!imgUrl) return { error: `接口没返回图片：${text.slice(0, 300)}` }
    const r = await net.fetch(imgUrl, { signal: ac.signal })
    if (!r.ok) return { error: `下载生成的图失败：HTTP ${r.status}` }
    const img = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer()))
    if (img.isEmpty()) return { error: '生成的图片解不开' }
    const png = img.resize({ width: OUT_SIZE, height: OUT_SIZE, quality: 'best' }).toPNG()
    writeFileSync(avatarPath(), png)
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, ms: Date.now() - t0 }
  } catch (e: any) {
    return { error: ac.signal.aborted ? '等了 3 分钟还没画完，稍后再试' : e?.message || String(e) }
  } finally {
    clearTimeout(timer)
    running = false
  }
}
