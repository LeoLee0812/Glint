import Foundation
import IOKit.hid

// Joy-Con 原生读取：直接走 IOHIDManager 读蓝牙 HID 原始报告。
// 不用系统 GameController 框架：它把单只 Joy-Con 当成横握小手柄，拿不到 R/ZR/摇杆按下，也没有模拟摇杆。
// 协议参考 dekuNukem/Nintendo_Switch_Reverse_Engineering：切到 0x30 全量模式后约 60Hz 上报。
// 输出（子命令、震动、灯）每只手柄走一个 15ms 节拍：实测蓝牙每 ~15ms 才送得出一包，发得更快就排队、卡住主线程。
// 0x30 报告里还带 6 轴 IMU（每包 3 组，约 200Hz）：用来判断手柄是不是放在桌上，以及「按住右摇杆拧手腕」精调焦点。

private let nintendoVendorID = 0x057E
/// 一帧「不震」（振幅 0）
private let quietFrame: [UInt8] = [0x00, 0x01, 0x40, 0x40]
/// 输出节拍：蓝牙每 ~15ms 一个空档
private let outTick = 0.015
/// 子命令之间至少隔 60ms，Joy-Con 连发太快会丢
private let subGap = 0.06
/// IMU 两组样本之间的间隔（200Hz）
private let imuDt = 0.005

private func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

enum JoySide: String {
    case left = "L"
    case right = "R"
    case pro = "P"
}

/// 摇杆出厂校准：中心值与向两侧的最大行程（12 位原始值）
struct StickCal {
    var xCenter = 2048.0, yCenter = 2048.0
    var xMinBelow = 1400.0, xMaxAbove = 1400.0
    var yMinBelow = 1400.0, yMaxAbove = 1400.0

    /// 左摇杆的 9 字节校准数据排列：上方最大值、中心、下方最小值
    static func decodeLeft(_ d: [UInt8]) -> StickCal? {
        guard d.count >= 9, !d.allSatisfy({ $0 == 0xFF }) else { return nil }
        var c = StickCal()
        c.xMaxAbove = Double((Int(d[1]) << 8) & 0xF00 | Int(d[0]))
        c.yMaxAbove = Double((Int(d[2]) << 4) | (Int(d[1]) >> 4))
        c.xCenter = Double((Int(d[4]) << 8) & 0xF00 | Int(d[3]))
        c.yCenter = Double((Int(d[5]) << 4) | (Int(d[4]) >> 4))
        c.xMinBelow = Double((Int(d[7]) << 8) & 0xF00 | Int(d[6]))
        c.yMinBelow = Double((Int(d[8]) << 4) | (Int(d[7]) >> 4))
        return c.isSane ? c : nil
    }

    /// 右摇杆的排列顺序不同：中心、下方最小值、上方最大值
    static func decodeRight(_ d: [UInt8]) -> StickCal? {
        guard d.count >= 9, !d.allSatisfy({ $0 == 0xFF }) else { return nil }
        var c = StickCal()
        c.xCenter = Double((Int(d[1]) << 8) & 0xF00 | Int(d[0]))
        c.yCenter = Double((Int(d[2]) << 4) | (Int(d[1]) >> 4))
        c.xMinBelow = Double((Int(d[4]) << 8) & 0xF00 | Int(d[3]))
        c.yMinBelow = Double((Int(d[5]) << 4) | (Int(d[4]) >> 4))
        c.xMaxAbove = Double((Int(d[7]) << 8) & 0xF00 | Int(d[6]))
        c.yMaxAbove = Double((Int(d[8]) << 4) | (Int(d[7]) >> 4))
        return c.isSane ? c : nil
    }

    private var isSane: Bool {
        xCenter > 1000 && xCenter < 3100 && yCenter > 1000 && yCenter < 3100
            && xMinBelow > 300 && xMaxAbove > 300 && yMinBelow > 300 && yMaxAbove > 300
    }

    /// 原始值 → [-1, 1]，上/右为正，带死区（Joy-Con 摇杆漂移很常见）
    func normalize(x rawX: Int, y rawY: Int, deadzone: Double = 0.14) -> (Double, Double) {
        let dx = Double(rawX) - xCenter
        let dy = Double(rawY) - yCenter
        var x = dx >= 0 ? dx / xMaxAbove : dx / xMinBelow
        var y = dy >= 0 ? dy / yMaxAbove : dy / yMinBelow
        x = max(-1, min(1, x))
        y = max(-1, min(1, y))
        let mag = (x * x + y * y).squareRoot()
        if mag < deadzone { return (0, 0) }
        // 死区外重新拉伸到 0~1，推一点点也有细腻的起步
        let scale = min(1, (mag - deadzone) / (1 - deadzone)) / mag
        return (x * scale, y * scale)
    }
}

/// IMU 校准：SPI 0x6020 出厂 24 字节（加速度零点 / 灵敏度、陀螺零点 / 灵敏度，各 3 个 int16）；
/// 0x8026 是用户校准，魔数 B2 A1 之后只覆盖两个零点（和 SDL 的做法一致）
struct ImuCal {
    var accOrigin = [0.0, 0.0, 0.0]
    var accSens = [16384.0, 16384.0, 16384.0]
    var gyroOrigin = [0.0, 0.0, 0.0]
    var gyroSens = [13371.0, 13371.0, 13371.0]

    private static func s16(_ d: [UInt8], _ i: Int) -> Double {
        Double(Int16(bitPattern: UInt16(d[i]) | (UInt16(d[i + 1]) << 8)))
    }

    static func decode(_ d: [UInt8]) -> ImuCal? {
        guard d.count >= 24, !d.allSatisfy({ $0 == 0xFF }) else { return nil }
        var c = ImuCal()
        c.accOrigin = [s16(d, 0), s16(d, 2), s16(d, 4)]
        c.accSens = [s16(d, 6), s16(d, 8), s16(d, 10)]
        c.gyroOrigin = [s16(d, 12), s16(d, 14), s16(d, 16)]
        c.gyroSens = [s16(d, 18), s16(d, 20), s16(d, 22)]
        return c.isSane ? c : nil
    }

    mutating func applyUser(_ d: [UInt8]) {
        guard d.count >= 18 else { return }
        accOrigin = [ImuCal.s16(d, 0), ImuCal.s16(d, 2), ImuCal.s16(d, 4)]
        gyroOrigin = [ImuCal.s16(d, 12), ImuCal.s16(d, 14), ImuCal.s16(d, 16)]
    }

    private var isSane: Bool {
        (0..<3).allSatisfy { gyroSens[$0] - gyroOrigin[$0] > 4000 && accSens[$0] - accOrigin[$0] > 4000 }
    }

    /// 陀螺原始值 → 度/秒：936 / (灵敏度 − 零点)（SDL 同款）
    func gyroScale(_ i: Int) -> Double { 936.0 / (gyroSens[i] - gyroOrigin[i]) }
    /// 加速度原始值 → g：4 / (灵敏度 − 零点)
    func accScale(_ i: Int) -> Double { 4.0 / (accSens[i] - accOrigin[i]) }
}

/// HD 震动编码，移植自 tomayac/joy-con-webhid；振幅夹在 0~1（再大伤马达）
func encodeRumble(lowFreq: Double, highFreq: Double, amplitude: Double) -> [UInt8] {
    let lf0 = min(max(lowFreq, 40.875885), 626.286133)
    let hf0 = min(max(highFreq, 81.75177), 1252.572266)
    let hf = (Int((32 * log2(hf0 * 0.1)).rounded()) - 0x60) * 4
    let lf = Int((32 * log2(lf0 * 0.1)).rounded()) - 0x40
    let amp = min(max(amplitude, 0), 1)
    var hfAmp: Double
    if amp == 0 { hfAmp = 0 }
    else if amp < 0.117 { hfAmp = (log2(amp * 1000) * 32 - 0x60) / (5 - amp * amp) - 1 }
    else if amp < 0.23 { hfAmp = log2(amp * 1000) * 32 - 0x60 - 0x5C }
    else { hfAmp = (log2(amp * 1000) * 32 - 0x60) * 2 - 0xF6 }
    let hfAmpI = Int(hfAmp.rounded())
    var lfAmp = Int(Double(hfAmpI) * 0.5)
    let parity = lfAmp % 2
    if parity > 0 { lfAmp -= 1 }
    lfAmp = lfAmp >> 1
    lfAmp += 0x40
    if parity > 0 { lfAmp |= 0x8000 }
    let b0 = UInt8(truncatingIfNeeded: hf & 0xFF)
    let b1 = UInt8(truncatingIfNeeded: hfAmpI + ((hf >> 8) & 0xFF))
    let b2 = UInt8(truncatingIfNeeded: lf + ((lfAmp >> 8) & 0xFF))
    let b3 = UInt8(truncatingIfNeeded: lfAmp & 0xFF)
    return [b0, b1, b2, b3]
}

/// 震动分段展开成 15ms 一帧。每段 [毫秒, 低频, 高频, 振幅, 结束低频?, 结束高频?, 结束振幅?]：
/// 频率按对数插值（听感上均匀的上扬 / 下沉），振幅线性插值；振幅 0 = 停顿。最长 12 秒
func rumbleFrames(_ segs: [[Double]]) -> [[UInt8]] {
    var out: [[UInt8]] = []
    for s in segs where s.count >= 4 {
        let n = max(1, Int((s[0] / 1000 / outTick).rounded()))
        let lo2 = s.count > 4 ? s[4] : s[1]
        let hi2 = s.count > 5 ? s[5] : s[2]
        let amp2 = s.count > 6 ? s[6] : s[3]
        for i in 0..<n {
            let t = n > 1 ? Double(i) / Double(n - 1) : 0
            let amp = s[3] + (amp2 - s[3]) * t
            if amp <= 0.001 || s[1] <= 0 || s[2] <= 0 || lo2 <= 0 || hi2 <= 0 {
                out.append(quietFrame)
                continue
            }
            out.append(encodeRumble(lowFreq: s[1] * pow(lo2 / s[1], t), highFreq: s[2] * pow(hi2 / s[2], t), amplitude: amp))
        }
        if out.count >= 800 { break }
    }
    return Array(out.prefix(800))
}

/// HOME 键那圈灯（子命令 0x38）：[mini cycle 数 | 全局时长, 起始亮度 | 循环次数(0 = 一直), 各 mini cycle 亮度, 渐变 | 保持倍数…]
func homePattern(_ mode: String) -> [UInt8] {
    switch mode {
    case "breathe":
        // 亮度 C ↔ 1 来回，渐变 ×4、保持 ×1 / ×2，一个来回约 2 秒
        return [0x2F, 0x10, 0xC1, 0x41, 0x42]
    case "blink":
        // 快闪：全亮 ↔ 全灭
        return [0x28, 0xF0, 0xF0, 0x01, 0x01]
    case "on":
        return [0x01, 0xF0, 0xF0, 0x00]
    default:
        // 关（同 SDL 亮度 0）
        return [0x01, 0x00, 0x00, 0x00]
    }
}

final class JoyConDevice {
    let device: IOHIDDevice
    let side: JoySide
    let id: String
    let name: String
    let playerIndex: Int

    private var packet: UInt8 = 0
    private let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 512)
    private var watchdog: Timer?
    private var lastReport = Date()

    // 输出：子命令队列和震动帧队列共用一个 15ms 节拍，每拍最多发一包
    private var commandQueue: [(UInt8, [UInt8])] = []
    private var frames: [[UInt8]] = []
    private var framesPrio = 0
    private var rumbling = false
    private var lastSubAt = 0.0
    private var outTimer: DispatchSourceTimer?
    private var homeMode = "off"

    private var leftCal = StickCal()
    private var rightCal = StickCal()

    // IMU：校准、陀螺零偏（静止时自动学）、低通后的重力方向、放下检测、手腕精调推流
    private var imuCal = ImuCal()
    private var gyroBias = [0.0, 0.0, 0.0]
    private var biasLearned = false
    private var biasSum = [0.0, 0.0, 0.0]
    private var biasN = 0
    private var grav: [Double]?
    private var motion = 0.0
    private var stillSince: Double?
    private var imuRetryAt = uptime()
    private(set) var resting = false
    private var streamUntil = 0.0

    private(set) var buttons: UInt32 = 0
    private var lx = 0.0, ly = 0.0, rx = 0.0, ry = 0.0
    private var battery = -1
    private var charging = false

    private var sentButtons: UInt32 = 0xFFFF_FFFF
    private var sentSticks = (0.0, 0.0, 0.0, 0.0)
    private var sentBattery = -2

    init(device: IOHIDDevice, side: JoySide, id: String, name: String, playerIndex: Int) {
        self.device = device
        self.side = side
        self.id = id
        self.name = name
        self.playerIndex = playerIndex
    }

    deinit {
        outTimer?.cancel()
        watchdog?.invalidate()
        inputBuffer.deallocate()
    }

    func start() {
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(device, inputBuffer, 512, { context, _, _, _, reportID, report, length in
            guard let context else { return }
            let me = Unmanaged<JoyConDevice>.fromOpaque(context).takeUnretainedValue()
            me.handleReport(id: UInt8(truncatingIfNeeded: reportID), report: report, length: length)
        }, ctx)
        initialize()
        // 看门狗：3 秒没收到全量报告就重发初始化（手柄休眠唤醒后会回到简单模式）
        watchdog = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else { return }
            if Date().timeIntervalSince(self.lastReport) > 3 { self.initialize() }
        }
    }

    private func initialize() {
        enqueue(0x03, [0x30])                    // 输入报告切到 0x30 全量模式
        enqueue(0x10, spiRead(0x603D, 0x12))     // 读出厂摇杆校准（左 9 字节 + 右 9 字节连续存放）
        enqueue(0x10, spiRead(0x8010, 0x16))     // 读用户校准（有魔数才生效）
        enqueue(0x30, [UInt8(1 << (playerIndex % 4))]) // 点亮玩家灯，告诉用户已被 LookAsk 接管
        enqueue(0x48, [0x01])                    // 允许震动
        enqueue(0x40, [0x01])                    // 开 IMU（6 轴）
        enqueue(0x10, spiRead(0x6020, 0x18))     // IMU 出厂校准
        enqueue(0x10, spiRead(0x8026, 0x1A))     // IMU 用户校准（B2 A1 魔数）
        // HOME 灯：休眠重连后会被重置；刚启动时顺手关掉上次异常退出留下的呼吸灯
        if side != .left { enqueue(0x38, homePattern(homeMode)) }
    }

    private func spiRead(_ addr: UInt32, _ len: UInt8) -> [UInt8] {
        [UInt8(addr & 0xFF), UInt8((addr >> 8) & 0xFF), UInt8((addr >> 16) & 0xFF), UInt8((addr >> 24) & 0xFF), len]
    }

    // ---------- 输出：15ms 节拍 ----------

    private func enqueue(_ sub: UInt8, _ args: [UInt8]) {
        commandQueue.append((sub, args))
        startOut()
    }

    private func startOut() {
        guard outTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: outTick, leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.outStep() }
        outTimer = t
        t.resume()
    }

    /// 每拍最多一包：有到点的子命令就发 0x01（顺带这一格的震动），否则只发震动 0x10；震完补一个停止帧
    private func outStep() {
        var four: [UInt8]?
        if !frames.isEmpty {
            let f = frames.removeFirst()
            four = f
            rumbling = f != quietFrame
            if frames.isEmpty { framesPrio = 0 }
        } else if rumbling {
            four = quietFrame
            rumbling = false
        }
        let now = uptime()
        if !commandQueue.isEmpty, now - lastSubAt >= subGap {
            let (sub, args) = commandQueue.removeFirst()
            sendSubcommand(sub, args, rumble: four ?? quietFrame)
            lastSubAt = now
        } else if let four {
            sendRumble(four)
        }
        if frames.isEmpty, !rumbling, commandQueue.isEmpty {
            outTimer?.cancel()
            outTimer = nil
        }
    }

    private func nextPacket() -> UInt8 {
        let p = packet & 0x0F
        packet &+= 1
        return p
    }

    private func sendSubcommand(_ sub: UInt8, _ args: [UInt8], rumble four: [UInt8]) {
        var r = [UInt8](repeating: 0, count: 49)
        r[0] = 0x01
        r[1] = nextPacket()
        for i in 0..<4 {
            r[2 + i] = four[i]
            r[6 + i] = four[i]
        }
        r[10] = sub
        for (i, a) in args.enumerated() where 11 + i < r.count { r[11 + i] = a }
        _ = IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(0x01), r, r.count)
    }

    private func sendRumble(_ four: [UInt8]) {
        var r = [UInt8](repeating: 0, count: 10)
        r[0] = 0x10
        r[1] = nextPacket()
        for i in 0..<4 {
            r[2 + i] = four[i]
            r[6 + i] = four[i]
        }
        _ = IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(0x10), r, r.count)
    }

    /// 播一段震动帧：正在播更重要的（优先级更高）就不打断；放在桌上时除非 force 否则不震（硬桌面一震嗡嗡响）
    func play(_ seq: [[UInt8]], prio: Int, force: Bool = false) {
        guard !seq.isEmpty, force || !resting else { return }
        if !frames.isEmpty, prio < framesPrio { return }
        frames = seq
        framesPrio = prio
        startOut()
    }

    /// 老接口：单一频率震 ms 毫秒（长震动每拍续帧，不会中途停）
    func rumble(lowFreq: Double = 160, highFreq: Double = 320, amplitude: Double = 0.5, ms: Int = 80) {
        play(rumbleFrames([[Double(ms), lowFreq, highFreq, amplitude]]), prio: 1)
    }

    func setLights(_ mask: UInt8) {
        enqueue(0x30, [mask])
    }

    /// HOME 键那圈灯（只有右手柄 / Pro 手柄有）：breathe 呼吸、blink 快闪、on 常亮、off 关
    func setHome(_ mode: String) {
        guard side != .left else { return }
        homeMode = mode
        enqueue(0x38, homePattern(mode))
    }

    /// 找手柄：高频大振幅「哔哔」响几秒（放在桌上也响），玩家灯和 HOME 灯一起闪，结束后恢复原样
    func locate(seconds: Double) {
        let beeps = max(1, min(30, Int((seconds / 0.3).rounded())))
        var segs: [[Double]] = []
        for _ in 0..<beeps {
            segs.append([180, 600, 1200, 1.0])
            segs.append([120, 0, 0, 0])
        }
        play(rumbleFrames(segs), prio: 9, force: true)
        enqueue(0x30, [0xF0])
        if side != .left { enqueue(0x38, homePattern("blink")) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(beeps) * 0.3 + 0.1) { [weak self] in
            guard let self else { return }
            self.enqueue(0x30, [UInt8(1 << (self.playerIndex % 4))])
            if self.side != .left { self.enqueue(0x38, homePattern(self.homeMode)) }
        }
    }

    /// 手腕精调：接下来 seconds 秒内每个 0x30 包推一次角度增量（joy_gyro）；0 = 停
    func stream(seconds: Double) {
        streamUntil = seconds > 0 ? uptime() + seconds : 0
    }

    /// 退出前同步收尾：停震动、关 HOME 灯（不然会一直呼吸到手柄休眠）
    func shutdown() {
        outTimer?.cancel()
        outTimer = nil
        frames.removeAll()
        commandQueue.removeAll()
        if side != .left { sendSubcommand(0x38, homePattern("off"), rumble: quietFrame) }
        else { sendRumble(quietFrame) }
    }

    // ---------- 输入 ----------

    private func handleReport(id: UInt8, report: UnsafeMutablePointer<UInt8>, length: CFIndex) {
        let n = Int(length)
        switch id {
        case 0x30, 0x21:
            guard n >= 13 else { return }
            lastReport = Date()
            parseStandard(report)
            if id == 0x30, n >= 49 { parseIMU(report) }
            if id == 0x21, n >= 20 { parseSubcommandReply(report, n) }
            publishIfChanged()
        case 0x3F:
            // 简单模式说明手柄刚醒或被别的程序重置了，重新切回全量模式
            enqueue(0x03, [0x30])
        default:
            break
        }
    }

    private func parseStandard(_ r: UnsafeMutablePointer<UInt8>) {
        let batt = Int(r[2] >> 4)
        battery = (batt >> 1) & 0x07   // 0~4 档
        charging = (batt & 0x01) == 1
        buttons = UInt32(r[3]) | (UInt32(r[4]) << 8) | (UInt32(r[5]) << 16)
        let lxRaw = Int(r[6]) | ((Int(r[7]) & 0x0F) << 8)
        let lyRaw = (Int(r[7]) >> 4) | (Int(r[8]) << 4)
        let rxRaw = Int(r[9]) | ((Int(r[10]) & 0x0F) << 8)
        let ryRaw = (Int(r[10]) >> 4) | (Int(r[11]) << 4)
        if side != .right { (lx, ly) = leftCal.normalize(x: lxRaw, y: lyRaw) }
        if side != .left { (rx, ry) = rightCal.normalize(x: rxRaw, y: ryRaw) }
    }

    /// Joy-Con 原始轴 → 竖握标准坐标（同 SDL 竖握模式：X 朝右、Y 朝上（按键面）、Z 朝自己）；右手柄芯片装反了，要多翻两个轴
    private func toStd(_ v: [Double]) -> [Double] {
        side == .right ? [v[1], -v[2], -v[0]] : [-v[1], v[2], -v[0]]
    }

    /// 0x30 报告 13~48 字节：3 组 [加速度 xyz, 陀螺 xyz]（int16 小端，约 5ms 一组）
    private func parseIMU(_ r: UnsafeMutablePointer<UInt8>) {
        func s16(_ i: Int) -> Double { Double(Int16(bitPattern: UInt16(r[i]) | (UInt16(r[i + 1]) << 8))) }
        var gSum = [0.0, 0.0, 0.0], aSum = [0.0, 0.0, 0.0], rawSum = [0.0, 0.0, 0.0]
        var yaw = 0.0, pitch = 0.0
        var count = 0
        for k in 0..<3 {
            let o = 13 + 12 * k
            let rawA = [s16(o), s16(o + 2), s16(o + 4)]
            if rawA[0] == 0, rawA[1] == 0, rawA[2] == 0 { continue }
            let rawG = [s16(o + 6), s16(o + 8), s16(o + 10)]
            count += 1
            let acc = toStd((0..<3).map { rawA[$0] * imuCal.accScale($0) })
            let gyr = toStd((0..<3).map { (rawG[$0] - gyroBias[$0]) * imuCal.gyroScale($0) })
            for i in 0..<3 {
                gSum[i] += gyr[i]
                aSum[i] += acc[i]
                rawSum[i] += rawG[i]
            }
            // 重力方向低通（时间常数约 0.12 秒）：手在动时加速度计里会混进线加速度
            var g = grav ?? acc
            for i in 0..<3 { g[i] += (acc[i] - g[i]) * 0.04 }
            grav = g
            let gn = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).squareRoot()
            guard gn > 0.3 else { continue }
            // 「玩家空间」陀螺（Jibb Smart 的做法）：左右 = 绕真实的竖直方向转，怎么握都一样；上下 = 绕手柄自己的横轴点头
            let world = (gyr[1] * g[1] + gyr[2] * g[2]) / gn
            let yz = (gyr[1] * gyr[1] + gyr[2] * gyr[2]).squareRoot()
            let ccw = (world < 0 ? -1.0 : 1.0) * min(abs(world) * 1.41, yz)
            yaw -= ccw * imuDt        // 逆时针 = 往左转；取反后往右为正
            pitch += gyr[0] * imuDt   // 手柄头抬起为正
        }
        let now = uptime()
        guard count > 0 else {
            // IMU 被关了（手柄休眠唤醒 / 别的程序重置）：隔 2 秒重开一次
            if now - imuRetryAt > 2 {
                imuRetryAt = now
                enqueue(0x40, [0x01])
            }
            return
        }
        imuRetryAt = now
        let c = Double(count)
        let w = (gSum[0] * gSum[0] + gSum[1] * gSum[1] + gSum[2] * gSum[2]).squareRoot() / c
        let a = (aSum[0] * aSum[0] + aSum[1] * aSum[1] + aSum[2] * aSum[2]).squareRoot() / c
        motion += (w - motion) * 0.25
        updateRest(now: now, calm: motion < 1.5 && abs(a - 1) < 0.06, woke: motion > 5 || abs(a - 1) > 0.15, rawSum: rawSum, count: count)
        if now < streamUntil {
            emit(["t": "joy_gyro", "side": side.rawValue, "id": id, "yaw": round4(yaw), "pitch": round4(pitch)])
        }
    }

    /// 放下 / 拿起：几乎不转、只受重力，连续 3 秒 = 放在桌上（握在手里总有抖动和慢漂）；一动或一按键 = 拿起来了
    private func updateRest(now: Double, calm: Bool, woke: Bool, rawSum: [Double], count: Int) {
        guard calm else {
            stillSince = nil
            biasSum = [0, 0, 0]
            biasN = 0
            if resting, woke { setResting(false) }
            return
        }
        let since = stillSince ?? now
        stillSince = since
        let still = now - since
        // 稳稳不动 2 秒以上才学陀螺零偏（手里的慢漂不能当零偏）
        if still >= 2 {
            for i in 0..<3 { biasSum[i] += rawSum[i] }
            biasN += count
            if biasN >= 200 {
                for i in 0..<3 { gyroBias[i] = gyroBias[i] * 0.5 + biasSum[i] / Double(biasN) * 0.5 }
                biasSum = [0, 0, 0]
                biasN = 0
                biasLearned = true
            }
        }
        if !resting, still >= 3 { setResting(true) }
    }

    private func setResting(_ v: Bool) {
        guard resting != v else { return }
        resting = v
        emit(["t": "joy_motion", "side": side.rawValue, "id": id, "resting": v])
    }

    /// 按键 / 摇杆有动静 = 手柄在手里
    private func noteActivity() {
        stillSince = nil
        if resting { setResting(false) }
    }

    private func parseSubcommandReply(_ r: UnsafeMutablePointer<UInt8>, _ n: Int) {
        let subID = r[14]
        guard subID == 0x10, n >= 20 else { return }
        let addr = UInt32(r[15]) | (UInt32(r[16]) << 8) | (UInt32(r[17]) << 16) | (UInt32(r[18]) << 24)
        let size = Int(r[19])
        guard 20 + size <= n else { return }
        let data = (0..<size).map { r[20 + $0] }
        if addr == 0x603D, size >= 18 {
            if let c = StickCal.decodeLeft(Array(data[0..<9])) { leftCal = c }
            if let c = StickCal.decodeRight(Array(data[9..<18])) { rightCal = c }
        } else if addr == 0x8010, size >= 22 {
            // 用户校准：0x8010 处魔数 B2 A1 表示左摇杆有用户校准，0x801B 处表示右摇杆
            if data[0] == 0xB2, data[1] == 0xA1, let c = StickCal.decodeLeft(Array(data[2..<11])) { leftCal = c }
            if data[11] == 0xB2, data[12] == 0xA1, let c = StickCal.decodeRight(Array(data[13..<22])) { rightCal = c }
        } else if addr == 0x6020, size >= 24 {
            if let c = ImuCal.decode(data) {
                imuCal = c
                if !biasLearned { gyroBias = c.gyroOrigin }
            }
        } else if addr == 0x8026, size >= 26, data[0] == 0xB2, data[1] == 0xA1 {
            imuCal.applyUser(Array(data[2..<26]))
            if !biasLearned { gyroBias = imuCal.gyroOrigin }
        }
    }

    private func publishIfChanged() {
        let sticks = (lx, ly, rx, ry)
        let moved = abs(sticks.0 - sentSticks.0) > 0.02 || abs(sticks.1 - sentSticks.1) > 0.02
            || abs(sticks.2 - sentSticks.2) > 0.02 || abs(sticks.3 - sentSticks.3) > 0.02
        // 摇杆回中必须发出去，否则前端会以为还在推
        let returnedToCenter = (sticks.0 == 0 && sticks.1 == 0 && (sentSticks.0 != 0 || sentSticks.1 != 0))
            || (sticks.2 == 0 && sticks.3 == 0 && (sentSticks.2 != 0 || sentSticks.3 != 0))
        let input = buttons != sentButtons || moved || returnedToCenter
        guard input || battery != sentBattery else { return }
        if input { noteActivity() }
        sentButtons = buttons
        sentSticks = sticks
        sentBattery = battery
        emit([
            "t": "joy", "side": side.rawValue, "id": id, "b": Int(buttons),
            "lx": round3(lx), "ly": round3(ly), "rx": round3(rx), "ry": round3(ry),
            "bat": battery, "chg": charging,
        ])
    }

    private func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
    private func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
}

final class JoyConManager {
    private let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
    private var devices: [String: JoyConDevice] = [:]

    func start() {
        IOHIDManagerSetDeviceMatching(manager, [kIOHIDVendorIDKey: nintendoVendorID] as CFDictionary)
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(manager, { context, _, _, device in
            guard let context else { return }
            Unmanaged<JoyConManager>.fromOpaque(context).takeUnretainedValue().attach(device)
        }, ctx)
        IOHIDManagerRegisterDeviceRemovalCallback(manager, { context, _, _, device in
            guard let context else { return }
            Unmanaged<JoyConManager>.fromOpaque(context).takeUnretainedValue().detach(device)
        }, ctx)
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        let res = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        if res != kIOReturnSuccess { logMsg("IOHIDManagerOpen 失败: \(res)") }
    }

    private func key(_ device: IOHIDDevice) -> String {
        if let serial = IOHIDDeviceGetProperty(device, kIOHIDSerialNumberKey as CFString) as? String, !serial.isEmpty {
            return serial
        }
        let loc = IOHIDDeviceGetProperty(device, kIOHIDLocationIDKey as CFString) as? Int ?? 0
        return String(loc, radix: 16)
    }

    private func attach(_ device: IOHIDDevice) {
        let pid = IOHIDDeviceGetProperty(device, kIOHIDProductIDKey as CFString) as? Int ?? 0
        let name = IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String ?? "Nintendo"
        let side: JoySide
        switch pid {
        case 0x2006: side = .left
        case 0x2007: side = .right
        case 0x2009: side = .pro
        default:
            logMsg("忽略未知任天堂设备 pid=0x\(String(pid, radix: 16)) \(name)")
            return
        }
        let id = key(device)
        if devices[id] != nil { return }
        let res = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        if res != kIOReturnSuccess {
            logMsg("打开 \(name) 失败: \(res)")
            return
        }
        let player = side == .left ? 0 : (side == .right ? 1 : 0)
        let joy = JoyConDevice(device: device, side: side, id: id, name: name, playerIndex: player)
        devices[id] = joy
        joy.start()
        emit(["t": "joy_conn", "side": side.rawValue, "id": id, "name": name, "connected": true])
    }

    private func detach(_ device: IOHIDDevice) {
        let id = key(device)
        guard let joy = devices.removeValue(forKey: id) else { return }
        emit(["t": "joy_conn", "side": joy.side.rawValue, "id": id, "name": joy.name, "connected": false])
    }

    /// 按侧别找手柄：L/R 找对应单只，找不到就用 Pro 手柄兜底
    private func find(side: String?) -> [JoyConDevice] {
        let all = Array(devices.values)
        guard let side, !side.isEmpty else { return all }
        let hit = all.filter { $0.side.rawValue == side }
        return hit.isEmpty ? all.filter { $0.side == .pro } : hit
    }

    func rumble(side: String?, amplitude: Double, ms: Int, low: Double, high: Double) {
        for d in find(side: side) { d.rumble(lowFreq: low, highFreq: high, amplitude: amplitude, ms: ms) }
    }

    /// 播一段震动：segs 见 rumbleFrames；prio 高的不会被低的打断；force = 放在桌上也震
    func play(side: String?, segs: [[Double]], prio: Int, force: Bool) {
        let seq = rumbleFrames(segs)
        for d in find(side: side) { d.play(seq, prio: prio, force: force) }
    }

    func setLights(side: String?, mask: UInt8) {
        for d in find(side: side) { d.setLights(mask) }
    }

    func setHome(side: String?, mode: String) {
        for d in find(side: side ?? "R") { d.setHome(mode) }
    }

    func locate(seconds: Double) {
        for d in devices.values { d.locate(seconds: seconds) }
    }

    func stream(side: String?, seconds: Double) {
        for d in find(side: side) { d.stream(seconds: seconds) }
    }

    func shutdown() {
        for d in devices.values { d.shutdown() }
    }

    func listConnected() {
        for d in devices.values {
            emit(["t": "joy_conn", "side": d.side.rawValue, "id": d.id, "name": d.name, "connected": true])
            if d.resting { emit(["t": "joy_motion", "side": d.side.rawValue, "id": d.id, "resting": true]) }
        }
    }
}
