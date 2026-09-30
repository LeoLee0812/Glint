import { useEffect } from 'react'
import { useStore } from '../store'
import { uiStore } from '../appState'
import { input, type Btn } from '../input/joycon'
import { openGuide } from '../onboarding'
import { KeyCap, Kbd } from './JoyKeys'
import { MOD, TALK_KEY } from '../platform'

// 按键速查：左手管左边的内容，右手管右边的 AI。第一次用的人走新手引导，这里只当备查

type Row = [Btn[], string, string?]

const LEFT: Row[] = [
  [['LS'], '滚动，左右推是翻页'],
  [['Up', 'Down'], '上一段 / 下一段'],
  [['Left', 'Right'], '翻页'],
  [['L'], '切标签'],
  [['ZL'], '对终端说话', '按住'],
  [['Minus'], '视线跟左边'],
  [['Capture'], '截图问']
]

const TERMINAL: Row[] = [
  [['Up', 'Down'], '选选项'],
  [['Right'], '确认'],
  [['Left'], '取消'],
  [['Minus'], '切审批模式']
]

const RIGHT: Row[] = [
  [['RS'], '挪焦点，一次一格'],
  [['RS'], '跳到你正在看的地方', '按下'],
  [['RS'], '转手腕微调', '按住'],
  [['A'], '解释'],
  [['X'], '翻译'],
  [['Y'], '总结'],
  [['B'], '取消 / 停止'],
  [['ZR'], '说出问题，松开发送', '按住'],
  [['R'], '一格多大：词 / 句 / 段 / 节'],
  [['Plus'], '视线跟右边，长按开关 Jev'],
  [['Home'], '显示 / 隐藏窗口']
]

function Rows({ rows }: { rows: Row[] }): React.JSX.Element {
  return (
    <div className="kh-rows">
      {rows.map(([keys, what, how], i) => (
        <div className="kh-row" key={i}>
          <span className="kh-keys">
            {how && <span className="kh-how">{how}</span>}
            {keys.map((k) => (
              <KeyCap key={k} k={k} />
            ))}
          </span>
          <span className="kh-what">{what}</span>
        </div>
      ))}
    </div>
  )
}

export function JoyHelp(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  useEffect(() => {
    if (!ui.showHelp) return
    return input.onAction((a) => a === 'cancel' && uiStore.patch({ showHelp: false }))
  }, [ui.showHelp])
  if (!ui.showHelp) return null
  return (
    <div className="modal-mask" onClick={() => uiStore.patch({ showHelp: false })}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <h2>按键</h2>
        <div className="help-cols">
          <section className="kh-card kh-L">
            <h3>左手 · 管内容</h3>
            <Rows rows={LEFT} />
            <h4>在终端里</h4>
            <Rows rows={TERMINAL} />
          </section>
          <section className="kh-card kh-R">
            <h3>右手 · 问 AI</h3>
            <Rows rows={RIGHT} />
          </section>
        </div>
        <div className="kh-kb">
          <b>没手柄时</b>
          <span>
            <Kbd>{MOD}</Kbd>
            <Kbd>方向键</Kbd> 挪焦点
          </span>
          <span>
            <Kbd>{MOD}</Kbd>
            <Kbd>↩</Kbd> 解释
          </span>
          <span>
            <Kbd>{MOD}</Kbd>
            <Kbd>T</Kbd> 翻译
          </span>
          <span>
            <Kbd>{MOD}</Kbd>
            <Kbd>S</Kbd> 总结
          </span>
          <span>
            按住 <Kbd>{MOD}</Kbd>
            <Kbd>{TALK_KEY}</Kbd> 说话
          </span>
        </div>
        <div className="kh-actions">
          <button
            className="btn ghost"
            onClick={() => {
              uiStore.patch({ showHelp: false })
              openGuide()
            }}
          >
            从头走一遍引导
          </button>
          <button className="btn primary" onClick={() => uiStore.patch({ showHelp: false })}>
            知道了（B）
          </button>
        </div>
      </div>
    </div>
  )
}
