// 「Glint Eye 已连接」顶部弹窗：白色胶囊从屏幕顶部正中滑出，Mac 上在菜单栏（刘海）正下方。
// 桌面版放进一个独立的透明置顶窗口（Glint 窗口不在前台也看得到），平板版直接插进页面，样式共用这一份

/** 弹窗显示多久（毫秒），含进出动画 */
export const ISLAND_MS = 3000

export function islandCss(): string {
  return `
.glint-island {
  position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
  display: flex; align-items: center; justify-content: center; gap: 10px; box-sizing: border-box;
  height: 52px; padding: 0 22px;
  background: rgba(255, 255, 255, 0.97); color: #1d1d1f; border-radius: 26px; white-space: nowrap;
  border: 0.5px solid rgba(0, 0, 0, 0.1);
  font: 600 15px/1 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
  letter-spacing: 0.01em; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.08);
  z-index: 2147483647; pointer-events: none;
  animation: gi-in 0.55s cubic-bezier(0.2, 1.25, 0.35, 1) both, gi-out 0.32s cubic-bezier(0.5, 0, 0.8, 0.4) ${(ISLAND_MS - 340) / 1000}s forwards;
}
.glint-island svg { width: 22px; height: 22px; flex: none; animation: gi-fade 0.3s 0.16s both; }
.glint-island span { animation: gi-fade 0.3s 0.2s both; }
.glint-island .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #34c759; box-shadow: 0 0 6px rgba(52, 199, 89, 0.7); animation: gi-fade 0.3s 0.26s both; }
.glint-island.off .dot { background: #aeaeb2; box-shadow: none; }
.glint-island.off .iris { fill: #aeaeb2; }
.glint-island .iris { fill: #0a84ff; transform-origin: 12px 12px; animation: gi-look 0.9s 0.35s ease-in-out; }
@keyframes gi-in { from { transform: translate(-50%, -90px) scale(0.72); opacity: 0; } to { transform: translate(-50%, 0) scale(1); opacity: 1; } }
@keyframes gi-out { to { transform: translate(-50%, -90px) scale(0.8); opacity: 0; } }
@keyframes gi-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gi-look { 0%, 100% { transform: scale(1); } 40% { transform: scale(1.35); } }
`
}

export function islandHtml(text: string, on: boolean): string {
  const safe = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  return `<div class="glint-island ${on ? '' : 'off'}"><svg viewBox="0 0 24 24" fill="none"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="#1d1d1f" stroke-width="1.6" stroke-linejoin="round"/><circle class="iris" cx="12" cy="12" r="3.4"/></svg><span>${safe}</span><i class="dot"></i></div>`
}
