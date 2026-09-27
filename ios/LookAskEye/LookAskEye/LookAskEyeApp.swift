import SwiftUI

// LookAskEye：iPhone 原深感眼动数据发送端。ARKit 人脸追踪 → UDP 发给 Mac 上的 LookAsk（协议见 Protocol.swift）

@main
struct LookAskEyeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
