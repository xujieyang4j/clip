import SwiftUI
import AVKit
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
#endif

private enum EditorTool: String, CaseIterable, Identifiable {
    case media, edit, audio
    var id: String { rawValue }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = EditorModel()
    @ObservedObject private var language = AppLanguage.shared
    @State private var showVideoImporter = false
    @State private var showAudioImporter = false
    @State private var showNewProjectConfirmation = false
    @State private var activeTool: EditorTool = .media
    #if os(iOS)
    @State private var photoItems: [PhotosPickerItem] = []
    #endif

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                editorLayout(size: geometry.size)
            }
            .navigationTitle("MiniClip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { editorToolbar }
        }
        .fileImporter(
            isPresented: $showVideoImporter,
            allowedContentTypes: [.movie, .video, .mpeg4Movie, .quickTimeMovie],
            allowsMultipleSelection: true,
            onCompletion: handleVideoFiles
        )
        .fileImporter(
            isPresented: $showAudioImporter,
            allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav],
            allowsMultipleSelection: false,
            onCompletion: handleAudioFile
        )
        #if os(iOS)
        .onChange(of: photoItems) { items in importPhotos(items) }
        #endif
        .onChange(of: scenePhase) { phase in
            if phase != .active {
                model.pausePlayback()
                model.saveProjectNow()
            }
        }
        .confirmationDialog(
            language.text("新建项目会清空当前时间线和素材库。", "A new project clears the current timeline and media library."),
            isPresented: $showNewProjectConfirmation, titleVisibility: .visible
        ) {
            Button(language.text("新建项目", "New Project"), role: .destructive) { model.startNewProject() }
            Button(language.text("取消", "Cancel"), role: .cancel) {}
        }
    }

    @ViewBuilder private func editorLayout(size: CGSize) -> some View {
        if size.width > size.height {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    previewArea(height: max(190, size.height - 48))
                    statusBar
                }
                .frame(width: size.width * 0.46)
                Divider()
                VStack(spacing: 0) {
                    toolPanel
                    Divider()
                    timeline
                }
            }
        } else {
            VStack(spacing: 0) {
                previewArea(height: min(size.height * 0.34, size.width * 9 / 16 + 68))
                statusBar
                Divider()
                toolPanel
                Divider()
                timeline
            }
        }
    }

    private var timeline: some View {
        TimelineView(model: model)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(platformBackground)
    }

    @ToolbarContentBuilder private var editorToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .navigationBarLeading) {
            Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .disabled(!model.canUndo)
            Button { model.redo() } label: { Image(systemName: "arrow.uturn.forward") }
                .disabled(!model.canRedo)
        }
        ToolbarItemGroup(placement: .navigationBarTrailing) {
            Menu {
                Button("中文") { language.code = "zh-CN" }
                Button("English") { language.code = "en" }
                Divider()
                Button(role: .destructive) { showNewProjectConfirmation = true } label: {
                    Label(language.text("新建项目", "New Project"), systemImage: "doc.badge.plus")
                }
                .disabled(model.isBusy)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            Button { Task { await model.export() } } label: {
                if model.isExporting { ProgressView() }
                else { Label(language.text("导出", "Export"), systemImage: "square.and.arrow.up") }
            }
            .disabled(model.clips.isEmpty || model.isBusy)
        }
    }

    private func previewArea(height: CGFloat) -> some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if model.clips.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "film.stack").font(.system(size: 38))
                        Text(language.text("从相册或“文件”导入视频", "Import video from Photos or Files"))
                            .font(.footnote)
                    }
                    .foregroundStyle(.white.opacity(0.65))
                } else {
                    PreviewView(player: model.player)
                        .aspectRatio(model.canvasFormat.renderSize.width / model.canvasFormat.renderSize.height, contentMode: .fit)
                }
            }
            playbackBar
        }
        .frame(height: max(190, height))
        .background(Color.black)
    }

    private var playbackBar: some View {
        HStack(spacing: 12) {
            Button { model.togglePlayback() } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 24)
            }
            .disabled(model.clips.isEmpty)
            Text(formatTime(model.playheadSeconds))
                .monospacedDigit().font(.caption)
            Slider(
                value: Binding(get: { model.playheadSeconds }, set: { model.seek(to: $0) }),
                in: 0...max(0.01, model.timelineDuration)
            )
            .disabled(model.clips.isEmpty)
            Text(formatTime(model.timelineDuration))
                .monospacedDigit().font(.caption)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Color.black.opacity(0.96))
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            Text(model.statusMessage)
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Spacer()
            if model.isExporting {
                Button(role: .destructive) { model.cancelExport() } label: {
                    Label(language.text("取消", "Cancel"), systemImage: "xmark.circle")
                }
                .font(.caption)
            } else if let url = model.exportedURL {
                #if os(iOS)
                Button { Task { await model.saveExportToPhotos() } } label: {
                    Label(language.text("存相册", "Save"), systemImage: "photo.badge.arrow.down")
                }
                .font(.caption)
                #endif
                ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .overlay(alignment: .bottomLeading) {
            if model.isExporting {
                ProgressView(value: model.exportProgress).progressViewStyle(.linear)
            } else if model.isImporting {
                ProgressView(value: model.importProgress).progressViewStyle(.linear)
            }
        }
    }

    private var toolPanel: some View {
        VStack(spacing: 8) {
            Picker(language.text("编辑工具", "Editing tools"), selection: $activeTool) {
                Label(language.text("素材", "Media"), systemImage: "photo.on.rectangle.angled").tag(EditorTool.media)
                Label(language.text("剪辑", "Edit"), systemImage: "scissors").tag(EditorTool.edit)
                Label(language.text("音频", "Audio"), systemImage: "waveform").tag(EditorTool.audio)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 12)

            Group {
                switch activeTool {
                case .media: mediaPanel
                case .edit: editPanel
                case .audio: audioPanel
                }
            }
            .frame(minHeight: 112, maxHeight: 210)
        }
        .padding(.vertical, 8)
    }

    private var mediaPanel: some View {
        VStack(spacing: 8) {
            HStack {
                #if os(iOS)
                PhotosPicker(selection: $photoItems, maxSelectionCount: 20, matching: .videos) {
                    Label(language.text("相册", "Photos"), systemImage: "photo.on.rectangle")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
                #endif
                Button { showVideoImporter = true } label: {
                    Label(language.text("文件", "Files"), systemImage: "folder")
                }
                .buttonStyle(.bordered)
                .disabled(model.isBusy)
                Spacer()
                Text(language.isEnglish ? "\(model.mediaAssets.count) items" : "\(model.mediaAssets.count) 个素材")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            MediaLibraryView(model: model)
        }
    }

    private var editPanel: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                toolButton(language.text("分割", "Split"), "scissors") { model.splitSelectedClipAtPlayhead() }
                toolButton(language.text("复制", "Duplicate"), "plus.square.on.square") { model.duplicateSelectedClip() }
                toolButton(language.text("删除", "Delete"), "trash", destructive: true) { model.deleteSelectedClip() }
            }
            .disabled(model.selectedClip == nil || model.isBusy)
            HStack(spacing: 8) {
                Text(language.text("画布", "Canvas")).font(.caption)
                Picker(language.text("画布比例", "Canvas Ratio"), selection: Binding(
                    get: { model.canvasFormat }, set: { model.setCanvasFormat($0) }
                )) {
                    ForEach(CanvasFormat.allCases) { format in Text(format.rawValue).tag(format) }
                }
                .pickerStyle(.segmented)
            }
            .padding(.horizontal, 12)
            .disabled(model.isBusy)
            if let clip = model.selectedClip {
                HStack(spacing: 8) {
                    Button { model.toggleMuteSelectedClip() } label: {
                        Label(
                            clip.isMuted ? language.text("恢复原声", "Unmute") : language.text("静音", "Mute"),
                            systemImage: clip.isMuted ? "speaker.wave.2" : "speaker.slash"
                        )
                    }
                    .buttonStyle(.bordered)
                    Text(language.text("速度", "Speed")).font(.caption)
                    Slider(
                        value: Binding(get: { clip.speed }, set: { model.setSpeed(for: clip, to: $0) }),
                        in: 0.25...4,
                        onEditingChanged: { if $0 { model.beginInteractiveEdit() } }
                    )
                    Text(String(format: "%.2f×", clip.speed)).font(.caption.monospacedDigit()).frame(width: 48)
                }
                .padding(.horizontal, 12)
                .disabled(model.isBusy)
            }
            if model.clips.count >= 2 {
                HStack(spacing: 8) {
                    Label(language.text("叠化", "Dissolve"), systemImage: "wand.and.stars").font(.caption)
                    Slider(
                        value: Binding(get: { model.transitionDuration }, set: { model.setTransition($0) }),
                        in: 0...2,
                        onEditingChanged: { if $0 { model.beginInteractiveEdit() } }
                    )
                    Text(String(format: "%.1fs", model.transitionDuration)).font(.caption.monospacedDigit())
                }
                .padding(.horizontal, 12)
                .disabled(model.isBusy)
            } else {
                Text(language.text("选择时间线片段后可分割、复制或删除", "Select a timeline clip to split, duplicate, or delete"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var audioPanel: some View {
        VStack(spacing: 8) {
            HStack {
                Button { showAudioImporter = true } label: {
                    Label(model.bgmName == nil ? language.text("添加音乐", "Add Music") : language.text("更换音乐", "Change Music"), systemImage: "music.note")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
                if model.bgmName != nil {
                    Button(role: .destructive) { model.removeBGM() } label: { Image(systemName: "xmark.circle") }
                        .disabled(model.isBusy)
                }
                Spacer()
                Text(model.bgmName ?? language.text("未添加背景音乐", "No background music"))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            volumeSlider(language.text("原声", "Original"), value: Binding(get: { model.originalVolume }, set: { model.setOriginalVolume($0) }))
                .disabled(model.isBusy)
            volumeSlider(language.text("音乐", "Music"), value: Binding(get: { model.bgmVolume }, set: { model.setBGMVolume($0) }))
                .disabled(model.bgmURL == nil || model.isBusy)
        }
        .padding(.horizontal, 12)
    }

    private func toolButton(_ title: String, _ icon: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            VStack(spacing: 4) { Image(systemName: icon).font(.title3); Text(title).font(.caption) }
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    private func volumeSlider(_ title: String, value: Binding<Double>) -> some View {
        HStack {
            Text(title).font(.caption).frame(width: 38, alignment: .leading)
            Slider(value: value, in: 0...1, onEditingChanged: { if $0 { model.beginInteractiveEdit() } })
            Text(String(format: "%.0f%%", value.wrappedValue * 100)).font(.caption.monospacedDigit()).frame(width: 42)
        }
    }

    private func handleVideoFiles(_ result: Result<[URL], Error>) {
        if case .success(let urls) = result { Task { await model.importVideos(urls: urls, addToTimeline: false) } }
    }

    private func handleAudioFile(_ result: Result<[URL], Error>) {
        if case .success(let urls) = result, let url = urls.first { Task { await model.importBGM(url: url) } }
    }

    #if os(iOS)
    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            var urls: [URL] = []
            var identifiers: [String] = []
            var names: [String] = []
            for (index, item) in items.enumerated() {
                if let video = try? await item.loadTransferable(type: ImportedVideo.self) {
                    let identifier = item.itemIdentifier.map { "photos:\($0)" } ?? video.url.lastPathComponent
                    let fallback = language.isEnglish ? "Photo Video \(index + 1).mov" : "相册视频 \(index + 1).mov"
                    urls.append(video.url)
                    identifiers.append(identifier)
                    names.append(video.name.isEmpty ? fallback : video.name)
                }
            }
            await model.importVideos(urls: urls, sourceIdentifiers: identifiers, displayNames: names, addToTimeline: false)
            urls.forEach { try? FileManager.default.removeItem(at: $0) }
            photoItems = []
        }
    }
    #endif

    private func formatTime(_ seconds: Double) -> String {
        let value = max(0, seconds.isFinite ? seconds : 0)
        return String(format: "%d:%02d.%d", Int(value) / 60, Int(value) % 60, Int(value * 10) % 10)
    }

    private var platformBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemBackground)
        #else
        Color(nsColor: .underPageBackgroundColor)
        #endif
    }
}

struct PreviewView: View {
    let player: AVPlayer
    var body: some View { VideoPlayer(player: player) }
}
