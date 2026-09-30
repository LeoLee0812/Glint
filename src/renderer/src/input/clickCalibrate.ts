import { gaze } from '../gaze/engine'
import { uiStore, toast, clientToScreen } from '../appState'

// ⌥ + 点击 = 漂移校正：读着读着视线点飘了，就按住 ⌥ 点一下自己正在看的地方，
// 点击处当作「真实落点」，和点击前一小段的原始预测做残差，视线点立刻拉回来。
// 只纠漂移（engine 的残差校正），不重新拟合模型。
// 落硬焦点仍由 focus.ts 的 ⌥+点击 处理；没校准时这里什么都不做，⌥+点击 就只是落焦点。

window.addEventListener(
  'mousedown',
  (e) => {
    if (!e.altKey || e.button !== 0) return
    if (uiStore.get().showCalibration) return
    // 捕获阶段拦下来：不让 ⌥+点击 去选字、点链接，或触发终端的移动光标
    e.preventDefault()
    e.stopPropagation()
    if (!gaze.isCalibrated()) return
    // 人一般先看过去再点，取按下前 400ms 的平均预测
    const pred = gaze.recentPrediction(400)
    if (!pred) {
      toast('没看到脸，没法校正', 'warn')
      return
    }
    const target = clientToScreen(e.clientX, e.clientY)
    gaze.addResidual(target, pred, 2)
    toast('视线拉回来了', 'ok')
  },
  true
)

// 把随 mousedown 而来的 click 也吞掉，免得链接照样打开
window.addEventListener(
  'click',
  (e) => {
    if (e.altKey && e.button === 0 && !uiStore.get().showCalibration) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true
)
