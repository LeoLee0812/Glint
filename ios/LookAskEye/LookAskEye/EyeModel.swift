import SwiftUI
import UIKit

// 把 ARKit、网络、配对码串起来：每帧编码签名后发给选中的 Mac，每秒一次心跳；按 Mac 的 ack 显示连接状态
// 发热时降帧；界面状态约 4 次/秒刷新，别让 SwiftUI 跟着 60 帧重绘

final class EyeModel: ObservableObject {
    enum MacState: Equatable {
        /// 还没选 Mac / 正在找
        case searching
        /// 发着包，还没收到回话
        case connecting(String)
        case paired(mac: String, fps: Int, use: Bool)
        case needPair(String)
        /// 之前连着，3 秒没回话了
        case silent(String)
    }

    @Published var supported = FaceTracker.isSupported
    @Published var macs: [MacEntry] = []
    @Published var chosen: String? = UserDefaults.standard.string(forKey: "lookask.mac")
    @Published var macState: MacState = .searching
    @Published var code: String
    @Published var sendFps = 0
    @Published var tracked = false
    @Published var distanceCm: Int?
    @Published var thermal: ProcessInfo.ThermalState = ProcessInfo.processInfo.thermalState
    @Published var browseProblem: String?
    @Published var connProblem: String?
    @Published var arError: String?
    @Published var preview = UserDefaults.standard.object(forKey: "lookask.preview") as? Bool ?? true {
        didSet { UserDefaults.standard.set(preview, forKey: "lookask.preview") }
    }
    /// 黑屏省电：OLED 全黑几乎不耗电，也不晃眼
    @Published var dark = false

    let identity = Identity()
    let tracker = FaceTracker()
    let link = MacLink()

    // 以下只在 link.queue 上动
    private let sid = UInt32.random(in: 1...2_000_000_000)
    private var seq: UInt64 = 0
    private var throttle = FrameThrottle()
    private var monitor = LinkMonitor()
    private var rate = RateCounter()
    private var targetFps = 60
    private var lastTracked = false
    private var lastUi: TimeInterval = 0
    private var silentSince: TimeInterval?
    private var hbTimer: DispatchSourceTimer?

    private var started = false
    private var seenNames = Set<String>()
    /// UIDevice 只能在主线程读：启动时先存下来
    private let deviceName = UIDevice.current.name
    private let model = EyeModel.modelId()
    private let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"

    init() {
        code = identity.code
        targetFps = FrameRatePolicy.fps(for: thermal)
        tracker.onSample = { [weak self] s in
            guard let self else { return }
            self.link.queue.async { self.handle(s) }
        }
        tracker.onError = { [weak self] msg in DispatchQueue.main.async { self?.arError = msg } }
        link.onMacs = { [weak self] list in DispatchQueue.main.async { self?.gotMacs(list) } }
        link.onAck = { [weak self] ack in
            guard let self else { return }
            // onAck 本来就在 link.queue 上
            if self.monitor.got(ack, at: ProcessInfo.processInfo.systemUptime) { self.refreshMacState() }
        }
        link.onBrowseProblem = { [weak self] p in DispatchQueue.main.async { self?.browseProblem = p } }
        link.onConnState = { [weak self] p in DispatchQueue.main.async { self?.connProblem = p } }
        NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.thermalChanged()
        }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.tracker.orient = EyeModel.orientName(UIDevice.current.orientation)
        }
    }

    func start() {
        guard !started else { return }
        started = true
        UIApplication.shared.isIdleTimerDisabled = true
        tracker.orient = EyeModel.orientName(UIDevice.current.orientation)
        link.startBrowsing()
        startHeartbeat()
        if supported { tracker.start(lowPower: FrameRatePolicy.lowPowerCamera(for: thermal)) }
    }

    // ---------- Mac 列表和连接 ----------

    private func gotMacs(_ list: [MacEntry]) {
        let names = Set(list.map(\.name))
        let reappeared = chosen.map { names.contains($0) && !seenNames.contains($0) } ?? false
        seenNames = names
        macs = list
        // 只找到一台、以前也没选过：直接连
        if chosen == nil, list.count == 1 {
            choose(list[0])
            return
        }
        // 选过的那台（重新）出现了：连上（Mac 端 LookAsk 重启后端口会变，要重连）
        if let c = chosen, let e = list.first(where: { $0.name == c }), reappeared {
            link.connect(e)
            setState(.connecting(c))
        }
    }

    func choose(_ e: MacEntry) {
        chosen = e.name
        UserDefaults.standard.set(e.name, forKey: "lookask.mac")
        link.queue.async { self.monitor.reset() }
        link.connect(e)
        setState(.connecting(e.name))
    }

    func connectManual(host: String, port: UInt16) {
        let label = "\(host):\(port)"
        chosen = label
        link.queue.async { self.monitor.reset() }
        link.connect(host: host, port: port)
        setState(.connecting(label))
    }

    func newCode() {
        identity.regenerate()
        code = identity.code
    }

    // ---------- 每帧 ----------

    private func handle(_ s: FaceSample) {
        let now = ProcessInfo.processInfo.systemUptime
        if s.tracked != lastTracked {
            lastTracked = s.tracked
        }
        // 没追到脸时也发，但降到 10 帧：Mac 要知道「手机在、看不到脸」
        let fps = s.tracked ? targetFps : min(targetFps, 10)
        if link.connected, throttle.shouldSend(at: s.ts, fps: fps) {
            seq += 1
            let json = LAProtocol.frameJSON(s, dev: identity.dev, sid: sid, seq: seq)
            link.send(LAProtocol.seal(json, key: identity.key))
            _ = rate.tick(at: now)
        }
        if now - lastUi > 0.25 {
            lastUi = now
            let r = rate.rate
            let tr = s.tracked
            let d = s.tracked ? s.distance.map { Int(($0 * 100).rounded()) } : nil
            DispatchQueue.main.async {
                self.sendFps = r
                self.tracked = tr
                self.distanceCm = d
            }
        }
    }

    // ---------- 心跳 ----------

    private func startHeartbeat() {
        let t = DispatchSource.makeTimerSource(queue: link.queue)
        t.schedule(deadline: .now() + 0.2, repeating: 1)
        t.setEventHandler { [weak self] in self?.heartbeat() }
        t.resume()
        hbTimer = t
    }

    private func heartbeat() {
        let now = ProcessInfo.processInfo.systemUptime
        if link.connected {
            seq += 1
            let hb = LAProtocol.Heartbeat(
                name: deviceName,
                model: model,
                app: appVersion,
                therm: FrameRatePolicy.level(ProcessInfo.processInfo.thermalState),
                fps: rate.rate,
                tracked: lastTracked,
                orient: tracker.orient
            )
            let json = LAProtocol.heartbeatJSON(hb, dev: identity.dev, sid: sid, seq: seq, ts: now)
            link.send(LAProtocol.seal(json, key: identity.key))
        }
        // Mac 超过 6 秒没回话：重连一次（Mac 端 LookAsk 重启后端口可能变了）
        if case .silent = monitor.status(at: now) {
            if silentSince == nil { silentSince = now }
            if let s = silentSince, now - s > 6 {
                silentSince = now
                link.reconnect()
            }
        } else {
            silentSince = nil
        }
        refreshMacState()
    }

    /// 在 link.queue 上算状态，切回主线程更新界面
    private func refreshMacState() {
        let st = monitor.status(at: ProcessInfo.processInfo.systemUptime)
        let label = link.targetLabel
        let next: MacState
        switch st {
        case .none: next = label.map { .connecting($0) } ?? .searching
        case let .paired(mac, fps, use): next = .paired(mac: mac, fps: fps, use: use)
        case let .needPair(mac): next = .needPair(mac)
        case let .silent(mac): next = .silent(mac)
        }
        setState(next)
    }

    private func setState(_ s: MacState) {
        DispatchQueue.main.async {
            if self.macState != s { self.macState = s }
        }
    }

    // ---------- 发热 ----------

    private func thermalChanged() {
        let st = ProcessInfo.processInfo.thermalState
        let wasLow = FrameRatePolicy.lowPowerCamera(for: thermal)
        thermal = st
        let fps = FrameRatePolicy.fps(for: st)
        link.queue.async { self.targetFps = fps }
        let low = FrameRatePolicy.lowPowerCamera(for: st)
        if supported, low != wasLow { tracker.start(lowPower: low) }
    }

    // ---------- 工具 ----------

    static func orientName(_ o: UIDeviceOrientation) -> String {
        switch o {
        case .portrait: return "portrait"
        case .portraitUpsideDown: return "portraitUpsideDown"
        case .landscapeLeft: return "landscapeLeft"
        case .landscapeRight: return "landscapeRight"
        case .faceUp: return "faceUp"
        case .faceDown: return "faceDown"
        default: return "unknown"
        }
    }

    /// 机型标识，比如 iPhone16,1（iPhone 15 Pro）
    static func modelId() -> String {
        var s = utsname()
        uname(&s)
        let m = Mirror(reflecting: s.machine)
        return m.children.compactMap { $0.value as? Int8 }.filter { $0 != 0 }.map { String(UnicodeScalar(UInt8(bitPattern: $0))) }.joined()
    }
}
