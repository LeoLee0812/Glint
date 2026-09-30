import type { BridgeEvent } from '../../../shared/types'
import { la } from '../appState'
import { Emitter } from '../store'
// worklet 单独成文件、按同源地址加载：页面的 CSP 不许从 blob: 加载脚本
import workletUrl from './pcm16.worklet.js?url'

// 按住说话：Mac 交给原生助手（系统 SFSpeechRecognizer，Apple 芯片上本地识别）；
// Windows 在这里采麦克风，16kHz 单声道 16 位 PCM、100ms 一块，经主进程转给百炼的 Fun-ASR 实时识别（src/main/asrCloud.ts）。
// 两边的结果都是同一种 asr 事件，按键路由只管 speechStart / speechStop / onSpeech

export type AsrEvent = Extract<BridgeEvent, { t: 'asr' }>

const isMac = la.platform === 'darwin'
const bus = new Emitter<{ asr: AsrEvent }>()

la.bridge.onEvent((e) => {
  if (e.t !== 'asr') return
  // 主进程那边先出错了（没填 Key、连不上）：按键路由会把这次语音收掉、松手时不再调 speechStop，麦克风得自己关
  if (!isMac && e.state === 'error') mic.stop().catch(() => undefined)
  bus.emit('asr', e)
})

export function onSpeech(fn: (e: AsrEvent) => void): () => void {
  return bus.on('asr', fn)
}

export function speechStart(target: 'chat' | 'terminal'): void {
  if (isMac) {
    la.bridge.send({ cmd: 'asr_start', lang: 'zh-CN', target })
    return
  }
  la.asr.start(target)
  mic.start(target).catch((e: any) => {
    // 麦克风没开起来：主进程那边的任务也收掉，免得等一个永远不来的结果
    la.asr.stop()
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
    const missing = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
    bus.emit('asr', { t: 'asr', state: 'error', error: denied ? 'mic_denied' : missing ? 'no_mic' : `mic: ${e?.message || e}`, target })
  })
}

export function speechStop(): void {
  if (isMac) {
    la.bridge.send({ cmd: 'asr_stop' })
    return
  }
  // 先把麦克风里剩下的那一小段送出去，再告诉主进程说完了
  mic.stop().finally(() => la.asr.stop())
}

// ---------- Windows：麦克风 → 16kHz PCM（转换在 pcm16.worklet.js 里） ----------

/** 松开后麦克风再留多久（毫秒）：连着问的时候第二句起不用再等开麦；这段时间里任务栏的麦克风图标会亮着 */
const WARM_MS = 30_000

class Mic {
  private ctx: AudioContext | null = null
  private moduleReady: Promise<void> | null = null
  private stream: MediaStream | null = null
  private src: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  /** 每按一次扳机加一：松开后才开起来的麦克风（开得慢）不再接着录 */
  private session = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * AudioContext 和 worklet 只建一次，启动后就先准备好（挂起着，不占声卡）：
   * 实测第一次按下时现建要大半秒，按下就开口的话前半句会丢
   */
  prepare(): Promise<void> {
    if (this.ctx && this.moduleReady) return this.moduleReady
    const ctx = new AudioContext({ sampleRate: 16000 })
    this.ctx = ctx
    this.moduleReady = ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => ctx.suspend())
      .catch((e) => {
        // 这次没加载上，下次按下重新建
        this.ctx = null
        this.moduleReady = null
        ctx.close().catch(() => undefined)
        throw e
      })
    return this.moduleReady
  }

  async start(_target: string): Promise<void> {
    const sid = ++this.session
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.detach()
    await this.prepare()
    const ctx = this.ctx!
    // 开麦克风和打开声卡输出一起做；松开后 30 秒内再按，麦克风还开着，直接接上
    const resumed = ctx.resume()
    if (!this.stream?.active) {
      this.closeStream()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      this.stream = stream
      this.src = ctx.createMediaStreamSource(stream)
    }
    await resumed
    if (sid !== this.session) {
      // 麦克风还没开好就松开了：不录了，麦克风照样留一会儿
      this.idle()
      return
    }
    this.node = new AudioWorkletNode(ctx, 'pcm16', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
    this.node.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) la.asr.audio(e.data)
    }
    this.src!.connect(this.node)
    // 接到输出上 worklet 才会被拉着跑；它不写输出，出来的是静音
    this.node.connect(ctx.destination)
  }

  /** 松开：把 worklet 里攒的零头要回来送出去，断开录音；麦克风再留一会儿 */
  async stop(): Promise<void> {
    this.session++
    const node = this.node
    if (node) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 150)
        node.port.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) la.asr.audio(e.data)
          else if (e.data === 'flushed') {
            clearTimeout(t)
            resolve()
          }
        }
        node.port.postMessage('flush')
      })
    }
    this.detach()
    this.idle()
  }

  /** 录音的这一段断开（麦克风不关） */
  private detach(): void {
    this.node?.disconnect()
    this.node = null
    this.src?.disconnect()
  }

  /** 挂起声卡输出，30 秒内没再按就真的关麦克风 */
  private idle(): void {
    this.ctx?.suspend().catch(() => undefined)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.closeStream()
    }, WARM_MS)
  }

  private closeStream(): void {
    this.src?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.src = null
    this.stream = null
  }
}

const mic = new Mic()
// Windows 启动一会儿后先把音频上下文准备好（Mac 走原生助手，用不到）
if (!isMac) setTimeout(() => mic.prepare().catch(() => undefined), 3000)
