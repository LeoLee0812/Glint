import { la } from './appState'
import { isMac } from './platform'

// Windows：右上角的最小化 / 最大化 / 关闭是系统画的，不会跟着弹窗的半透明蒙层一起变暗；
// 页面上出现 .modal-mask 时把按钮条的底色也调成蒙层压暗后的灰，关掉弹窗再换回白

if (!isMac) {
  let dim = false
  const check = () => {
    const now = !!document.querySelector('.modal-mask')
    if (now === dim) return
    dim = now
    la.win.setOverlayDim(now)
  }
  new MutationObserver(check).observe(document.body, { childList: true, subtree: true })
}
