import Foundation
import Speech
import AVFoundation

// 按住说话：系统自带的 SFSpeechRecognizer，Apple 芯片上中文可以纯本地识别，不花钱、不出网
final class SpeechController {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var session = 0
    private var lastText = ""
    private var finished = true
    private var target = "chat"

    func start(lang: String, target: String) {
        self.target = target
        ensureSpeechAuth { [weak self] ok in
            guard let self else { return }
            guard ok else {
                emit(["t": "asr", "state": "error", "error": "speech_denied", "target": target])
                return
            }
            self.ensureMicAuth { ok in
                guard ok else {
                    emit(["t": "asr", "state": "error", "error": "mic_denied", "target": target])
                    return
                }
                self.begin(lang: lang)
            }
        }
    }

    private func ensureSpeechAuth(_ done: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: done(true)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async { done(status == .authorized) }
            }
        default: done(false)
        }
    }

    private func ensureMicAuth(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in
                DispatchQueue.main.async { done(ok) }
            }
        default: done(false)
        }
    }

    private func begin(lang: String) {
        teardown()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)), recognizer.isAvailable else {
            emit(["t": "asr", "state": "error", "error": "recognizer_unavailable", "target": target])
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            req.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            emit(["t": "asr", "state": "error", "error": "audio_engine: \(error.localizedDescription)", "target": target])
            return
        }

        session += 1
        let sid = session
        lastText = ""
        finished = false
        let tgt = target
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, sid == self.session, !self.finished else { return }
                if let result {
                    self.lastText = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.finish(sid)
                        return
                    }
                    emit(["t": "asr", "state": "partial", "text": self.lastText, "target": tgt])
                }
                if error != nil { self.finish(sid) }
            }
        }
        emit(["t": "asr", "state": "listening", "onDevice": req.requiresOnDeviceRecognition, "target": target])
    }

    func stop() {
        guard !finished else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        let sid = session
        // 松开扳机后最多再等 1.2 秒拿最终结果，拿不到就用最后一次的中间结果
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.finish(sid)
        }
    }

    private func finish(_ sid: Int) {
        guard sid == session, !finished else { return }
        finished = true
        emit(["t": "asr", "state": "final", "text": lastText, "target": target])
        teardown()
    }

    private func teardown() {
        task?.cancel()
        task = nil
        request = nil
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
    }
}
