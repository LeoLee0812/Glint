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
    case "lights":
        joycons.setLights(side: cmd["side"] as? String, mask: UInt8(cmd["mask"] as? Int ?? 1))
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
        exit(0)
    default:
        emit(["t": "error", "id": id, "msg": "未知命令 \(name)"])
    }
}

emit(["t": "ready", "version": "0.1.0", "pid": Int(ProcessInfo.processInfo.processIdentifier)])
RunLoop.main.run()
