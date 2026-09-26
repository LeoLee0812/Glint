import type { JevAnswer } from '../../../shared/types'
import type { JevTrace } from './jevBrain'

// Jev 判断结果的小条：choice 显示前两名概率，score 显示档位条，noul 显示百分比

const NAME: Record<string, string> = {
  difficulty: '难度',
  jargon: '含术语',
  kind: '类型',
  stuck: '卡住了',
  intent: '意图',
  needs_image: '要看图',
  depth: '详细度',
  state: '状态',
  target: '指的是',
  risk: '风险',
  irreversible: '不可逆',
  action: '建议',
  verifiable_claim: '可核实',
  hallucination_risk: '幻觉风险'
}

const CHOICE_CN: Record<string, string> = {
  prose: '叙述',
  definition: '定义',
  math: '公式推导',
  algorithm: '算法',
  result: '实验结果',
  figure: '图表说明',
  code: '代码',
  references: '参考文献',
  explain: '解释',
  translate: '翻译',
  summarize: '总结',
  derive: '推导',
  critique: '挑刺',
  other: '其他',
  working: '正在干活',
  waiting_permission: '等你批准',
  asking_user: '在问你',
  error: '出错了',
  done: '做完了',
  idle: '空闲',
  auto_approve: '直接放行',
  ask_user: '再确认一次',
  block: '拦下来'
}

function Answer({ k, a }: { k: string; a: JevAnswer }): React.JSX.Element {
  if (a.type === 'noul') {
    const p = a.noul ?? 0
    return (
      <span className="jb">
        {NAME[k] || k} <b>{Math.round(p * 100)}%</b>
        <i className="bar" style={{ width: `${p * 36}px` }} />
      </span>
    )
  }
  if (a.type === 'score') {
    const max = a.legend ? Object.keys(a.legend).length - 1 : 3
    const v = a.score ?? 0
    return (
      <span className="jb" title={a.legend ? Object.values(a.legend).join(' → ') : ''}>
        {NAME[k] || k} <b>{v.toFixed(1)}</b>/{max}
        <i className="bar" style={{ width: `${(v / Math.max(1, max)) * 36}px` }} />
      </span>
    )
  }
  const probs = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1])
  return (
    <span className="jb" title={probs.map(([n, p]) => `${CHOICE_CN[n] || n} ${Math.round(p * 100)}%`).join('  ')}>
      {NAME[k] || k} <b>{CHOICE_CN[a.choice || ''] || (/^L\d+$/.test(a.choice || '') ? `第 ${a.choice!.slice(1)} 句` : a.choice)}</b>
      {probs[0] && ` ${Math.round(probs[0][1] * 100)}%`}
    </span>
  )
}

export function JevBadges({ traces }: { traces: JevTrace[] }): React.JSX.Element {
  return (
    <div className="jev-badges">
      {traces.map((t) => (
        <div key={t.id} className="jev-line">
          <span className="jev-logo">Jev</span>
          {t.error ? (
            <span className="err small">{t.error}</span>
          ) : (
            Object.entries(t.answers).map(([k, a]) => <Answer key={k} k={k} a={a} />)
          )}
          <span className="dim small">{t.cached ? '缓存' : `${t.tokens} tok · ${t.ms}ms`}</span>
        </div>
      ))}
    </div>
  )
}
