import MarkdownIt from 'markdown-it'
import katexPlugin from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'

// Markdown 渲染：左侧阅读和右侧回答共用；公式走 KaTeX（保留 LaTeX 源码方便焦点取回），代码高亮

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(code, lang) {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      return hljs.highlightAuto(code).value
    } catch {
      return ''
    }
  }
})
md.use((katexPlugin as any).default ?? katexPlugin, { throwOnError: false, output: 'htmlAndMathml' })

// 链接一律新窗口打开（主进程会转给系统浏览器）
const defaultLink = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  return defaultLink(tokens, idx, options, env, self)
}

/** 模型常用 \( \) \[ \] 写公式，统一换成 $ 形式再渲染 */
function normalizeMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, g) => `$$${g}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, g) => `$${g}$`)
}

export function renderMarkdown(src: string): string {
  return md.render(normalizeMath(src))
}

/** 流式输出时公式/代码块可能只来了一半，补个临时收尾再渲染，避免闪烁 */
export function renderStreaming(src: string): string {
  let s = src
  const fences = (s.match(/```/g) || []).length
  if (fences % 2 === 1) s += '\n```'
  const dollars = (s.match(/(?<!\\)\$\$/g) || []).length
  if (dollars % 2 === 1) s += '$$'
  return renderMarkdown(s)
}
