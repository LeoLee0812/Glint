import { useEffect, useState } from 'react'
import { la, setUiMode, toast } from '../appState'

// 全局模式入口：LookAsk 缩成右侧边栏，左边可以是任何 App（浏览器、预览、微信、IDE…）

export function WindowPane(): React.JSX.Element {
  const [perm, setPerm] = useState<{ camera: string; microphone: string; screen: string } | null>(null)
  const [ax, setAx] = useState<boolean | null>(null)

  const refresh = async () => setPerm(await la.perm.status())

  useEffect(() => {
    refresh()
    const off = la.bridge.onEvent((e: any) => {
      if (e.t === 'pong') setAx(!!e.ax)
      if (e.t === 'ax_trust') setAx(!!e.trusted)
    })
    la.bridge.send({ cmd: 'ping', id: 99 })
    const t = setInterval(() => {
      refresh()
      la.bridge.send({ cmd: 'ping', id: 99 })
    }, 4000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const ok = (v?: string | boolean | null) => v === 'granted' || v === true

  return (
    <div className="doc-scroll">
      <article className="md-doc window-pane">
        <h1>全局模式</h1>
        <p>
          左侧不一定是 LookAsk 里的文档。进入全局模式后，LookAsk 缩成屏幕右边的侧边栏，一个透明浮层把视线圈和焦点框画在整块屏幕上，
          你在任何 App 里看到哪、按 A 就问哪：浏览器里的论文、预览里的 PDF、微信里的长消息、IDE 里的报错、B 站视频画面都行。
        </p>
        <p>取上下文的方式：截焦点那一块屏幕 → 系统 OCR 识字；能拿到原文的 App（终端、浏览器、备忘录等）再用辅助功能读原文；截图同时发给视觉模型。</p>

        <h2>需要的权限</h2>
        <ul className="perm-list">
          <li className={ok(perm?.camera) ? 'ok' : 'bad'}>
            摄像头（眼动）：{perm?.camera ?? '…'}
            {!ok(perm?.camera) && (
              <button className="btn sm" onClick={() => la.perm.openSettings('camera')}>
                去打开
              </button>
            )}
          </li>
          <li className={ok(perm?.screen) ? 'ok' : 'bad'}>
            录屏与系统录音（看见别的 App）：{perm?.screen ?? '…'}
            {!ok(perm?.screen) && (
              <button className="btn sm" onClick={() => la.perm.openSettings('screen')}>
                去打开
              </button>
            )}
          </li>
          <li className={ax ? 'ok' : 'bad'}>
            辅助功能（直接读原文，可选）：{ax === null ? '…' : ax ? '已授权' : '未授权'}
            {!ax && (
              <button
                className="btn sm"
                onClick={() => {
                  la.bridge.axPrompt()
                  la.perm.openSettings('accessibility')
                }}
              >
                去打开
              </button>
            )}
          </li>
          <li className={ok(perm?.microphone) ? 'ok' : 'bad'}>
            麦克风（按住扳机说话）：{perm?.microphone ?? '…'}
            {!ok(perm?.microphone) && (
              <button className="btn sm" onClick={() => la.perm.openSettings('microphone')}>
                去打开
              </button>
            )}
          </li>
        </ul>
        <p className="dim">授权后如果没生效，退出 LookAsk 再打开一次（macOS 的录屏权限要重启 App 才生效）。</p>

        <p>
          <button
            className="btn primary"
            onClick={async () => {
              await setUiMode('global')
              toast('已进入全局模式：看任何 App，按 A 问；长按 HOME 或点侧边栏顶部按钮退出', 'ok', { ttl: 6000 })
            }}
          >
            进入全局模式
          </button>
        </p>
        <h2>全局模式下的手柄</h2>
        <ul>
          <li>视线照常移动焦点框；右摇杆按屏幕像素挪框（左右 90 点、上下 30 点）</li>
          <li>R 切换框的大小：词 / 句 / 段 / 节</li>
          <li>A 解释 · X 翻译 · Y 总结 · 截图键看图问 · 按住 ZR 说话</li>
          <li>长按 HOME 回到普通模式</li>
        </ul>
      </article>
    </div>
  )
}
