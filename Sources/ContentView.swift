import SwiftUI
import AVKit
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
#endif

private enum EditorTool: String, CaseIterable, Identifiable {
    case media, edit, transform, color, overlay, text, audio
    var id: String { rawValue }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: EditorModel
    private let onClose: () -> Void
    @ObservedObject private var language = AppLanguage.shared
    @State private var showMediaImporter = false
    @State private var showAudioImporter = false
    @State private var showAudioTrackImporter = false
    @State private var showExportSettings = false
    @State private var activeTool: EditorTool = .media
    @StateObject private var voiceRecorder: VoiceRecorder
    #if os(iOS)
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photoImageItems: [PhotosPickerItem] = []
    #endif

    init(projectID: UUID, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: EditorModel(projectID: projectID))
        _voiceRecorder = StateObject(wrappedValue: VoiceRecorder())
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                editorLayout(size: geometry.size)
            }
            .navigationTitle(model.projectName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { editorToolbar }
        }
        .fileImporter(
            isPresented: $showMediaImporter,
            allowedContentTypes: [
                .movie, .video, .mpeg4Movie, .quickTimeMovie,
                .image, .audio, .mp3, .mpeg4Audio, .wav
            ],
            allowsMultipleSelection: true,
            onCompletion: handleMediaFiles
        )
        .sheet(isPresented: $showExportSettings) {
            ExportSettingsView(model: model) {
                Task { await model.export() }
            }
        }
        .fileImporter(
            isPresented: $showAudioImporter,
            allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav],
            allowsMultipleSelection: false,
            onCompletion: handleAudioFile
        )
        .fileImporter(
            isPresented: $showAudioTrackImporter,
            allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav],
            allowsMultipleSelection: true,
            onCompletion: handleAudioTrackFiles
        )
        #if os(iOS)
        .onChange(of: photoItems) { items in importPhotos(items) }
        .onChange(of: photoImageItems) { items in importPhotoImages(items) }
        #endif
        .onChange(of: scenePhase) { phase in
            if phase != .active {
                model.pausePlayback()
                Task {
                    await finishVoiceRecordingIfNeeded()
                    model.saveProjectNow()
                }
            }
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
            Button {
                Task {
                    await finishVoiceRecordingIfNeeded()
                    model.cancelMediaProcessing()
                    model.pausePlayback()
                    model.saveProjectNow()
                    onClose()
                }
            } label: {
                Label(language.text("草稿", "Drafts"), systemImage: "chevron.left")
            }
            .disabled(model.isBusy)
            Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .disabled(!model.canUndo)
            Button { model.redo() } label: { Image(systemName: "arrow.uturn.forward") }
                .disabled(!model.canRedo)
        }
        ToolbarItemGroup(placement: .navigationBarTrailing) {
            Menu {
                Button("中文") { language.code = "zh-CN" }
                Button("English") { language.code = "en" }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            Button { showExportSettings = true } label: {
                if model.isExporting { ProgressView() }
                else { Label(language.text("导出", "Export"), systemImage: "square.and.arrow.up") }
            }
            .disabled(model.clips.isEmpty || model.isBusy || model.isProcessingMedia || voiceRecorder.isRecording)
        }
    }

    private func previewArea(height: CGFloat) -> some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if model.clips.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "film.stack").font(.system(size: 38))
                        Text(language.text("从相册或“文件”导入视频或图片", "Import video or photos from Photos or Files"))
                            .font(.footnote)
                    }
                    .foregroundStyle(.white.opacity(0.65))
                } else {
                    ZStack {
                        PreviewView(player: model.player)
                        OverlayPreviewView(model: model)
                        if let subtitle = model.activeSubtitle {
                            SubtitlePreviewOverlay(subtitle: subtitle)
                                .allowsHitTesting(false)
                        }
                    }
                    .aspectRatio(
                        model.canvasFormat.renderSize.width / model.canvasFormat.renderSize.height,
                        contentMode: .fit
                    )
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
            } else if model.isRecognizingSpeech {
                Button(role: .destructive) { model.cancelCaptionRecognition() } label: {
                    Label(language.text("取消识别", "Cancel Recognition"), systemImage: "xmark.circle")
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
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(EditorTool.allCases) { tool in
                        Button { activeTool = tool } label: {
                            Label(toolTitle(tool), systemImage: toolIcon(tool))
                                .font(.caption)
                                .padding(.horizontal, 9).padding(.vertical, 6)
                                .background(
                                    activeTool == tool ? Color.accentColor : Color.secondary.opacity(0.12),
                                    in: Capsule()
                                )
                                .foregroundStyle(activeTool == tool ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
            }

            Group {
                switch activeTool {
                case .media: mediaPanel
                case .edit: editPanel
                case .transform: ClipTransformPanel(model: model)
                case .color: ColorPanel(model: model)
                case .overlay: OverlayPanel(model: model)
                case .text: SubtitlePanel(model: model)
                case .audio: audioPanel
                }
            }
            .frame(minHeight: 112, maxHeight: activeTool == .media ? 230 : 340)
        }
        .padding(.vertical, 8)
    }

    private func toolTitle(_ tool: EditorTool) -> String {
        switch tool {
        case .media: return language.text("素材", "Media")
        case .edit: return language.text("剪辑", "Edit")
        case .transform: return language.text("画面", "Transform")
        case .color: return language.text("调色", "Color")
        case .overlay: return language.text("画中画", "Overlay")
        case .text: return language.text("字幕", "Captions")
        case .audio: return language.text("音频", "Audio")
        }
    }

    private func toolIcon(_ tool: EditorTool) -> String {
        switch tool {
        case .media: return "photo.on.rectangle.angled"
        case .edit: return "scissors"
        case .transform: return "viewfinder"
        case .color: return "slider.horizontal.3"
        case .overlay: return "rectangle.on.rectangle"
        case .text: return "captions.bubble"
        case .audio: return "waveform"
        }
    }

    private var mediaPanel: some View {
        VStack(spacing: 8) {
            HStack {
                #if os(iOS)
                PhotosPicker(selection: $photoItems, maxSelectionCount: 20, matching: .videos) {
                    Label(language.text("视频", "Videos"), systemImage: "video")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
                #endif
                #if os(iOS)
                PhotosPicker(selection: $photoImageItems, maxSelectionCount: 20, matching: .images) {
                    Label(language.text("图片", "Photos"), systemImage: "photo")
                }
                .buttonStyle(.bordered)
                .disabled(model.isBusy)
                #endif
                Button { showMediaImporter = true } label: {
                    Label(language.text("媒体文件", "Media Files"), systemImage: "folder")
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
                    .disabled(clip.isReversed && clip.reverseIncludesAudio == false)
                    if clip.kind == .video {
                        Button { model.toggleReverseSelectedClip() } label: {
                            Label(
                                clip.isReversed ? language.text("关闭倒放", "Disable Reverse") : language.text("倒放", "Reverse"),
                                systemImage: "backward.end.alt.fill"
                            )
                        }
                        .buttonStyle(.bordered)
                        if clip.isReversed, let hasAudio = clip.reverseIncludesAudio {
                            Label(
                                hasAudio
                                    ? language.text("音画倒放", "Video + Audio")
                                    : language.text("无原声", "No Source Audio"),
                                systemImage: hasAudio ? "speaker.wave.2.fill" : "speaker.slash.fill"
                            )
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                    Text(language.text("速度", "Speed")).font(.caption)
                    Slider(
                        value: Binding(get: { clip.speed }, set: { model.setSpeed(for: clip, to: $0) }),
                        in: 0.25...4,
                        onEditingChanged: { if $0 { model.beginInteractiveEdit() } }
                    )
                    .disabled(!clip.speedPoints.isEmpty)
                    Text(String(format: "%.2f×", clip.speed)).font(.caption.monospacedDigit()).frame(width: 48)
                }
                .padding(.horizontal, 12)
                .disabled(model.isBusy)
                SpeedCurvePanel(model: model)
            }
            if let transition = model.selectedOutgoingTransition {
                VStack(spacing: 7) {
                    HStack(spacing: 8) {
                        Label(language.text("到下一片段", "To Next Clip"), systemImage: "rectangle.split.2x1")
                            .font(.caption)
                        Picker(language.text("转场", "Transition"), selection: Binding(
                            get: { transition.style }, set: { model.setSelectedTransitionStyle($0) }
                        )) {
                            Text(language.text("无", "None")).tag(TransitionStyle.none)
                            Text(language.text("叠化", "Dissolve")).tag(TransitionStyle.dissolve)
                            Text(language.text("左推", "Push Left")).tag(TransitionStyle.pushLeft)
                            Text(language.text("右推", "Push Right")).tag(TransitionStyle.pushRight)
                        }
                        .pickerStyle(.menu)
                        Spacer()
                    }
                    HStack(spacing: 8) {
                        Text(language.text("时长", "Duration")).font(.caption)
                        Slider(
                            value: Binding(
                                get: { transition.duration },
                                set: { model.setSelectedTransitionDuration($0) }
                            ),
                            in: 0.1...2,
                            onEditingChanged: { editing in
                                if editing { model.beginInteractiveEdit() }
                                else { model.commitSelectedTransitionEdit() }
                            }
                        )
                        .disabled(transition.style == .none)
                        Text(String(format: "%.1fs", transition.duration))
                            .font(.caption.monospacedDigit())
                    }
                }
                .padding(.horizontal, 12)
                .disabled(model.isBusy)
            } else if model.clips.count < 2 {
                Text(language.text("选择时间线片段后可分割、复制或删除", "Select a timeline clip to split, duplicate, or delete"))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(language.text("选择非末尾片段以设置到下一片段的转场", "Select a non-final clip to set its outgoing transition"))
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
            AudioTrackPanel(model: model, recorder: voiceRecorder)
                .environment(\.openAudioTrackImporter, { showAudioTrackImporter = true })
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

    private func handleMediaFiles(_ result: Result<[URL], Error>) {
        if case .success(let urls) = result { Task { await model.importMedia(urls: urls, addToTimeline: false) } }
    }

    private func handleAudioFile(_ result: Result<[URL], Error>) {
        if case .success(let urls) = result, let url = urls.first { Task { await model.importBGM(url: url) } }
    }

    private func handleAudioTrackFiles(_ result: Result<[URL], Error>) {
        if case .success(let urls) = result {
            Task {
                await model.importMedia(
                    urls: urls, kinds: Array(repeating: .audio, count: urls.count), addToTimeline: true
                )
            }
        }
    }

    private func finishVoiceRecordingIfNeeded() async {
        guard let recording = voiceRecorder.stop() else { return }
        await model.importMedia(
            urls: [recording.url], kinds: [.audio],
            sourceIdentifiers: ["voice:\(UUID().uuidString)"],
            displayNames: [language.text("旁白.m4a", "Voice-over.m4a")], addToTimeline: true,
            timelineStart: recording.timelineStart
        )
        try? FileManager.default.removeItem(at: recording.url)
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
            await model.importMedia(
                urls: urls, kinds: Array(repeating: .video, count: urls.count),
                sourceIdentifiers: identifiers, displayNames: names, addToTimeline: false
            )
            urls.forEach { try? FileManager.default.removeItem(at: $0) }
            photoItems = []
        }
    }

    private func importPhotoImages(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            var urls: [URL] = []
            var identifiers: [String] = []
            var names: [String] = []
            for (index, item) in items.enumerated() {
                if let image = try? await item.loadTransferable(type: ImportedImage.self) {
                    let identifier = item.itemIdentifier.map { "photos:\($0)" } ?? image.url.lastPathComponent
                    let fallback = language.isEnglish ? "Photo \(index + 1).jpg" : "相册图片 \(index + 1).jpg"
                    urls.append(image.url)
                    identifiers.append(identifier)
                    names.append(image.name.isEmpty ? fallback : image.name)
                }
            }
            await model.importMedia(
                urls: urls, kinds: Array(repeating: .image, count: urls.count),
                sourceIdentifiers: identifiers, displayNames: names, addToTimeline: false
            )
            urls.forEach { try? FileManager.default.removeItem(at: $0) }
            photoImageItems = []
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

private struct OverlayPreviewView: View {
    @ObservedObject var model: EditorModel
    @State private var isDragging = false

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                ForEach(model.isPlaying ? [] : model.activeOverlays.filter { $0.id == model.selectedOverlayID }) { item in
                    if let asset = model.mediaAsset(id: item.assetID), let image = asset.thumbnail {
                        let displayed = model.displayedOverlay(item)
                        overlayImage(image)
                            .scaledToFit()
                            .frame(
                                width: proxy.size.width * CGFloat(displayed.scale),
                                height: proxy.size.height * CGFloat(displayed.scale)
                            )
                            .rotationEffect(.degrees(displayed.rotation))
                            .opacity(displayed.opacity)
                            .overlay {
                                if model.selectedOverlayID == item.id {
                                    RoundedRectangle(cornerRadius: 5)
                                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [5, 3]))
                                }
                            }
                            .position(
                                x: proxy.size.width * CGFloat(displayed.x),
                                y: proxy.size.height * CGFloat(displayed.y)
                            )
                            .gesture(
                                DragGesture(minimumDistance: 0, coordinateSpace: .named("overlayCanvas"))
                                    .onChanged { value in
                                        if !isDragging {
                                            isDragging = true
                                            model.beginInteractiveEdit()
                                        }
                                        model.updateOverlay(
                                            item,
                                            x: Double(value.location.x / max(1, proxy.size.width)),
                                            y: Double(value.location.y / max(1, proxy.size.height))
                                        )
                                    }
                                    .onEnded { _ in isDragging = false }
                            )
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .coordinateSpace(name: "overlayCanvas")
        }
    }

    @ViewBuilder private func overlayImage(_ image: PlatformImage) -> some View {
        #if os(iOS)
        Image(uiImage: image).resizable()
        #else
        Image(nsImage: image).resizable()
        #endif
    }
}

private struct SubtitlePreviewOverlay: View {
    let subtitle: SubtitleItem

    var body: some View {
        GeometryReader { proxy in
            VStack {
                Spacer()
                Text(subtitle.text)
                    .font(subtitle.style == .center ? .title2.bold() : .headline.bold())
                    .foregroundStyle(subtitle.style == .highlight ? Color.yellow : Color.white)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .minimumScaleFactor(0.55)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.42), in: RoundedRectangle(cornerRadius: 7))
                    .shadow(color: .black.opacity(0.9), radius: 2, y: 1)
                    .frame(maxWidth: proxy.size.width * 0.84)
                if subtitle.style == .center { Spacer() }
            }
            .padding(.bottom, subtitle.style == .center ? 0 : proxy.size.height * 0.07)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
