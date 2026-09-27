import XCTest
import simd
@testable import LookAskEye

// 协议层单元测试：帧编码 / 解码、签名和 Mac 端一致、seq 乱序丢弃、心跳断线判断、发热降帧

final class ProtocolTests: XCTestCase {
    /// 签名要和 Mac 端（Node：src/main/truedepth.ts 的 tdKey / tdSign）算得一模一样
    func testSignatureMatchesMacSide() {
        let json = #"{"t":"f","v":1,"dev":"TEST-DEV-1","sid":7,"seq":1,"ts":1.5,"tracked":false,"orient":"portrait"}"#
        let key = LAProtocol.key(dev: "TEST-DEV-1", code: "4827")
        XCTAssertEqual(LAProtocol.macHex(json: Data(json.utf8), key: key), "8f6708ba65b422673e75d060c07e169f")
        let pkt = LAProtocol.seal(json, key: key)
        XCTAssertEqual(String(data: pkt, encoding: .utf8), "8f6708ba65b422673e75d060c07e169f" + json)
    }

    func testFrameEncodeDecodeRoundTrip() throws {
        let q = simd_quatf(angle: 0.3, axis: simd_normalize(SIMD3<Float>(0.2, 1, 0.1)))
        let s = FaceSample(
            tracked: true,
            head: Pose3(pos: SIMD3(0.012345, -0.07, -0.52), quat: q),
            eyeL: Pose3(pos: SIMD3(0.031, 0.026, 0.028), quat: simd_quatf(angle: 0.1, axis: SIMD3(0, 1, 0))),
            eyeR: Pose3(pos: SIMD3(-0.031, 0.026, 0.028), quat: simd_quatf(angle: -0.05, axis: SIMD3(1, 0, 0))),
            look: SIMD3(0.01, -0.02, 0.5),
            blend: [("eyeBlinkLeft", 0.12), ("eyeBlinkRight", 0.1), ("jawOpen", 0.0)],
            grav: SIMD3(0.99, 0.01, -0.13),
            orient: "portrait",
            ts: 812_345.123_456
        )
        let json = LAProtocol.frameJSON(s, dev: "D1", sid: 42, seq: 99)
        let key = LAProtocol.key(dev: "D1", code: "0007")
        let o = try XCTUnwrap(LAProtocol.open(LAProtocol.seal(json, key: key), key: key))
        XCTAssertEqual(o["t"] as? String, "f")
        XCTAssertEqual(o["dev"] as? String, "D1")
        XCTAssertEqual((o["sid"] as? NSNumber)?.intValue, 42)
        XCTAssertEqual((o["seq"] as? NSNumber)?.intValue, 99)
        XCTAssertEqual(o["tracked"] as? Bool, true)
        XCTAssertEqual((o["ts"] as? NSNumber)?.doubleValue ?? 0, 812_345.1235, accuracy: 1e-4)
        let head = try XCTUnwrap(o["head"] as? [String: Any])
        let pos = try XCTUnwrap(head["pos"] as? [NSNumber]).map(\.floatValue)
        XCTAssertEqual(pos[0], 0.01235, accuracy: 1e-5)
        XCTAssertEqual(pos[2], -0.52, accuracy: 1e-5)
        let quat = try XCTUnwrap(head["quat"] as? [NSNumber]).map(\.floatValue)
        XCTAssertEqual(quat.count, 4)
        XCTAssertEqual(quat[3], q.vector.w, accuracy: 1e-5)
        let bs = try XCTUnwrap(o["bs"] as? [String: NSNumber])
        XCTAssertEqual(bs["eyeBlinkLeft"]?.floatValue ?? 0, 0.12, accuracy: 1e-3)
        XCTAssertEqual((o["grav"] as? [NSNumber])?.count, 3)
        XCTAssertEqual(o["orient"] as? String, "portrait")
    }

    func testUntrackedFrameOmitsFace() throws {
        let s = FaceSample(tracked: false, head: nil, eyeL: nil, eyeR: nil, look: nil, blend: [], grav: SIMD3(0, -1, 0), orient: "portrait", ts: 1)
        let json = LAProtocol.frameJSON(s, dev: "D", sid: 1, seq: 1)
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertNil(o["head"])
        XCTAssertNil(o["eyeL"])
        XCTAssertEqual(o["tracked"] as? Bool, false)
    }

    func testWrongCodeRejected() {
        let json = LAProtocol.heartbeatJSON(.init(name: "iPhone", model: "iPhone16,1", app: "0.1.0", therm: 0, fps: 60, tracked: true, orient: "portrait"), dev: "D", sid: 1, seq: 3, ts: 2)
        let pkt = LAProtocol.seal(json, key: LAProtocol.key(dev: "D", code: "1234"))
        XCTAssertNil(LAProtocol.open(pkt, key: LAProtocol.key(dev: "D", code: "1235")))
        XCTAssertNil(LAProtocol.open(pkt, key: LAProtocol.key(dev: "E", code: "1234")))
        XCTAssertNotNil(LAProtocol.open(pkt, key: LAProtocol.key(dev: "D", code: "1234")))
    }

    func testJSONEscapingAndNumbers() throws {
        var w = JSONWriter()
        w.str("name", "Leo’s \"iPhone\"\n")
        w.num("nan", .nan)
        w.num("neg", -0.000001, 3)
        w.num("pi", 3.14159265, 4)
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(w.finish().utf8)) as? [String: Any])
        XCTAssertEqual(o["name"] as? String, "Leo’s \"iPhone\"\n")
        XCTAssertEqual((o["nan"] as? NSNumber)?.doubleValue, 0)
        XCTAssertEqual((o["neg"] as? NSNumber)?.doubleValue, 0)
        XCTAssertEqual((o["pi"] as? NSNumber)?.doubleValue ?? 0, 3.1416, accuracy: 1e-9)
    }

    func testSeqFilterDropsOutOfOrder() {
        var f = SeqFilter()
        let accepted = [1, 2, 4, 3, 5, 5, 6].filter { f.accept(UInt64($0)) }
        XCTAssertEqual(accepted, [1, 2, 4, 5, 6])
        XCTAssertEqual(f.dropped, 2)
    }

    func testAckParsing() throws {
        let a = try XCTUnwrap(LAProtocol.parseAck(Data(#"{"t":"ack","v":1,"sid":9,"seq":3,"state":"paired","mac":"Leo's MacBook","fps":58,"use":true}"#.utf8)))
        XCTAssertEqual(a, LAProtocol.Ack(state: "paired", mac: "Leo's MacBook", fps: 58, use: true, sid: 9, seq: 3))
        XCTAssertNil(LAProtocol.parseAck(Data(#"{"t":"hb"}"#.utf8)))
        XCTAssertNil(LAProtocol.parseAck(Data("不是 JSON".utf8)))
    }

    func testHeartbeatAndDisconnect() {
        var m = LinkMonitor(timeout: 3)
        XCTAssertEqual(m.status(at: 0), .none)
        let ack = LAProtocol.Ack(state: "paired", mac: "Mac", fps: 60, use: true, sid: 1, seq: 1)
        XCTAssertTrue(m.got(ack, at: 10))
        XCTAssertEqual(m.status(at: 12.9), .paired(mac: "Mac", fps: 60, use: true))
        XCTAssertEqual(m.status(at: 13.1), .silent(mac: "Mac"))
        // 乱序到达的旧 ack 不能把状态改回去
        XCTAssertTrue(m.got(.init(state: "paired", mac: "Mac", fps: 59, use: true, sid: 1, seq: 5), at: 14))
        XCTAssertFalse(m.got(.init(state: "need_pair", mac: "Mac", fps: 0, use: true, sid: 1, seq: 4), at: 14.1))
        XCTAssertEqual(m.status(at: 14.2), .paired(mac: "Mac", fps: 59, use: true))
        // Mac 重启（会话号变了）：序号从头来
        XCTAssertTrue(m.got(.init(state: "need_pair", mac: "Mac", fps: 0, use: true, sid: 2, seq: 1), at: 15))
        XCTAssertEqual(m.status(at: 15.5), .needPair(mac: "Mac"))
        m.reset()
        XCTAssertEqual(m.status(at: 16), .none)
    }

    func testThermalFrameRate() {
        XCTAssertEqual(FrameRatePolicy.fps(for: .nominal), 60)
        XCTAssertEqual(FrameRatePolicy.fps(for: .fair), 60)
        XCTAssertEqual(FrameRatePolicy.fps(for: .serious), 30)
        XCTAssertEqual(FrameRatePolicy.fps(for: .critical), 15)
        XCTAssertFalse(FrameRatePolicy.lowPowerCamera(for: .fair))
        XCTAssertTrue(FrameRatePolicy.lowPowerCamera(for: .serious))
    }

    func testThrottleKeepsTargetRate() {
        // ARKit 60 帧输入，带一点时间抖动
        var times: [Double] = []
        for i in 0..<600 {
            let wobble: Double = i % 3 == 0 ? 0.002 : -0.001
            times.append(Double(i) / 60 + wobble)
        }
        func sent(_ fps: Int) -> Int {
            var t = FrameThrottle()
            return times.filter { t.shouldSend(at: $0, fps: fps) }.count
        }
        XCTAssertEqual(sent(60), 600, accuracy: 3)
        XCTAssertEqual(sent(30), 300, accuracy: 3)
        XCTAssertEqual(sent(15), 150, accuracy: 3)
    }

    func testIdentityPersistsAndRegenerates() throws {
        let suite = "lookask.test.\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        let a = Identity(defaults: d)
        XCTAssertTrue(Identity.isValid(a.code))
        let b = Identity(defaults: d)
        XCTAssertEqual(a.dev, b.dev)
        XCTAssertEqual(a.code, b.code)
        let old = b.code
        b.regenerate()
        XCTAssertNotEqual(old, b.code)
        XCTAssertEqual(Identity(defaults: d).code, b.code)
    }
}
