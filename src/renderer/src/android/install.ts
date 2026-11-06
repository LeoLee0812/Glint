import { createAsr } from '../../../shared/asrCore'
import { createLlm } from '../../../shared/llmCore'
import { AVATAR_MODEL, baseSettings } from '../../../shared/defaults'
import { ISLAND_MS, islandCss, islandHtml } from '../../../shared/island'
import type { BridgeEvent, DisplayInfo, Provider, Rect, Settings, TdStatus } from '../../../shared/types'

// 平板版（Android WebView）：渲染进程和桌面版是同一份代码，这里用原生层（android/ 里的 GlintNative）拼出同样的 window.lookask。
// 必须是 main.tsx 的第一个 import：appState 在模块加载时就要读 window.lookask。桌面版没有 GlintNative，这个文件什么都不做。

interface Native {
  readFile(name: string): string | null
  writeFile(name: string, text: string): void
  deleteFile(name: string): void
  httpStart(id: string, url: string, method: string, headers: string, body: string | null): void
  httpAbort(id: string): void
  wsOpen(id: string, url: string, headers: string): void
  wsSend(id: string, text: string): void
  wsSendB64(id: string, b64: string): void
  wsClose(id: string): void
  pickFile(reqId: string): void
  saveText(name: string, text: string): string | null
  capture(reqId: string, x: number, y: number, w: number, h: number): void
  bridge(json: string): void
  openSettings(pane: string): void
  permStatus(): string
  display(): string
  moveToBack(): void
  uvcOpen(reqId: string): void
  uvcClose(): void
  uvcPresent(): boolean
}

type NativeEvent =
  | { t: 'http'; id: string; phase: 'head'; status: number; headers: Record<string, string> }
  | { t: 'http'; id: string; phase: 'chunk'; b64: string }
  | { t: 'http'; id: string; phase: 'end' }
  | { t: 'http'; id: string; phase: 'error'; error: string }
  | { t: 'ws'; id: string; phase: 'open' }
  | { t: 'ws'; id: string; phase: 'text'; text: string }
  | { t: 'ws'; id: string; phase: 'closed'; error?: string }
  | { t: 'file'; reqId: string; name?: string; url?: string }
  | { t: 'capture'; reqId: string; dataUrl: string | null }
  | { t: 'uvc'; reqId: string; state: string; w: number; h: number; error: string }
  | { t: 'uvc_lost'; error: string }
  | { t: 'uvc_attached' }
  | { t: 'uvc_detached' }
  | BridgeEvent

const native = (window as unknown as { GlintNative?: Native }).GlintNative

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

if (native) install(native)

function install(n: Native): void {
  let seq = 0
  const nextId = (): string => `n${++seq}`
  const listeners = {
    http: new Map<string, (e: any) => void>(),
    ws: new Map<string, (e: any) => void>(),
    once: new Map<string, (e: any) => void>()
  }
  const emitters = {
    bridge: new Set<(e: BridgeEvent) => void>(),
    delta: new Set<(d: any) => void>(),
    done: new Set<(d: any) => void>(),
    bounds: new Set<(b: any) => void>(),
    uvcLost: new Set<() => void>()
  }

  // 原生层调这个函数推事件
  ;(window as any).__glint = (e: NativeEvent) => {
    if (e.t === 'http') listeners.http.get(e.id)?.(e)
    else if (e.t === 'ws') listeners.ws.get(e.id)?.(e)
    else if (e.t === 'file' || e.t === 'capture' || e.t === 'uvc') listeners.once.get(e.reqId)?.(e)
    else if (e.t === 'uvc_lost') emitters.uvcLost.forEach((f) => f())
    // 插上 USB 摄像头：系统不发 devicechange，这里替它发一个，WebcamSource 的自动重试接着走
    else if (e.t === 'uvc_attached' || e.t === 'uvc_detached') navigator.mediaDevices?.dispatchEvent(new Event('devicechange'))
    else emitters.bridge.forEach((f) => f(e))
  }

  const emitBridge = (e: BridgeEvent): void => emitters.bridge.forEach((f) => f(e))

  /** fetch 的原生版：响应体是真正的流，SSE 能一段段读；不受页面 CSP 和跨域限制 */
  const nativeFetch = ((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const id = nextId()
      let ctl: ReadableStreamDefaultController<Uint8Array> | null = null
      let settled = false
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          ctl = c
        },
        cancel: () => n.httpAbort(id)
      })
      const fail = (err: Error): void => {
        listeners.http.delete(id)
        if (!settled) reject(err)
        else {
          try {
            ctl?.error(err)
          } catch {
            /* 流已经关了 */
          }
        }
      }
      listeners.http.set(id, (e) => {
        if (e.phase === 'head') {
          settled = true
          resolve(new Response(e.status === 204 ? null : body, { status: e.status, headers: e.headers }))
        } else if (e.phase === 'chunk') ctl?.enqueue(b64ToBytes(e.b64))
        else if (e.phase === 'end') {
          listeners.http.delete(id)
          try {
            ctl?.close()
          } catch {
            /* 已经关了 */
          }
        } else fail(new Error(e.error))
      })
      const signal = init.signal
      if (signal?.aborted) return fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal?.addEventListener('abort', () => {
        n.httpAbort(id)
        fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
      n.httpStart(id, String(input), init.method || 'GET', JSON.stringify(init.headers || {}), typeof init.body === 'string' ? init.body : null)
    })) as typeof fetch

  /** WebSocket 的原生版：百炼语音识别握手时要带 Key，页面里的 WebSocket 带不了请求头 */
  const openWs = (url: string, headers: Record<string, string>): WebSocket => {
    const id = nextId()
    const ws: any = {
      binaryType: 'arraybuffer',
      send(d: string | ArrayBuffer | ArrayBufferView) {
        if (typeof d === 'string') n.wsSend(id, d)
        else if (d instanceof ArrayBuffer) n.wsSendB64(id, bytesToB64(new Uint8Array(d)))
        else n.wsSendB64(id, bytesToB64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)))
      },
      close() {
        n.wsClose(id)
        listeners.ws.delete(id)
      }
    }
    listeners.ws.set(id, (e) => {
      if (e.phase === 'open') ws.onopen?.({})
      else if (e.phase === 'text') ws.onmessage?.({ data: e.text })
      else {
        listeners.ws.delete(id)
        if (e.error) ws.onerror?.({})
        ws.onclose?.({})
      }
    })
    n.wsOpen(id, url, JSON.stringify(headers))
    return ws as WebSocket
  }

  // ---------- 设置 ----------

  const SETTINGS = 'settings.json'
  const load = (): Settings => {
    // 平板上没有 Ollama，也没有终端
    const def = baseSettings({ cwd: '', shell: '' })
    def.providers = def.providers.filter((p) => p.id !== 'ollama')
    def.gaze = { ...def.gaze, glintRotate: 0 }
    def.leftRatio = 0.62
    try {
      const text = n.readFile(SETTINGS)
      if (!text) return def
      const raw = JSON.parse(text) as Partial<Settings>
      const s: Settings = {
        ...def,
        ...raw,
        avatar: { ...def.avatar, ...(raw.avatar || {}) },
        gaze: { ...def.gaze, ...(raw.gaze || {}) },
        providers: raw.providers?.length ? raw.providers : def.providers
      }
      // 从桌面拷来的设置可能选着本地 Ollama：服务商不在了就回默认模型
      for (const k of ['chatModel', 'fastModel', 'visionModel'] as const) {
        if (!s.providers.some((p) => p.id === s[k].providerId)) s[k] = def[k]
      }
      return s
    } catch {
      return def
    }
  }
  let settings = load()
  const getProvider = (id: string): Provider | undefined => settings.providers.find((p) => p.id === id)

  const llm = createLlm(nativeFetch, getProvider)
  const asr = createAsr({
    providers: () => settings.providers,
    openWs,
    uuid: () => crypto.randomUUID()
  })

  // ---------- 窗口：平板上全屏，窗口坐标就是屏幕坐标 ----------

  const boundsNow = () => {
    const r: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
    return { content: r, display: r, workArea: r, scale: window.devicePixelRatio, mode: 'normal' as const }
  }
  const pushBounds = (): void => emitters.bounds.forEach((f) => f(boundsNow()))
  window.addEventListener('resize', pushBounds)

  const TD_OFF: TdStatus = { listening: false, port: 0, name: '', active: null, devices: [], paired: [] }
  const onceEvent = <T,>(reqId: string, start: () => void): Promise<T> =>
    new Promise((resolve) => {
      listeners.once.set(reqId, (e) => {
        listeners.once.delete(reqId)
        resolve(e)
      })
      start()
    })

  // ---------- 小人 ----------

  const AVATAR = 'avatar.dataurl'
  const avatarPrompt =
    'Turn the person in this photo into a cute chibi 3D cartoon avatar, in the style of a Pixar character / Pop Mart blind box figure: oversized round head, small shoulders, big friendly eyes, soft clean shading, smooth toy-like finish. Keep the person recognizable: same hairstyle and hair color, face shape, skin tone, glasses and accessories if any. Facing the camera straight on, relaxed friendly expression, head and shoulders only, centered. Plain very light gray background (#F2F2F7). No text, no border, no extra objects.'

  const generateAvatar = async (photo: string): Promise<{ dataUrl: string; ms: number } | { error: string }> => {
    const t0 = Date.now()
    const p = getProvider(settings.avatar.providerId)
    if (!p) return { error: '找不到服务商，去设置里重新选' }
    if (!p.apiKey) return { error: `「${p.name}」还没填 API Key` }
    try {
      const res = await nativeFetch(`${new URL(p.baseUrl).origin}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: settings.avatar.model || AVATAR_MODEL,
          input: { messages: [{ role: 'user', content: [{ image: photo }, { text: avatarPrompt }] }] },
          parameters: { n: 1, size: '1024*1024', prompt_extend: false, watermark: false }
        })
      })
      const j: any = await res.json()
      if (!res.ok || j?.code) return { error: `${j?.code || `HTTP ${res.status}`}：${j?.message || ''}` }
      const url: string | undefined = j?.output?.choices?.[0]?.message?.content?.find((c: any) => c?.image)?.image
      if (!url) return { error: '百炼没返回图片' }
      const img = await createImageBitmap(await (await nativeFetch(url)).blob())
      const c = document.createElement('canvas')
      c.width = c.height = 512
      c.getContext('2d')!.drawImage(img, 0, 0, 512, 512)
      const dataUrl = c.toDataURL('image/png')
      n.writeFile(AVATAR, dataUrl)
      return { dataUrl, ms: Date.now() - t0 }
    } catch (e: any) {
      return { error: e?.message || String(e) }
    }
  }

  // ---------- 拼出和桌面版一样的 API ----------

  const api = {
    platform: 'android',
    settings: {
      get: async () => settings,
      save: async (s: Settings) => {
        settings = s
        n.writeFile(SETTINGS, JSON.stringify(s))
        return s
      },
      listModels: (p: Provider) => llm.listModels(p),
      testProvider: (p: Provider, model: string) => llm.testProvider(p, model)
    },
    llm: {
      start: (req: any) => {
        llm.startStream(req, (ch, payload) => {
          ;(ch === 'llm:delta' ? emitters.delta : emitters.done).forEach((f) => f(payload))
        })
      },
      abort: (id: string) => llm.abortStream(id),
      onDelta: (f: (d: any) => void) => (emitters.delta.add(f), () => emitters.delta.delete(f)),
      onDone: (f: (d: any) => void) => (emitters.done.add(f), () => emitters.done.delete(f))
    },
    // 平板上跑不了本地终端
    pty: {
      create: () => Promise.reject(new Error('平板版没有终端')),
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined
    },
    bridge: {
      send: (cmd: Record<string, unknown>) => n.bridge(JSON.stringify(cmd)),
      onEvent: (f: (e: BridgeEvent) => void) => (emitters.bridge.add(f), () => emitters.bridge.delete(f))
    },
    asr: {
      start: (target: string) => asr.asrStart(target, emitBridge),
      audio: (pcm: ArrayBuffer) => asr.asrAudio(pcm),
      stop: () => asr.asrStop()
    },
    win: {
      setMode: async (m: string) => m,
      requestBounds: async () => pushBounds(),
      onBounds: (f: (b: any) => void) => (emitters.bounds.add(f), () => emitters.bounds.delete(f)),
      toggleVisible: () => n.moveToBack(),
      capture: async (r: Rect) => {
        const reqId = nextId()
        const e = await onceEvent<{ dataUrl: string | null }>(reqId, () => n.capture(reqId, r.x, r.y, r.width, r.height))
        return e.dataUrl
      },
      focus: () => undefined,
      island: (text: string, on: boolean) => {
        document.getElementById('glint-island-host')?.remove()
        const host = document.createElement('div')
        host.id = 'glint-island-host'
        host.attachShadow({ mode: 'open' }).innerHTML = `<style>${islandCss()}</style>${islandHtml(text, on)}`
        document.body.appendChild(host)
        setTimeout(() => host.remove(), ISLAND_MS)
      },
      setOverlayDim: () => undefined
    },
    uvc: {
      open: () => {
        const reqId = nextId()
        return onceEvent(reqId, () => n.uvcOpen(reqId))
      },
      close: () => n.uvcClose(),
      present: () => n.uvcPresent(),
      onLost: (f: () => void) => (emitters.uvcLost.add(f), () => emitters.uvcLost.delete(f))
    },
    tray: { status: () => undefined, onCommand: () => () => undefined },
    truedepth: {
      enable: async () => TD_OFF,
      pair: async () => ({ ok: false, error: '平板版不支持 iPhone 原深感' }),
      unpair: async () => undefined,
      status: async () => TD_OFF,
      display: async () => JSON.parse(n.display()) as DisplayInfo,
      onFrame: () => () => undefined,
      onStatus: () => () => undefined
    },
    avatar: {
      get: async () => n.readFile(AVATAR),
      generate: generateAvatar,
      clear: async () => n.deleteFile(AVATAR)
    },
    perm: {
      status: async () => JSON.parse(n.permStatus()) as { camera: string; microphone: string },
      openSettings: async (pane: string) => n.openSettings(pane)
    },
    file: {
      open: async () => {
        const reqId = nextId()
        const e = await onceEvent<{ name?: string; url?: string }>(reqId, () => n.pickFile(reqId))
        if (!e.name || !e.url) return null
        const res = await fetch(e.url)
        if (/\.pdf$/i.test(e.name)) return { name: e.name, path: e.url, kind: 'pdf', data: new Uint8Array(await res.arrayBuffer()) }
        return { name: e.name, path: e.url, kind: 'md', text: await res.text() }
      },
      read: () => Promise.reject(new Error('平板版只能从文件选择器打开')),
      saveText: async (name: string, text: string) => n.saveText(name, text),
      pathOf: () => ''
    }
  }
  ;(window as any).lookask = api
}
