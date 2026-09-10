import AVFoundation
import Foundation
import Speech

struct RecognizedCaption: Sendable {
    var text: String
    var sourceStart: Double
    var sourceEnd: Double
}

enum SpeechCaptionRecognizer {
    private final class RecognitionState: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<[RecognizedCaption], Error>?
        private var recognitionTask: SFSpeechRecognitionTask?
        private var isCancelled = false
        private var isFinished = false

        func install(_ continuation: CheckedContinuation<[RecognizedCaption], Error>) -> Bool {
            lock.lock()
            if isCancelled || isFinished {
                isFinished = true
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return false
            }
            self.continuation = continuation
            lock.unlock()
            return true
        }

        func install(_ task: SFSpeechRecognitionTask) {
            lock.lock()
            let shouldCancel = isCancelled || isFinished
            if !shouldCancel { recognitionTask = task }
            lock.unlock()
            if shouldCancel { task.cancel() }
        }

        func finish(_ result: Result<[RecognizedCaption], Error>) {
            lock.lock()
            guard !isFinished else { lock.unlock(); return }
            isFinished = true
            let pending = continuation
            continuation = nil
            recognitionTask = nil
            lock.unlock()
            pending?.resume(with: result)
        }

        func cancel() {
            lock.lock()
            guard !isFinished else { lock.unlock(); return }
            isCancelled = true
            let pending = continuation
            let task = recognitionTask
            if pending != nil { isFinished = true }
            continuation = nil
            recognitionTask = nil
            lock.unlock()
            task?.cancel()
            pending?.resume(throwing: CancellationError())
        }
    }

    static func recognize(
        mediaURL: URL, trimStart: Double, trimDuration: Double, localeIdentifier: String
    ) async throws -> [RecognizedCaption] {
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard authorization == .authorized else { throw CocoaError(.userCancelled) }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)),
              recognizer.isAvailable else { throw CocoaError(.featureUnsupported) }
        let duration = max(0, trimDuration)
        guard duration >= 0.05 else { return [] }
        let chunkDuration = 55.0
        var sourceOffset = 0.0
        var captions: [RecognizedCaption] = []
        while sourceOffset < duration - 0.001 {
            try Task.checkCancellation()
            let length = min(chunkDuration, duration - sourceOffset)
            let audioURL = try await extractAudio(
                mediaURL: mediaURL, trimStart: trimStart + sourceOffset, trimDuration: length
            )
            do {
                let chunk = try await recognizeAudio(at: audioURL, recognizer: recognizer)
                captions.append(contentsOf: chunk.map { caption in
                    RecognizedCaption(
                        text: caption.text, sourceStart: sourceOffset + caption.sourceStart,
                        sourceEnd: min(duration, sourceOffset + caption.sourceEnd)
                    )
                })
                try? FileManager.default.removeItem(at: audioURL)
            } catch {
                try? FileManager.default.removeItem(at: audioURL)
                throw error
            }
            sourceOffset += length
        }
        return captions
    }

    private static func recognizeAudio(
        at audioURL: URL, recognizer: SFSpeechRecognizer
    ) async throws -> [RecognizedCaption] {
        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let state = RecognitionState()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard state.install(continuation) else { return }
                let task = recognizer.recognitionTask(with: request) { result, error in
                    if let error {
                        state.finish(.failure(error))
                        return
                    }
                    guard let result, result.isFinal else { return }
                    let words = result.bestTranscription.segments.compactMap { segment -> RecognizedCaption? in
                        let text = segment.substring.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return nil }
                        return RecognizedCaption(
                            text: text, sourceStart: segment.timestamp,
                            sourceEnd: segment.timestamp + max(0.25, segment.duration)
                        )
                    }
                    state.finish(.success(grouped(words)))
                }
                state.install(task)
            }
        } onCancel: {
            state.cancel()
        }
    }

    private static func grouped(_ words: [RecognizedCaption]) -> [RecognizedCaption] {
        var result: [RecognizedCaption] = []
        var text = ""
        var start = 0.0
        var end = 0.0
        for word in words {
            if text.isEmpty { start = word.sourceStart }
            let needsSpace = text.unicodeScalars.last.map { $0.isASCII } == true &&
                word.text.unicodeScalars.first.map { $0.isASCII } == true
            text += (needsSpace && !text.isEmpty ? " " : "") + word.text
            end = word.sourceEnd
            let punctuation = word.text.last.map { "。！？!?.,".contains($0) } ?? false
            if end - start >= 3.2 || text.count >= 26 || punctuation {
                result.append(RecognizedCaption(text: text, sourceStart: start, sourceEnd: end))
                text = ""
            }
        }
        if !text.isEmpty { result.append(RecognizedCaption(text: text, sourceStart: start, sourceEnd: end)) }
        return result
    }

    private static func extractAudio(
        mediaURL: URL, trimStart: Double, trimDuration: Double
    ) async throws -> URL {
        let source = AVURLAsset(url: mediaURL)
        guard let audio = try await source.loadTracks(withMediaType: .audio).first else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { throw CocoaError(.fileWriteUnknown) }
        try track.insertTimeRange(
            CMTimeRange(
                start: CMTime(seconds: trimStart, preferredTimescale: 600),
                duration: CMTime(seconds: trimDuration, preferredTimescale: 600)
            ),
            of: audio, at: .zero
        )
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("Speech-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        guard let session = AVAssetExportSession(
            asset: composition, presetName: AVAssetExportPresetAppleM4A
        ) else { throw CocoaError(.fileWriteUnknown) }
        session.outputURL = url
        session.outputFileType = .m4a
        await withTaskCancellationHandler {
            await session.export()
        } onCancel: {
            session.cancelExport()
        }
        if Task.isCancelled {
            try? FileManager.default.removeItem(at: url)
            throw CancellationError()
        }
        guard session.status == .completed else {
            try? FileManager.default.removeItem(at: url)
            throw session.error ?? CocoaError(.fileWriteUnknown)
        }
        return url
    }
}
