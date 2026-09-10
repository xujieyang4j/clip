import AVFoundation
import SwiftUI

private struct OpenAudioTrackImporterKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    var openAudioTrackImporter: () -> Void {
        get { self[OpenAudioTrackImporterKey.self] }
        set { self[OpenAudioTrackImporterKey.self] = newValue }
    }
}

struct AudioTrackPanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject var recorder: VoiceRecorder
    @ObservedObject private var language = AppLanguage.shared
    @Environment(\.openAudioTrackImporter) private var openImporter

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Button(action: openImporter) {
                    Label(language.text("导入音频轨", "Import Audio"), systemImage: "waveform.badge.plus")
                }.buttonStyle(.bordered)
                Button(action: toggleRecording) {
                    Label(
                        recorder.isRecording ? language.text("停止旁白", "Stop Voice-over") : language.text("录制旁白", "Voice-over"),
                        systemImage: recorder.isRecording ? "stop.circle.fill" : "mic.circle"
                    )
                }
                .buttonStyle(.bordered)
                .tint(recorder.isRecording ? .red : .accentColor)
                Button { Task { await model.detachSelectedClipAudio() } } label: {
                    Label(language.text("分离原声", "Detach Audio"), systemImage: "waveform.path.badge.minus")
                }.buttonStyle(.bordered).disabled(model.selectedClip?.kind != .video)
            }

            if !model.audioTracks.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.audioTracks) { item in
                            Button { model.selectAudioTrack(item) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(model.mediaAsset(id: item.assetID)?.name ?? language.text("失效音频", "Missing Audio"))
                                        .lineLimit(1)
                                    Text(String(format: "%.1f–%.1fs", item.start, item.start + item.duration))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(model.selectedAudioTrackID == item.id ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.10))
                                .clipShape(RoundedRectangle(cornerRadius: 7))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }

            if let item = model.selectedAudioTrack {
                HStack(spacing: 6) {
                    Text(language.text("音量", "Volume")).font(.caption)
                    Slider(value: Binding(get: { item.volume }, set: { model.updateAudioTrack(item, volume: $0) }),
                           in: 0...1, onEditingChanged: { if $0 { model.beginInteractiveEdit() } })
                    Text(String(format: "%.0f%%", item.volume * 100)).font(.caption.monospacedDigit()).frame(width: 46)
                    Button { model.updateAudioTrack(item, isMuted: !item.isMuted) } label: {
                        Image(systemName: item.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    }.buttonStyle(.bordered)
                    Button(role: .destructive) { model.deleteSelectedAudioTrack() } label: { Image(systemName: "trash") }
                        .buttonStyle(.bordered)
                }
                HStack(spacing: 6) {
                    labeledSlider(language.text("位置", "Start"), value: item.start, range: 0...max(0.1, model.timelineDuration)) {
                        model.updateAudioTrack(item, start: $0)
                    }
                    labeledSlider(language.text("时长", "Length"), value: item.duration, range: 0.05...max(0.1, model.timelineDuration)) {
                        model.updateAudioTrack(item, duration: $0)
                    }
                }
                HStack(spacing: 6) {
                    labeledSlider(language.text("淡入", "Fade In"), value: item.fadeIn, range: 0...max(0.1, item.duration / 2)) {
                        model.updateAudioTrack(item, fadeIn: $0)
                    }
                    labeledSlider(language.text("淡出", "Fade Out"), value: item.fadeOut, range: 0...max(0.1, item.duration / 2)) {
                        model.updateAudioTrack(item, fadeOut: $0)
                    }
                }
                if let asset = model.mediaAsset(id: item.assetID) {
                    labeledSlider(
                        language.text("源起点", "Source"), value: item.sourceStart,
                        range: 0...max(0.1, asset.duration - item.duration * max(0.25, item.speed ?? 1))
                    ) { model.updateAudioTrack(item, sourceStart: $0) }
                }
            }
        }
        .disabled(model.isBusy && !recorder.isRecording)
    }

    private func labeledSlider(
        _ title: String, value: Double, range: ClosedRange<Double>, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).frame(width: 36, alignment: .leading)
            Slider(value: Binding(get: { value }, set: onChange), in: range,
                   onEditingChanged: { if $0 { model.beginInteractiveEdit() } })
        }
    }

    private func toggleRecording() {
        if recorder.isRecording {
            guard let recording = recorder.stop() else { return }
            Task {
                await model.importMedia(
                    urls: [recording.url], kinds: [.audio],
                    sourceIdentifiers: ["voice:\(UUID().uuidString)"],
                    displayNames: [language.text("旁白.m4a", "Voice-over.m4a")], addToTimeline: true,
                    timelineStart: recording.timelineStart
                )
                try? FileManager.default.removeItem(at: recording.url)
            }
        } else {
            guard model.timelineDuration > 0 else {
                model.statusMessage = language.text("请先添加主轨视频或图片", "Add main-track video or photos first")
                return
            }
            Task {
                do {
                    model.pausePlayback()
                    try await recorder.start(at: model.playheadSeconds)
                }
                catch {
                    model.statusMessage = language.isEnglish
                        ? "Could not record: \(error.localizedDescription)"
                        : "无法录制旁白：\(error.localizedDescription)"
                }
            }
        }
    }
}

struct RecordedVoice {
    let url: URL
    let timelineStart: Double
}

@MainActor
final class VoiceRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published var isRecording = false
    private var recorder: AVAudioRecorder?
    private var outputURL: URL?
    private var timelineStart: Double = 0

    func start(at timelineStart: Double) async throws {
        guard !isRecording else { return }
        let allowed = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard allowed else { throw CocoaError(.userCancelled) }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("Voice-\(UUID().uuidString)").appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self
        recorder.prepareToRecord()
        guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
        self.recorder = recorder
        outputURL = url
        self.timelineStart = max(0, timelineStart)
        isRecording = true
    }

    func stop() -> RecordedVoice? {
        guard isRecording else { return nil }
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer { outputURL = nil }
        return outputURL.map { RecordedVoice(url: $0, timelineStart: timelineStart) }
    }

}
