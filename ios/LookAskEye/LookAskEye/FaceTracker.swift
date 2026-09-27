import ARKit

// ARKit 人脸追踪：每帧拿脸在相机坐标系里的位姿、两只眼睛（相对脸）的位姿、lookAtPoint、表情系数、重力方向
// 世界坐标按重力对齐，所以「相机坐标系里的重力」= 相机变换的逆作用在 (0, -1, 0) 上，Mac 靠它定「上」

final class FaceTracker: NSObject, ARSessionDelegate {
    static var isSupported: Bool { ARFaceTrackingConfiguration.isSupported }

    let session = ARSession()
    /// 每一帧（在 ARKit 的回调队列上调用）
    var onSample: ((FaceSample) -> Void)?
    var onError: ((String) -> Void)?
    /// 手机现在怎么放的（主线程写，ARKit 队列读，字符串赋值足够）
    var orient = "portrait"

    private let queue = DispatchQueue(label: "lookask.ar")
    private var lowPower = false
    private(set) var running = false

    /// 发给 Mac 的表情系数：眼睛、眉毛、下巴相关（名字和 Mac 端约定一致，不用 ARKit 的 rawValue）
    private static let blendKeys: [(ARFaceAnchor.BlendShapeLocation, String)] = [
        (.eyeBlinkLeft, "eyeBlinkLeft"), (.eyeBlinkRight, "eyeBlinkRight"),
        (.eyeLookDownLeft, "eyeLookDownLeft"), (.eyeLookDownRight, "eyeLookDownRight"),
        (.eyeLookInLeft, "eyeLookInLeft"), (.eyeLookInRight, "eyeLookInRight"),
        (.eyeLookOutLeft, "eyeLookOutLeft"), (.eyeLookOutRight, "eyeLookOutRight"),
        (.eyeLookUpLeft, "eyeLookUpLeft"), (.eyeLookUpRight, "eyeLookUpRight"),
        (.eyeSquintLeft, "eyeSquintLeft"), (.eyeSquintRight, "eyeSquintRight"),
        (.eyeWideLeft, "eyeWideLeft"), (.eyeWideRight, "eyeWideRight"),
        (.browDownLeft, "browDownLeft"), (.browDownRight, "browDownRight"),
        (.browInnerUp, "browInnerUp"),
        (.browOuterUpLeft, "browOuterUpLeft"), (.browOuterUpRight, "browOuterUpRight"),
        (.cheekSquintLeft, "cheekSquintLeft"), (.cheekSquintRight, "cheekSquintRight"),
        (.jawOpen, "jawOpen")
    ]

    /// 开始（或按新的省电设置重开）；lowPower = 发热严重时相机本身降到 30 帧
    func start(lowPower: Bool = false) {
        guard Self.isSupported else { return }
        self.lowPower = lowPower
        let cfg = ARFaceTrackingConfiguration()
        cfg.isLightEstimationEnabled = false
        cfg.maximumNumberOfTrackedFaces = 1
        cfg.worldAlignment = .gravity
        let formats = ARFaceTrackingConfiguration.supportedVideoFormats
        let want = lowPower ? 30 : 60
        if let f = formats.first(where: { $0.framesPerSecond == want }) ?? formats.max(by: { $0.framesPerSecond < $1.framesPerSecond }) {
            cfg.videoFormat = f
        }
        session.delegate = self
        session.delegateQueue = queue
        session.run(cfg, options: running ? [] : [.resetTracking, .removeExistingAnchors])
        running = true
    }

    func pause() {
        session.pause()
        running = false
    }

    // ---------- ARSessionDelegate ----------

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let inv = frame.camera.transform.inverse
        let g = inv * SIMD4<Float>(0, -1, 0, 0)
        let grav = simd_normalize(SIMD3<Float>(g.x, g.y, g.z))
        guard let face = frame.anchors.lazy.compactMap({ $0 as? ARFaceAnchor }).first else {
            onSample?(FaceSample(tracked: false, head: nil, eyeL: nil, eyeR: nil, look: nil, blend: [], grav: grav, orient: orient, ts: frame.timestamp))
            return
        }
        // 脸从世界坐标换到相机坐标系
        let m = inv * face.transform
        var blend: [(String, Float)] = []
        blend.reserveCapacity(Self.blendKeys.count)
        for (k, name) in Self.blendKeys {
            if let v = face.blendShapes[k]?.floatValue { blend.append((name, v)) }
        }
        onSample?(FaceSample(
            tracked: face.isTracked,
            head: Self.pose(m),
            eyeL: Self.pose(face.leftEyeTransform),
            eyeR: Self.pose(face.rightEyeTransform),
            look: face.lookAtPoint,
            blend: blend,
            grav: grav,
            orient: orient,
            ts: frame.timestamp
        ))
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        running = false
        onError?(error.localizedDescription)
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        // 回到前台 / 摄像头被别的 App 占用后恢复：重开一次，脸重新找
        running = false
        start(lowPower: lowPower)
    }

    // ---------- 工具 ----------

    static func pose(_ m: simd_float4x4) -> Pose3 {
        let c0 = SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z)
        let c1 = SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z)
        let c2 = SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        // 去掉可能的缩放，保证是纯旋转再转四元数
        let r = simd_float3x3(simd_normalize(c0), simd_normalize(c1), simd_normalize(c2))
        return Pose3(pos: SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z), quat: simd_quatf(r))
    }
}
