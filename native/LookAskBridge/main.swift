import Foundation
import AppKit

// LookAsk 原生助手入口：Electron 主进程把它当子进程拉起，stdin/stdout 走 JSON 行协议。
// 负责 Electron 做不好的系统级能力：Joy-Con 原始 HID、语音识别、OCR、辅助功能取词。

setvbuf(stdout, nil, _IONBF, 0)

let joycons = JoyConManager()
let speech = SpeechController()

// --probe：终端里单独跑，人类可读地打印手柄事件，方便排查
if CommandLine.arguments.contains("--probe") {
    logMsg("probe 模式：按手柄按键看输出，Ctrl+C 退出")
}

joycons.start()
warmUpOCR()

startCommandReader { cmd in
    guard let name = cmd["cmd"] as? String else { return }
    let id = cmd["id"] as? Int ?? 0
    switch name {
    case "ping":
        emit(["t": "pong", "id": id, "ax": axTrusted(prompt: false)])
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
    case "ocr":
        if let path = cmd["path"] as? String {
            runOCR(id: id, path: path, fast: cmd["fast"] as? Bool ?? false)
        }
    case "ax_at":
        axTextAt(id: id, x: cmd["x"] as? Double ?? 0, y: cmd["y"] as? Double ?? 0)
    case "ax_prompt":
        emit(["t": "ax_trust", "id": id, "trusted": axTrusted(prompt: true)])
    case "quit":
        exit(0)
    default:
        emit(["t": "error", "id": id, "msg": "未知命令 \(name)"])
    }
}

emit(["t": "ready", "version": "0.1.0", "pid": Int(ProcessInfo.processInfo.processIdentifier)])
RunLoop.main.run()
