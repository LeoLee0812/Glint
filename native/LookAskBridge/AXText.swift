import Foundation
import ApplicationServices
import AppKit

// 辅助功能取词：拿屏幕某点下的界面元素和它的文字（终端、浏览器、备忘录等支持的 App 能拿到原文，比 OCR 准）

private func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

private func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let a = v as? NSAttributedString { return a.string }
    return nil
}

private func param(_ el: AXUIElement, _ name: String, _ arg: CFTypeRef) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(el, name as CFString, arg, &v) == .success ? v : nil
}

func axTrusted(prompt: Bool) -> Bool {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
}

func axTextAt(id: Int, x: Double, y: Double) {
    guard axTrusted(prompt: false) else {
        emit(["t": "ax", "id": id, "error": "not_trusted"])
        return
    }
    let system = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &hit) == .success, let el = hit else {
        emit(["t": "ax", "id": id, "error": "no_element"])
        return
    }
    var out: [String: Any] = ["t": "ax", "id": id]
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    if let app = NSRunningApplication(processIdentifier: pid) {
        out["app"] = app.localizedName ?? ""
        out["bundle"] = app.bundleIdentifier ?? ""
    }
    out["role"] = stringAttr(el, kAXRoleAttribute) ?? ""
    if let title = stringAttr(el, kAXTitleAttribute), !title.isEmpty { out["title"] = title }
    if let desc = stringAttr(el, kAXDescriptionAttribute), !desc.isEmpty { out["desc"] = String(desc.prefix(500)) }

    // 支持按坐标取字符位置的元素（文本区域、网页正文），取出所在行
    var point = CGPoint(x: x, y: y)
    if let axPoint = AXValueCreate(.cgPoint, &point),
       let rangeVal = param(el, "AXRangeForPosition", axPoint) {
        var r = CFRange()
        if AXValueGetValue(rangeVal as! AXValue, .cfRange, &r) {
            let idx = r.location as CFNumber
            if let lineNum = param(el, "AXLineForIndex", idx) as? NSNumber,
               let lineRangeVal = param(el, "AXRangeForLine", lineNum),
               let lineText = param(el, "AXStringForRange", lineRangeVal) as? String {
                out["line"] = lineText
            }
        }
    }
    // 元素本身的值（整段文字），截断避免太长
    if let value = stringAttr(el, kAXValueAttribute), !value.isEmpty {
        out["text"] = String(value.prefix(6000))
    } else if let parent = attr(el, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID(),
              let pv = stringAttr(parent as! AXUIElement, kAXValueAttribute), !pv.isEmpty {
        out["text"] = String(pv.prefix(6000))
    }
    // 所在窗口标题，帮 AI 判断语境（比如论文名、网页标题）
    if let win = attr(el, kAXWindowAttribute), CFGetTypeID(win) == AXUIElementGetTypeID(),
       let wt = stringAttr(win as! AXUIElement, kAXTitleAttribute) {
        out["window"] = wt
    }
    emit(out)
}
