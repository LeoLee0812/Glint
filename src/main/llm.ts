import { net } from 'electron'
import type { ChatContentPart, ChatMessageIn, LlmDone, LlmRequest, Provider } from '../shared/types'
import { getProvider } from './settings'

// 大模型流式调用：放在主进程用 net.fetch，走 Chromium 网络栈（认系统代理、没有跨域问题、Key 不进渲染进程）

const running = new Map<string, AbortController>()

type Emit = (channel: 'llm:delta' | 'llm:done', payload: unknown) => void

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

function dataUrlParts(dataUrl: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: 'image/png', data: dataUrl }
}

function toOpenAIContent(content: string | ChatContentPart[]): unknown {
  if (typeof content === 'string') return content
  return content.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } }
  )
}

function toAnthropicContent(content: string | ChatContentPart[]): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    const { mediaType, data } = dataUrlParts(p.dataUrl)
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
  })
}

function buildRequest(provider: Provider, req: LlmRequest, stream: boolean): { url: string; init: RequestInit } {
  if (provider.kind === 'anthropic') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': provider.apiKey
    }
    // 第三方 Anthropic 兼容网关（如百炼）用 Bearer 鉴权，官方用 x-api-key
    if (!/api\.anthropic\.com/.test(provider.baseUrl)) headers.authorization = `Bearer ${provider.apiKey}`
    const base = provider.baseUrl.replace(/\/v1\/?$/, '')
    return {
      url: joinUrl(base, '/v1/messages'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model.model,
          system: req.system,
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature ?? 0.4,
          stream,
          messages: req.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
          ...(provider.extraBody || {})
        })
      }
    }
  }
  const messages: Array<{ role: string; content: unknown }> = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) messages.push({ role: m.role, content: toOpenAIContent(m.content) })
  const body: Record<string, unknown> = {
    model: req.model.model,
    messages,
    stream,
    temperature: req.temperature ?? 0.4,
    ...(provider.extraBody || {})
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (stream) body.stream_options = { include_usage: true }
  return {
    url: joinUrl(provider.baseUrl, '/chat/completions'),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body)
    }
  }
}

/** 逐行读 SSE，把 data: 后面的 JSON 交给 onData */
async function readSSE(body: ReadableStream<Uint8Array>, onData: (json: any, event?: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event: string | undefined
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line) {
        event = undefined
        continue
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        onData(JSON.parse(data), event)
      } catch {
        /* 半截 JSON 或心跳，跳过 */
      }
    }
  }
}

export async function startStream(req: LlmRequest, emit: Emit): Promise<void> {
  const t0 = Date.now()
  const provider = getProvider(req.model.providerId)
  const done = (extra: Partial<LlmDone>) => emit('llm:done', { reqId: req.reqId, ms: Date.now() - t0, ...extra })
  if (!provider) return done({ error: `找不到服务商 ${req.model.providerId}` })
  if (!provider.apiKey) return done({ error: `「${provider.name}」还没填 API Key，去设置里填一下` })

  const ac = new AbortController()
  running.set(req.reqId, ac)
  const usage: { input?: number; output?: number } = {}
  try {
    const { url, init } = buildRequest(provider, req, true)
    const res = await net.fetch(url, { ...init, signal: ac.signal })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      return done({ error: `HTTP ${res.status}：${text.slice(0, 400)}` })
    }
    await readSSE(res.body, (j, event) => {
      if (provider.kind === 'anthropic') {
        if (event === 'content_block_delta' || j.type === 'content_block_delta') {
          const d = j.delta || {}
          if (d.type === 'text_delta' && d.text) emit('llm:delta', { reqId: req.reqId, text: d.text })
          if (d.type === 'thinking_delta' && d.thinking) emit('llm:delta', { reqId: req.reqId, reasoning: d.thinking })
        } else if (j.type === 'message_start') {
          usage.input = j.message?.usage?.input_tokens
        } else if (j.type === 'message_delta') {
          usage.output = j.usage?.output_tokens
        } else if (j.type === 'error') {
          throw new Error(j.error?.message || '服务端错误')
        }
        return
      }
      const choice = j.choices?.[0]
      const delta = choice?.delta || {}
      if (delta.content) emit('llm:delta', { reqId: req.reqId, text: delta.content })
      if (delta.reasoning_content) emit('llm:delta', { reqId: req.reqId, reasoning: delta.reasoning_content })
      if (j.usage) {
        usage.input = j.usage.prompt_tokens
        usage.output = j.usage.completion_tokens
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
    })
    done({ usage })
  } catch (e: any) {
    if (ac.signal.aborted) done({ error: 'aborted' })
    else done({ error: e?.message || String(e) })
  } finally {
    running.delete(req.reqId)
  }
}

export function abortStream(reqId: string): void {
  running.get(reqId)?.abort()
}

/** 非流式一次性调用，给 Jev 路由之外的小任务（如生成标题）用 */
export async function completeOnce(req: Omit<LlmRequest, 'reqId'>): Promise<string> {
  const provider = getProvider(req.model.providerId)
  if (!provider?.apiKey) throw new Error('服务商未配置')
  const { url, init } = buildRequest(provider, { ...req, reqId: 'once' }, false)
  const res = await net.fetch(url, init)
  const j: any = await res.json()
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`)
  if (provider.kind === 'anthropic') return (j.content || []).map((c: any) => c.text || '').join('')
  return j.choices?.[0]?.message?.content || ''
}

/** 拉服务商的模型列表（设置页「获取模型」按钮） */
export async function listModels(provider: Provider): Promise<string[]> {
  const headers: Record<string, string> =
    provider.kind === 'anthropic'
      ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${provider.apiKey}` }
  const base = provider.kind === 'anthropic' ? provider.baseUrl.replace(/\/v1\/?$/, '') + '/v1' : provider.baseUrl
  const res = await net.fetch(joinUrl(base, '/models'), { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j: any = await res.json()
  const list: any[] = j.data || j.models || []
  return list.map((m) => m.id || m.name).filter(Boolean).sort()
}

/** 连通性测试：发一句固定问候，返回耗时和回复片段 */
export async function testProvider(provider: Provider, model: string): Promise<{ ok: boolean; ms: number; text?: string; error?: string }> {
  const t0 = Date.now()
  try {
    const { url, init } = buildRequest(
      provider,
      { reqId: 'test', model: { providerId: provider.id, model }, system: '', messages: [{ role: 'user', content: '只回复两个字：你好' } as ChatMessageIn], maxTokens: 16 },
      false
    )
    const res = await net.fetch(url, init)
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, ms: Date.now() - t0, error: j?.error?.message || `HTTP ${res.status}` }
    const text = provider.kind === 'anthropic' ? (j.content || []).map((c: any) => c.text || '').join('') : j.choices?.[0]?.message?.content
    return { ok: true, ms: Date.now() - t0, text }
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) }
  }
}
