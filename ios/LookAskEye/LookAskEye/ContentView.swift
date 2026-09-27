import SwiftUI
import ARKit

// Glint Eye 界面：品牌头 + 灯带（连上 Mac 时亮青色，和实体 Glint Eye 的灯带一致）、配对码、帧率和脸有没有追到、小预览窗、Mac 列表、摆放说明
// 手机竖放：测试时立在 MacBook 屏幕和键盘之间的缝里，以后用背板挂在屏幕后面、镜头露出上沿

/// 品牌青：和 Mac 端视线光环、Glint Eye 灯带同一个颜色
extension Color {
    static let glint = Color(red: 30 / 255, green: 170 / 255, blue: 240 / 255)
}

struct ContentView: View {
    @StateObject private var m = EyeModel()
    @State private var manual = false
    @State private var host = ""
    @State private var port = "47650"

    var body: some View {
        ZStack {
            if m.dark {
                DarkScreen(m: m)
            } else {
                main
            }
        }
        .onAppear { m.start() }
        .statusBarHidden(m.dark)
        .tint(.glint)
    }

    private var main: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if !m.supported {
                    Card {
                        Text("这台设备不支持原深感人脸追踪")
                            .font(.title3.bold())
                        Text("需要有面容 ID 的 iPhone（iPhone X 及以后）。模拟器也不支持，只能看看界面。")
                            .foregroundStyle(.secondary)
                    }
                }
                statusCard
                codeCard
                if m.supported { previewCard }
                macCard
                tipsCard
                Button {
                    m.dark = true
                } label: {
                    Label("黑屏省电（继续发送）", systemImage: "moon.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .padding(.bottom, 20)
            }
            .padding(.horizontal, 18)
        }
        .background(Color(.systemGroupedBackground))
    }

    // ---------- 品牌头 ----------

    private var header: some View {
        HStack(spacing: 14) {
            Image("Logo")
                .resizable()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text("Glint Eye")
                    .font(.system(size: 30, weight: .bold))
                    .kerning(-0.5)
                Text("Glint 瞳问 · 给 Mac 一只眼睛")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 8)
    }

    /// 连上并且 Mac 正在用 = 灯带亮
    private var live: Bool {
        if case let .paired(_, _, use) = m.macState { return use && m.tracked }
        return false
    }

    // ---------- 连接状态 ----------

    private var statusText: (String, Color) {
        if let p = m.browseProblem, m.macs.isEmpty { return (p, .orange) }
        switch m.macState {
        case .searching:
            return (m.macs.isEmpty ? "正在找 Mac…" : "点下面的 Mac 连上", .secondary)
        case let .connecting(name):
            return ("正在连「\(name)」…", .secondary)
        case let .needPair(mac):
            return ("在「\(mac)」上输入配对码 \(m.code)", .orange)
        case let .paired(mac, fps, use):
            return use ? ("已连上「\(mac)」· Mac 收到 \(fps) 帧/秒", .glint) : ("已配对，但「\(mac)」没选 iPhone 原深感（Mac 上：设置 → 眼动 → 输入源）", .orange)
        case let .silent(mac):
            return ("「\(mac)」没回话：Mac 上的 Glint 开着吗？", .red)
        }
    }

    private var statusCard: some View {
        Card {
            let (text, color) = statusText
            LightStrip(on: live)
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(color).frame(width: 12, height: 12).padding(.top, 7)
                Text(text).font(.title3.weight(.semibold))
            }
            if let p = m.connProblem, case .silent = m.macState {
                Text(p).font(.footnote).foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                Label(m.tracked ? "看得到脸" : "看不到脸", systemImage: m.tracked ? "face.smiling" : "eye.slash")
                    .foregroundStyle(m.tracked ? Color.glint : .orange)
                if let d = m.distanceCm { Text("离手机 \(d) 厘米").foregroundStyle(d < 30 || d > 85 ? .orange : .secondary) }
                Spacer()
                Text("发送 \(m.sendFps) 帧/秒").foregroundStyle(.secondary)
            }
            .font(.subheadline)
            if FrameRatePolicy.fps(for: m.thermal) < 60 {
                Label("手机偏热，已降到 \(FrameRatePolicy.fps(for: m.thermal)) 帧/秒；可以先黑屏省电", systemImage: "thermometer.high")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let e = m.arError {
                Text("人脸追踪出错：\(e)").font(.footnote).foregroundStyle(.red)
            }
        }
    }

    // ---------- 配对码 ----------

    private var codeCard: some View {
        Card {
            HStack(alignment: .firstTextBaseline) {
                Text("配对码").font(.headline)
                Spacer()
                Button("换一个") { m.newCode() }
                    .font(.subheadline)
            }
            Text(m.code)
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .monospacedDigit()
                .kerning(14)
                .frame(maxWidth: .infinity)
            Text("第一次连这台 Mac 时，在 Mac 上的 Glint：设置 → 眼动 → 输入这 4 位数字。之后自动认得。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // ---------- 预览 ----------

    private var previewCard: some View {
        Card {
            Toggle("显示摄像头预览（关掉更省电）", isOn: $m.preview)
                .font(.subheadline)
            if m.preview {
                ARPreview(session: m.tracker.session)
                    .aspectRatio(3 / 4, contentMode: .fit)
                    .frame(maxWidth: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(m.tracked ? Color.glint : Color.orange, lineWidth: 3))
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // ---------- Mac 列表 ----------

    private var macCard: some View {
        Card {
            Text("附近的 Mac").font(.headline)
            if m.macs.isEmpty {
                Text("还没找到：Mac 上的 Glint 要选「iPhone 原深感」输入源；手机和 Mac 连同一个 Wi‑Fi，或者 Mac 连这台手机的个人热点。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(m.macs) { e in
                Button {
                    m.choose(e)
                } label: {
                    HStack {
                        Image(systemName: "laptopcomputer")
                        Text(e.name)
                        Spacer()
                        if m.chosen == e.name { Image(systemName: "checkmark").foregroundStyle(.tint) }
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            DisclosureGroup("手动输入 Mac 地址", isExpanded: $manual) {
                HStack {
                    TextField("IP，比如 172.20.10.2", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("端口", text: $port)
                        .keyboardType(.numberPad)
                        .frame(width: 70)
                    Button("连接") {
                        if let p = UInt16(port), !host.isEmpty { m.connectManual(host: host, port: p) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .textFieldStyle(.roundedBorder)
                .padding(.top, 6)
            }
            .font(.subheadline)
        }
    }

    // ---------- 摆放说明 ----------

    private var tipsCard: some View {
        Card {
            Text("怎么放").font(.headline)
            VStack(alignment: .leading, spacing: 6) {
                Text("• 手机竖放：测试时立在 MacBook 屏幕和键盘之间的缝里；以后用背板挂在屏幕后面、镜头露出屏幕上沿。")
                Text("• 前置镜头对着脸，离脸 40～70 厘米，越近越准。放好后别再碰它，碰了要在 Mac 上重新校准。")
                Text("• 这个 App 要一直开在前台，屏幕会常亮；嫌亮就点下面的「黑屏省电」。")
                Text("• 没有 Wi‑Fi：Mac 连这台手机的个人热点，其它不变。")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}

/// 黑屏省电：OLED 全黑，只留一行小字，点一下回来
struct DarkScreen: View {
    @ObservedObject var m: EyeModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 8) {
                Text(m.tracked ? "Glint Eye · 发送中 \(m.sendFps) 帧/秒" : "Glint Eye · 看不到脸")
                Text("点一下回来")
            }
            .font(.footnote)
            .foregroundStyle(Color(white: 0.28))
        }
        .contentShape(Rectangle())
        .onTapGesture { m.dark = false }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
    }
}

/// 灯带：实体 Glint Eye 正面的那条青色光，连上时亮起并轻轻呼吸
struct LightStrip: View {
    let on: Bool
    @State private var breathe = false

    var body: some View {
        Capsule()
            .fill(on ? Color.glint : Color(.systemGray4))
            .frame(height: 5)
            .shadow(color: on ? Color.glint.opacity(breathe ? 0.9 : 0.45) : .clear, radius: 8)
            .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: breathe)
            .onAppear { breathe = true }
    }
}

/// 摄像头预览：和追踪共用同一个 ARSession，只负责画面
struct ARPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let v = ARSCNView(frame: .zero)
        v.session = session
        v.automaticallyUpdatesLighting = false
        v.rendersCameraGrain = false
        v.scene = SCNScene()
        return v
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
