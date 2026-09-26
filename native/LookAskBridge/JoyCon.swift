import Foundation
import IOKit.hid

// Joy-Con 原生读取：直接走 IOHIDManager 读蓝牙 HID 原始报告。
// 不用系统 GameController 框架：它把单只 Joy-Con 当成横握小手柄，拿不到 R/ZR/摇杆按下，也没有模拟摇杆。
// 协议参考 dekuNukem/Nintendo_Switch_Reverse_Engineering：切到 0x30 全量模式后约 60Hz 上报。

private let nintendoVendorID = 0x057E

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

final class JoyConDevice {
    let device: IOHIDDevice
    let side: JoySide
    let id: String
    let name: String
    let playerIndex: Int

    private var packet: UInt8 = 0
    private let inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 512)
    private var commandQueue: [(UInt8, [UInt8])] = []
    private var commandTimer: Timer?
    private var watchdog: Timer?
    private var lastReport = Date()

    private var leftCal = StickCal()
    private var rightCal = StickCal()

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
        commandTimer?.invalidate()
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
    }

    private func spiRead(_ addr: UInt32, _ len: UInt8) -> [UInt8] {
        [UInt8(addr & 0xFF), UInt8((addr >> 8) & 0xFF), UInt8((addr >> 16) & 0xFF), UInt8((addr >> 24) & 0xFF), len]
    }

    private func enqueue(_ sub: UInt8, _ args: [UInt8]) {
        commandQueue.append((sub, args))
        if commandTimer == nil {
            // 子命令之间留 60ms，Joy-Con 连发太快会丢
            commandTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] t in
                guard let self else { t.invalidate(); return }
                if self.commandQueue.isEmpty {
                    t.invalidate()
                    self.commandTimer = nil
                    return
                }
                let (sub, args) = self.commandQueue.removeFirst()
                self.sendSubcommand(sub, args)
            }
        }
    }

    private func nextPacket() -> UInt8 {
        let p = packet & 0x0F
        packet &+= 1
        return p
    }

    private func sendSubcommand(_ sub: UInt8, _ args: [UInt8]) {
        var r = [UInt8](repeating: 0, count: 49)
        r[0] = 0x01
        r[1] = nextPacket()
        let neutral: [UInt8] = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]
        for i in 0..<8 { r[2 + i] = neutral[i] }
        r[10] = sub
        for (i, a) in args.enumerated() where 11 + i < r.count { r[11 + i] = a }
        _ = IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, CFIndex(0x01), r, r.count)
    }

    /// 震动：低频 + 高频双频段，amplitude 0~1；持续 ms 毫秒后自动停
    func rumble(lowFreq: Double = 160, highFreq: Double = 320, amplitude: Double = 0.5, ms: Int = 80) {
        sendRumble(encodeRumble(lowFreq: lowFreq, highFreq: highFreq, amplitude: amplitude))
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(10, ms))) { [weak self] in
            self?.sendRumble([0x00, 0x01, 0x40, 0x40])
        }
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

    /// HD 震动编码，移植自 tomayac/joy-con-webhid
    private func encodeRumble(lowFreq: Double, highFreq: Double, amplitude: Double) -> [UInt8] {
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

    func setLights(_ mask: UInt8) {
        enqueue(0x30, [mask])
    }

    private func handleReport(id: UInt8, report: UnsafeMutablePointer<UInt8>, length: CFIndex) {
        let n = Int(length)
        switch id {
        case 0x30, 0x21:
            guard n >= 13 else { return }
            lastReport = Date()
            parseStandard(report)
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
        }
    }

    private func publishIfChanged() {
        let sticks = (lx, ly, rx, ry)
        let moved = abs(sticks.0 - sentSticks.0) > 0.02 || abs(sticks.1 - sentSticks.1) > 0.02
            || abs(sticks.2 - sentSticks.2) > 0.02 || abs(sticks.3 - sentSticks.3) > 0.02
        // 摇杆回中必须发出去，否则前端会以为还在推
        let returnedToCenter = (sticks.0 == 0 && sticks.1 == 0 && (sentSticks.0 != 0 || sentSticks.1 != 0))
            || (sticks.2 == 0 && sticks.3 == 0 && (sentSticks.2 != 0 || sentSticks.3 != 0))
        guard buttons != sentButtons || moved || returnedToCenter || battery != sentBattery else { return }
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

    func setLights(side: String?, mask: UInt8) {
        for d in find(side: side) { d.setLights(mask) }
    }

    func listConnected() {
        for d in devices.values {
            emit(["t": "joy_conn", "side": d.side.rawValue, "id": d.id, "name": d.name, "connected": true])
        }
    }
}
