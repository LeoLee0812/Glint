import Foundation
import AppKit

// LookAsk 原生助手入口：Electron 主进程把它当子进程拉起，stdin/stdout 走 JSON 行协议。
// 负责 Electron 做不好的系统级能力：Joy-Con 原始 HID、语音识别、收 iPhone 原深感数据。

setvbuf(stdout, nil, _IONBF, 0)

let joycons = JoyConManager()
let speech = SpeechController()
let truedepth = TrueDepthReceiver()
// 测试用：LOOKASK_BRIDGE_NO_JOY=1 不接管 Joy-Con（只收原深感数据），免得和正在用的 LookAsk 抢手柄
let noJoy = ProcessInfo.processInfo.environment["LOOKASK_BRIDGE_NO_JOY"] == "1"

// --probe：终端里单独跑，人类可读地打印手柄事件，方便排查
if CommandLine.arguments.contains("--probe") {
    logMsg("probe 模式：按手柄按键看输出，Ctrl+C 退出")
}

if !noJoy { joycons.start() }
// 父进程退出（stdin 关了）时也要收尾：停震动、关 HOME 灯
beforeExit = { joycons.shutdown() }

startCommandReader { cmd in
    guard let name = cmd["cmd"] as? String else { return }
    let id = cmd["id"] as? Int ?? 0
    switch name {
    case "ping":
        emit(["t": "pong", "id": id])
    case "joy_list":
        joycons.listConnected()
    case "rumble":
        joycons.rumble(
            side: cmd["side"] as? String,
            amplitude: cmd["amp"] as? Double ?? 0.45,
            ms: cmd["ms"] as? Int ?? 70,
            low: cmd["low"] as? Double ?? 160,
            high: cmd["high"] as? Double ?? 320
        )
    case "rumble_seq":
        // 分段震动：seq = [[毫秒, 低频, 高频, 振幅, 结束低频?, 结束高频?, 结束振幅?], ...]
        joycons.play(
            side: cmd["side"] as? String,
            segs: cmd["seq"] as? [[Double]] ?? [],
            prio: cmd["prio"] as? Int ?? 1,
            force: cmd["force"] as? Bool ?? false
        )
    case "lights":
        joycons.setLights(side: cmd["side"] as? String, mask: UInt8(cmd["mask"] as? Int ?? 1))
    case "home_led":
        joycons.setHome(side: cmd["side"] as? String, mode: cmd["mode"] as? String ?? "off")
    case "joy_find":
        joycons.locate(seconds: cmd["seconds"] as? Double ?? 3)
    case "imu_stream":
        // 手腕精调：开着时每个 0x30 包推一次 joy_gyro；最多 20 秒，渲染进程忘了关也会自己停
        joycons.stream(side: cmd["side"] as? String, seconds: (cmd["on"] as? Bool ?? false) ? 20 : 0)
    case "asr_start":
        speech.start(lang: cmd["lang"] as? String ?? "zh-CN", target: cmd["target"] as? String ?? "chat")
    case "asr_stop":
        speech.stop()
    case "td_start":
        let port = (cmd["port"] as? Int).map { UInt16(clamping: $0) }
        truedepth.start(port: port, name: cmd["name"] as? String)
    case "td_stop":
        truedepth.stop()
    case "td_send":
        if let ep = cmd["ep"] as? String, let d = cmd["d"] as? String { truedepth.send(ep: ep, text: d) }
    case "display_mm":
        displayMillimeters(id: id, display: UInt32(clamping: cmd["display"] as? Int ?? 0))
    case "quit":
        joycons.shutdown()
        exit(0)
    default:
        emit(["t": "error", "id": id, "msg": "未知命令 \(name)"])
    }
}

emit(["t": "ready", "version": "0.1.0", "pid": Int(ProcessInfo.processInfo.processIdentifier)])
RunLoop.main.run()
