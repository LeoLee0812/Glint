import { emit, logMsg, startCommandReader } from './io'
import { JoyConManager } from './joycon'

// Glint 原生助手（Windows 版）入口：Electron 主进程用 ELECTRON_RUN_AS_NODE 把它当 Node 子进程拉起，stdin/stdout 走 JSON 行协议，
// 命令和事件跟 Mac 版 Swift 助手（native/LookAskBridge/main.swift）一一对应。
// 只管 Joy-Con：语音在 Windows 上走百炼云端识别（主进程 src/main/asrCloud.ts），iPhone 原深感 Windows 版不做

const joycons = new JoyConManager()
// 测试用：LOOKASK_BRIDGE_NO_JOY=1 不接管 Joy-Con，免得和正在用的 Glint 抢手柄
const noJoy = process.env.LOOKASK_BRIDGE_NO_JOY === '1'

// --probe：终端里单独跑，按手柄按键看输出，方便排查
if (process.argv.includes('--probe')) logMsg('probe 模式：按手柄按键看输出，Ctrl+C 退出')

if (!noJoy) joycons.start()

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

startCommandReader(
  (cmd) => {
    const id = num(cmd.id, 0)
    switch (cmd.cmd) {
      case 'ping':
        emit({ t: 'pong', id })
        break
      case 'joy_list':
        joycons.listConnected()
        break
      case 'rumble':
        joycons.rumble(str(cmd.side), num(cmd.amp, 0.45), num(cmd.ms, 70), num(cmd.low, 160), num(cmd.high, 320))
        break
      case 'rumble_seq':
        // 分段震动：seq = [[毫秒, 低频, 高频, 振幅, 结束低频?, 结束高频?, 结束振幅?], ...]
        joycons.play(
          str(cmd.side),
          Array.isArray(cmd.seq) ? (cmd.seq as unknown[]).filter(Array.isArray).map((s) => (s as unknown[]).map((x) => num(x, 0))) : [],
          num(cmd.prio, 1),
          cmd.force === true
        )
        break
      case 'lights':
        joycons.setLights(str(cmd.side), num(cmd.mask, 1) & 0xff)
        break
      case 'home_led':
        joycons.setHome(str(cmd.side), str(cmd.mode) ?? 'off')
        break
      case 'joy_find':
        joycons.locate(num(cmd.seconds, 3))
        break
      case 'imu_stream':
        // 手腕精调：开着时每个 0x30 包推一次 joy_gyro；最多 20 秒，渲染进程忘了关也会自己停
        joycons.stream(str(cmd.side), cmd.on === true ? 20 : 0)
        break
      case 'td_start':
      case 'td_stop':
        // iPhone 原深感只有 Mac 版有
        emit({ t: 'td_listen', ok: false, error: 'Windows 版不支持 iPhone 原深感', stopped: cmd.cmd === 'td_stop' })
        break
      case 'display_mm':
        // 显示器物理尺寸在 Windows 上由主进程读 EDID（src/main/displayWin.ts），这里回 0 让它走自己的办法
        emit({ t: 'display_mm', id, display: num(cmd.display, 0), w: 0, h: 0, ptw: 0, pth: 0, builtin: false })
        break
      case 'quit':
        joycons.shutdown().finally(() => process.exit(0))
        break
      default:
        emit({ t: 'error', id, msg: `未知命令 ${cmd.cmd}` })
    }
  },
  () => joycons.shutdown()
)

emit({ t: 'ready', version: '0.1.0', pid: process.pid })
