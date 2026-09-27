import Foundation
import Network

// 找 Mac、连 Mac：Bonjour 浏览 _lookask._udp（带点对点 Wi‑Fi），UDP 发包、收 ack
// 同一 Wi‑Fi、手机个人热点、没有路由器时的点对点 Wi‑Fi，Network.framework 都自己处理

struct MacEntry: Identifiable, Hashable {
    let name: String
    let endpoint: NWEndpoint
    var id: String { name }
}

final class MacLink {
    /// 所有收发都在这个队列上
    let queue = DispatchQueue(label: "lookask.link")
    var onMacs: (([MacEntry]) -> Void)?
    var onAck: ((LAProtocol.Ack) -> Void)?
    /// Bonjour 浏览出错（最常见：本地网络权限被拒）；nil = 正常
    var onBrowseProblem: ((String?) -> Void)?
    /// UDP 连接的状态说明（给界面显示）
    var onConnState: ((String?) -> Void)?

    private var browser: NWBrowser?
    private var conn: NWConnection?
    private(set) var targetLabel: String?
    private var lastEndpoint: NWEndpoint?

    func startBrowsing() {
        queue.async { self.browse() }
    }

    private func browse() {
        browser?.cancel()
        let p = NWParameters()
        p.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: LAProtocol.serviceType, domain: nil), using: p)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = results.compactMap { r -> MacEntry? in
                if case let .service(name, _, _, _) = r.endpoint { return MacEntry(name: name, endpoint: r.endpoint) }
                return nil
            }.sorted { $0.name < $1.name }
            self?.onMacs?(list)
        }
        b.stateUpdateHandler = { [weak self, weak b] st in
            guard let self else { return }
            switch st {
            case .ready:
                self.onBrowseProblem?(nil)
            case let .waiting(err):
                self.onBrowseProblem?(MacLink.describe(err))
            case let .failed(err):
                self.onBrowseProblem?(MacLink.describe(err))
                b?.cancel()
                // 权限刚给上、网络刚切换：过一会儿重来
                self.queue.asyncAfter(deadline: .now() + 2) { self.browse() }
            default:
                break
            }
        }
        b.start(queue: queue)
        browser = b
    }

    /// 连到某台 Mac（Bonjour 服务），UDP「连接」其实只是记住对方地址
    func connect(_ entry: MacEntry) {
        connect(entry.endpoint, label: entry.name)
    }

    /// 手动输入地址（Bonjour 找不到时的兜底）
    func connect(host: String, port: UInt16) {
        guard let p = NWEndpoint.Port(rawValue: port) else { return }
        connect(.hostPort(host: NWEndpoint.Host(host), port: p), label: "\(host):\(port)")
    }

    private func connect(_ endpoint: NWEndpoint, label: String) {
        queue.async {
            self.conn?.cancel()
            let p = NWParameters.udp
            p.includePeerToPeer = true
            let c = NWConnection(to: endpoint, using: p)
            c.stateUpdateHandler = { [weak self, weak c] st in
                guard let self, let c, self.conn === c else { return }
                switch st {
                case .ready:
                    self.onConnState?(nil)
                case let .waiting(err):
                    self.onConnState?(MacLink.describe(err))
                case let .failed(err):
                    self.onConnState?(MacLink.describe(err))
                    // 连不上就过一会儿重连（Mac 那边 LookAsk 可能刚重启）
                    self.queue.asyncAfter(deadline: .now() + 1.5) {
                        if self.conn === c, let e = self.lastEndpoint, let l = self.targetLabel { self.connect(e, label: l) }
                    }
                default:
                    break
                }
            }
            self.conn = c
            self.lastEndpoint = endpoint
            self.targetLabel = label
            c.start(queue: self.queue)
            self.receive(on: c)
        }
    }

    /// 重新连一次当前的 Mac（Mac 端重启后端口可能变了）
    func reconnect() {
        queue.async {
            if let e = self.lastEndpoint, let l = self.targetLabel { self.connect(e, label: l) }
        }
    }

    func disconnect() {
        queue.async {
            self.conn?.cancel()
            self.conn = nil
            self.lastEndpoint = nil
            self.targetLabel = nil
        }
    }

    /// 发一个数据报（必须在 queue 上调用）
    func send(_ data: Data) {
        dispatchPrecondition(condition: .onQueue(queue))
        conn?.send(content: data, completion: .idempotent)
    }

    var connected: Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        return conn != nil
    }

    private func receive(on c: NWConnection) {
        c.receiveMessage { [weak self, weak c] data, _, _, error in
            guard let self, let c else { return }
            if let data, let ack = LAProtocol.parseAck(data) { self.onAck?(ack) }
            if error == nil, self.conn === c { self.receive(on: c) }
        }
    }

    static func describe(_ e: NWError) -> String {
        if case let .dns(code) = e, code == -65570 {
            return "本地网络权限被关了：设置 → 隐私与安全性 → 本地网络 → 打开 Glint Eye"
        }
        if case let .posix(code) = e {
            switch code {
            case .ECONNREFUSED: return "Mac 没在收（Glint 没开，或者没选 iPhone 原深感）"
            case .ENETDOWN, .ENETUNREACH, .EHOSTUNREACH: return "网络不通：手机和 Mac 连同一个 Wi‑Fi，或者 Mac 连手机热点"
            default: break
            }
        }
        return e.localizedDescription
    }
}
