import Foundation
import Network
import CoreGraphics
import SystemConfiguration

// iPhone 原深感眼动收包：开一个 UDP 监听并发布 Bonjour 服务 _lookask._udp（带点对点 Wi-Fi），
// 手机上的 LookAskEye 找到这台 Mac 后按帧发 UDP 数据报。
// 助手只当管道：每个数据报原样转成一行 td_pkt 交给主进程（配对校验、乱序丢弃都在主进程做）；
// 主进程要回话（ack）时发 td_send，从同一个 UDP 流回给手机。
// 放在原生助手里而不是 Node 里收，是为了白拿 Network.framework 的 Bonjour、点对点 Wi-Fi 和热点支持。

let tdServiceType = "_lookask._udp"
let tdDefaultPort: UInt16 = 47650

final class TrueDepthReceiver {
    private let queue = DispatchQueue(label: "lookask.td")
    private var listener: NWListener?
    private var conns: [String: NWConnection] = [:]
    private var lastSeen: [String: Date] = [:]
    private var sweeper: DispatchSourceTimer?
    private var wantPort: UInt16 = tdDefaultPort
    private var wantName = ""
    /// 指定端口被占（比如装好的 LookAsk 和开发版同时开）时退到系统随机端口，Bonjour 会带上真实端口
    private var triedFallback = false

    func start(port: UInt16?, name: String?) {
        queue.async {
            self.stopLocked()
            self.wantPort = port ?? tdDefaultPort
            self.wantName = (name?.isEmpty == false ? name! : nil) ?? computerName()
            self.triedFallback = false
            self.listen(on: self.wantPort)
            self.startSweeper()
        }
    }

    func stop() {
        queue.async {
            self.stopLocked()
            emit(["t": "td_listen", "ok": false, "stopped": true])
        }
    }

    /// 回一个数据报给某个手机（ep 是 td_pkt 里带的那个）
    func send(ep: String, text: String) {
        queue.async {
            guard let c = self.conns[ep] else { return }
            c.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
        }
    }

    // ---------- 内部 ----------

    private func stopLocked() {
        listener?.cancel()
        listener = nil
        for c in conns.values { c.cancel() }
        conns.removeAll()
        lastSeen.removeAll()
        sweeper?.cancel()
        sweeper = nil
    }

    private func listen(on port: UInt16) {
        let params = NWParameters.udp
        params.includePeerToPeer = true
        params.allowLocalEndpointReuse = true
        let nwPort = port == 0 ? NWEndpoint.Port.any : (NWEndpoint.Port(rawValue: port) ?? .any)
        let l: NWListener
        do {
            l = try NWListener(using: params, on: nwPort)
        } catch {
            emit(["t": "td_listen", "ok": false, "error": "开监听失败：\(error.localizedDescription)"])
            return
        }
        l.service = NWListener.Service(name: wantName, type: tdServiceType)
        l.serviceRegistrationUpdateHandler = { change in
            if case let .add(ep) = change, case let .service(name, _, _, _) = ep {
                emit(["t": "td_service", "name": name])
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.stateUpdateHandler = { [weak self, weak l] st in
            guard let self, let l else { return }
            switch st {
            case .ready:
                emit(["t": "td_listen", "ok": true, "port": Int(l.port?.rawValue ?? 0), "name": self.wantName])
            case let .failed(err):
                l.cancel()
                if self.listener === l { self.listener = nil }
                if port != 0 && !self.triedFallback {
                    self.triedFallback = true
                    logMsg("原深感：端口 \(port) 开不了（\(err.localizedDescription)），换随机端口")
                    self.listen(on: 0)
                } else {
                    emit(["t": "td_listen", "ok": false, "error": err.localizedDescription])
                }
            default:
                break
            }
        }
        listener = l
        l.start(queue: queue)
    }

    private func accept(_ c: NWConnection) {
        let key = "\(c.endpoint)"
        conns[key]?.cancel()
        conns[key] = c
        lastSeen[key] = Date()
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled:
                self?.forget(key, c)
            default:
                break
            }
        }
        c.start(queue: queue)
        receive(key, c)
    }

    private func receive(_ key: String, _ c: NWConnection) {
        c.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.lastSeen[key] = Date()
                if let s = String(data: data, encoding: .utf8) {
                    emit(["t": "td_pkt", "ep": key, "d": s])
                }
            }
            if error == nil && self.conns[key] === c { self.receive(key, c) }
        }
    }

    private func forget(_ key: String, _ c: NWConnection) {
        if conns[key] === c {
            conns[key] = nil
            lastSeen[key] = nil
        }
    }

    /// UDP 的「连接」不会自己断，15 秒没收到东西就清掉
    private func startSweeper() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let now = Date()
            for (k, at) in self.lastSeen where now.timeIntervalSince(at) > 15 {
                self.conns[k]?.cancel()
                self.conns[k] = nil
                self.lastSeen[k] = nil
            }
        }
        t.resume()
        sweeper = t
    }
}

/// 「系统设置 → 通用 → 关于本机」里的电脑名，手机上列出来的就是它
func computerName() -> String {
    if let n = SCDynamicStoreCopyComputerName(nil, nil) as String?, !n.isEmpty { return n }
    return ProcessInfo.processInfo.hostName
}

/// 显示器的物理尺寸（毫米），原深感几何换算要用「每米多少点」
func displayMillimeters(id: Int, display: UInt32) {
    let did: CGDirectDisplayID = display == 0 ? CGMainDisplayID() : display
    let mm = CGDisplayScreenSize(did)
    let b = CGDisplayBounds(did)
    emit(["t": "display_mm", "id": id, "display": Int(did), "w": Double(mm.width), "h": Double(mm.height),
          "ptw": Double(b.width), "pth": Double(b.height), "builtin": CGDisplayIsBuiltin(did) != 0])
}
