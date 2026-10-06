import type { JevAnswer, JevQuestion, JevUsage } from '../../../shared/types'
import { createStore, uid } from '../store'
import { la, settingsStore } from '../appState'
import type { FocusContext } from '../focus/types'
import type { BlockDwell } from '../focus/focus'
import type { Action } from '../chat/prompts'
import { looksLikeAgent, looksLikePermissionPrompt, terminalAgent, withoutModeLine } from '../panes/agent'
import { jevMissing } from '../../../shared/jev'

export { looksLikePermissionPrompt }

// Jev 模式 =「先判断，再开口」：Jev 只做判断（便宜、带概率），决定什么时候插话、怎么答；真正写字交给大模型
// 规则：state 用中文原文，问题和选项用英文（准确率更高）；数字先在这里分档成文字再给 Jev（它不擅长读数字）
// 判断结果不往对话区里塞：要提醒的出在眼睛正看着的那段上（jevHintStore → GazeLayer 画的小签）+ 手柄轻敲，
// 终端里的提醒挂在终端标签上（termAlertStore），全部判断用大白话记一条（summary），顶栏 Jev 药丸点开能看

export interface JevTrace {
  id: string
  t: number
  kind: 'block' | 'stuck' | 'route' | 'terminal' | 'fact'
  title: string
  state: string
  answers: Record<string, JevAnswer>
  tokens: number
  cached: boolean
  ms: number
  error?: string
  /** 这次判断得出了什么，一句大白话（判断记录里显示） */
  summary?: string
}

/** 眼睛正看着的那段上冒的小签：stuck = 卡住了（按 A 拆开讲），fact = 这句数字可能不准 */
export interface JevHint {
  kind: 'stuck' | 'fact'
  paneId: string
  blockKey: string
  at: number
}

export const jevHintStore = createStore<{ hint: JevHint | null }>({ hint: null })

let hintTimer: ReturnType<typeof setTimeout> | null = null

/** 冒一个小签：卡住了留 12 秒，核实提醒留 8 秒；眼睛挪到别的段就不画（GazeLayer 判断） */
export function showJevHint(h: Omit<JevHint, 'at'>): void {
  if (hintTimer) clearTimeout(hintTimer)
  jevHintStore.set({ hint: { ...h, at: Date.now() } })
  hintTimer = setTimeout(clearJevHint, h.kind === 'stuck' ? 12000 : 8000)
}

export function clearJevHint(): void {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = null
  if (jevHintStore.get().hint) jevHintStore.set({ hint: null })
}

/** 终端里的编程智能体在等你（批准 / 回答）：挂在对应终端的标签上 */
export const termAlertStore = createStore<{ docId: string | null; state: string | null }>({ docId: null, state: null })

export function clearTermAlert(): void {
  if (termAlertStore.get().docId) termAlertStore.set({ docId: null, state: null })
}

export interface BlockAnalysis {
  difficulty: number
  jargon: number
  kind: string
}

export const jevStore = createStore<{ traces: JevTrace[]; usage: JevUsage | null; busy: number }>({
  traces: [],
  usage: null,
  busy: 0
})

export function jevEnabled(): boolean {
  const s = settingsStore.get().s
  return !!s?.jevMode && !jevMissing(s)
}

async function run(kind: JevTrace['kind'], title: string, state: string, questions: Record<string, JevQuestion>): Promise<JevTrace> {
  jevStore.patch({ busy: jevStore.get().busy + 1 })
  const r = await la.jev.judge(state, questions)
  const trace: JevTrace = {
    id: uid('jev'),
    t: Date.now(),
    kind,
    title,
    state: state.length > 160 ? state.slice(0, 160) + '…' : state,
    answers: r.answers,
    tokens: r.inputTokens,
    cached: r.cached,
    ms: r.ms,
    error: r.ok ? undefined : r.error
  }
  const usage = await la.jev.usage()
  jevStore.set((s) => ({ traces: [trace, ...s.traces].slice(0, 40), usage, busy: Math.max(0, s.busy - 1) }))
  return trace
}

/** 给一条判断补上大白话结论 */
function summarize(tr: JevTrace, text: string): void {
  tr.summary = text
  jevStore.set((s) => ({ ...s, traces: s.traces.map((t) => (t.id === tr.id ? { ...t, summary: text } : t)) }))
}

// ---------- 1. 看段落：难度 / 术语 / 类型 ----------

const analyses = new Map<string, BlockAnalysis>()
const pendingBlocks = new Set<string>()

function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function analysisOf(text: string): BlockAnalysis | undefined {
  return analyses.get(hashText(text))
}

export async function analyzeBlock(text: string): Promise<BlockAnalysis | null> {
  const clean = text.trim()
  if (clean.length < 24) return null
  const key = hashText(clean)
  if (analyses.has(key)) return analyses.get(key)!
  if (pendingBlocks.has(key)) return null
  pendingBlocks.add(key)
  try {
    const tr = await run('block', '读者正在看的段落', clean.slice(0, 2400), {
      difficulty: {
        type: 'score',
        instructions: 'How hard is this passage for a smart reader who is not an expert in this specific field',
        criteria: [
          'Plain prose, easy to follow',
          'Some domain terms but still easy to follow',
          'Dense technical content that needs background knowledge',
          'Very dense: heavy math, notation or jargon'
        ]
      },
      jargon: {
        type: 'noul',
        instructions: 'The passage contains at least one technical term, acronym, symbol or formula that a first-year graduate student outside this subfield would need explained'
      },
      kind: {
        type: 'choice',
        instructions: 'What kind of content is this passage',
        criteria: {
          prose: 'Narrative or argumentative prose',
          definition: 'A definition or notation setup',
          math: 'Equations, derivation or proof',
          algorithm: 'Algorithm, procedure or pseudo code',
          result: 'Experimental results, numbers or claims about performance',
          figure: 'Figure or table caption',
          code: 'Program code or terminal output',
          references: 'Bibliography or citations list'
        }
      }
    })
    if (tr.error) return null
    const a: BlockAnalysis = {
      difficulty: tr.answers.difficulty?.score ?? 0,
      jargon: tr.answers.jargon?.noul ?? 0,
      kind: tr.answers.kind?.choice ?? 'prose'
    }
    analyses.set(key, a)
    summarize(tr, `这段${difficultyLevel(a.difficulty)}${a.jargon > 0.6 ? '，有术语' : ''}`)
    return a
  } finally {
    pendingBlocks.delete(key)
  }
}

// ---------- 2. 读者卡住了吗：停留和回看分档成文字，交给 Jev 决定要不要主动插话 ----------

type SuggestHandler = (s: { text: string; trace: JevTrace; analysis: BlockAnalysis; paneId: string; blockKey: string }) => void
let onSuggest: SuggestHandler | null = null
export function setSuggestHandler(fn: SuggestHandler): void {
  onSuggest = fn
}

const suggested = new Set<string>()
const stuckAsked = new Map<string, number>()

function dwellLevel(ms: number): string {
  if (ms < 3000) return '很短（扫一眼）'
  if (ms < 8000) return '正常'
  if (ms < 20000) return '偏长'
  return '很长（盯了很久）'
}

function visitLevel(n: number): string {
  if (n <= 1) return '第一次看'
  if (n === 2) return '回看过一次'
  return '反复回看了好几次'
}

function difficultyLevel(d: number): string {
  if (d < 0.8) return '容易'
  if (d < 1.6) return '中等'
  if (d < 2.4) return '难'
  return '非常难'
}

export async function onDwell(d: BlockDwell, opts: { aiReply?: boolean } = {}): Promise<void> {
  if (!jevEnabled()) return
  // AI 写的内容不判断难度，改成判断「这句要不要核实」
  if (opts.aiReply) {
    if (d.dwellMs >= 2500) await factCheck(d.text, d)
    return
  }
  if (d.text.trim().length < 24) return
  const key = hashText(d.text.trim())
  // 盯够 1.5 秒才分析，扫一眼的不花钱
  if (d.dwellMs >= 1500 && !analyses.has(key)) await analyzeBlock(d.text)
  const a = analyses.get(key)
  if (!a || suggested.has(key)) return
  // 百炼决策模型打难度偏保守（满篇公式的段落也就 1.4 左右），门槛放在 1.2
  const stuckish = (d.dwellMs >= 9000 || d.visits >= 3) && a.difficulty >= 1.2
  if (!stuckish) return
  // 同一段 20 秒内最多问一次
  const last = stuckAsked.get(key) || 0
  if (Date.now() - last < 20000) return
  stuckAsked.set(key, Date.now())
  const state = [
    `读者正在读这一段：${d.text.trim().slice(0, 1200)}`,
    `停留时间：${dwellLevel(d.dwellMs)}`,
    `回看情况：${visitLevel(d.visits)}`,
    `段落难度：${difficultyLevel(a.difficulty)}`,
    `含专业术语：${a.jargon > 0.6 ? '是' : '不明显'}`
  ].join('\n')
  const tr = await run('stuck', '读者是不是卡住了', state, {
    stuck: {
      type: 'noul',
      instructions: 'The reader is stuck on this passage and would welcome a short unprompted explanation right now'
    }
  })
  const p = tr.answers.stuck?.noul ?? 0
  summarize(tr, p >= 0.65 ? '你好像卡在这段了，提示了「A 拆开讲」' : '没卡住，不打扰')
  if (p >= 0.65) {
    suggested.add(key)
    onSuggest?.({ text: d.text, trace: tr, analysis: a, paneId: d.paneId, blockKey: d.blockKey })
  }
}

// ---------- 3. 提问路由：意图 / 要不要看图 / 答多深 ----------

const INTENT_TO_ACTION: Record<string, Action> = {
  explain: 'explain',
  translate: 'translate',
  summarize: 'summarize',
  derive: 'derive',
  critique: 'critique',
  other: 'ask'
}

const sentSeg = new Intl.Segmenter('zh', { granularity: 'sentence' })

/**
 * 视线只能到段落级：把焦点段落拆成候选句，交给 Jev 结合用户的话挑出指的是哪一句（指代消解）
 * 终端就按行拆。少于 2 句不用挑。
 */
export function candidatesOf(ctx: FocusContext | null): string[] {
  if (!ctx || ctx.gran === 'word' || ctx.gran === 'sentence') return []
  const src = ctx.paragraph || ctx.selection || ''
  let parts: string[]
  if (ctx.source === 'terminal') parts = src.split('\n')
  else parts = Array.from(sentSeg.segment(src), (x) => x.segment)
  parts = parts.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 4)
  return parts.length >= 2 ? parts.slice(0, 8) : []
}

export async function routeQuestion(
  question: string,
  ctx: FocusContext | null,
  candidates: string[] = []
): Promise<{ action: Action; needsImage: boolean; depth: number; target: number | null; trace: JevTrace } | null> {
  const lines = candidates.map((c, i) => `L${i + 1}: ${c.slice(0, 160)}`).join('\n')
  const state = [
    `用户的问题：${question}`,
    candidates.length
      ? `视线落点附近的候选句（普通摄像头眼动只能到段落级）：\n${lines}`
      : `用户正在看：${(ctx?.selection || ctx?.paragraph || '（无）').slice(0, 800)}`,
    `内容来源：${ctx?.source ?? '无'}`
  ].join('\n')
  const questions: Record<string, JevQuestion> = {
    intent: {
      type: 'choice',
      instructions: 'What does the user want the assistant to do with the content they are looking at',
      criteria: {
        explain: 'Explain the meaning of a term, sentence, formula or passage',
        translate: 'Translate the content into another language',
        summarize: 'Summarize or give the key points',
        derive: 'Derive, prove or walk through a formula step by step',
        critique: 'Critically evaluate: weaknesses, assumptions, what to question',
        other: 'Something else, such as a free-form question or small talk'
      }
    },
    needs_image: {
      type: 'noul',
      instructions: 'Answering well requires seeing the visual layout (a figure, chart, table, rendered equation or video frame) rather than only extracted text'
    },
    depth: {
      type: 'score',
      instructions: 'How detailed should the answer be',
      criteria: ['One sentence', 'A short paragraph', 'A detailed step by step explanation']
    }
  }
  if (candidates.length) {
    const criteria: Record<string, string> = {}
    candidates.forEach((c, i) => (criteria[`L${i + 1}`] = c.slice(0, 90)))
    questions.target = { type: 'choice', instructions: 'Which candidate line is the user referring to in the question', criteria }
  }
  const tr = await run('route', candidates.length ? '你指的是哪一句 · 想让我做什么' : '这句话想让我做什么', state, questions)
  if (tr.error) return null
  const intent = tr.answers.intent?.choice ?? 'other'
  const conf = tr.answers.intent?.confidence ?? 0
  let target: number | null = null
  const t = tr.answers.target
  if (t?.choice && (t.confidence ?? 0) >= 0.5) {
    const i = Number(t.choice.slice(1)) - 1
    if (i >= 0 && i < candidates.length) target = i
  }
  // 把握度低就不改写动作，按用户原话自由回答
  const action = conf >= 0.55 ? INTENT_TO_ACTION[intent] ?? 'ask' : 'ask'
  const needsImage = (tr.answers.needs_image?.noul ?? 0) >= 0.6
  const bits = [action !== 'ask' ? `按「${ACTION_NAME[action] ?? action}」答` : '', target !== null ? `指第 ${target + 1} 句` : '', needsImage ? '带上截图' : '']
  summarize(tr, `你的问题：${bits.filter(Boolean).join('，') || '照原话答'}`)
  return { action, needsImage, depth: tr.answers.depth?.score ?? 1, target, trace: tr }
}

/** 路由结果里的动作名（和对话区的叫法一致） */
export const ACTION_NAME: Partial<Record<Action, string>> = {
  explain: '解释',
  translate: '翻译',
  summarize: '总结',
  derive: '推导',
  critique: '挑刺'
}

// ---------- 3b. 放行终端里的编程智能体（Qwen Code）之前先评风险 ----------

export async function riskGate(screen: string): Promise<{ risky: boolean; reason: string; trace: JevTrace } | null> {
  if (!jevEnabled()) return null
  const tail = withoutModeLine(screen).split('\n').slice(-30).join('\n').trim()
  const agent = terminalAgent(screen) ?? '编程智能体'
  const tr = await run('terminal', 'Joy-Con 放行前的风险判断', `左侧终端里 ${agent} 请求执行操作，用户正要按手柄放行：\n${tail}`, {
    risk: {
      type: 'score',
      instructions: 'Risk level of approving the action the coding agent is asking permission for',
      criteria: ['Safe, read-only', 'Modifies local files, recoverable', 'Destructive or affects remote/shared state']
    },
    irreversible: { type: 'noul', instructions: 'Approving this can cause irreversible loss of work or data' },
    action: {
      type: 'choice',
      instructions: 'What should the assistant do before the user approves',
      criteria: {
        auto_approve: 'Safe enough to approve with a single button press',
        ask_user: 'Ask the user to confirm again with a second button press',
        block: 'Block and explain the danger'
      }
    }
  })
  if (tr.error) return null
  const risk = tr.answers.risk?.score ?? 0
  const irr = tr.answers.irreversible?.noul ?? 0
  const act = tr.answers.action?.choice ?? 'auto_approve'
  const risky = act !== 'auto_approve' || irr >= 0.6 || risk >= 1.5
  const reason = `${risk < 0.5 ? '只读' : risk < 1.5 ? '会改本地文件' : '会删东西或动到远端'}${irr >= 0.6 ? '，可能撤不回来' : ''}`
  summarize(tr, `${agent} 要执行的操作${reason}${risky ? '，要再按一次才放行' : '，直接放行'}`)
  return { risky, reason, trace: tr }
}

// ---------- 3c. 盯着 AI 回复里带数字 / 出处的句子：要不要核实 ----------

type FactHandler = (s: { text: string; trace: JevTrace; risk: number; paneId: string; blockKey: string }) => void
let onFact: FactHandler | null = null
export function setFactHandler(fn: FactHandler): void {
  onFact = fn
}
const factChecked = new Set<string>()

export async function factCheck(text: string, d: { paneId: string; blockKey: string }): Promise<void> {
  const clean = text.trim()
  // 本地粗筛：有数字、百分比、年份或「研究 / 报告 / 据」这类出处词才值得问
  if (clean.length < 12 || !/\d|%|％|研究|报告|据|论文|Nature|Science|arXiv|统计|调查/.test(clean)) return
  const key = hashText(clean)
  if (factChecked.has(key)) return
  factChecked.add(key)
  const tr = await run('fact', '这句要不要核实', `用户正盯着 AI 回复里的这句话：\n${clean.slice(0, 600)}`, {
    verifiable_claim: {
      type: 'noul',
      instructions: 'The sentence contains a specific factual claim with numbers or sources that should be fact-checked'
    },
    // 档位写成中文并说清每档长什么样：百炼决策模型只给 Low / Medium / High 三个词时，「2024 年 Nature 研究称缺陷率降 57%」这种也只打 0.2
    hallucination_risk: {
      type: 'score',
      instructions: '这句话里的数字或出处是编造或不准确的可能性',
      criteria: ['低：常识或广为人知、可轻易查证', '中：具体但有可能记错', '高：精确数字配权威出处却难以查证，像是编的']
    }
  })
  if (tr.error) return
  const v = tr.answers.verifiable_claim?.noul ?? 0
  const r = tr.answers.hallucination_risk?.score ?? 0
  const flag = v >= 0.7 && r >= 0.5
  summarize(tr, flag ? '回答里这句的数字或出处可能不准' : '回答里这句看着没问题')
  if (flag) onFact?.({ text: clean, trace: tr, risk: r, paneId: d.paneId, blockKey: d.blockKey })
}

// ---------- 4. 盯着终端里的编程智能体（Qwen Code）：它在等你拍板时提醒 ----------

type TermAlert = (s: { state: string; trace: JevTrace; agent: string; docId?: string }) => void
let onTermAlert: TermAlert | null = null
export function setTerminalAlertHandler(fn: TermAlert): void {
  onTermAlert = fn
}

let lastTermHash = ''
let lastTermAt = 0
let termRetry: ReturnType<typeof setTimeout> | null = null

/**
 * 终端输出停下来时调用，传「取当前整屏」的函数。两次判断至少隔 8 秒；节流期间不直接丢掉，到点再看一眼最新屏幕——
 * 否则确认框刚好在上次判断后 8 秒内弹出、之后屏幕不再动，就永远不会提醒（Qwen Code 实测踩到过）
 */
export async function judgeTerminal(getScreen: () => string, docId?: string): Promise<void> {
  if (!jevEnabled()) return
  let screen: string
  try {
    screen = getScreen()
  } catch {
    return // 终端已关
  }
  const tail = withoutModeLine(screen).split('\n').slice(-30).join('\n').trim()
  if (!tail) return
  // 先本地粗筛：屏幕上不像编程智能体 / 交互确认的，不花 Jev 的钱
  if (!looksLikeAgent(screen)) return
  const h = hashText(tail)
  if (h === lastTermHash) return
  const wait = lastTermAt + 8000 - Date.now()
  if (wait > 0) {
    if (termRetry) clearTimeout(termRetry)
    termRetry = setTimeout(() => {
      termRetry = null
      void judgeTerminal(getScreen, docId)
    }, wait)
    return
  }
  lastTermHash = h
  lastTermAt = Date.now()
  const known = terminalAgent(screen)
  const agent = known ?? '编程智能体'
  const tr = await run('terminal', `${agent} 现在是什么状态`, tail, {
    state: {
      type: 'choice',
      instructions: 'What is the state of the coding agent shown at the bottom of this terminal output',
      criteria: {
        working: 'Still working or streaming output',
        waiting_permission: 'Waiting for the user to approve or reject an action (a permission prompt with options)',
        asking_user: 'Asking the user a question and waiting for an answer',
        error: 'Stopped with an error',
        done: 'Finished the task and is idle at the prompt',
        idle: 'Just a shell prompt or unrelated output'
      }
    },
    stuck: { type: 'noul', instructions: 'The agent is stuck repeating the same failing approach' }
  })
  const st = tr.answers.state?.choice
  // 认得出是 Qwen Code 时本地规则认确认框很准：屏幕上没有确认框却判成「等你批准」，不提醒
  const noPrompt = st === 'waiting_permission' && !!known && !looksLikePermissionPrompt(screen)
  const STATE_CN: Record<string, string> = {
    working: '在干活',
    waiting_permission: '在等你批准',
    asking_user: '在问你',
    error: '出错停了',
    done: '做完了',
    idle: '闲着'
  }
  const stuck = (tr.answers.stuck?.noul ?? 0) >= 0.7
  const waiting = (st === 'waiting_permission' || st === 'asking_user') && (tr.answers.state?.confidence ?? 0) >= 0.6 && !noPrompt
  summarize(tr, `${agent} ${waiting ? STATE_CN[st!] : stuck ? '好像卡住了' : STATE_CN[st ?? ''] ?? '状态不明'}`)
  if (waiting) {
    onTermAlert?.({ state: st!, trace: tr, agent, docId })
  } else if (stuck) {
    onTermAlert?.({ state: 'stuck', trace: tr, agent, docId })
  } else if (docId && termAlertStore.get().docId === docId) {
    // 它又动起来了（批准过了 / 答过了）：标签上的提醒收掉
    clearTermAlert()
  }
}

export async function refreshJevUsage(): Promise<void> {
  jevStore.patch({ usage: await la.jev.usage() })
}
