import Foundation
import Vision
import AppKit

// 截图 OCR：全局模式下看别的 App 时，把视线处的画面转成文字喂给 AI
private let ocrQueue = DispatchQueue(label: "lookask.bridge.ocr", qos: .userInitiated)

func runOCR(id: Int, path: String, fast: Bool) {
    ocrQueue.async {
        guard let image = NSImage(contentsOfFile: path),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            emit(["t": "ocr", "id": id, "error": "无法读取图片"])
            return
        }
        let w = Double(cg.width), h = Double(cg.height)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
        } catch {
            emit(["t": "ocr", "id": id, "error": error.localizedDescription])
            return
        }
        var lines: [[String: Any]] = []
        for obs in request.results ?? [] {
            guard let top = obs.topCandidates(1).first else { continue }
            // Vision 的坐标原点在左下角且归一化，转成图片像素、原点左上
            let b = obs.boundingBox
            lines.append([
                "text": top.string,
                "conf": Double(top.confidence),
                "x": b.minX * w, "y": (1 - b.maxY) * h, "w": b.width * w, "h": b.height * h,
            ])
        }
        // 按阅读顺序排：先上后下，同一行从左到右
        lines.sort { a, b in
            let ay = a["y"] as! Double, by = b["y"] as! Double
            let ah = a["h"] as! Double
            if abs(ay - by) > ah * 0.5 { return ay < by }
            return (a["x"] as! Double) < (b["x"] as! Double)
        }
        emit(["t": "ocr", "id": id, "w": w, "h": h, "lines": lines])
    }
}

/// 启动后在后台先跑一次 OCR，把识别模型加载进内存（冷启动第一次要 8 秒，预热后 0.3 秒）
func warmUpOCR() {
    ocrQueue.asyncAfter(deadline: .now() + 2) {
        let w = 96, h = 32
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let img = ctx.makeImage() else { return }
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    }
}
