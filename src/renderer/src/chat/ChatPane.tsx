import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { chatStore, ask, abort, clearChat, removeMsg, exportChat, popFork, closeFork, type ChatMsg, type ForkCard } from './chatStore'
import { renderMarkdown, renderStreaming } from './markdown'
import { focus, panes } from '../focus/focus'
import { DomAdapter, ElementBlocks } from '../focus/domAdapter'
import { GRAN_LABEL, unionBox } from '../focus/types'
import { settingsStore, updateSettings, la, toast, uiStore } from '../appState'
import { openDoc } from '../panes/docs'
import { Icon } from '../ui/Icon'

// 右侧对话区：焦点卡片 + 快捷动作 + 流式回答；回答本身也能被眼睛「看中」再追问
// 右侧模式（右手柄 +）下追问回答里的某一处，解释不塞进主对话，而是在下面裂变出一个解释窗口，可以一层层往下问

/** 文本节点往上找带某个 data 属性的条目（消息 / 解释卡片），给焦点上下文当 ref */
function refOf(attr: 'mid' | 'card') {
  return (n: Node): string | undefined => {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement
    return (el?.closest(`[data-${attr}]`) as HTMLElement | null)?.dataset[attr] || undefined
  }
}

function ModelPicker(): React.JSX.Element | null {
  const s = useStore(settingsStore).s
  if (!s) return null
  const opts = s.providers.filter((p) => p.apiKey).flatMap((p) => p.models.map((m) => ({ v: `${p.id}::${m}`, label: `${p.name.split(' ')[0]} · ${m}` })))
  const cur = `${s.chatModel.providerId}::${s.chatModel.model}`
  return (
    <select
      className="model-pick"
      value={cur}
      onChange={(e) => {
        const [providerId, model] = e.target.value.split('::')
        updateSettings((x) => ({ ...x, chatModel: { providerId, model } }))
      }}
      title="回答用的模型"
    >
      {!opts.some((o) => o.v === cur) && <option value={cur}>{s.chatModel.model}（没填 Key）</option>}
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function FocusChip(): React.JSX.Element {
  const f = useStore(focus.state)
  const side = useStore(uiStore).side
  if (f.mode === 'none' || !f.sel) {
    return (
      <div className="focus-chip empty">
        {side === 'right' ? '看着回答里没懂的地方，按 A' : '还没选中内容'}
      </div>
    )
  }
  const text = f.sel.text.replace(/\s+/g, ' ')
  return (
    <div className={`focus-chip ${f.mode}`}>
      <span className="fc-tag">
        <Icon name={f.mode === 'hard' ? 'scope' : 'eye'} />
        {f.sel.unit ?? GRAN_LABEL[f.gran]}
      </span>
      <span className="fc-text">{text ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : ''}</span>
    </div>
  )
}

function UserMsg({ m }: { m: ChatMsg }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="msg user" data-mid={m.id}>
      <div className="bubble msg-plain">{m.text}</div>
      {m.ctx && (m.ctx.selection || m.ctx.paragraph || m.ctx.scan) && (
        <div className="ctx-quote" onClick={() => setOpen((o) => !o)}>
          <div className="cq-head">
            <Icon name="pin" />
            {m.ctx.docTitle}
            {m.ctx.location ? ` · ${m.ctx.location}` : ''} · {m.ctx.scan?.unit ?? GRAN_LABEL[m.ctx.gran]}
          </div>
          <div className={`cq-body ${open ? 'open' : ''}`}>
            {m.ctx.selection || m.ctx.paragraph || '扫描件，发的是下面这张截图'}
          </div>
        </div>
      )}
      {m.image && <img className="ctx-img" src={m.image} alt="焦点截图" />}
      {m.jevNote && <div className="jev-note">Jev · {m.jevNote}</div>}
    </div>
  )
}

function BotMsg({ m, onRetry }: { m: ChatMsg; onRetry: () => void }): React.JSX.Element {
  const html = useMemo(() => (m.status === 'streaming' ? renderStreaming(m.text) : renderMarkdown(m.text)), [m.text, m.status])
  return (
    <div className={`msg bot ${m.status}`} data-mid={m.id}>
      {m.reasoning && m.status === 'streaming' && !m.text && <div className="thinking">思考中… {m.reasoning.slice(-80)}</div>}
      {m.status === 'streaming' && !m.text && !m.reasoning && <div className="thinking">正在看你盯着的内容…</div>}
      <div className="md-doc msg-md" dangerouslySetInnerHTML={{ __html: html }} />
      {m.status === 'error' && <div className="err">出错了：{m.error}</div>}
      {m.status !== 'streaming' && (
        <div className="msg-foot">
          <span className="dim">{m.model}</span>
          <button className="link" onClick={() => navigator.clipboard.writeText(m.text).then(() => toast('已复制', 'ok'))}>
            复制
          </button>
          <button
            className="link"
            onClick={() => openDoc({ kind: 'md', title: 'AI 回复 · ' + m.text.replace(/[#*`>\n]/g, ' ').trim().slice(0, 10), text: m.text })}
          >
            在左侧阅读
          </button>
          <button className="link" onClick={onRetry}>
            重答
          </button>
        </div>
      )}
    </div>
  )
}

function NoteMsg({ m }: { m: ChatMsg }): React.JSX.Element {
  return (
    <div className="msg note" data-mid={m.id}>
      <div className="note-body">{m.text}</div>
      <button className="link" onClick={() => removeMsg(m.id)}>
        忽略
      </button>
    </div>
  )
}

function ForkCardView({ c, depth }: { c: ForkCard; depth: number }): React.JSX.Element {
  const a = c.ans
  const html = useMemo(() => (a.status === 'streaming' ? renderStreaming(a.text) : renderMarkdown(a.text)), [a.text, a.status])
  return (
    <div className={`fork-card ${a.status}`} data-card={c.id}>
      <div className="fork-q focus-skip">
        <span className="fork-depth">{depth + 1}</span>
        <span className="ellipsis">{c.ask.text}</span>
      </div>
      {c.ask.image && <img className="ctx-img" src={c.ask.image} alt="截图" />}
      {a.reasoning && a.status === 'streaming' && !a.text && <div className="thinking">思考中… {a.reasoning.slice(-80)}</div>}
      {a.status === 'streaming' && !a.text && !a.reasoning && <div className="thinking">正在看你指的这一处…</div>}
      <div className="md-doc msg-md" dangerouslySetInnerHTML={{ __html: html }} />
      {a.status === 'error' && <div className="err">出错了：{a.error}</div>}
      {a.status === 'done' && (
        <div className="msg-foot focus-skip">
          <span className="dim">{a.model}</span>
        </div>
      )}
    </div>
  )
}

/** 往下裂变出的解释窗口：每追问一层就往下长一张卡片；它本身也是一个能被眼睛选中的视图 */
function ForkPanel({ cards }: { cards: ForkCard[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const last = cards[cards.length - 1]

  useEffect(() => {
    const blocks = new ElementBlocks(() => ref.current)
    const adapter = new DomAdapter({
      id: 'fork',
      kind: 'chat',
      root: () => ref.current,
      blocks,
      docTitle: () => '解释窗口',
      capture: (rect) => la.win.capture(rect),
      refOf: refOf('card')
    })
    const off = panes.register(adapter)
    const mo = new MutationObserver(() => blocks.invalidate())
    if (ref.current) mo.observe(ref.current, { childList: true, subtree: true })
    return () => {
      off()
      mo.disconnect()
    }
  }, [])

  // 最新一层尽量整张露出来：往下滚，但最多滚到它的开头贴着顶（再长就从开头往下读）
  const follow = () => {
    const el = ref.current
    const node = last && el?.querySelector<HTMLElement>(`[data-card="${last.id}"]`)
    if (!el || !node) return
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8
    el.scrollTop = Math.max(el.scrollTop, Math.min(top, el.scrollHeight - el.clientHeight))
  }
  useEffect(() => {
    stick.current = true
    follow()
    requestAnimationFrame(() => focus.refresh())
  }, [last?.id])
  // 流式输出时跟着长（用户自己往上翻了就不打扰）
  useEffect(() => {
    if (stick.current && last?.ans.status === 'streaming') follow()
  }, [last?.ans.text])

  return (
    <div className="fork">
      <div className="fork-head">
        <span className="fork-mark">
          <Icon name="split" />
        </span>
        <b>解释窗口</b>
        <span className="dim small">第 {cards.length} 层</span>
        <span className="grow" />
        {cards.length > 1 && (
          <button className="btn sm ghost" onClick={() => popFork()} title="按 B 也行">
            上一层
          </button>
        )}
        <button className="btn sm ghost" onClick={closeFork}>
          关闭
        </button>
      </div>
      <div
        className="fork-scroll"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {cards.map((c, i) => (
          <ForkCardView key={c.id} c={c} depth={i} />
        ))}
      </div>
    </div>
  )
}

export function ChatPane(): React.JSX.Element {
  const chat = useStore(chatStore)
  const s = useStore(settingsStore).s
  const ui = useStore(uiStore)
  const listRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const stick = useRef(true)

  // 回答区也注册成可被视线选中的视图
  useEffect(() => {
    const blocks = new ElementBlocks(() => listRef.current)
    const adapter = new DomAdapter({
      id: 'chat',
      kind: 'chat',
      root: () => listRef.current,
      blocks,
      docTitle: () => '右侧对话',
      capture: (rect) => la.win.capture(rect),
      refOf: refOf('mid')
    })
    const off = panes.register(adapter)
    const mo = new MutationObserver(() => blocks.invalidate())
    if (listRef.current) mo.observe(listRef.current, { childList: true, subtree: true })
    return () => {
      off()
      mo.disconnect()
    }
  }, [])

  // 新内容自动滚到底（用户往上翻了就不打扰）
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.msgs])

  // 解释窗口开合会挤压 / 放开回答区：刚问的那一处别被挤到下面看不见，高亮框也跟着重算
  const forkOpen = chat.fork.length > 0
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = listRef.current
      const st = focus.state.get()
      const u = forkOpen && st.paneId === 'chat' && st.sel ? unionBox(st.sel.rects) : null
      if (el && u) {
        const r = el.getBoundingClientRect()
        const bottom = u.y + Math.min(u.height, 120)
        if (bottom > r.bottom - 16) el.scrollBy({ top: bottom - r.bottom + 40 })
      }
      focus.refresh()
    })
  }, [forkOpen])

  const send = () => {
    const q = draft.trim()
    if (!q) return
    setDraft('')
    ask('ask', { question: q, target: 'main' })
  }

  const retry = (i: number) => {
    const prevUser = [...chat.msgs.slice(0, i)].reverse().find((m) => m.role === 'user')
    if (!prevUser) return
    ask(prevUser.action || 'ask', { question: prevUser.action === 'ask' ? prevUser.text : undefined, ctx: prevUser.ctx, target: 'main' })
  }

  const jevOn = !!s?.jevMode

  return (
    <section className="right">
      <header className="chat-head">
        <ModelPicker />
        <label className={`jev-toggle ${jevOn ? 'on' : ''}`} title="长按右手柄 + 也能开关">
          <input
            type="checkbox"
            checked={jevOn}
            onChange={(e) => {
              if (e.target.checked && !s?.jev.apiKey) {
                toast('先在设置里填 Jev Key', 'warn')
                uiStore.patch({ showSettings: true })
                return
              }
              updateSettings((x) => ({ ...x, jevMode: e.target.checked }))
            }}
          />
          Jev 模式
        </label>
        <span className="grow" />
        <button
          className="btn sm ghost"
          onClick={async () => {
            const p = await la.file.saveText('Glint 对话.md', exportChat())
            if (p) toast('已导出 ' + p, 'ok')
          }}
          title="导出成 Markdown 文件"
        >
          导出
        </button>
        <button className="btn sm ghost" onClick={clearChat}>
          清空
        </button>
      </header>

      <div
        className="msgs"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {!chat.msgs.length && (
          <div className="chat-empty no-focus">
            <p>
              <Icon name="eye" />
              <span>看着哪里不懂，按 <b>A</b> 解释</span>
            </p>
            <p>
              <Icon name="gamepad" />
              <span>按 <b>R</b> 换成整句、整段，按 <b>X</b> 翻译</span>
            </p>
            <p>
              <Icon name="mic" />
              <span>按住 <b>ZR</b> 说出你的问题</span>
            </p>
          </div>
        )}
        {chat.msgs.map((m, i) =>
          m.role === 'user' ? <UserMsg key={m.id} m={m} /> : m.role === 'assistant' ? <BotMsg key={m.id} m={m} onRetry={() => retry(i)} /> : <NoteMsg key={m.id} m={m} />
        )}
      </div>

      {forkOpen && <ForkPanel cards={chat.fork} />}

      <div className="composer">
        <FocusChip />
        <div className="quick">
          <button className="btn sm" onClick={() => ask('explain')}>
            解释 <kbd>A</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('translate')}>
            翻译 <kbd>X</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('summarize')}>
            总结 <kbd>Y</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('capture')} title="左手柄截图键">
            看图问 <Icon name="camera" />
          </button>
          {chat.busy && (
            <button className="btn sm warn" onClick={abort}>
              停止 <kbd>B</kbd>
            </button>
          )}
        </div>
        {chat.asr.active ? (
          <div className="asr-live">
            <span className="mic" /> {chat.asr.target === 'terminal' ? '说给终端：' : '正在听：'}
            {chat.asr.text || '…'}
          </div>
        ) : (
          <textarea
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
        )}
      </div>
    </section>
  )
}
