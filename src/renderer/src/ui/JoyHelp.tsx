import { useEffect } from 'react'
import { useStore } from '../store'
import { uiStore } from '../appState'
import { input } from '../input/joycon'

// 按键速查：左手管左边，右手管右边

const LEFT: Array<[string, string]> = [
  ['左摇杆', '上下滚动 · 左右翻页'],
  ['左摇杆按下', '眼动翻页 开/关'],
  ['十字键 ↑↓', '文档：跳段 · 终端：方向键'],
  ['十字键 → ←', '文档：翻页 · 终端：回车 / Esc'],
  ['L', '切换左侧标签'],
  ['ZL（按住）', '说话 → 打字进终端（Qwen Code）'],
  ['−', '视线跟左边内容 · 已在左边再按 = 漂移校正（终端里 = ⇧Tab）· 长按重新校准'],
  ['截图键', '整块截图，蓝圈标出你在看哪，交给看图模型重点解释']
]

const RIGHT: Array<[string, string]> = [
  ['右摇杆', '微调焦点：先落到视线圈吸住的词，再左右逐词、上下逐行'],
  ['右摇杆按下', '焦点跳回视线处（视线圈吸着词就落在那个词上）'],
  ['A', '解释'],
  ['X', '翻译'],
  ['Y', '总结'],
  ['B', '放开焦点 / 停止回答 / 收起最下面一层解释窗口'],
  ['ZR（按住）', '说话提问，松开发送'],
  ['R', '粒度：词 → 句 → 段 → 节'],
  ['+', '视线跟右边的回答，不懂的按 A 往下裂变解释 · 长按 = Jev 开/关'],
  ['HOME', '显示/隐藏 Glint']
]

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
        <h2>Joy-Con 按键：左手管左边，右手管右边</h2>
        <div className="help-cols">
          <div>
            <h3 className="joy-l">左手 · 操作内容</h3>
            <table>
              <tbody>
                {LEFT.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="joy-r">右手 · 问 AI</h3>
            <table>
              <tbody>
                {RIGHT.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="dim small">
          键盘兜底：⌥+方向键 移焦点 · ⌥⇧+方向键 滚动 · ⌥↩ 解释 · ⌥T 翻译 · ⌥S 总结 · ⌥G 粒度 · 按住⌥空格 说话 · 按住⌥V 说给终端 · ⌥C 看图 · ⌥D 视线跟左边 · ⌥J 视线跟右边（按住 = Jev）· ⌥L 切标签
        </p>
        <button className="btn primary" onClick={() => uiStore.patch({ showHelp: false })}>
          知道了（B）
        </button>
      </div>
    </div>
  )
}
