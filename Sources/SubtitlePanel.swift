import SwiftUI

struct SubtitlePanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    @State private var showImporter = false
    @State private var showExporter = false
    @State private var exportDocument = SubtitleDocument()
    @State private var draftText = ""
    @State private var editingSubtitleID: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    model.addSubtitle()
                    syncDraft()
                } label: {
                    Label(language.text("添加字幕", "Add Caption"), systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.clips.isEmpty)
                Button { model.startGeneratingCaptionsForSelectedClip() } label: {
                    if model.isRecognizingSpeech { ProgressView() }
                    else { Label(language.text("自动字幕", "Auto Captions"), systemImage: "waveform.and.mic") }
                }
                .buttonStyle(.bordered)
                .disabled(model.selectedClip?.kind != .video || model.isRecognizingSpeech)
                Button { showImporter = true } label: {
                    Label(language.text("导入 SRT", "Import SRT"), systemImage: "doc.badge.plus")
                }
                .buttonStyle(.bordered)
                Button {
                    exportDocument = SubtitleDocument(text: SubtitleSRT.encode(subtitles: model.subtitles))
                    showExporter = true
                } label: {
                    Label(language.text("导出 SRT", "Export SRT"), systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
                .disabled(model.subtitles.isEmpty)
            }

            if model.subtitles.isEmpty {
                Text(language.text("在播放头添加字幕，或导入标准 SRT 文件。",
                                   "Add a caption at the playhead or import a standard SRT file."))
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.subtitles) { item in
                            Button {
                                model.selectSubtitle(item)
                                syncDraft()
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.text.replacingOccurrences(of: "\n", with: " "))
                                        .lineLimit(1)
                                    Text(String(format: "%.1f–%.1fs", item.start, item.end))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 6)
                                .background(model.selectedSubtitleID == item.id ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.10))
                                .clipShape(RoundedRectangle(cornerRadius: 7))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            if let subtitle = model.selectedSubtitle {
                HStack {
                    TextField(language.text("字幕内容", "Caption Text"), text: $draftText)
                        .textFieldStyle(.roundedBorder)
                    Button(language.text("应用", "Apply")) {
                        model.beginInteractiveEdit()
                        model.updateSubtitle(subtitle, text: draftText)
                    }
                    .buttonStyle(.bordered)
                    .disabled(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(role: .destructive) { model.deleteSelectedSubtitle() } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.bordered)
                }

                HStack(spacing: 8) {
                    Text(language.text("开始", "Start")).font(.caption)
                    Slider(value: Binding(
                        get: { subtitle.start },
                        set: { model.updateSubtitle(subtitle, start: $0) }
                    ), in: 0...max(0.1, model.timelineDuration), onEditingChanged: {
                        if $0 { model.beginInteractiveEdit() }
                    })
                    Text(String(format: "%.1f", subtitle.start)).font(.caption.monospacedDigit()).frame(width: 34)
                    Text(language.text("结束", "End")).font(.caption)
                    Slider(value: Binding(
                        get: { subtitle.end },
                        set: { model.updateSubtitle(subtitle, end: $0) }
                    ), in: 0...max(0.1, model.timelineDuration), onEditingChanged: {
                        if $0 { model.beginInteractiveEdit() }
                    })
                    Text(String(format: "%.1f", subtitle.end)).font(.caption.monospacedDigit()).frame(width: 34)
                }

                Picker(language.text("样式", "Style"), selection: Binding(
                    get: { subtitle.style },
                    set: { style in
                        model.beginInteractiveEdit()
                        model.updateSubtitle(subtitle, style: style)
                    }
                )) {
                    Text(language.text("经典白字", "Classic")).tag(SubtitleStylePreset.classic)
                    Text(language.text("黄色强调", "Highlight")).tag(SubtitleStylePreset.highlight)
                    Text(language.text("居中大字", "Large Center")).tag(SubtitleStylePreset.center)
                }
                .pickerStyle(.segmented)
            }
        }
        .padding(.horizontal, 12)
        .disabled(model.isBusy)
        .onAppear(perform: syncDraft)
        .onChange(of: model.selectedSubtitleID) { _ in syncDraft() }
        .fileImporter(
            isPresented: $showImporter, allowedContentTypes: [.subRipSubtitle, .plainText],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                model.replaceSubtitles(with: try SubtitleSRT.decode(Data(contentsOf: url)))
                syncDraft()
            } catch {
                model.statusMessage = language.isEnglish
                    ? "SRT import failed: \(error.localizedDescription)"
                    : "SRT 导入失败：\(error.localizedDescription)"
            }
        }
        .fileExporter(
            isPresented: $showExporter, document: exportDocument, contentType: .subRipSubtitle,
            defaultFilename: safeFilename
        ) { result in
            switch result {
            case .success:
                model.statusMessage = language.text("SRT 已导出", "SRT exported")
            case .failure(let error):
                model.statusMessage = language.isEnglish
                    ? "SRT export failed: \(error.localizedDescription)"
                    : "SRT 导出失败：\(error.localizedDescription)"
            }
        }
    }

    private func syncDraft() {
        guard editingSubtitleID != model.selectedSubtitleID else { return }
        editingSubtitleID = model.selectedSubtitleID
        draftText = model.selectedSubtitle?.text ?? ""
    }

    private var safeFilename: String {
        let invalid = CharacterSet(charactersIn: "/:*?\"<>|")
        let name = model.projectName.components(separatedBy: invalid).joined(separator: "-")
        return (name.isEmpty ? "captions" : name) + ".srt"
    }
}
