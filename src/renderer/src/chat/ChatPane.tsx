import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { chatStore, ask, abort, clearChat, removeMsg, exportChat, type ChatMsg } from './chatStore'
import { renderMarkdown, renderStreaming } from './markdown'
import { focus, panes } from '../focus/focus'
import { DomAdapter, ElementBlocks } from '../focus/domAdapter'
import { GRAN_LABEL } from '../focus/types'
import { settingsStore, updateSettings, la, toast, uiStore, setUiMode } from '../appState'
import { openDoc } from '../panes/docs'
import { JevPanel } from '../jev/JevPanel'
import { JevBadges } from '../jev/JevBadges'

// 右侧对话区：焦点卡片 + 快捷动作 + 流式回答；回答本身也能被眼睛「看中」再追问

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
      title="回答用的模型（设置里还能分别指定快速模型和看图模型）"
    >
      {!opts.some((o) => o.v === cur) && <option value={cur}>{s.chatModel.model}（未配置 Key）</option>}
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
  if (f.mode === 'none' || !f.sel) {
    return <div className="focus-chip empty">没有焦点：看向左边的内容，或推一下右摇杆（⌥ + 方向键）</div>
  }
  const text = f.sel.text.replace(/\s+/g, ' ')
  return (
    <div className={`focus-chip ${f.mode}`}>
      <span className="fc-tag">{f.mode === 'hard' ? '🎯' : '👁'} {GRAN_LABEL[f.gran]}</span>
      <span className="fc-text">{text ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : f.sel.space === 'screen' ? '（屏幕区域，发问时再截图识别）' : ''}</span>
    </div>
  )
}

function UserMsg({ m }: { m: ChatMsg }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="msg user">
      <div className="bubble msg-plain">{m.text}</div>
      {m.ctx && (m.ctx.selection || m.ctx.paragraph) && (
        <div className="ctx-quote" onClick={() => setOpen((o) => !o)}>
          <div className="cq-head">
            📍 {m.ctx.docTitle}
            {m.ctx.location ? ` · ${m.ctx.location}` : ''} · {GRAN_LABEL[m.ctx.gran]}
          </div>
          <div className={`cq-body ${open ? 'open' : ''}`}>{m.ctx.selection || m.ctx.paragraph}</div>
        </div>
      )}
      {m.image && <img className="ctx-img" src={m.image} alt="焦点截图" />}
      {m.jev && <JevBadges traces={m.jev} />}
    </div>
  )
}

function BotMsg({ m, onRetry }: { m: ChatMsg; onRetry: () => void }): React.JSX.Element {
  const html = useMemo(() => (m.status === 'streaming' ? renderStreaming(m.text) : renderMarkdown(m.text)), [m.text, m.status])
  return (
    <div className={`msg bot ${m.status}`}>
      {m.reasoning && m.status === 'streaming' && !m.text && <div className="thinking">思考中… {m.reasoning.slice(-80)}</div>}
      {m.status === 'streaming' && !m.text && !m.reasoning && <div className="thinking">正在看你盯着的内容…</div>}
      <div className="md-doc msg-md" dangerouslySetInnerHTML={{ __html: html }} />
      {m.status === 'error' && <div className="err">出错了：{m.error}</div>}
      {m.status !== 'streaming' && (
        <div className="msg-foot">
          <span className="dim">
            {m.model}
            {m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}
          </span>
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
    <div className="msg note">
      <div className="note-body">{m.text}</div>
      {m.jev && <JevBadges traces={m.jev} />}
      <button className="link" onClick={() => removeMsg(m.id)}>
        忽略
      </button>
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
      capture: (rect) => la.win.capture(rect)
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

  const send = () => {
    const q = draft.trim()
    if (!q) return
    setDraft('')
    ask('ask', { question: q })
  }

  const retry = (i: number) => {
    const prevUser = [...chat.msgs.slice(0, i)].reverse().find((m) => m.role === 'user')
    if (!prevUser) return
    ask(prevUser.action || 'ask', { question: prevUser.action === 'ask' ? prevUser.text : undefined, ctx: prevUser.ctx })
  }

  const jevOn = !!s?.jevMode

  return (
    <section className="right">
      <header className="chat-head">
        {ui.mode === 'global' && (
          <button className="btn sm" onClick={() => setUiMode('normal')} title="回到普通模式（长按 HOME）">
            ← 退出全局
          </button>
        )}
        <ModelPicker />
        <label className={`jev-toggle ${jevOn ? 'on' : ''}`} title="Jev 模式：先判断再开口（右手柄 + 键）">
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
            const p = await la.file.saveText('LookAsk 对话.md', exportChat())
            if (p) toast('已导出 ' + p, 'ok')
          }}
          title="导出成 Markdown"
        >
          导出
        </button>
        <button className="btn sm ghost" onClick={clearChat} title="清空对话">
          清空
        </button>
      </header>

      {jevOn && <JevPanel />}

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
            <p>👀 {ui.mode === 'global' ? '看向屏幕上任何一处' : '看向左边的一段'}，按 <b>A</b> 解释</p>
            <p>🕹 推右摇杆精确到词，按 <b>X</b> 翻译、<b>Y</b> 总结</p>
            <p>🎙 按住 <b>ZR</b> 说出你的问题</p>
            <p className="dim">键盘：⌥↩ 解释 · ⌥T 翻译 · ⌥S 总结 · 按住 ⌥空格 说话</p>
          </div>
        )}
        {chat.msgs.map((m, i) =>
          m.role === 'user' ? <UserMsg key={m.id} m={m} /> : m.role === 'assistant' ? <BotMsg key={m.id} m={m} onRetry={() => retry(i)} /> : <NoteMsg key={m.id} m={m} />
        )}
      </div>

      <div className="composer">
        <FocusChip />
        <div className="quick">
          <button className="btn sm" onClick={() => ask('explain')} title="A">
            解释 <kbd>A</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('translate')} title="X">
            翻译 <kbd>X</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('summarize')} title="Y">
            总结 <kbd>Y</kbd>
          </button>
          <button className="btn sm" onClick={() => ask('capture')} title="截图键">
            看图问 <kbd>📷</kbd>
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
            placeholder="问点什么（自动带上你正在看的内容）· Enter 发送 · Shift+Enter 换行"
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
