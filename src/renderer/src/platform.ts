// 界面上和平台有关的写法集中在这儿：修饰键（Mac ⌥ / Windows Alt）、按住说话的键、摄像头叫法、iPhone 原深感只有 Mac 版有。
// 直接读 window.lookask，不经 appState，免得循环引用

export const isMac = window.lookask.platform === 'darwin'

/** 键盘快捷键的修饰键 */
export const MOD = isMac ? '⌥' : 'Alt'

/** 修饰键 + 一个键，写在句子里的样子：Mac「⌥ 回车」，Windows「Alt+回车」 */
export function combo(key: string): string {
  return isMac ? `⌥ ${key}` : `Alt+${key}`
}

/**
 * 按住说话的键：Mac 是 ⌥空格；Windows 的 Alt+空格 会弹出窗口的系统菜单（空格根本到不了页面），
 * 改成 Alt+V（V = Voice，左手一只手就能按住）。TALK_CODE 是 KeyboardEvent.code，TALK_KEY 是键帽上写的字
 */
export const TALK_CODE = isMac ? 'Space' : 'KeyV'
export const TALK_KEY = isMac ? '空格' : 'V'

/** 眼动输入源里的摄像头叫什么 */
export const CAM_NAME = isMac ? 'Mac 摄像头' : '摄像头'

/** iPhone 原深感（手机把数据发给 Mac 上的原生助手）只有 Mac 版有 */
export const HAS_TRUEDEPTH = isMac
