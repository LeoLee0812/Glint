import Foundation
import CryptoKit
import simd

// LookAskEye ↔ Mac 的 UDP 协议（Mac 端对应 src/main/truedepth.ts）
// 数据报 = 32 位十六进制签名 + JSON；签名 = HMAC-SHA256(SHA256("lookask-td|设备ID|配对码"), JSON 原文) 的前 16 字节
// JSON：t = "f" 一帧（约 60 帧/秒），t = "hb" 每秒一次心跳；Mac 回 t = "ack"（不签名）
// 这个文件只放纯逻辑（编码、签名、心跳判断、降帧），不碰 ARKit 和网络，单元测试都在它身上

enum LAProtocol {
    static let serviceType = "_lookask._udp"
    static let version = 1

    /// 签名密钥 = SHA256("lookask-td|设备ID|配对码")
    static func key(dev: String, code: String) -> SymmetricKey {
        let d = SHA256.hash(data: Data("lookask-td|\(dev)|\(code)".utf8))
        return SymmetricKey(data: Data(d))
    }

    static func macHex(json: Data, key: SymmetricKey) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: json, using: key)
        return Data(mac).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// JSON → 数据报（签名 + JSON）
    static func seal(_ json: String, key: SymmetricKey) -> Data {
        let j = Data(json.utf8)
        return Data(macHex(json: j, key: key).utf8) + j
    }

    /// 拆开并验签（Mac 端逻辑的 Swift 版，测试用）：签名对就返回 JSON 字典
    static func open(_ packet: Data, key: SymmetricKey) -> [String: Any]? {
        guard packet.count > 33 else { return nil }
        let json = Data(packet.dropFirst(32))
        guard let mac = String(data: packet.prefix(32), encoding: .utf8), mac == macHex(json: json, key: key) else { return nil }
        return (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
    }

    // ---------- 编码 ----------

    static func frameJSON(_ f: FaceSample, dev: String, sid: UInt32, seq: UInt64) -> String {
        var w = JSONWriter()
        w.str("t", "f")
        w.int("v", version)
        w.str("dev", dev)
        w.int("sid", Int(sid))
        w.int("seq", Int(seq))
        w.num("ts", f.ts, 4)
        w.bool("tracked", f.tracked)
        if let h = f.head { w.raw("head", poseJSON(h)) }
        if let e = f.eyeL { w.raw("eyeL", poseJSON(e)) }
        if let e = f.eyeR { w.raw("eyeR", poseJSON(e)) }
        if let l = f.look { w.arr("look", [l.x, l.y, l.z], 4) }
        if !f.blend.isEmpty {
            var b = JSONWriter()
            for (k, v) in f.blend { b.num(k, Double(v), 3) }
            w.raw("bs", b.finish())
        }
        if let g = f.grav { w.arr("grav", [g.x, g.y, g.z], 4) }
        w.str("orient", f.orient)
        return w.finish()
    }

    static func poseJSON(_ p: Pose3) -> String {
        var w = JSONWriter()
        w.arr("pos", [p.pos.x, p.pos.y, p.pos.z], 5)
        let q = p.quat.vector
        w.arr("quat", [q.x, q.y, q.z, q.w], 5)
        return w.finish()
    }

    struct Heartbeat {
        var name: String
        var model: String
        var app: String
        var therm: Int
        var fps: Int
        var tracked: Bool
        var orient: String
    }

    static func heartbeatJSON(_ h: Heartbeat, dev: String, sid: UInt32, seq: UInt64, ts: TimeInterval) -> String {
        var w = JSONWriter()
        w.str("t", "hb")
        w.int("v", version)
        w.str("dev", dev)
        w.int("sid", Int(sid))
        w.int("seq", Int(seq))
        w.num("ts", ts, 4)
        w.str("name", h.name)
        w.str("model", h.model)
        w.str("app", h.app)
        w.int("therm", h.therm)
        w.int("fps", h.fps)
        w.bool("tracked", h.tracked)
        w.str("orient", h.orient)
        return w.finish()
    }

    // ---------- Mac 的回包 ----------

    struct Ack: Equatable {
        /// paired / need_pair
        var state: String
        /// Mac 在 Bonjour 上的名字
        var mac: String
        /// Mac 实收帧率
        var fps: Int
        /// Mac 现在是不是正用原深感当眼动输入源
        var use: Bool
        /// Mac 这次启动的会话号、递增序号（丢乱序旧 ack 用）
        var sid: Int
        var seq: UInt64
    }

    static func parseAck(_ data: Data) -> Ack? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], o["t"] as? String == "ack" else { return nil }
        return Ack(
            state: o["state"] as? String ?? "",
            mac: o["mac"] as? String ?? "Mac",
            fps: (o["fps"] as? NSNumber)?.intValue ?? 0,
            use: (o["use"] as? NSNumber)?.boolValue ?? false,
            sid: (o["sid"] as? NSNumber)?.intValue ?? 0,
            seq: (o["seq"] as? NSNumber)?.uint64Value ?? 0
        )
    }
}

// ---------- 一帧数据 ----------

struct Pose3 {
    var pos: SIMD3<Float>
    var quat: simd_quatf
}

/// ARKit 一帧里要发给 Mac 的东西（坐标都在前置相机坐标系里，单位米）
struct FaceSample {
    var tracked: Bool
    var head: Pose3?
    var eyeL: Pose3?
    var eyeR: Pose3?
    var look: SIMD3<Float>?
    /// 眼睛、眉毛、下巴相关的表情系数（有序，名字和 Mac 端约定一致，如 eyeBlinkLeft）
    var blend: [(String, Float)]
    /// 重力方向（相机坐标系）：Mac 用它定「上」，手机竖放横放都行
    var grav: SIMD3<Float>?
    var orient: String
    /// ARFrame.timestamp（秒，系统开机以来的单调时钟）
    var ts: TimeInterval

    /// 脸离镜头多远（米），界面显示用
    var distance: Float? { head.map { simd_length($0.pos) } }
}

/// 手写的 JSON 拼接：数字位数固定、包小、不受系统区域设置影响
struct JSONWriter {
    private(set) var out = "{"
    private var first = true

    private mutating func key(_ k: String) {
        if !first { out += "," }
        first = false
        out += JSONWriter.quote(k) + ":"
    }

    mutating func str(_ k: String, _ v: String) {
        key(k)
        out += JSONWriter.quote(v)
    }

    mutating func int(_ k: String, _ v: Int) {
        key(k)
        out += String(v)
    }

    mutating func num(_ k: String, _ v: Double, _ digits: Int = 5) {
        key(k)
        out += JSONWriter.fmt(v, digits)
    }

    mutating func bool(_ k: String, _ v: Bool) {
        key(k)
        out += v ? "true" : "false"
    }

    mutating func arr(_ k: String, _ v: [Float], _ digits: Int = 5) {
        key(k)
        out += "[" + v.map { JSONWriter.fmt(Double($0), digits) }.joined(separator: ",") + "]"
    }

    mutating func raw(_ k: String, _ json: String) {
        key(k)
        out += json
    }

    func finish() -> String { out + "}" }

    static func fmt(_ v: Double, _ digits: Int) -> String {
        guard v.isFinite else { return "0" }
        var s = String(format: "%.\(digits)f", v)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        if s == "-0" { s = "0" }
        return s
    }

    static func quote(_ s: String) -> String {
        var o = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": o += "\\\""
            case "\\": o += "\\\\"
            case "\n": o += "\\n"
            case "\r": o += "\\r"
            case "\t": o += "\\t"
            default:
                if u.value < 0x20 { o += String(format: "\\u%04x", u.value) } else { o.unicodeScalars.append(u) }
            }
        }
        return o + "\""
    }
}

// ---------- 设备身份和配对码 ----------

/// 设备 ID（第一次打开时生成）和 4 位配对码，存在 UserDefaults；换码后 Mac 上要重新输入
final class Identity {
    private let defaults: UserDefaults
    let dev: String
    private(set) var code: String

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let d = defaults.string(forKey: "lookask.dev"), !d.isEmpty {
            dev = d
        } else {
            dev = UUID().uuidString
            defaults.set(dev, forKey: "lookask.dev")
        }
        if let c = defaults.string(forKey: "lookask.code"), Identity.isValid(c) {
            code = c
        } else {
            code = Identity.newCode()
            defaults.set(code, forKey: "lookask.code")
        }
    }

    var key: SymmetricKey { LAProtocol.key(dev: dev, code: code) }

    func regenerate() {
        var c = Identity.newCode()
        while c == code { c = Identity.newCode() }
        code = c
        defaults.set(code, forKey: "lookask.code")
    }

    static func newCode() -> String { String(format: "%04d", Int.random(in: 0...9999)) }

    static func isValid(_ c: String) -> Bool { c.count == 4 && c.allSatisfy(\.isNumber) }
}

// ---------- 乱序、心跳、降帧 ----------

/// 按 seq 丢掉乱序、重复的旧包（Mac 收帧也是同样的规则；手机这边用来丢乱序到达的旧 ack）
struct SeqFilter {
    private(set) var last: UInt64?
    private(set) var dropped = 0

    mutating func accept(_ seq: UInt64) -> Bool {
        if let l = last, seq <= l {
            dropped += 1
            return false
        }
        last = seq
        return true
    }

    mutating func reset() {
        last = nil
    }
}

/// Mac 那边的状态：按最近一次 ack 判断，3 秒没 ack 就算 Mac 没回话
enum MacReply: Equatable {
    /// 还没收到过 ack
    case none
    /// 配好对了；use = Mac 正用原深感
    case paired(mac: String, fps: Int, use: Bool)
    /// Mac 收到了，但要在 Mac 上输入配对码
    case needPair(mac: String)
    /// 之前有回话，现在超时了
    case silent(mac: String)
}

struct LinkMonitor {
    let timeout: TimeInterval
    private(set) var lastAck: LAProtocol.Ack?
    private(set) var lastAckAt: TimeInterval?
    private var filter = SeqFilter()
    private var macSid = 0

    init(timeout: TimeInterval = 3) {
        self.timeout = timeout
    }

    /// 收到一个 ack；乱序到达的旧 ack 丢掉（返回 false）
    @discardableResult
    mutating func got(_ ack: LAProtocol.Ack, at t: TimeInterval) -> Bool {
        if ack.sid != macSid {
            // Mac 那边重启过：序号从头来
            macSid = ack.sid
            filter.reset()
        }
        guard filter.accept(ack.seq) else { return false }
        lastAck = ack
        lastAckAt = t
        return true
    }

    mutating func reset() {
        lastAck = nil
        lastAckAt = nil
        filter.reset()
        macSid = 0
    }

    func status(at now: TimeInterval) -> MacReply {
        guard let a = lastAck, let t = lastAckAt else { return .none }
        if now - t > timeout { return .silent(mac: a.mac) }
        return a.state == "paired" ? .paired(mac: a.mac, fps: a.fps, use: a.use) : .needPair(mac: a.mac)
    }
}

/// 发热降帧：正常 60 帧，严重 30 帧，过热 15 帧
enum FrameRatePolicy {
    static func fps(for state: ProcessInfo.ThermalState) -> Int {
        switch state {
        case .nominal, .fair: return 60
        case .serious: return 30
        case .critical: return 15
        @unknown default: return 30
        }
    }

    /// 严重以上把 ARKit 本身也降到 30 帧（光少发包不够，处理本身也发热）
    static func lowPowerCamera(for state: ProcessInfo.ThermalState) -> Bool {
        state == .serious || state == .critical
    }

    /// 给 Mac 的发热档位 0~3
    static func level(_ state: ProcessInfo.ThermalState) -> Int {
        switch state {
        case .nominal: return 0
        case .fair: return 1
        case .serious: return 2
        case .critical: return 3
        @unknown default: return 1
        }
    }
}

/// 按目标帧率决定这一帧发不发（ARKit 本身 60 帧；降到 30 就隔一帧发一帧）
/// 按时间表排而不是看「离上一帧多久」：帧间隔抖几毫秒时，后者在 60 帧目标下会误丢三分之一的帧
struct FrameThrottle {
    private var next: TimeInterval = -.infinity

    mutating func shouldSend(at t: TimeInterval, fps: Int) -> Bool {
        let interval = 1.0 / Double(max(1, fps))
        guard next.isFinite else {
            next = t + interval
            return true
        }
        // 离排好的时间还差不到 0.4 帧就算到点
        if t + interval * 0.4 < next { return false }
        // 按时间表往后排；卡顿过（落后一整帧以上）就从现在重新排，别一下子补发一串
        next = max(next + interval, t + interval * 0.5)
        return true
    }
}

/// 每秒计数（发送帧率）
struct RateCounter {
    private var n = 0
    private var t0: TimeInterval?
    private(set) var rate = 0

    /// 记一次；过了一秒就更新 rate 并返回 true
    mutating func tick(at t: TimeInterval) -> Bool {
        n += 1
        guard let s = t0 else {
            t0 = t
            return false
        }
        if t - s >= 1 {
            rate = Int((Double(n) / (t - s)).rounded())
            n = 0
            t0 = t
            return true
        }
        return false
    }
}
