import { useEffect } from 'react'
import { useStore } from '../store'
import { settingsStore } from '../appState'
import { jevStore, refreshJevUsage, type JevTrace } from './jevBrain'

// Jev 判断记录：顶栏 Jev 药丸点开的小弹层，用大白话列最近的判断（不再占对话区）；鼠标停在一条上能看原始概率

const KIND: Record<JevTrace['kind'], string> = {
  block: '看段落',
  stuck: '卡住了吗',
  route: '听你问',
  terminal: '看终端',
  fact: '核实'
}

/** 原始判断结果，鼠标悬停时看 */
function raw(t: JevTrace): string {
  return Object.entries(t.answers)
    .map(([k, a]) => (a.type === 'noul' ? `${k} ${Math.round((a.noul ?? 0) * 100)}%` : a.type === 'score' ? `${k} ${(a.score ?? 0).toFixed(1)}` : `${k} ${a.choice}`))
    .join(' · ')
}

function ago(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${Math.round(s / 3600)} 小时前`
}

export function JevLog({ left, onClose }: { left: number; onClose: () => void }): React.JSX.Element {
  const j = useStore(jevStore)
  const s = useStore(settingsStore).s

  useEffect(() => {
    refreshJevUsage()
    // 点外面、按 Esc 就收起
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.jev-pop, .pill.jev')) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const list = j.traces.slice(0, 12)
  return (
    <div className="jev-pop" style={{ left: Math.max(8, Math.min(left, window.innerWidth - 368)) }}>
      <div className="jev-pop-head">
        <b>Jev 判断记录</b>
        {j.usage && (
          <span>
            今天 {j.usage.inputTokens.toLocaleString()} / {(s?.jev.dailyTokenCap ?? 0).toLocaleString()} token
          </span>
        )}
      </div>
      {list.length ? (
        <ul>
          {list.map((t) => (
            <li key={t.id} title={raw(t)}>
              <span className="k">{KIND[t.kind]}</span>
              <span className="s">{t.error ? `没判断成：${t.error}` : (t.summary ?? '…')}</span>
              <span className="t">{ago(t.t)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="jev-pop-empty">盯着一段看一会儿，它就开始判断了</p>
      )}
    </div>
  )
}
