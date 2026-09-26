import type { ChatContentPart, ChatMessageIn, ModelRef } from '../../../shared/types'
import { createStore, uid } from '../store'
import { la, settingsStore, rumble, toast } from '../appState'
import { focus } from '../focus/focus'
import type { FocusContext } from '../focus/types'
import { buildPrompt, bubbleText, type Action } from './prompts'
import { routeQuestion, jevEnabled, candidatesOf, type JevTrace } from '../jev/jevBrain'

// 右侧对话：一问一答 + 流式输出；每次提问自动带上「你正在看的东西」

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

export const chatStore = createStore<{ msgs: ChatMsg[]; busy: string | null; asr: AsrState }>({
  msgs: [],
  busy: null,
  asr: { active: false, text: '', target: 'chat' }
})

function patchMsg(id: string, p: Partial<ChatMsg>): void {
  chatStore.set((s) => ({ ...s, msgs: s.msgs.map((m) => (m.id === id ? { ...m, ...p } : m)) }))
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
  chatStore.patch({ busy: null })
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
}

export async function ask(action: Action, opts: AskOptions = {}): Promise<void> {
  const s = settingsStore.get().s
  if (!s) return
  if (chatStore.get().busy) abort()

  // 自由提问时，只有焦点是新鲜的（硬焦点或 30 秒内看过）才附带上下文，免得把很久以前看的东西塞给模型
  const skipCtx = opts.noContext || (action === 'ask' && !opts.ctx && !focus.isFresh())
  let ctx: FocusContext | null = skipCtx ? null : opts.ctx ?? (await focus.context({ withImage: action === 'capture' || opts.withImage }))
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
  const prompt = buildPrompt(act, ctx, opts.question, depth)
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
  const hist = history()
  chatStore.set((st) => ({ ...st, msgs: [...st.msgs, userMsg, botMsg] }))

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
  chatStore.set((s) => ({ ...s, msgs: [] }))
}

export function exportChat(): string {
  return chatStore
    .get()
    .msgs.filter((m) => m.role !== 'note')
    .map((m) => (m.role === 'user' ? `### 🙋 ${m.text}\n${m.ctx?.selection ? `> ${m.ctx.selection.replace(/\n/g, '\n> ')}\n` : ''}` : `${m.text}\n`))
    .join('\n')
}
