import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { la, settingsStore, toast, uiStore } from '../appState'
import { panes } from '../focus/focus'
import { createTerminalAdapter } from '../focus/terminalAdapter'
import { judgeTerminal } from '../jev/jevBrain'
import { AGENT } from './agent'
import type { Doc } from './docs'

// 终端视图：node-pty 起登录 shell，一键启动 Qwen Code（命令 qwen，百炼 Key 由主进程带进环境变量）；
// 手柄十字键 = 方向键 / 回车 / Esc，ZL 语音直接打字进来

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
      // 白底终端：Qwen Code 这类终端界面默认按深色背景配色，靠最低对比度自动把浅色字压深，不会糊成一片
      minimumContrastRatio: 4.5,
      theme: {
        background: '#ffffff',
        foreground: '#1d1d1f',
        cursor: '#007aff',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(0, 122, 255, 0.22)',
        black: '#1d1d1f',
        red: '#d70015',
        green: '#248a3d',
        yellow: '#b25000',
        blue: '#0040dd',
        magenta: '#8944ab',
        cyan: '#0071a4',
        white: '#8e8e93',
        brightBlack: '#6e6e73',
        brightRed: '#ff3b30',
        brightGreen: '#34c759',
        brightYellow: '#ff9500',
        brightBlue: '#007aff',
        brightMagenta: '#af52de',
        brightCyan: '#32ade6',
        brightWhite: '#c7c7cc'
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
          settleTimer = setTimeout(() => judgeTerminal(() => screenOf(term), doc.id), 1500)
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

  // 启动 Qwen Code；没装的话 shell 会报 command not found，就地用 npm 装上再启动
  const startAgent = () => {
    run(`${AGENT.cmd}\r`)
    if (!settingsStore.get().s?.providers.find((p) => p.id === 'qwen')?.apiKey) {
      toast('还没填百炼 Key，Qwen Code 会先让你登录。填好后新开个终端就行', 'warn', {
        ttl: 8000,
        action: { label: '去填 Key', run: () => uiStore.patch({ showSettings: true }) }
      })
    }
    let installing = false
    const check = () => {
      const t = termRef.current
      if (installing || !t || !/command not found: qwen|qwen: command not found/.test(screenOf(t).split('\n').slice(-4).join('\n'))) return
      installing = true
      run(`${AGENT.install}\r`)
      toast('还没装 Qwen Code，正在装，装好会自己启动', 'info', { ttl: 8000 })
    }
    // shell 刚起来时 .zshrc 可能还没跑完，看两次
    setTimeout(check, 1500)
    setTimeout(check, 4000)
  }

  return (
    <div className="term-pane">
      <div className="pane-toolbar">
        <button className="btn sm primary" onClick={startAgent}>
          启动 Qwen Code
        </button>
        <button className="btn sm" onClick={() => run('clear\r')}>
          清屏
        </button>
        {exited && <span className="warn small">终端已退出，关掉这个标签重开一个</span>}
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
