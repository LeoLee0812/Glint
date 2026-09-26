import Foundation

// 与 Electron 主进程通信：stdout 每行一条 JSON 事件，stdin 每行一条 JSON 命令

private let outQueue = DispatchQueue(label: "lookask.bridge.stdout")

/// 输出一条事件（线程安全，整行写出，避免多线程交错）
func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    outQueue.async {
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }
}

func logMsg(_ msg: String) {
    emit(["t": "log", "msg": msg])
}

/// 后台线程逐行读 stdin，解析后切回主线程交给 handler
func startCommandReader(_ handler: @escaping ([String: Any]) -> Void) {
    let thread = Thread {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            DispatchQueue.main.async { handler(obj) }
        }
        // stdin 关闭说明父进程已退出，助手跟着退出，避免残留孤儿进程
        DispatchQueue.main.async { exit(0) }
    }
    thread.start()
}
