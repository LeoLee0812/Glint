import type { FocusContext, Granularity } from '../focus/types'
import { GRAN_LABEL } from '../focus/types'

// 把「焦点上下文 + 动作」拼成发给大模型的提示词

export type Action = 'explain' | 'translate' | 'summarize' | 'ask' | 'capture' | 'derive' | 'critique'

export const ACTION_LABEL: Record<Action, string> = {
  explain: '解释',
  translate: '翻译',
  summarize: '总结',
  ask: '提问',
  capture: '看图',
  derive: '推导',
  critique: '挑刺'
}

const SOURCE_LABEL: Record<FocusContext['source'], string> = {
  markdown: 'Markdown 文档',
  pdf: 'PDF 论文',
  terminal: '终端',
  chat: '你之前的回答'
}

function hasCJK(s: string): boolean {
  return /[一-鿿]/.test(s)
}

export function formatContext(ctx: FocusContext): string {
  const lines: string[] = []
  const where = [ctx.docTitle && `《${ctx.docTitle}》`, SOURCE_LABEL[ctx.source], ctx.location].filter(Boolean).join(' · ')
  lines.push(`【用户正在看】${where}`)
  if (ctx.origin) lines.push(`【这段回答当时在回应】${ctx.origin}`)
  if (ctx.selection) lines.push(`【焦点（${GRAN_LABEL[ctx.gran]}）】\n${ctx.selection}`)
  if (ctx.paragraph && ctx.paragraph !== ctx.selection) lines.push(`【所在段落】\n${ctx.paragraph}`)
  if (ctx.section) lines.push(`【所在小节】${ctx.section}`)
  if (ctx.before) lines.push(`【上文】\n${ctx.before}`)
  if (ctx.after) lines.push(`【下文】\n${ctx.after}`)
  if (ctx.extra) lines.push(ctx.source === 'terminal' ? `【终端当前整屏】\n${ctx.extra}` : `【界面原文】\n${ctx.extra}`)
  if (ctx.image) lines.push('【附图】用户盯着的区域截图已附上')
  return lines.join('\n\n')
}

function explainTask(g: Granularity, ctx: FocusContext): string {
  if (ctx.source === 'terminal') {
    return '这是终端（多半是 Qwen Code）里的输出。说清楚焦点这部分是什么意思：它在做什么、在问用户什么、有没有风险、用户下一步该怎么回应。'
  }
  switch (g) {
    case 'word':
      return '解释焦点这个词 / 符号 / 公式在这里的含义：先一句话说它是什么，再结合上下文说它在这里起什么作用；缩写先展开，公式逐项说明符号。'
    case 'sentence':
      return '把焦点这句话讲明白：它在说什么、为什么这么说、和前后文什么关系。'
    case 'paragraph':
      return '用大白话讲清这一段在说什么：核心观点、关键概念、论证链条；读者最可能卡住的地方重点讲。'
    case 'section':
      return '概括这一节的主线：解决什么问题、用了什么方法、得到什么结论。'
  }
}

const DEPTH_HINT = ['\n\n（只用一两句话回答。）', '\n\n（简短回答，一小段即可。）', '\n\n（请详细、分步骤讲清楚。）']

/** 右侧模式下对回答里某一处的追问：答案进往下裂变出的解释窗口，只讲这一处 */
export const FORK_HINT = '\n\n（这是在右侧「解释窗口」里对上面回答某一处的追问：只讲清楚焦点这一处，简短，不要把前面已经讲过的内容再讲一遍。）'

/** 看图问：整张截图 + 蓝圈标出视线位置，不再纠结具体是哪一行 */
function capturePrompt(ctx: FocusContext | null, question?: string): string {
  const where = ctx?.region || '屏幕'
  const lines: string[] = []
  if (ctx?.circle) {
    lines.push(`图片是用户${where}的整张截图。图上那个蓝色圆圈是后加的标注，圈出了用户此刻视线所在的位置（摄像头眼动估计，可能偏几十像素）。`)
    lines.push(
      '请重点解释蓝色圆圈里的内容：先用一句话说圈里是什么（一个词、公式、图表、代码、界面元素……），再讲清楚它的意思，需要时结合整张图的上下文；圈里有好几样东西时，优先讲最靠近圆心的那个。蓝圈本身不是原图内容，不用解释它。'
    )
  } else {
    lines.push(`图片是用户${where}的整张截图（这次没拿到视线位置）。先一句话说这张图整体在讲什么，再挑最可能让人卡住的地方讲清楚。`)
  }
  const near = ctx?.selection || ctx?.paragraph
  if (near) lines.push(`【蓝圈附近的原文（从页面文字层取的，仅供参考，以图为准）】\n${near}`)
  if (ctx?.origin) lines.push(`【这块内容当时在回应】${ctx.origin}`)
  if (question) lines.push(`用户的问题：${question}`)
  return lines.join('\n\n')
}

/** depth：Jev 判断的详略档位 0~2，不传就按默认 */
export function buildPrompt(action: Action, ctx: FocusContext | null, question?: string, depth?: number): string {
  const hint = depth === undefined ? '' : DEPTH_HINT[Math.max(0, Math.min(2, Math.round(depth)))]
  return buildPromptInner(action, ctx, question) + hint
}

function buildPromptInner(action: Action, ctx: FocusContext | null, question?: string): string {
  const c = ctx ? formatContext(ctx) + '\n\n' : ''
  const sel = ctx?.selection || ctx?.paragraph || ''
  switch (action) {
    case 'explain':
      return `${c}${ctx ? explainTask(ctx.gran, ctx) : '解释一下。'}`
    case 'translate': {
      const target = hasCJK(sel) ? '英文' : '中文'
      return `${c}把焦点内容翻译成${target}。术语第一次出现保留原文括注；只给译文和必要的一两句注释，不要逐字解释。`
    }
    case 'summarize':
      return `${c}总结焦点所在的${ctx && ctx.gran === 'section' ? '小节' : '段落'}：3～5 条要点，每条一句话；最后用一句话说它在全文里起什么作用。`
    case 'capture':
      return capturePrompt(ctx, question)
    case 'derive':
      return `${c}把焦点里的公式 / 结论一步一步推导出来，每一步说明用了什么。${question ? `\n用户的问题：${question}` : ''}`
    case 'critique':
      return `${c}以审稿人的眼光看焦点内容：它的假设、潜在漏洞、可以追问的地方。${question ? `\n用户的问题：${question}` : ''}`
    case 'ask':
    default:
      return ctx
        ? `${c}用户的问题：${question || '这是什么意思？'}\n（上面是用户提问时正在看的内容：和问题相关就结合着答；不相关就直接回答问题本身，别硬扯。）`
        : question || '这是什么意思？'
  }
}

/** 用户气泡里显示的简短文字 */
export function bubbleText(action: Action, ctx: FocusContext | null, question?: string): string {
  if (question) return question
  const sel = (ctx?.selection || ctx?.paragraph || '').replace(/\s+/g, ' ')
  const short = sel.length > 40 ? sel.slice(0, 40) + '…' : sel
  if (action === 'capture') return ctx?.circle ? '看图：解释蓝圈里的内容' : '看图：这张图在讲什么'
  return `${ACTION_LABEL[action]}${short ? `「${short}」` : ''}`
}
