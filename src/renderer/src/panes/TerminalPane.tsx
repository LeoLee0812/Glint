import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { la } from '../appState'
import { panes } from '../focus/focus'
import { createTerminalAdapter } from '../focus/terminalAdapter'
import { judgeTerminal } from '../jev/jevBrain'
import type { Doc } from './docs'

// 终端视图：node-pty 起登录 shell，直接跑 agent；手柄十字键 = 方向键 / 回车 / Esc，ZL 语音直接打字进来

export interface TermHandle {
  term: Terminal
  write: (data: string) => void
  screenText: () => string
}

export const terminals = new Map<string, TermHandle>()

export const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  shiftTab: '\x1b[Z',
  ctrlC: '\x03'
}

function screenOf(t: Terminal): string {
  const b = t.buffer.active
  const out: string[] = []
  for (let r = b.viewportY; r < b.viewportY + t.rows; r++) out.push(b.getLine(r)?.translateToString(true) ?? '')
  return out.join('\n').trim()
}

export function TerminalPane({ doc, active }: { doc: Doc; active: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [ptyId, setPtyId] = useState<string | null>(null)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "PingFang SC", monospace',
      fontSize: 13,
      lineHeight: 1.18,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      macOptionIsMeta: false,
      theme: {
        background: '#0b0d11',
        foreground: '#d7dde8',
        cursor: '#5eead4',
        selectionBackground: '#334155',
        black: '#1b1f27',
        brightBlack: '#5c6370'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    let id: string | null = null
    let disposed = false
    const offs: Array<() => void> = []
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    requestAnimationFrame(async () => {
      try {
        fit.fit()
      } catch {
        /* 容器还没尺寸 */
      }
      id = await la.pty.create({ cols: term.cols, rows: term.rows })
      if (disposed) {
        la.pty.kill(id)
        return
      }
      setPtyId(id)
      offs.push(
        la.pty.onData((p) => {
          if (p.id !== id) return
          term.write(p.data)
          // 输出停下来 1.5 秒后，让 Jev 看一眼 Qwen Code 是不是在等你拍板
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(() => judgeTerminal(screenOf(term)), 1500)
        })
      )
      offs.push(
        la.pty.onExit((p) => {
          if (p.id === id) setExited(true)
        })
      )
      term.onData((d) => id && la.pty.write(id, d))
      terminals.set(doc.id, {
        term,
        write: (d) => id && la.pty.write(id, d),
        screenText: () => screenOf(term)
      })
    })

    const ro = new ResizeObserver(() => {
      if (!host.offsetWidth) return
      try {
        fit.fit()
        if (id) la.pty.resize(id, term.cols, term.rows)
      } catch {
        /* 忽略 */
      }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      offs.forEach((f) => f())
      if (settleTimer) clearTimeout(settleTimer)
      terminals.delete(doc.id)
      if (id) la.pty.kill(id)
      term.dispose()
    }
  }, [doc.id])

  useEffect(() => {
    if (!active) return
    const adapter = createTerminalAdapter(`doc:${doc.id}`, () => termRef.current, () => doc.title)
    const off = panes.register(adapter)
    setTimeout(() => termRef.current?.focus(), 30)
    return off
  }, [active, doc.id])

  const run = (cmd: string) => {
    if (ptyId) la.pty.write(ptyId, cmd)
    termRef.current?.focus()
  }

  return (
    <div className="term-pane">
      <div className="pane-toolbar">
        <button className="btn sm primary" onClick={() => run('agent\r')}>
          启动 Qwen Code
        </button>
        <button className="btn sm" onClick={() => run('clear\r')}>
          清屏
        </button>
        <span className="dim small">十字键 ↑↓ 选选项 · → 回车 · ← Esc · 按住 ZL 说话直接打字</span>
        {exited && <span className="warn small">shell 已退出，关掉这个标签重开</span>}
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
