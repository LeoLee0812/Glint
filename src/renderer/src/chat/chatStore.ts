import type { ChatContentPart, ChatMessageIn, ModelRef } from '../../../shared/types'
import { createStore, uid } from '../store'
import { la, settingsStore, rumble, toast, uiStore } from '../appState'
import { focus } from '../focus/focus'
import { snapshot } from '../focus/snapshot'
import type { FocusContext } from '../focus/types'
import { clip } from '../focus/types'
import { buildPrompt, bubbleText, FORK_HINT, type Action } from './prompts'
import { routeQuestion, jevEnabled, candidatesOf, type JevTrace } from '../jev/jevBrain'

// 右侧对话：一问一答 + 流式输出；每次提问自动带上「你正在看的东西」
// 右侧模式（右手柄 +）下对回答里某一处提问，不往主对话里塞，而是在下面「裂变」出一个解释窗口，
// 解释里再有不懂的继续往下裂变一层；B 一层层收回

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'note'
  text: string
  prompt?: string
  ctx?: FocusContext | null
  image?: string
  action?: Action
  model?: string
  status?: 'streaming' | 'done' | 'error'
  error?: string
  reasoning?: string
  jev?: JevTrace[]
  ms?: number
}

export interface AsrState {
  active: boolean
  text: string
  target: 'chat' | 'terminal'
}

/** 解释窗口里的一层：对上一层（或主对话某条回答）某一处的一问一答 */
export interface ForkCard {
  id: string
  ask: ChatMsg
  ans: ChatMsg
}

export const chatStore = createStore<{ msgs: ChatMsg[]; busy: string | null; asr: AsrState; fork: ForkCard[] }>({
  msgs: [],
  busy: null,
  asr: { active: false, text: '', target: 'chat' },
  fork: []
})

function patchMsg(id: string, p: Partial<ChatMsg>): void {
  chatStore.set((s) => {
    if (s.msgs.some((m) => m.id === id)) return { ...s, msgs: s.msgs.map((m) => (m.id === id ? { ...m, ...p } : m)) }
    if (s.fork.some((c) => c.ans.id === id)) return { ...s, fork: s.fork.map((c) => (c.ans.id === id ? { ...c, ans: { ...c.ans, ...p } } : c)) }
    return s
  })
}

function pickModel(action: Action, hasImage: boolean): ModelRef | null {
  const s = settingsStore.get().s
  if (!s) return null
  if (hasImage) return s.visionModel
  if (action === 'translate') return s.fastModel
  return s.chatModel
}

/** 历史对话：最近 8 轮，只带文字，图片只保留当前这一条 */
function history(): ChatMessageIn[] {
  const out: ChatMessageIn[] = []
  const msgs = chatStore.get().msgs.filter((m) => m.role !== 'note' && m.status !== 'error')
  for (const m of msgs.slice(-16)) {
    if (m.role === 'user') out.push({ role: 'user', content: m.prompt || m.text })
    else if (m.role === 'assistant' && m.text) out.push({ role: 'assistant', content: m.text })
  }
  return out
}

// 流式回调统一在这里分发
const streams = new Map<string, { msgId: string; buf: string; reasoning: string; timer: ReturnType<typeof setTimeout> | null }>()

la.llm.onDelta((d) => {
  const st = streams.get(d.reqId)
  if (!st) return
  if (d.text) st.buf += d.text
  if (d.reasoning) st.reasoning += d.reasoning
  // 50ms 合并一次渲染，避免每个 token 都重排
  if (!st.timer) {
    st.timer = setTimeout(() => {
      st.timer = null
      patchMsg(st.msgId, { text: st.buf, reasoning: st.reasoning || undefined })
    }, 50)
  }
})

la.llm.onDone((d) => {
  const st = streams.get(d.reqId)
  if (!st) return
  if (st.timer) clearTimeout(st.timer)
  streams.delete(d.reqId)
  const aborted = d.error === 'aborted'
  patchMsg(st.msgId, {
    text: st.buf || (aborted ? '（已停止）' : ''),
    reasoning: st.reasoning || undefined,
    status: d.error && !aborted ? 'error' : 'done',
    error: d.error && !aborted ? d.error : undefined,
    ms: d.ms
  })
  // 连按时旧请求的结束可能晚于新请求开始，只清自己的忙碌标记
  if (chatStore.get().busy === d.reqId) chatStore.patch({ busy: null })
  if (!d.error) rumble('done', 'R')
  else if (!aborted) toast(`回答出错：${d.error.slice(0, 120)}`, 'error', { ttl: 6000 })
})

export interface AskOptions {
  question?: string
  ctx?: FocusContext | null
  /** 截取焦点区域的画面一起发（视觉模型） */
  withImage?: boolean
  /** 不带焦点上下文（纯聊天） */
  noContext?: boolean
  /** 答案放哪：主对话 / 往下裂变的解释窗口；不传就看视线跟着哪边（右边 = 解释窗口） */
  target?: 'main' | 'fork'
}

/** 这段回答当时在回应什么：解释窗口里是上一层问的那一处；主对话里往上找最近的那一问 */
function originOf(ctx: FocusContext, fromFork: boolean, keep: ForkCard[]): string | undefined {
  if (fromFork) {
    const last = keep[keep.length - 1]
    return last ? clip(last.ask.text, 120) : undefined
  }
  const msgs = chatStore.get().msgs
  const i = ctx.ref ? msgs.findIndex((m) => m.id === ctx.ref) : -1
  if (i < 0 || msgs[i].role !== 'assistant') return undefined
  const q = msgs
    .slice(0, i)
    .reverse()
    .find((m) => m.role === 'user')
  if (!q) return undefined
  const saw = q.ctx?.selection || q.ctx?.paragraph
  return `用户问「${clip(q.text, 120)}」${saw ? `（当时在看：${clip(saw, 160)}）` : ''}`
}

export async function ask(action: Action, opts: AskOptions = {}): Promise<void> {
  const s = settingsStore.get().s
  if (!s) return
  if (chatStore.get().busy) abort()

  // 右侧模式下手柄 / 快捷按钮问的是回答里的某一处 → 答案往下裂变进解释窗口；输入框打的字永远进主对话
  let toFork = (opts.target ?? (uiStore.get().side === 'right' ? 'fork' : 'main')) === 'fork'

  let ctx: FocusContext | null
  if (action === 'capture' && !opts.ctx) {
    // 看图问：视线跟着的那一侧整块截图 + 蓝圈标出在看哪，不用先选中具体哪一行
    ctx = await snapshot()
    if (!ctx) return
  } else {
    // 自由提问时，只有焦点是新鲜的（硬焦点或 30 秒内看过）才附带上下文，免得把很久以前看的东西塞给模型
    const skipCtx = opts.noContext || (action === 'ask' && !opts.ctx && !focus.isFresh())
    ctx = skipCtx ? null : opts.ctx ?? (await focus.context({ withImage: opts.withImage }))
  }
  const paneId = focus.state.get().paneId

  if (toFork && ctx?.source !== 'chat') {
    // 右侧模式下没指着回答里的哪一处：说出来的问题照常进主对话，按键就提示先看准
    if (action === 'ask' && opts.question) toFork = false
    else {
      toast('右侧模式：先看着回答里不懂的地方（或推右摇杆点准），再按键', 'warn')
      return
    }
  }

  // 从解释窗口的第几层往下裂变：焦点在某张卡片里 → 接在它下面（更深的层丢掉）；在主对话里 → 重开一条
  let keep: ForkCard[] = []
  if (toFork && ctx) {
    const cards = chatStore.get().fork
    const i = action !== 'capture' && paneId === 'fork' && ctx.ref ? cards.findIndex((c) => c.id === ctx!.ref) : -1
    keep = i >= 0 ? cards.slice(0, i + 1) : []
    if (!ctx.origin) ctx = { ...ctx, origin: originOf(ctx, i >= 0, keep) }
  }

  let act = action
  let depth: number | undefined
  const traces: JevTrace[] = []

  // Jev 模式：自由提问先让 Jev 判断意图、要不要看图、答多深
  if (act === 'ask' && opts.question && jevEnabled()) {
    // 视线只到段落级：顺带让 Jev 从候选句里挑出你说的「这个」指哪一句
    const cands = candidatesOf(ctx)
    const r = await routeQuestion(opts.question, ctx, cands)
    if (r) {
      traces.push(r.trace)
      depth = r.depth
      if (ctx && r.target !== null && cands[r.target]) ctx = { ...ctx, selection: cands[r.target], gran: 'sentence' }
      if (r.action && r.action !== 'ask') act = r.action
      if (r.needsImage && ctx && !ctx.image) {
        const withImg = await focus.context({ withImage: true })
        if (withImg?.image) ctx = { ...ctx, image: withImg.image }
      }
    }
  }

  const image = ctx?.image
  const model = pickModel(act, !!image)
  if (!model) return
  const prompt = buildPrompt(act, ctx, opts.question, depth) + (toFork ? FORK_HINT : '')
  const userMsg: ChatMsg = {
    id: uid('m'),
    role: 'user',
    text: bubbleText(action, ctx, opts.question),
    prompt,
    ctx,
    image,
    action: act,
    jev: traces.length ? traces : undefined
  }
  const botMsg: ChatMsg = { id: uid('m'), role: 'assistant', text: '', status: 'streaming', model: `${model.model}`, action: act }
  let hist: ChatMessageIn[]
  if (toFork) {
    // 解释窗口只带这条裂变链上最近几层，不带主对话
    hist = keep
      .slice(-3)
      .flatMap((c): ChatMessageIn[] =>
        c.ans.text && c.ans.status === 'done'
          ? [
              { role: 'user', content: c.ask.prompt || c.ask.text },
              { role: 'assistant', content: c.ans.text }
            ]
          : []
      )
    const card: ForkCard = { id: uid('f'), ask: userMsg, ans: botMsg }
    chatStore.set((st) => ({ ...st, fork: [...keep, card] }))
  } else {
    hist = history()
    // 主对话有了新的一问，旧的解释窗口就收起来
    chatStore.set((st) => ({ ...st, msgs: [...st.msgs, userMsg, botMsg], fork: [] }))
  }

  const content: ChatContentPart[] | string = image ? [{ type: 'image', dataUrl: image }, { type: 'text', text: prompt }] : prompt
  const reqId = uid('req')
  streams.set(reqId, { msgId: botMsg.id, buf: '', reasoning: '', timer: null })
  chatStore.patch({ busy: reqId })
  la.llm.start({
    reqId,
    model,
    system: s.systemPrompt,
    messages: [...hist, { role: 'user', content }],
    temperature: act === 'translate' ? 0.2 : 0.4,
    maxTokens: 2048
  })
}

/** 正在流式输出的那条回答的 id */
function streamingMsgId(): string | null {
  const busy = chatStore.get().busy
  return busy ? (streams.get(busy)?.msgId ?? null) : null
}

/** 收起解释窗口最下面一层；已经没有可收的就返回 false */
export function popFork(): boolean {
  const cards = chatStore.get().fork
  if (!cards.length) return false
  if (streamingMsgId() === cards[cards.length - 1].ans.id) abort()
  chatStore.set((st) => ({ ...st, fork: st.fork.slice(0, -1) }))
  return true
}

export function closeFork(): void {
  const cards = chatStore.get().fork
  if (!cards.length) return
  const sid = streamingMsgId()
  if (sid && cards.some((c) => c.ans.id === sid)) abort()
  chatStore.set((st) => ({ ...st, fork: [] }))
}

export function abort(): void {
  const busy = chatStore.get().busy
  if (busy) la.llm.abort(busy)
}

export function addNote(text: string, jev?: JevTrace[]): string {
  const m: ChatMsg = { id: uid('n'), role: 'note', text, jev }
  chatStore.set((s) => ({ ...s, msgs: [...s.msgs, m] }))
  return m.id
}

export function removeMsg(id: string): void {
  chatStore.set((s) => ({ ...s, msgs: s.msgs.filter((m) => m.id !== id) }))
}

export function clearChat(): void {
  abort()
  chatStore.set((s) => ({ ...s, msgs: [], fork: [] }))
}

export function exportChat(): string {
  return chatStore
    .get()
    .msgs.filter((m) => m.role !== 'note')
    .map((m) => (m.role === 'user' ? `### 🙋 ${m.text}\n${m.ctx?.selection ? `> ${m.ctx.selection.replace(/\n/g, '\n> ')}\n` : ''}` : `${m.text}\n`))
    .join('\n')
}
