# LookAskEye（iPhone 端）

iPhone 原深感眼动的数据发送端：ARKit 人脸追踪拿头的三维位姿、双眼朝向、lookAtPoint、眼部表情系数和重力方向，每帧签名后用 UDP 发给 Mac 上的 LookAsk。Mac 端的收包、配对、几何换算见仓库根目录的 `README.md`。

## 文件

- `LookAskEye/Protocol.swift`：协议纯逻辑（编码、HMAC 签名、ack 解析、乱序丢弃、心跳断线判断、发热降帧），和 Mac 端 `src/main/truedepth.ts` 一一对应，改协议两边一起改
- `LookAskEye/FaceTracker.swift`：ARKit 人脸追踪（世界坐标按重力对齐，脸换到相机坐标系）
- `LookAskEye/MacLink.swift`：Bonjour 找 `_lookask._udp`、UDP 连接、收 ack（同一 Wi‑Fi / 个人热点 / 点对点 Wi‑Fi）
- `LookAskEye/EyeModel.swift`：把追踪、网络、配对码串起来；60 帧发帧、每秒一次心跳、发热降到 30 / 15 帧
- `LookAskEye/ContentView.swift`：界面（连接状态、配对码、预览、Mac 列表、摆放说明、黑屏省电）
- `LookAskEyeTests/ProtocolTests.swift`：单元测试（签名和 Mac 端 Node 逐字节对照、帧编解码、乱序、心跳、降帧）
- `project.yml`：XcodeGen 工程描述，`LookAskEye.xcodeproj` 由它生成

## 构建

```bash
bash ios/LookAskEye/build.sh test     # 模拟器上跑单元测试
bash ios/LookAskEye/build.sh ipa      # 无签名 ipa → release/ios/
bash ios/LookAskEye/build.sh device   # 个人团队证书签名，装到插着线（或同一 Wi‑Fi、已解锁）的 iPhone
```

- 没越狱的 iPhone 装不了完全无签名的 App：无签名 ipa 留着以后用 Sideloadly / AltStore 拿 Apple ID 重签
- 免费个人团队签的版本 7 天后过期，到时再跑一次 `device`；第一次打开要在「设置 → 通用 → VPN 与设备管理」里信任开发者
- 手机要开「开发者模式」（设置 → 隐私与安全性 → 开发者模式），第一次装开发版时系统会提示
- 模拟器没有原深感人脸追踪，界面会显示「这台设备不支持」，但 Bonjour、UDP、配对都能测（模拟器和 Mac 共用网络）

## 摆放

手机竖放、前置镜头对着脸、离脸 40～70 厘米：测试时立在 MacBook 屏幕和键盘之间的缝里；以后用背板挂在屏幕后面，镜头露出屏幕上沿。放好后别再碰它，碰了要在 Mac 上重新校准。App 要一直开在前台（屏幕常亮，可以点「黑屏省电」）。
