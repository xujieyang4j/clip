import Foundation
import AVFoundation
import CoreImage
import QuartzCore
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
import Photos
typealias PlatformImage = UIImage
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
#else
import AppKit
typealias PlatformImage = NSImage
typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
#endif

enum CanvasFormat: String, CaseIterable, Identifiable {
    case portrait = "9:16"
    case landscape = "16:9"
    case square = "1:1"

    var id: String { rawValue }

    var renderSize: CGSize {
        switch self {
        case .portrait: return CGSize(width: 1080, height: 1920)
        case .landscape: return CGSize(width: 1920, height: 1080)
        case .square: return CGSize(width: 1080, height: 1080)
        }
    }

    func renderSize(for resolution: ExportResolution) -> CGSize {
        let shortEdge = CGFloat(resolution.shortEdge)
        switch self {
        case .portrait: return CGSize(width: shortEdge, height: shortEdge * 16 / 9)
        case .landscape: return CGSize(width: shortEdge * 16 / 9, height: shortEdge)
        case .square: return CGSize(width: shortEdge, height: shortEdge)
        }
    }
}

enum ExportResolution: String, CaseIterable, Identifiable {
    case hd = "720p"
    case fullHD = "1080p"
    case twoK = "2K"
    case fourK = "4K"

    var id: String { rawValue }
    var shortEdge: Int {
        switch self {
        case .hd: return 720
        case .fullHD: return 1080
        case .twoK: return 1440
        case .fourK: return 2160
        }
    }
}

enum ExportQuality: String, CaseIterable, Identifiable {
    case draft, standard, high
    var id: String { rawValue }
}

/// One reusable source video in the project's media library.
struct MediaAsset: Identifiable, Equatable {
    let id: UUID
    let url: URL
    let name: String
    let duration: Double
    let sourceIdentifier: String
    let kind: MediaKind
    let proxyURL: URL?
    var thumbnail: PlatformImage?

    static func == (lhs: MediaAsset, rhs: MediaAsset) -> Bool { lhs.id == rhs.id }
}

/// One trimmed use of a source video that sits on the timeline.
struct Clip: Identifiable, Equatable {
    let id: UUID
    let assetID: UUID
    let url: URL
    let kind: MediaKind
    /// Full duration of the source file (seconds).
    let sourceDuration: Double
    /// Trim in-point (seconds from start of source).
    var trimStart: Double
    /// Trim out-point (seconds from start of source).
    var trimEnd: Double
    /// Playback speed. The exported duration is source trim duration / speed.
    var speed: Double
    var isMuted: Bool
    var colorAdjustments: ColorAdjustments
    var effectURL: URL?
    var speedPoints: [SpeedPoint]
    var isReversed: Bool
    var reverseURL: URL?
    var reverseIncludesAudio: Bool?
    /// Legacy state used by video-only reverse proxies; cleared after upgrade.
    var muteBeforeReverse: Bool?
    var lutURL: URL?
    var lutName: String?
    var lutIntensity: Double
    var transform: ClipTransform = ClipTransform()
    var transformKeyframes: [ClipTransformKeyframe] = []
    var visualEffects: ClipVisualEffects = ClipVisualEffects()
    var outgoingTransition: ClipTransition = ClipTransition()
    /// Small preview image for the timeline card.
    var thumbnail: PlatformImage?

    /// How long this clip plays after trimming.
    var sourceTrimDuration: Double { max(0, trimEnd - trimStart) }
    var trimmedDuration: Double {
        TimelineMath.speedCurveDuration(
            sourceDuration: sourceTrimDuration, baseSpeed: speed, points: speedPoints
        )
    }
    var playbackURL: URL { effectURL ?? reverseURL ?? url }
    var hasConfiguredLUT: Bool { lutName != nil || lutURL != nil }
    var hasActiveLUT: Bool { hasConfiguredLUT && lutIntensity > 0.001 }
    var hasMissingLUT: Bool { hasActiveLUT && lutURL == nil }
    var hasColorEffect: Bool {
        !colorAdjustments.isIdentity || hasActiveLUT || !visualEffects.isIdentity
    }

    static func == (lhs: Clip, rhs: Clip) -> Bool { lhs.id == rhs.id }
}

/// Immutable capture of everything the user can edit. Pushed onto the
/// undo/redo stacks so any edit can be rolled back.
struct EditorSnapshot {
    var mediaAssets: [MediaAsset]
    var clips: [Clip]
    var bgmURL: URL?
    var bgmName: String?
    var originalVolume: Double
    var bgmVolume: Double
    var transitionDuration: Double
    var canvasFormat: CanvasFormat
    var subtitles: [SubtitleItem]
    var overlays: [OverlayItem]
    var audioTracks: [AudioTrackItem]
}

/// Holds all editor state and does the AVFoundation heavy lifting.
/// Marked @MainActor so every published change happens on the UI thread.
@MainActor
final class EditorModel: ObservableObject {
    let projectID: UUID
    @Published var projectName: String = "未命名项目"
    @Published var mediaAssets: [MediaAsset] = []
    @Published var clips: [Clip] = []
    @Published var selectedClipID: UUID?
    @Published var selectedSpeedPointID: UUID?
    @Published var exportedURL: URL?
    @Published var isImporting = false
    @Published var importProgress: Double = 0
    @Published var isExporting = false
    @Published var exportProgress: Double = 0
    @Published var statusMessage: String = AppLanguage.shared.text("导入一段视频开始", "Import a video to get started")
    @Published var playheadSeconds: Double = 0
    @Published var isPlaying = false
    @Published private(set) var isLoadingProject = true
    @Published var isRecognizingSpeech = false
    @Published private(set) var isProcessingMedia = false

    var isBusy: Bool { isLoadingProject || isImporting || isExporting || isRecognizingSpeech }

    // MARK: - Background music
    /// Optional background music track. Loops to cover the whole timeline.
    @Published var bgmURL: URL?
    @Published var bgmName: String?
    /// Volume of the clips' own audio, 0…1.
    @Published var originalVolume: Double = 1.0
    /// Volume of the background music, 0…1.
    @Published var bgmVolume: Double = 0.5

    // MARK: - Transition
    /// Legacy global dissolve retained only for decoding and resaving projects
    /// created before transitions became per-boundary clip metadata.
    @Published var transitionDuration: Double = 0
    @Published var canvasFormat: CanvasFormat = .portrait
    @Published var exportResolution: ExportResolution = .fullHD
    @Published var exportFrameRate: Int = 30
    @Published var exportQuality: ExportQuality = .standard
    @Published var subtitles: [SubtitleItem] = []
    @Published var selectedSubtitleID: UUID?
    @Published var overlays: [OverlayItem] = []
    @Published var selectedOverlayID: UUID?
    @Published var audioTracks: [AudioTrackItem] = []
    @Published var selectedAudioTrackID: UUID?

    // MARK: - Undo / redo
    /// Past states, most recent last. Populated before each edit.
    private var undoStack: [EditorSnapshot] = []
    /// States that were undone and can be reapplied.
    private var redoStack: [EditorSnapshot] = []
    private let maxHistory = 50
    @Published var canUndo = false
    @Published var canRedo = false

    /// The player the preview view observes. We swap its item when clips change.
    let player = AVPlayer()
    private var wantsPlayback = false
    private var previewGeneration = 0
    private var colorRenderTasks: [UUID: Task<Void, Never>] = [:]
    private var colorRenderTokens: [UUID: UUID] = [:]
    private var reverseRenderTasks: [UUID: Task<Void, Never>] = [:]
    private var reverseRenderTokens: [UUID: UUID] = [:]
    private var derivedMediaRepairTask: Task<Void, Never>?
    private var speechRecognitionTask: Task<Void, Never>?
    private var mediaProcessingTokens: Set<UUID> = []
    private var playerTimeObserver: Any?
    private var playerEndObserver: NSObjectProtocol?

    /// The in-flight preview rebuild. Cancelled and replaced whenever a newer
    /// edit arrives so rapid changes don't pile up concurrent recompositions.
    private var previewTask: Task<Void, Never>?
    private var autosaveTask: Task<Void, Never>?
    private var activeExportSession: AVAssetExportSession?
    private var projectCreatedAt = Date()
    private var coverPath: String?
    private var canPersistProject = false
    #if os(iOS)
    private var exportBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    #endif

    init(projectID: UUID) {
        self.projectID = projectID
        playerTimeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let seconds = CMTimeGetSeconds(time)
                if seconds.isFinite { self.playheadSeconds = max(0, seconds) }
                self.isPlaying = self.wantsPlayback
            }
        }
        playerEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] note in
            Task { @MainActor [weak self] in
                guard let self, let ended = note.object as? AVPlayerItem, ended === self.player.currentItem else { return }
                self.wantsPlayback = false
                self.player.pause()
                self.isPlaying = false
                self.seek(to: 0)
                self.schedulePreviewRebuild(debounceMillis: 0)
            }
        }
        Task { [weak self] in await self?.restoreProject() }
    }

    deinit {
        if let playerTimeObserver { player.removeTimeObserver(playerTimeObserver) }
        if let playerEndObserver { NotificationCenter.default.removeObserver(playerEndObserver) }
    }

    // MARK: - History

    /// Snapshot of the current editable state.
    private func currentSnapshot() -> EditorSnapshot {
        EditorSnapshot(mediaAssets: mediaAssets,
                       clips: clips,
                       bgmURL: bgmURL,
                       bgmName: bgmName,
                       originalVolume: originalVolume,
                       bgmVolume: bgmVolume,
                       transitionDuration: transitionDuration,
                       canvasFormat: canvasFormat,
                       subtitles: subtitles, overlays: overlays, audioTracks: audioTracks)
    }

    private func beginMediaProcessing() -> UUID {
        let token = UUID()
        mediaProcessingTokens.insert(token)
        isProcessingMedia = true
        return token
    }

    private func endMediaProcessing(_ token: UUID) {
        mediaProcessingTokens.remove(token)
        isProcessingMedia = !mediaProcessingTokens.isEmpty
    }

    func cancelMediaProcessing() {
        colorRenderTasks.values.forEach { $0.cancel() }
        reverseRenderTasks.values.forEach { $0.cancel() }
        derivedMediaRepairTask?.cancel()
        speechRecognitionTask?.cancel()
        colorRenderTasks.removeAll()
        colorRenderTokens.removeAll()
        reverseRenderTasks.removeAll()
        reverseRenderTokens.removeAll()
        mediaProcessingTokens.removeAll()
        isProcessingMedia = false
    }

    private func finishColorRender(clipID: UUID, token: UUID) {
        if colorRenderTokens[clipID] == token {
            colorRenderTasks[clipID] = nil
            colorRenderTokens[clipID] = nil
        }
        endMediaProcessing(token)
    }

    private func finishReverseRender(clipID: UUID, token: UUID) {
        if reverseRenderTokens[clipID] == token {
            reverseRenderTasks[clipID] = nil
            reverseRenderTokens[clipID] = nil
        }
        endMediaProcessing(token)
    }

    /// Records the current state so the *next* mutation can be undone.
    /// Call this immediately before applying an edit. Clears the redo stack,
    /// because branching history off an old state discards the redone future.
    private func recordUndo() {
        undoStack.append(currentSnapshot())
        if undoStack.count > maxHistory { undoStack.removeFirst() }
        redoStack.removeAll()
        refreshHistoryFlags()
    }

    /// Overwrites live state from a snapshot (used by undo/redo).
    private func apply(_ s: EditorSnapshot) {
        mediaAssets = s.mediaAssets
        clips = s.clips
        bgmURL = s.bgmURL
        bgmName = s.bgmName
        originalVolume = s.originalVolume
        bgmVolume = s.bgmVolume
        transitionDuration = s.transitionDuration
        canvasFormat = s.canvasFormat
        subtitles = s.subtitles
        overlays = s.overlays
        audioTracks = s.audioTracks
        normalizeSubtitleSelection()
        normalizeOverlaySelection()
        normalizeAudioTrackSelection()
        normalizeSelection()
        normalizeSpeedPointSelection()
    }

    private func refreshHistoryFlags() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
    }

    private func normalizeSelection() {
        if !clips.contains(where: { $0.id == selectedClipID }) {
            selectedClipID = clips.first?.id
        }
    }

    private func normalizeSpeedPointSelection() {
        guard let selectedClip else {
            selectedSpeedPointID = nil
            return
        }
        if !selectedClip.speedPoints.contains(where: { $0.id == selectedSpeedPointID }) {
            selectedSpeedPointID = selectedClip.speedPoints.first?.id
        }
    }

    private func normalizeSubtitleSelection() {
        if !subtitles.contains(where: { $0.id == selectedSubtitleID }) {
            selectedSubtitleID = subtitles.first?.id
        }
    }

    private func normalizeOverlaySelection() {
        if !overlays.contains(where: { $0.id == selectedOverlayID }) {
            selectedOverlayID = overlays.first?.id
        }
    }

    private func normalizeAudioTrackSelection() {
        if !audioTracks.contains(where: { $0.id == selectedAudioTrackID }) {
            selectedAudioTrackID = audioTracks.first?.id
        }
    }

    var selectedClip: Clip? {
        clips.first { $0.id == selectedClipID }
    }

    var selectedSpeedPoint: SpeedPoint? {
        selectedClip?.speedPoints.first { $0.id == selectedSpeedPointID }
    }

    var transitionDurations: [Double] {
        guard clips.count >= 2 else { return [] }
        return clips.dropLast().map { clip in
            clip.outgoingTransition.style == .none ? 0 : clip.outgoingTransition.duration
        }
    }

    private var effectiveTransitions: [ClipTransition] {
        let durations = TimelineMath.effectiveTransitionDurations(
            durations: clips.map(\.trimmedDuration), requested: transitionDurations
        )
        return durations.enumerated().map { index, duration in
            ClipTransition(style: clips[index].outgoingTransition.style, duration: duration)
        }
    }

    var selectedOutgoingTransition: ClipTransition? {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              index < clips.count - 1 else { return nil }
        return clips[index].outgoingTransition
    }

    func displayedClipTransform(_ clip: Clip, at timelineTime: Double? = nil) -> ClipTransform {
        guard !clip.transformKeyframes.isEmpty,
              let index = clips.firstIndex(where: { $0.id == clip.id }),
              let start = TimelineMath.clipStart(
                index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
              ) else { return clip.transform }
        let position = max(0, min(1, ((timelineTime ?? playheadSeconds) - start) / max(0.0001, clip.trimmedDuration)))
        return TimelineMath.clipTransformValue(
            at: position, base: clip.transform, keyframes: clip.transformKeyframes
        )
    }

    func timelineStart(of clip: Clip) -> Double? {
        guard let index = clips.firstIndex(where: { $0.id == clip.id }) else { return nil }
        return TimelineMath.clipStart(
            index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
        )
    }

    var selectedSubtitle: SubtitleItem? {
        subtitles.first { $0.id == selectedSubtitleID }
    }

    var activeSubtitle: SubtitleItem? {
        subtitles.last { $0.start <= playheadSeconds && playheadSeconds < $0.end }
    }

    var selectedOverlay: OverlayItem? { overlays.first { $0.id == selectedOverlayID } }
    var selectedAudioTrack: AudioTrackItem? { audioTracks.first { $0.id == selectedAudioTrackID } }
    var activeOverlays: [OverlayItem] {
        overlays.filter { $0.start <= playheadSeconds && playheadSeconds < $0.end }
    }
    func displayedOverlay(_ item: OverlayItem, at timelineTime: Double? = nil) -> OverlayItem {
        let keyframes = item.keyframes ?? []
        guard !keyframes.isEmpty else { return item }
        let base = OverlayKeyframe(
            id: item.id, time: 0, x: item.x, y: item.y, scale: item.scale,
            rotation: item.rotation, opacity: item.opacity, curve: .linear
        )
        let value = TimelineMath.overlayValue(
            at: max(0, (timelineTime ?? playheadSeconds) - item.start),
            base: base, keyframes: keyframes
        )
        var displayed = item
        displayed.x = value.x; displayed.y = value.y; displayed.scale = value.scale
        displayed.rotation = value.rotation; displayed.opacity = value.opacity
        return displayed
    }
    private var editableOverlayPreviewID: UUID? {
        guard let selectedOverlay, mediaAsset(id: selectedOverlay.assetID)?.thumbnail != nil else { return nil }
        return selectedOverlay.id
    }

    func mediaAsset(id: UUID) -> MediaAsset? { mediaAssets.first { $0.id == id } }

    func select(_ clip: Clip) {
        guard clips.contains(where: { $0.id == clip.id }) else { return }
        selectedClipID = clip.id
        if !clip.speedPoints.contains(where: { $0.id == selectedSpeedPointID }) {
            selectedSpeedPointID = clip.speedPoints.first?.id
        }
    }

    /// Records a pre-edit snapshot for a continuous gesture (slider drag).
    /// Called once at drag start so the whole drag collapses into one undo step.
    func beginInteractiveEdit() {
        recordUndo()
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        cancelMediaProcessing()
        redoStack.append(currentSnapshot())
        apply(previous)
        refreshHistoryFlags()
        statusMessage = AppLanguage.shared.text("已撤销", "Undone")
        schedulePreviewRebuild(debounceMillis: 0)
        repairMissingDerivedMedia()
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        cancelMediaProcessing()
        undoStack.append(currentSnapshot())
        apply(next)
        refreshHistoryFlags()
        statusMessage = AppLanguage.shared.text("已重做", "Redone")
        schedulePreviewRebuild(debounceMillis: 0)
        repairMissingDerivedMedia()
    }

    // MARK: - Import

    /// Called with URLs coming from PhotosPicker or the Files document picker.
    /// Every source is copied into the app sandbox first, so later previews and
    /// exports never depend on a temporary picker URL or a stale security scope.
    func importMedia(
        urls: [URL], kinds: [MediaKind]? = nil, sourceIdentifiers: [String]? = nil,
        displayNames: [String]? = nil, addToTimeline: Bool = true, timelineStart: Double? = nil
    ) async {
        guard !urls.isEmpty, !isImporting else { return }
        isImporting = true
        importProgress = 0
        defer {
            isImporting = false
            importProgress = 0
        }
        var imported: [MediaAsset] = []
        var reused: [MediaAsset] = []
        var failures = 0
        for (index, url) in urls.enumerated() {
            importProgress = Double(index) / Double(urls.count)
            let identifier = sourceIdentifiers.flatMap { index < $0.count ? $0[index] : nil } ?? sourceIdentifier(for: url)
            let displayName = displayNames.flatMap { index < $0.count ? $0[index] : nil } ?? url.lastPathComponent
            let kind = kinds.flatMap { index < $0.count ? $0[index] : nil } ?? mediaKind(for: url)
            if let existing = mediaAssets.first(where: { $0.sourceIdentifier == identifier }) {
                reused.append(existing)
                continue
            }
            do {
                imported.append(try await makeMediaAsset(
                    from: url, kind: kind, sourceIdentifier: identifier, displayName: displayName
                ))
            } catch {
                failures += 1
                statusMessage = AppLanguage.shared.isEnglish ? "Import failed: \(error.localizedDescription)" : "导入失败：\(error.localizedDescription)"
            }
        }
        importProgress = 1
        let available = reused + imported
        guard !available.isEmpty else { return }
        guard addToTimeline || !imported.isEmpty else {
            statusMessage = AppLanguage.shared.text("这些素材已经在素材库中", "These items are already in the media library")
            return
        }
        recordUndo()
        mediaAssets.append(contentsOf: imported)
        if addToTimeline {
            clips.append(contentsOf: available.filter { $0.kind != .audio }.map(makeClip))
            for audio in available where audio.kind == .audio {
                addAudioAssetToTimeline(audio, recordHistory: false, startAt: timelineStart)
            }
            selectedClipID = clips.last?.id
        }
        let addedText = AppLanguage.shared.isEnglish
            ? "Imported \(imported.count) media item(s)"
            : "已导入 \(imported.count) 个素材"
        let reusedText = reused.isEmpty ? "" : (AppLanguage.shared.isEnglish ? " · reused \(reused.count)" : " · 复用 \(reused.count) 个")
        statusMessage = failures > 0 ? "\(addedText)\(reusedText)，\(failures) 个失败" : "\(addedText)\(reusedText)"
        if addToTimeline { schedulePreviewRebuild(debounceMillis: 0) }
        else { scheduleAutosave() }
    }

    private func sourceIdentifier(for url: URL) -> String {
        url.standardizedFileURL.path
    }

    private func mediaKind(for url: URL) -> MediaKind {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return .video }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .audio) { return .audio }
        return .video
    }

    private func makeMediaAsset(
        from sourceURL: URL, kind: MediaKind, sourceIdentifier: String, displayName: String
    ) async throws -> MediaAsset {
        let scoped = sourceURL.startAccessingSecurityScopedResource()
        defer { if scoped { sourceURL.stopAccessingSecurityScopedResource() } }
        let projectID = self.projectID
        let url = try await Task.detached(priority: .userInitiated) {
            try Self.persistImportedFile(sourceURL, projectID: projectID)
        }.value
        do {
            if kind == .image {
                guard let image = PlatformImage(contentsOfFile: url.path) else { throw CocoaError(.fileReadCorruptFile) }
                let proxyURL = try await StillImageVideoGenerator.makeVideo(
                    from: url, duration: 3, projectID: projectID
                )
                return MediaAsset(
                    id: UUID(), url: url, name: displayName, duration: 3, sourceIdentifier: sourceIdentifier,
                    kind: .image, proxyURL: proxyURL, thumbnail: image
                )
            }
            let avAsset = AVURLAsset(url: url)
            let duration = try await avAsset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            let requiredType: AVMediaType = kind == .audio ? .audio : .video
            guard seconds.isFinite, seconds > 0, !(try await avAsset.loadTracks(withMediaType: requiredType)).isEmpty else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return MediaAsset(
                id: UUID(), url: url, name: displayName, duration: seconds,
                sourceIdentifier: sourceIdentifier, kind: kind, proxyURL: nil,
                thumbnail: kind == .video ? await makeThumbnail(asset: avAsset) : nil
            )
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    nonisolated private static func persistImportedFile(_ sourceURL: URL, projectID: UUID) throws -> URL {
        let fileManager = FileManager.default
        let root = try ProjectDocumentStore.mediaDirectory(for: projectID, fileManager: fileManager)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mediaDirectory = root
        try? mediaDirectory.setResourceValues(resourceValues)
        let ext = sourceURL.pathExtension.isEmpty ? "mov" : sourceURL.pathExtension
        let destination = root.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
        try fileManager.copyItem(at: sourceURL, to: destination)
        return destination
    }

    private func makeClip(from asset: MediaAsset) -> Clip {
        Clip(id: UUID(), assetID: asset.id, url: asset.proxyURL ?? asset.url, kind: asset.kind, sourceDuration: asset.duration,
             trimStart: 0, trimEnd: asset.duration, speed: 1, isMuted: false,
             colorAdjustments: ColorAdjustments(), effectURL: nil, speedPoints: [],
             isReversed: false, reverseURL: nil, reverseIncludesAudio: nil, muteBeforeReverse: nil,
             lutURL: nil, lutName: nil, lutIntensity: 1, thumbnail: asset.thumbnail)
    }

    private static func normalizedClipTransform(_ value: ClipTransform) -> ClipTransform {
        ClipTransform(
            scale: max(0.25, min(4, value.scale)),
            x: max(-1, min(1, value.x)), y: max(-1, min(1, value.y)),
            rotation: max(-180, min(180, value.rotation)),
            opacity: max(0, min(1, value.opacity))
        )
    }

    func addAssetToTimeline(_ asset: MediaAsset) {
        guard mediaAssets.contains(where: { $0.id == asset.id }) else { return }
        if asset.kind == .audio {
            addAudioAssetToTimeline(asset)
            return
        }
        recordUndo()
        let clip = makeClip(from: asset)
        clips.append(clip)
        selectedClipID = clip.id
        statusMessage = AppLanguage.shared.isEnglish ? "Added to timeline: \(asset.name)" : "已加入时间线：\(asset.name)"
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func mediaUsageCount(_ asset: MediaAsset) -> Int {
        clips.filter { $0.assetID == asset.id }.count
            + overlays.filter { $0.assetID == asset.id }.count
            + audioTracks.filter { $0.assetID == asset.id }.count
    }

    func removeMediaAsset(_ asset: MediaAsset) {
        guard mediaUsageCount(asset) == 0 else {
            statusMessage = AppLanguage.shared.text("素材正在时间线中使用", "This media is in use on the timeline")
            return
        }
        recordUndo()
        mediaAssets.removeAll { $0.id == asset.id }
        statusMessage = AppLanguage.shared.isEnglish ? "Removed: \(asset.name)" : "已移出素材库：\(asset.name)"
        scheduleAutosave()
    }

    private func makeThumbnail(asset: AVAsset) async -> PlatformImage? {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 240, height: 240)
        let time = CMTime(seconds: 0.1, preferredTimescale: 600)
        do {
            let cg = try await gen.image(at: time).image
            #if os(iOS)
            return UIImage(cgImage: cg)
            #else
            return NSImage(cgImage: cg, size: .zero)
            #endif
        } catch {
            return nil
        }
    }

    // MARK: - Background music

    /// Called with a URL coming from the audio file importer.
    func importBGM(url: URL) async {
        guard !isImporting else { return }
        isImporting = true
        defer { isImporting = false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        do {
            let projectID = self.projectID
            let localURL = try await Task.detached(priority: .userInitiated) {
                try Self.persistImportedFile(url, projectID: projectID)
            }.value
            let asset = AVURLAsset(url: localURL)
            let duration = try await asset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0 else {
                try? FileManager.default.removeItem(at: localURL)
                statusMessage = AppLanguage.shared.text("无法读取该音频的时长", "Could not read this audio file's duration")
                return
            }
            recordUndo()
            bgmURL = localURL
            bgmName = url.lastPathComponent
            statusMessage = AppLanguage.shared.isEnglish ? "Added background music: \(url.lastPathComponent)" : "已添加背景音乐:\(url.lastPathComponent)"
        } catch {
            statusMessage = AppLanguage.shared.isEnglish ? "Music import failed: \(error.localizedDescription)" : "音乐导入失败: \(error.localizedDescription)"
        }
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func removeBGM() {
        guard bgmURL != nil else { return }
        recordUndo()
        bgmURL = nil
        bgmName = nil
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setOriginalVolume(_ v: Double) {
        originalVolume = min(1, max(0, v))
        schedulePreviewRebuild()
    }

    func setBGMVolume(_ v: Double) {
        bgmVolume = min(1, max(0, v))
        schedulePreviewRebuild()
    }

    // MARK: - Timeline editing

    func togglePlayback() {
        guard player.currentItem != nil else { return }
        if wantsPlayback {
            wantsPlayback = false
            player.pause()
            isPlaying = false
            schedulePreviewRebuild(debounceMillis: 0)
        } else {
            if playheadSeconds >= max(0, timelineDuration - 0.05) { seek(to: 0) }
            wantsPlayback = true
            isPlaying = true
            if editableOverlayPreviewID != nil {
                previewTask?.cancel()
                Task { [weak self] in
                    guard let self else { return }
                    await self.rebuildPreview(excludedOverlayID: nil)
                }
            } else {
                player.play()
            }
        }
    }

    func pausePlayback() {
        let wasPlaying = wantsPlayback || player.rate > 0
        wantsPlayback = false
        player.pause()
        isPlaying = false
        if wasPlaying, editableOverlayPreviewID != nil {
            schedulePreviewRebuild(debounceMillis: 0)
        }
    }

    func seek(to seconds: Double) {
        let bounded = max(0, min(seconds, timelineDuration))
        player.seek(
            to: CMTime(seconds: bounded, preferredTimescale: 600),
            toleranceBefore: .zero, toleranceAfter: .zero,
            completionHandler: { _ in }
        )
        playheadSeconds = bounded
    }

    func splitSelectedClipAtPlayhead() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        let clip = clips[index]
        guard let sourceSplit = TimelineMath.splitSourceTime(
            playhead: playheadSeconds, clipIndex: index, trimStart: clip.trimStart, trimEnd: clip.trimEnd,
            speed: clip.speed, speedPoints: clip.speedPoints,
            durations: clips.map(\.trimmedDuration), transitions: transitionDurations,
            isReversed: clip.isReversed
        ) else {
            statusMessage = AppLanguage.shared.text("请把播放头移到片段内部再分割", "Move the playhead inside the clip before splitting")
            return
        }
        recordUndo()
        let splitPosition = clip.isReversed
            ? (clip.trimEnd - sourceSplit) / max(0.0001, clip.sourceTrimDuration)
            : (sourceSplit - clip.trimStart) / max(0.0001, clip.sourceTrimDuration)
        let splitCurve = TimelineMath.splitSpeedPoints(
            clip.speedPoints, at: splitPosition, baseSpeed: clip.speed
        )
        let clipStart = TimelineMath.clipStart(
            index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
        ) ?? 0
        let transformSplit = TimelineMath.splitClipTransformKeyframes(
            base: clip.transform, keyframes: clip.transformKeyframes,
            at: (playheadSeconds - clipStart) / max(0.0001, clip.trimmedDuration)
        )
        var left = clip
        if clip.isReversed { left.trimStart = sourceSplit }
        else { left.trimEnd = sourceSplit }
        let rightStart = clip.isReversed ? clip.trimStart : sourceSplit
        let rightEnd = clip.isReversed ? sourceSplit : clip.trimEnd
        let right = Clip(id: UUID(), assetID: clip.assetID, url: clip.url, kind: clip.kind,
                         sourceDuration: clip.sourceDuration, trimStart: rightStart, trimEnd: rightEnd, speed: clip.speed,
                         isMuted: clip.isMuted, colorAdjustments: clip.colorAdjustments, effectURL: clip.effectURL,
                         speedPoints: splitCurve.right, isReversed: clip.isReversed,
                         reverseURL: clip.reverseURL, reverseIncludesAudio: clip.reverseIncludesAudio,
                         muteBeforeReverse: clip.muteBeforeReverse,
                         lutURL: clip.lutURL, lutName: clip.lutName, lutIntensity: clip.lutIntensity,
                         transform: transformSplit.rightBase, transformKeyframes: transformSplit.right,
                         visualEffects: clip.visualEffects,
                         outgoingTransition: clip.outgoingTransition,
                         thumbnail: clip.thumbnail)
        left.speedPoints = splitCurve.left
        left.transform = transformSplit.leftBase
        left.transformKeyframes = transformSplit.left
        left.outgoingTransition = ClipTransition()
        clips.replaceSubrange(index...index, with: [left, right])
        self.selectedClipID = right.id
        selectedSpeedPointID = right.speedPoints.first?.id
        statusMessage = AppLanguage.shared.text("已在播放头分割片段", "Split clip at the playhead")
        schedulePreviewRebuild(debounceMillis: 0)
        repairMissingDerivedMedia()
    }

    func duplicateSelectedClip() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        let source = clips[index]
        let copy = Clip(id: UUID(), assetID: source.assetID, url: source.url, kind: source.kind,
                        sourceDuration: source.sourceDuration, trimStart: source.trimStart, trimEnd: source.trimEnd, speed: source.speed,
                        isMuted: source.isMuted, colorAdjustments: source.colorAdjustments, effectURL: source.effectURL,
                        speedPoints: source.speedPoints, isReversed: source.isReversed, reverseURL: source.reverseURL,
                        reverseIncludesAudio: source.reverseIncludesAudio,
                        muteBeforeReverse: source.muteBeforeReverse, lutURL: source.lutURL,
                        lutName: source.lutName, lutIntensity: source.lutIntensity,
                        transform: source.transform, transformKeyframes: source.transformKeyframes,
                        visualEffects: source.visualEffects,
                        outgoingTransition: source.outgoingTransition,
                        thumbnail: source.thumbnail)
        clips[index].outgoingTransition = ClipTransition()
        clips.insert(copy, at: index + 1)
        self.selectedClipID = copy.id
        selectedSpeedPointID = copy.speedPoints.first?.id
        statusMessage = AppLanguage.shared.text("已复制片段", "Duplicated clip")
        schedulePreviewRebuild(debounceMillis: 0)
        repairMissingDerivedMedia()
    }

    func deleteSelectedClip() {
        guard let selectedClip else { return }
        delete(selectedClip)
    }

    func delete(_ clip: Clip) {
        guard clips.contains(where: { $0.id == clip.id }) else { return }
        recordUndo()
        clips.removeAll { $0.id == clip.id }
        normalizeSelection()
        normalizeSpeedPointSelection()
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func move(_ clip: Clip, by offset: Int) {
        guard let i = clips.firstIndex(of: clip) else { return }
        let j = i + offset
        guard j >= 0, j < clips.count else { return }
        recordUndo()
        clips.swapAt(i, j)
        selectedClipID = clip.id
        schedulePreviewRebuild(debounceMillis: 0)
    }

    /// Drag-and-drop reorder: moves the clip with `id` so it lands in the slot
    /// of `targetID` (target and everything after it shift right). No-op if the
    /// two are equal or either can't be found.
    func moveClip(withID id: String, toCardOf targetID: String) {
        guard id != targetID,
              let from = clips.firstIndex(where: { $0.id.uuidString == id })
        else { return }
        recordUndo()
        let clip = clips.remove(at: from)
        // Re-find the target after removal so the index is always valid.
        guard let target = clips.firstIndex(where: { $0.id.uuidString == targetID }) else {
            // Target vanished (shouldn't happen); put the clip back where it was.
            clips.insert(clip, at: min(from, clips.count))
            return
        }
        clips.insert(clip, at: target)
        selectedClipID = clip.id
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setTransition(_ seconds: Double) {
        setSelectedTransitionDuration(seconds)
    }

    func setSelectedTransitionStyle(_ style: TransitionStyle) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              index < clips.count - 1 else { return }
        guard clips[index].outgoingTransition.style != style else { return }
        recordUndo()
        clips[index].outgoingTransition.style = style
        if style != .none, clips[index].outgoingTransition.duration <= 0.001 {
            clips[index].outgoingTransition.duration = 0.5
        }
        statusMessage = AppLanguage.shared.text("已更新片段转场", "Clip transition updated")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setSelectedTransitionDuration(_ seconds: Double) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              index < clips.count - 1 else { return }
        clips[index].outgoingTransition.duration = max(0, min(2, seconds))
        schedulePreviewRebuild()
    }

    func commitSelectedTransitionEdit() {
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setCanvasFormat(_ format: CanvasFormat) {
        guard canvasFormat != format else { return }
        recordUndo()
        canvasFormat = format
        statusMessage = AppLanguage.shared.isEnglish ? "Canvas: \(format.rawValue)" : "画布比例：\(format.rawValue)"
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setExportResolution(_ resolution: ExportResolution) {
        exportResolution = resolution
        exportedURL = nil
        scheduleAutosave()
    }

    func setExportFrameRate(_ frameRate: Int) {
        exportFrameRate = [24, 25, 30, 50, 60].contains(frameRate) ? frameRate : 30
        exportedURL = nil
        scheduleAutosave()
    }

    func setExportQuality(_ quality: ExportQuality) {
        exportQuality = quality
        exportedURL = nil
        scheduleAutosave()
    }

    var exportRenderSize: CGSize { canvasFormat.renderSize(for: exportResolution) }

    var estimatedExportMegabytes: Int {
        let bytes = Double(targetExportBitrate) * max(1, timelineDuration) / 8
        return max(1, Int((bytes / 1_000_000).rounded()))
    }

    private var targetExportBitrate: Int {
        let base: Double
        switch exportResolution {
        case .hd: base = 4_000_000
        case .fullHD: base = 8_000_000
        case .twoK: base = 16_000_000
        case .fourK: base = 35_000_000
        }
        let qualityMultiplier: Double
        switch exportQuality {
        case .draft: qualityMultiplier = 0.5
        case .standard: qualityMultiplier = 1
        case .high: qualityMultiplier = 1.5
        }
        return Int(base * qualityMultiplier * Double(exportFrameRate) / 30)
    }

    // MARK: - Subtitles

    func addSubtitle() {
        guard !clips.isEmpty, timelineDuration >= 0.05 else {
            statusMessage = AppLanguage.shared.text("请先向时间线添加视频", "Add video to the timeline first")
            return
        }
        let start = max(0, min(playheadSeconds, max(0, timelineDuration - 0.05)))
        let end = min(timelineDuration, start + 2)
        let item = SubtitleItem(
            id: UUID(), text: AppLanguage.shared.text("输入字幕", "Enter caption"),
            start: start, end: end, style: .classic
        )
        recordUndo()
        subtitles.append(item)
        subtitles.sort { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        selectedSubtitleID = item.id
        scheduleAutosave()
    }

    func selectSubtitle(_ subtitle: SubtitleItem) {
        guard subtitles.contains(where: { $0.id == subtitle.id }) else { return }
        selectedSubtitleID = subtitle.id
        seek(to: subtitle.start)
    }

    func updateSubtitle(
        _ subtitle: SubtitleItem, text: String? = nil, start: Double? = nil,
        end: Double? = nil, style: SubtitleStylePreset? = nil
    ) {
        guard let index = subtitles.firstIndex(where: { $0.id == subtitle.id }) else { return }
        var updated = subtitles[index]
        if let text { updated.text = String(text.prefix(300)) }
        if let start { updated.start = max(0, min(start, max(0, timelineDuration - 0.05))) }
        if let end { updated.end = max(updated.start + 0.05, min(end, timelineDuration)) }
        if updated.end > timelineDuration { updated.end = timelineDuration }
        if updated.start >= updated.end { updated.start = max(0, updated.end - 0.05) }
        if let style { updated.style = style }
        subtitles[index] = updated
        subtitles.sort { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        scheduleAutosave()
    }

    func deleteSelectedSubtitle() {
        guard let selectedSubtitleID, subtitles.contains(where: { $0.id == selectedSubtitleID }) else { return }
        recordUndo()
        subtitles.removeAll { $0.id == selectedSubtitleID }
        normalizeSubtitleSelection()
        scheduleAutosave()
    }

    func replaceSubtitles(with imported: [SubtitleItem]) {
        let valid = imported.compactMap { item -> SubtitleItem? in
            let start = max(0, min(item.start, timelineDuration))
            let end = max(start, min(item.end, timelineDuration))
            guard !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, end - start >= 0.05 else {
                return nil
            }
            return SubtitleItem(id: UUID(), text: item.text, start: start, end: end, style: item.style)
        }.sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        guard !valid.isEmpty else {
            statusMessage = AppLanguage.shared.text("SRT 中没有可用字幕", "No usable captions were found in the SRT")
            return
        }
        recordUndo()
        subtitles = valid
        selectedSubtitleID = valid.first?.id
        statusMessage = AppLanguage.shared.isEnglish
            ? "Imported \(valid.count) captions" : "已导入 \(valid.count) 条字幕"
        scheduleAutosave()
    }

    func makeSRTData() -> Data? {
        SubtitleSRT.encode(subtitles: subtitles).data(using: .utf8)
    }

    func startGeneratingCaptionsForSelectedClip() {
        guard speechRecognitionTask == nil else { return }
        speechRecognitionTask = Task { [weak self] in
            await self?.generateCaptionsForSelectedClip()
            self?.speechRecognitionTask = nil
        }
    }

    func cancelCaptionRecognition() {
        speechRecognitionTask?.cancel()
        statusMessage = AppLanguage.shared.text("已取消自动字幕", "Auto captions cancelled")
    }

    private func generateCaptionsForSelectedClip() async {
        guard !isRecognizingSpeech, let selectedClip,
              let index = clips.firstIndex(where: { $0.id == selectedClip.id }),
              let asset = mediaAsset(id: selectedClip.assetID), asset.kind == .video else {
            statusMessage = AppLanguage.shared.text("请选择带原声的视频片段", "Select a video clip with audio")
            return
        }
        let source = AVURLAsset(url: asset.url)
        let sourceAudioTracks = try? await source.loadTracks(withMediaType: .audio)
        guard sourceAudioTracks?.isEmpty == false, !selectedClip.isReversed else {
            statusMessage = AppLanguage.shared.text("该片段没有可识别的原声", "This clip has no recognizable audio")
            return
        }
        isRecognizingSpeech = true
        defer { isRecognizingSpeech = false }
        pausePlayback()
        statusMessage = AppLanguage.shared.text("正在识别字幕…", "Recognizing captions…")
        do {
            let recognized = try await SpeechCaptionRecognizer.recognize(
                mediaURL: asset.url, trimStart: selectedClip.trimStart,
                trimDuration: selectedClip.sourceTrimDuration,
                localeIdentifier: AppLanguage.shared.isEnglish ? "en-US" : "zh-CN"
            )
            let clipStart = TimelineMath.clipStart(
                index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
            ) ?? 0
            let generated = recognized.compactMap { caption -> SubtitleItem? in
                let start = clipStart + TimelineMath.outputTime(
                    forSourceOffset: caption.sourceStart, sourceDuration: selectedClip.sourceTrimDuration,
                    baseSpeed: selectedClip.speed, points: selectedClip.speedPoints
                )
                let end = clipStart + TimelineMath.outputTime(
                    forSourceOffset: min(caption.sourceEnd, selectedClip.sourceTrimDuration),
                    sourceDuration: selectedClip.sourceTrimDuration, baseSpeed: selectedClip.speed,
                    points: selectedClip.speedPoints
                )
                guard end - start >= 0.05 else { return nil }
                return SubtitleItem(
                    id: UUID(), text: caption.text, start: start, end: min(timelineDuration, end),
                    style: .classic
                )
            }
            guard !generated.isEmpty else {
                statusMessage = AppLanguage.shared.text("没有识别到可用字幕", "No usable speech was recognized")
                return
            }
            recordUndo()
            subtitles.append(contentsOf: generated)
            subtitles.sort { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
            selectedSubtitleID = generated.first?.id
            statusMessage = AppLanguage.shared.isEnglish
                ? "Generated \(generated.count) captions" : "已生成 \(generated.count) 条字幕"
            scheduleAutosave()
        } catch is CancellationError {
            statusMessage = AppLanguage.shared.text("已取消自动字幕", "Auto captions cancelled")
        } catch {
            statusMessage = AppLanguage.shared.isEnglish
                ? "Speech recognition failed: \(error.localizedDescription)"
                : "语音识别失败：\(error.localizedDescription)"
        }
    }

    // MARK: - Overlay tracks

    func addAssetAsOverlay(_ asset: MediaAsset) {
        guard asset.kind != .audio, timelineDuration > 0 else {
            statusMessage = AppLanguage.shared.text("请先添加主轨视频", "Add main-track video first")
            return
        }
        let start = max(0, min(playheadSeconds, max(0, timelineDuration - 0.05)))
        let duration = min(asset.duration, 3, timelineDuration - start)
        guard duration >= 0.05 else { return }
        let item = OverlayItem(
            id: UUID(), assetID: asset.id, start: start, end: start + duration,
            x: 0.72, y: 0.28, scale: 0.34, rotation: 0, opacity: 1, sourceStart: 0
        )
        recordUndo()
        overlays.append(item)
        selectedOverlayID = item.id
        statusMessage = AppLanguage.shared.isEnglish ? "Added overlay: \(asset.name)" : "已添加画中画：\(asset.name)"
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func selectOverlay(_ item: OverlayItem) {
        guard overlays.contains(where: { $0.id == item.id }) else { return }
        pausePlayback()
        selectedOverlayID = item.id
        seek(to: item.start)
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func updateOverlay(
        _ item: OverlayItem, start: Double? = nil, end: Double? = nil, x: Double? = nil, y: Double? = nil,
        scale: Double? = nil, rotation: Double? = nil, opacity: Double? = nil, sourceStart: Double? = nil
    ) {
        guard let index = overlays.firstIndex(where: { $0.id == item.id }),
              let asset = mediaAsset(id: item.assetID) else { return }
        var updated = overlays[index]
        let beforeGeometry = displayedOverlay(updated)
        if let start {
            let duration = max(0.05, updated.end - updated.start)
            updated.start = max(0, min(start, max(0, timelineDuration - duration)))
            updated.end = min(timelineDuration, updated.start + duration)
        }
        let sourceAvailable = max(0.05, asset.duration - (updated.sourceStart ?? 0))
        let maxEnd = min(timelineDuration, updated.start + sourceAvailable)
        if let end { updated.end = max(updated.start + 0.05, min(end, maxEnd)) }
        if updated.end > timelineDuration { updated.end = timelineDuration }
        if updated.start >= updated.end { updated.start = max(0, updated.end - 0.05) }
        if let sourceStart {
            let maxStart = max(0, asset.duration - max(0.05, updated.end - updated.start))
            updated.sourceStart = max(0, min(sourceStart, maxStart))
        }
        updated.end = min(updated.end, updated.start + asset.duration - (updated.sourceStart ?? 0))
        let hasGeometryUpdate = x != nil || y != nil || scale != nil || rotation != nil || opacity != nil
        if !(updated.keyframes ?? []).isEmpty && hasGeometryUpdate {
            upsertKeyframe(
                in: &updated, at: max(0, min(updated.end - updated.start, playheadSeconds - updated.start)),
                x: x.map { max(0, min(1, $0)) } ?? beforeGeometry.x,
                y: y.map { max(0, min(1, $0)) } ?? beforeGeometry.y,
                scale: scale.map { max(0.1, min(1.5, $0)) } ?? beforeGeometry.scale,
                rotation: rotation.map { max(-180, min(180, $0)) } ?? beforeGeometry.rotation,
                opacity: opacity.map { max(0, min(1, $0)) } ?? beforeGeometry.opacity
            )
        } else {
            if let x { updated.x = max(0, min(1, x)) }
            if let y { updated.y = max(0, min(1, y)) }
            if let scale { updated.scale = max(0.1, min(1.5, scale)) }
            if let rotation { updated.rotation = max(-180, min(180, rotation)) }
            if let opacity { updated.opacity = max(0, min(1, opacity)) }
        }
        overlays[index] = updated
        if editableOverlayPreviewID == item.id { scheduleAutosave() }
        else { schedulePreviewRebuild() }
    }

    func deleteSelectedOverlay() {
        guard let selectedOverlayID else { return }
        recordUndo()
        overlays.removeAll { $0.id == selectedOverlayID }
        normalizeOverlaySelection()
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func addOrUpdateOverlayKeyframe(
        curve: KeyframeCurve = .easeInOut, bezier: KeyframeBezier? = nil
    ) {
        guard let selectedOverlayID, let index = overlays.firstIndex(where: { $0.id == selectedOverlayID }) else { return }
        recordUndo()
        var item = overlays[index]
        let displayed = displayedOverlay(item)
        upsertKeyframe(
            in: &item, at: max(0, min(item.end - item.start, playheadSeconds - item.start)),
            x: displayed.x, y: displayed.y, scale: displayed.scale, rotation: displayed.rotation,
            opacity: displayed.opacity, curve: curve, bezier: bezier
        )
        overlays[index] = item
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func removeNearestOverlayKeyframe() {
        guard let selectedOverlayID, let index = overlays.firstIndex(where: { $0.id == selectedOverlayID }) else { return }
        let localTime = max(0, playheadSeconds - overlays[index].start)
        guard let nearest = (overlays[index].keyframes ?? []).min(by: {
            abs($0.time - localTime) < abs($1.time - localTime)
        }), abs(nearest.time - localTime) <= 0.25 else {
            statusMessage = AppLanguage.shared.text("播放头附近没有关键帧", "No keyframe near the playhead")
            return
        }
        recordUndo()
        overlays[index].keyframes?.removeAll { $0.id == nearest.id }
        schedulePreviewRebuild(debounceMillis: 0)
    }

    private func upsertKeyframe(
        in item: inout OverlayItem, at time: Double, x: Double, y: Double, scale: Double,
        rotation: Double, opacity: Double, curve: KeyframeCurve? = nil,
        bezier: KeyframeBezier? = nil
    ) {
        var keyframes = item.keyframes ?? []
        if let index = keyframes.firstIndex(where: { abs($0.time - time) < 0.05 }) {
            let old = keyframes[index]
            keyframes[index] = OverlayKeyframe(
                id: old.id, time: time, x: x, y: y, scale: scale, rotation: rotation,
                opacity: opacity, curve: curve ?? old.curve,
                bezier: curve == nil ? old.bezier : normalizedBezier(for: curve!, bezier: bezier)
            )
        } else {
            let resolvedCurve = curve ?? .easeInOut
            keyframes.append(OverlayKeyframe(
                id: UUID(), time: time, x: x, y: y, scale: scale, rotation: rotation,
                opacity: opacity, curve: resolvedCurve,
                bezier: normalizedBezier(for: resolvedCurve, bezier: bezier)
            ))
        }
        item.keyframes = keyframes.sorted { $0.time < $1.time }
    }

    // MARK: - Independent audio tracks

    func addAudioAssetToTimeline(_ asset: MediaAsset) {
        addAudioAssetToTimeline(asset, recordHistory: true, startAt: nil)
    }

    private func addAudioAssetToTimeline(
        _ asset: MediaAsset, recordHistory: Bool, startAt requestedStart: Double?
    ) {
        guard asset.kind == .audio, timelineDuration > 0 else {
            statusMessage = AppLanguage.shared.text("请先添加主轨视频", "Add main-track video first")
            return
        }
        let start = max(0, min(requestedStart ?? playheadSeconds, max(0, timelineDuration - 0.05)))
        let duration = min(asset.duration, timelineDuration - start)
        guard duration >= 0.05 else { return }
        if recordHistory { recordUndo() }
        let item = AudioTrackItem(
            id: UUID(), assetID: asset.id, start: start, sourceStart: 0, duration: duration,
            volume: 1, fadeIn: 0, fadeOut: 0, isMuted: false, speed: 1
        )
        audioTracks.append(item)
        selectedAudioTrackID = item.id
        statusMessage = AppLanguage.shared.isEnglish ? "Added audio: \(asset.name)" : "已加入音频轨：\(asset.name)"
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func detachSelectedClipAudio() async {
        guard let selectedClip, let index = clips.firstIndex(where: { $0.id == selectedClip.id }),
              let asset = mediaAsset(id: selectedClip.assetID), asset.kind == .video else {
            statusMessage = AppLanguage.shared.text("当前片段没有可分离的原声", "This clip has no detachable audio")
            return
        }
        let source = AVURLAsset(url: asset.url)
        let sourceAudioTracks = try? await source.loadTracks(withMediaType: .audio)
        guard sourceAudioTracks?.isEmpty == false, !selectedClip.isReversed else {
            statusMessage = AppLanguage.shared.text("当前片段没有可分离的原声", "This clip has no detachable audio")
            return
        }
        let start = TimelineMath.clipStart(
            index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
        ) ?? 0
        recordUndo()
        clips[index].isMuted = true
        let item = AudioTrackItem(
            id: UUID(), assetID: asset.id, start: start, sourceStart: selectedClip.trimStart,
            duration: selectedClip.trimmedDuration, volume: 1, fadeIn: 0, fadeOut: 0, isMuted: false,
            speed: selectedClip.sourceTrimDuration / max(0.05, selectedClip.trimmedDuration)
        )
        audioTracks.append(item)
        selectedAudioTrackID = item.id
        statusMessage = AppLanguage.shared.text("已分离原声到音频轨", "Detached original audio")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func selectAudioTrack(_ item: AudioTrackItem) {
        guard audioTracks.contains(where: { $0.id == item.id }) else { return }
        selectedAudioTrackID = item.id
        seek(to: item.start)
    }

    func updateAudioTrack(
        _ item: AudioTrackItem, start: Double? = nil, duration: Double? = nil, volume: Double? = nil,
        fadeIn: Double? = nil, fadeOut: Double? = nil, isMuted: Bool? = nil, sourceStart: Double? = nil
    ) {
        guard let index = audioTracks.firstIndex(where: { $0.id == item.id }),
              let asset = mediaAsset(id: item.assetID) else { return }
        var updated = audioTracks[index]
        if let start { updated.start = max(0, min(start, max(0, timelineDuration - 0.05))) }
        if let sourceStart {
            let speed = max(0.25, updated.speed ?? 1)
            let maxStart = max(0, asset.duration - updated.duration * speed)
            updated.sourceStart = max(0, min(sourceStart, maxStart))
        }
        let maxSourceDuration = max(0.05, (asset.duration - updated.sourceStart) / max(0.25, updated.speed ?? 1))
        if let duration { updated.duration = max(0.05, min(duration, maxSourceDuration, timelineDuration - updated.start)) }
        updated.duration = min(updated.duration, maxSourceDuration, max(0.05, timelineDuration - updated.start))
        if let volume { updated.volume = max(0, min(1, volume)) }
        if let fadeIn { updated.fadeIn = max(0, min(fadeIn, updated.duration / 2)) }
        if let fadeOut { updated.fadeOut = max(0, min(fadeOut, updated.duration / 2)) }
        if let isMuted { updated.isMuted = isMuted }
        audioTracks[index] = updated
        schedulePreviewRebuild()
    }

    func deleteSelectedAudioTrack() {
        guard let selectedAudioTrackID else { return }
        recordUndo()
        audioTracks.removeAll { $0.id == selectedAudioTrackID }
        normalizeAudioTrackSelection()
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func updateTrim(for clip: Clip, start: Double, end: Double) {
        // No recordUndo here: trim is a continuous slider drag. The single
        // pre-drag snapshot is taken via beginInteractiveEdit() so the whole
        // drag collapses into one undo step instead of one per frame.
        guard let i = clips.firstIndex(of: clip) else { return }
        clips[i].trimStart = max(0, min(start, clips[i].sourceDuration))
        clips[i].trimEnd = max(clips[i].trimStart, min(end, clips[i].sourceDuration))
        schedulePreviewRebuild()
    }

    func setSpeed(for clip: Clip, to value: Double) {
        guard let index = clips.firstIndex(of: clip) else { return }
        clips[index].speed = max(0.25, min(4, value))
        schedulePreviewRebuild()
    }

    func applySpeedCurvePreset(_ preset: String) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        switch preset {
        case "montage":
            clips[index].speedPoints = [
                SpeedPoint(id: UUID(), position: 0, speed: 0.65),
                SpeedPoint(id: UUID(), position: 0.42, speed: 2.4),
                SpeedPoint(id: UUID(), position: 1, speed: 0.8)
            ]
        case "bullet":
            clips[index].speedPoints = [
                SpeedPoint(id: UUID(), position: 0, speed: 1.4),
                SpeedPoint(id: UUID(), position: 0.48, speed: 0.35),
                SpeedPoint(id: UUID(), position: 1, speed: 1.4)
            ]
        case "hero":
            clips[index].speedPoints = [
                SpeedPoint(id: UUID(), position: 0, speed: 0.5),
                SpeedPoint(id: UUID(), position: 0.35, speed: 1),
                SpeedPoint(id: UUID(), position: 1, speed: 2)
            ]
        default:
            clips[index].speedPoints = []
        }
        selectedSpeedPointID = clips[index].speedPoints.first?.id
        statusMessage = clips[index].speedPoints.isEmpty
            ? AppLanguage.shared.text("已关闭速度曲线", "Speed curve removed")
            : AppLanguage.shared.text("已应用速度曲线", "Speed curve applied")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func selectSpeedPoint(_ id: UUID) {
        guard selectedClip?.speedPoints.contains(where: { $0.id == id }) == true else { return }
        selectedSpeedPointID = id
    }

    func addSpeedPointAtPlayhead() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              let clipStart = TimelineMath.clipStart(
                index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
              ) else { return }
        let clip = clips[index]
        let localTime = playheadSeconds - clipStart
        guard localTime >= 0, localTime <= clip.trimmedDuration else {
            statusMessage = AppLanguage.shared.text(
                "请把播放头移到选中片段内", "Move the playhead inside the selected clip"
            )
            return
        }
        var points = clip.speedPoints
        if points.isEmpty {
            recordUndo()
            points = [
                SpeedPoint(id: UUID(), position: 0, speed: clip.speed),
                SpeedPoint(id: UUID(), position: 1, speed: clip.speed)
            ]
        }
        let sourceOffset = TimelineMath.sourceOffset(
            forOutputTime: localTime, sourceDuration: clip.sourceTrimDuration,
            baseSpeed: clip.speed, points: points
        )
        let position = max(0, min(1, sourceOffset / max(0.0001, clip.sourceTrimDuration)))
        if let existing = points.min(by: { abs($0.position - position) < abs($1.position - position) }),
           abs(existing.position - position) < 0.02 {
            selectedSpeedPointID = existing.id
            statusMessage = AppLanguage.shared.text(
                "已选中附近的速度控制点", "Selected the nearby speed point"
            )
        } else {
            if !clip.speedPoints.isEmpty { recordUndo() }
            let point = SpeedPoint(
                id: UUID(), position: position,
                speed: TimelineMath.speedAt(position: position, baseSpeed: clip.speed, points: points)
            )
            points.append(point)
            selectedSpeedPointID = point.id
            statusMessage = AppLanguage.shared.text("已添加速度控制点", "Speed point added")
        }
        clips[index].speedPoints = points.sorted { $0.position < $1.position }
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func updateSpeedPoint(_ id: UUID, position: Double, speed: Double) {
        guard let selectedClipID, let clipIndex = clips.firstIndex(where: { $0.id == selectedClipID }),
              let pointIndex = clips[clipIndex].speedPoints.firstIndex(where: { $0.id == id }) else { return }
        let points = clips[clipIndex].speedPoints
        let lowerBound = pointIndex > 0 ? min(1, points[pointIndex - 1].position + 0.01) : 0
        let upperBound = pointIndex + 1 < points.count ? max(0, points[pointIndex + 1].position - 0.01) : 1
        clips[clipIndex].speedPoints[pointIndex].position = lowerBound <= upperBound
            ? max(lowerBound, min(upperBound, position)) : points[pointIndex].position
        clips[clipIndex].speedPoints[pointIndex].speed = max(0.25, min(4, speed))
        clips[clipIndex].speedPoints.sort { $0.position < $1.position }
        schedulePreviewRebuild()
    }

    func removeSelectedSpeedPoint() {
        guard let selectedClipID, let clipIndex = clips.firstIndex(where: { $0.id == selectedClipID }),
              let selectedSpeedPointID,
              clips[clipIndex].speedPoints.contains(where: { $0.id == selectedSpeedPointID }) else { return }
        recordUndo()
        clips[clipIndex].speedPoints.removeAll { $0.id == selectedSpeedPointID }
        self.selectedSpeedPointID = clips[clipIndex].speedPoints.first?.id
        statusMessage = clips[clipIndex].speedPoints.isEmpty
            ? AppLanguage.shared.text("已关闭速度曲线", "Speed curve removed")
            : AppLanguage.shared.text("已删除速度控制点", "Speed point removed")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func commitSpeedCurveEdit() {
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func updateSelectedClipTransform(
        scale: Double? = nil, x: Double? = nil, y: Double? = nil,
        rotation: Double? = nil, opacity: Double? = nil
    ) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        let current = displayedClipTransform(clips[index])
        let value = ClipTransform(
            scale: scale.map { max(0.25, min(4, $0)) } ?? current.scale,
            x: x.map { max(-1, min(1, $0)) } ?? current.x,
            y: y.map { max(-1, min(1, $0)) } ?? current.y,
            rotation: rotation.map { max(-180, min(180, $0)) } ?? current.rotation,
            opacity: opacity.map { max(0, min(1, $0)) } ?? current.opacity
        )
        if clips[index].transformKeyframes.isEmpty {
            clips[index].transform = value
        } else {
            let position = clipOutputPosition(index: index)
            upsertClipTransformKeyframe(in: &clips[index], at: position, value: value)
        }
        schedulePreviewRebuild()
    }

    func addOrUpdateClipTransformKeyframe(
        curve: KeyframeCurve = .easeInOut, bezier: KeyframeBezier? = nil
    ) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        let value = displayedClipTransform(clips[index])
        let position = clipOutputPosition(index: index)
        upsertClipTransformKeyframe(
            in: &clips[index], at: position, value: value, curve: curve, bezier: bezier
        )
        statusMessage = AppLanguage.shared.text("已记录主轨关键帧", "Main-track keyframe recorded")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func removeNearestClipTransformKeyframe() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              !clips[index].transformKeyframes.isEmpty,
              let clipStart = TimelineMath.clipStart(
                index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
              ) else { return }
        let duration = max(0.0001, clips[index].trimmedDuration)
        let position = max(0, min(1, (playheadSeconds - clipStart) / duration))
        guard let nearest = clips[index].transformKeyframes.min(by: {
            abs($0.position - position) < abs($1.position - position)
        }), abs(nearest.position - position) * duration <= 0.25 else {
            statusMessage = AppLanguage.shared.text("播放头附近没有主轨关键帧", "No main-track keyframe near the playhead")
            return
        }
        recordUndo()
        clips[index].transformKeyframes.removeAll { $0.id == nearest.id }
        statusMessage = AppLanguage.shared.text("已删除主轨关键帧", "Main-track keyframe removed")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func resetSelectedClipTransform() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              !clips[index].transform.isIdentity || !clips[index].transformKeyframes.isEmpty else { return }
        recordUndo()
        clips[index].transform = ClipTransform()
        clips[index].transformKeyframes = []
        statusMessage = AppLanguage.shared.text("已重置画面变换", "Transform reset")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func commitSelectedClipTransform() {
        schedulePreviewRebuild(debounceMillis: 0)
    }

    private func upsertClipTransformKeyframe(
        in clip: inout Clip, at position: Double, value: ClipTransform,
        curve: KeyframeCurve? = nil, bezier: KeyframeBezier? = nil
    ) {
        if let frameIndex = clip.transformKeyframes.firstIndex(where: {
            abs($0.position - position) * clip.trimmedDuration < 0.05
        }) {
            let old = clip.transformKeyframes[frameIndex]
            clip.transformKeyframes[frameIndex] = ClipTransformKeyframe(
                id: old.id, position: position, scale: value.scale, x: value.x, y: value.y,
                rotation: value.rotation, opacity: value.opacity, curve: curve ?? old.curve,
                bezier: curve == nil ? old.bezier : normalizedBezier(for: curve!, bezier: bezier)
            )
        } else {
            let resolvedCurve = curve ?? .easeInOut
            clip.transformKeyframes.append(ClipTransformKeyframe(
                id: UUID(), position: position, scale: value.scale, x: value.x, y: value.y,
                rotation: value.rotation, opacity: value.opacity, curve: resolvedCurve,
                bezier: normalizedBezier(for: resolvedCurve, bezier: bezier)
            ))
        }
        clip.transformKeyframes.sort { $0.position < $1.position }
    }

    private func normalizedBezier(
        for curve: KeyframeCurve, bezier: KeyframeBezier?
    ) -> KeyframeBezier? {
        curve == .custom ? (bezier ?? KeyframeBezier()).normalized : nil
    }

    private func clipOutputPosition(index: Int) -> Double {
        guard clips.indices.contains(index), let start = TimelineMath.clipStart(
            index: index, durations: clips.map(\.trimmedDuration), transitions: transitionDurations
        ) else { return 0 }
        return max(0, min(1, (playheadSeconds - start) / max(0.0001, clips[index].trimmedDuration)))
    }

    func setColorPreset(_ preset: ColorPreset) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        var settings = clips[index].colorAdjustments
        settings.preset = preset
        switch preset {
        case .original: settings.brightness = 0; settings.contrast = 1; settings.saturation = 1; settings.temperature = 0
        case .warm: settings.brightness = 0.03; settings.contrast = 1.05; settings.saturation = 1.08; settings.temperature = 35
        case .cool: settings.brightness = 0; settings.contrast = 1.04; settings.saturation = 0.96; settings.temperature = -35
        case .vivid: settings.brightness = 0.02; settings.contrast = 1.16; settings.saturation = 1.28; settings.temperature = 5
        case .mono: settings.brightness = 0; settings.contrast = 1.12; settings.saturation = 0; settings.temperature = 0
        }
        clips[index].colorAdjustments = settings
        scheduleColorRender(for: clips[index])
    }

    func updateSelectedClipColor(
        brightness: Double? = nil, contrast: Double? = nil,
        saturation: Double? = nil, temperature: Double? = nil
    ) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        var settings = clips[index].colorAdjustments
        settings.preset = .original
        if let brightness { settings.brightness = max(-0.5, min(0.5, brightness)) }
        if let contrast { settings.contrast = max(0.5, min(2, contrast)) }
        if let saturation { settings.saturation = max(0, min(2, saturation)) }
        if let temperature { settings.temperature = max(-100, min(100, temperature)) }
        clips[index].colorAdjustments = settings
        scheduleColorRender(for: clips[index])
    }

    func commitSelectedClipColor() {
        guard let selectedClip else { return }
        scheduleColorRender(for: selectedClip, debounceMillis: 0)
    }

    func setSelectedClipEffectPreset(_ preset: ClipEffectPreset) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        clips[index].visualEffects.preset = preset
        scheduleColorRender(for: clips[index], debounceMillis: 0)
    }

    func updateSelectedClipEffects(vignette: Double? = nil, grain: Double? = nil) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        if let vignette { clips[index].visualEffects.vignette = max(0, min(1, vignette)) }
        if let grain { clips[index].visualEffects.grain = max(0, min(1, grain)) }
        scheduleColorRender(for: clips[index])
    }

    func resetSelectedClipEffects() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              !clips[index].visualEffects.isIdentity else { return }
        recordUndo()
        clips[index].visualEffects = ClipVisualEffects()
        statusMessage = AppLanguage.shared.text("已重置片段特效", "Clip effects reset")
        scheduleColorRender(for: clips[index], debounceMillis: 0)
    }

    func importLUT(from sourceURL: URL) async {
        guard let selectedClipID else { return }
        let scoped = sourceURL.startAccessingSecurityScopedResource()
        defer { if scoped { sourceURL.stopAccessingSecurityScopedResource() } }
        do {
            let projectID = self.projectID
            let localURL = try await Task.detached(priority: .userInitiated) {
                let attributes = try FileManager.default.attributesOfItem(atPath: sourceURL.path)
                if let size = attributes[.size] as? NSNumber, size.intValue > CubeLUT.maximumFileSize {
                    throw CubeLUTError.fileTooLarge
                }
                _ = try CubeLUT.parse(data: Data(contentsOf: sourceURL))
                try Self.persistImportedFile(sourceURL, projectID: projectID)
            }.value
            guard let index = clips.firstIndex(where: { $0.id == selectedClipID }) else {
                try? FileManager.default.removeItem(at: localURL)
                return
            }
            recordUndo()
            clips[index].lutURL = localURL
            clips[index].lutName = sourceURL.deletingPathExtension().lastPathComponent
            clips[index].lutIntensity = 1
            statusMessage = AppLanguage.shared.text("已导入 LUT，正在生成预览…", "LUT imported; rendering preview…")
            scheduleColorRender(for: clips[index], debounceMillis: 0)
        } catch {
            statusMessage = AppLanguage.shared.isEnglish
                ? "LUT import failed: \(error.localizedDescription)"
                : "LUT 导入失败：\(error.localizedDescription)"
        }
    }

    func updateSelectedClipLUTIntensity(_ value: Double) {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              clips[index].lutName != nil else { return }
        clips[index].lutIntensity = max(0, min(1, value))
        scheduleColorRender(for: clips[index])
    }

    func removeSelectedClipLUT() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              clips[index].lutName != nil else { return }
        recordUndo()
        clips[index].lutURL = nil
        clips[index].lutName = nil
        clips[index].lutIntensity = 1
        statusMessage = AppLanguage.shared.text("已移除 LUT", "LUT removed")
        scheduleColorRender(for: clips[index], debounceMillis: 0)
    }

    private func scheduleColorRender(for clip: Clip, debounceMillis: UInt64 = 180) {
        colorRenderTasks[clip.id]?.cancel()
        if let index = clips.firstIndex(where: { $0.id == clip.id }) {
            clips[index].effectURL = nil
        }
        scheduleAutosave()
        if !clip.hasColorEffect {
            schedulePreviewRebuild(debounceMillis: 0)
            return
        }
        if clip.isReversed && clip.reverseURL == nil { return }
        let token = beginMediaProcessing()
        colorRenderTokens[clip.id] = token
        colorRenderTasks[clip.id] = Task { [weak self] in
            defer { self?.finishColorRender(clipID: clip.id, token: token) }
            if debounceMillis > 0 { try? await Task.sleep(nanoseconds: debounceMillis * 1_000_000) }
            guard !Task.isCancelled, let self else { return }
            await self.renderColorProxy(for: clip.id)
        }
    }

    private func renderColorProxy(for clipID: UUID) async {
        guard let index = clips.firstIndex(where: { $0.id == clipID }) else { return }
        let clip = clips[index]
        if !clip.hasColorEffect {
            clips[index].effectURL = nil
            schedulePreviewRebuild(debounceMillis: 0)
            return
        }
        guard !clip.hasMissingLUT else {
            statusMessage = AppLanguage.shared.text(
                "LUT 文件缺失，请重新导入", "The LUT file is missing; import it again"
            )
            return
        }
        statusMessage = AppLanguage.shared.text("正在生成调色预览…", "Rendering color preview…")
        do {
            let url = try await ColorEffectRenderer.render(
                sourceURL: clip.reverseURL ?? clip.url, adjustments: clip.colorAdjustments,
                lutURL: clip.lutURL, lutIntensity: clip.lutIntensity,
                effects: clip.visualEffects, projectID: projectID
            )
            guard !Task.isCancelled,
                  let current = clips.firstIndex(where: { $0.id == clipID }),
                  clips[current].colorAdjustments == clip.colorAdjustments,
                  clips[current].lutURL == clip.lutURL,
                  abs(clips[current].lutIntensity - clip.lutIntensity) < 0.0001,
                  clips[current].visualEffects == clip.visualEffects,
                  clips[current].isReversed == clip.isReversed,
                  (clips[current].reverseURL ?? clips[current].url) == (clip.reverseURL ?? clip.url) else {
                try? FileManager.default.removeItem(at: url)
                return
            }
            clips[current].effectURL = url
            statusMessage = AppLanguage.shared.text("调色已应用", "Color adjustments applied")
            schedulePreviewRebuild(debounceMillis: 0)
        } catch is CancellationError {
        } catch {
            statusMessage = AppLanguage.shared.isEnglish
                ? "Color rendering failed: \(error.localizedDescription)"
                : "调色渲染失败：\(error.localizedDescription)"
            schedulePreviewRebuild(debounceMillis: 0)
        }
    }

    func toggleMuteSelectedClip() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        guard !clips[index].isReversed || clips[index].reverseIncludesAudio != false else {
            statusMessage = AppLanguage.shared.text(
                "源素材没有可倒放的原声", "The source has no audio to reverse"
            )
            return
        }
        recordUndo()
        clips[index].isMuted.toggle()
        statusMessage = clips[index].isMuted
            ? AppLanguage.shared.text("已静音片段原声", "Muted clip audio")
            : AppLanguage.shared.text("已恢复片段原声", "Restored clip audio")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func toggleReverseSelectedClip() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }),
              clips[index].kind == .video else { return }
        recordUndo()
        clips[index].isReversed.toggle()
        colorRenderTasks[clips[index].id]?.cancel()
        clips[index].effectURL = nil
        if !clips[index].isReversed {
            reverseRenderTasks[clips[index].id]?.cancel()
            clips[index].reverseURL = nil
            clips[index].reverseIncludesAudio = nil
            clips[index].muteBeforeReverse = nil
            statusMessage = AppLanguage.shared.text("已关闭倒放", "Reverse disabled")
            if !clips[index].hasColorEffect { schedulePreviewRebuild(debounceMillis: 0) }
            else { scheduleColorRender(for: clips[index], debounceMillis: 0) }
            return
        }
        clips[index].reverseURL = nil
        clips[index].reverseIncludesAudio = nil
        clips[index].muteBeforeReverse = nil
        let clipID = clips[index].id
        reverseRenderTasks[clipID]?.cancel()
        let token = beginMediaProcessing()
        reverseRenderTokens[clipID] = token
        reverseRenderTasks[clipID] = Task { [weak self] in
            defer { self?.finishReverseRender(clipID: clipID, token: token) }
            await self?.renderReverseProxy(for: clipID)
        }
    }

    private func renderReverseProxy(for clipID: UUID) async {
        guard let index = clips.firstIndex(where: { $0.id == clipID }) else { return }
        let previousURL = clips[index].reverseURL
        statusMessage = AppLanguage.shared.text("正在生成倒放媒体…", "Rendering reversed media…")
        do {
            let result = try await ReverseMediaGenerator.makeReversedVideo(
                from: clips[index].url, projectID: projectID
            )
            guard !Task.isCancelled,
                  let current = clips.firstIndex(where: { $0.id == clipID }), clips[current].isReversed else {
                try? FileManager.default.removeItem(at: result.url)
                return
            }
            clips[current].reverseURL = result.url
            clips[current].reverseIncludesAudio = result.includesAudio
            clips[current].muteBeforeReverse = nil
            clips[current].effectURL = nil
            if let previousURL, previousURL != result.url,
               !clips.contains(where: { $0.id != clipID && $0.reverseURL == previousURL }) {
                try? FileManager.default.removeItem(at: previousURL)
            }
            statusMessage = result.includesAudio
                ? AppLanguage.shared.text("倒放画面和原声已生成", "Reversed video and audio ready")
                : AppLanguage.shared.text("倒放画面已生成，源素材无原声", "Reversed video ready; source has no audio")
            if !clips[current].hasColorEffect { schedulePreviewRebuild(debounceMillis: 0) }
            else { scheduleColorRender(for: clips[current], debounceMillis: 0) }
        } catch is CancellationError {
        } catch {
            if let current = clips.firstIndex(where: { $0.id == clipID }) {
                clips[current].isReversed = false
                clips[current].reverseURL = nil
                clips[current].reverseIncludesAudio = nil
                clips[current].muteBeforeReverse = nil
                if !clips[current].hasColorEffect {
                    schedulePreviewRebuild(debounceMillis: 0)
                } else {
                    scheduleColorRender(for: clips[current], debounceMillis: 0)
                }
            }
            statusMessage = AppLanguage.shared.isEnglish
                ? "Reverse failed: \(error.localizedDescription)"
                : "倒放生成失败：\(error.localizedDescription)"
        }
    }

    var totalDuration: Double { clips.reduce(0) { $0 + $1.trimmedDuration } }

    var timelineDuration: Double {
        TimelineMath.timelineDuration(
            durations: clips.map(\.trimmedDuration), transitions: transitionDurations
        )
    }

    // MARK: - Composition

    /// Result of assembling the timeline: the composition, an optional audio mix
    /// that balances original clip audio against the background music, and an
    /// optional video composition used only when cross-dissolve transitions are on.
    private struct Assembled {
        let composition: AVMutableComposition
        let audioMix: AVAudioMix?
        let videoComposition: AVVideoComposition?
    }

    /// Seconds → CMTime at a 600 timescale (enough for frame-accurate edits).
    private func cmt(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 600)
    }

    private func insertClip(
        _ clip: Clip, sourceVideo: AVAssetTrack, sourceAudio: AVAssetTrack?,
        into videoTrack: AVMutableCompositionTrack, audioTrack: AVMutableCompositionTrack?,
        at timelineStart: CMTime
    ) throws {
        let segments = TimelineMath.speedSegments(
            sourceDuration: clip.sourceTrimDuration, baseSpeed: clip.speed, points: clip.speedPoints
        )
        let sourceBase = clip.isReversed
            ? max(0, clip.sourceDuration - clip.trimEnd)
            : clip.trimStart
        var outputCursor = timelineStart
        for segment in segments {
            let sourceRange = CMTimeRange(
                start: cmt(sourceBase + segment.sourceOffset),
                duration: cmt(segment.sourceDuration)
            )
            let sourceDuration = cmt(segment.sourceDuration)
            let outputDuration = cmt(segment.outputDuration)
            try videoTrack.insertTimeRange(sourceRange, of: sourceVideo, at: outputCursor)
            videoTrack.scaleTimeRange(
                CMTimeRange(start: outputCursor, duration: sourceDuration), toDuration: outputDuration
            )
            if !clip.isMuted, let sourceAudio, let audioTrack {
                try? audioTrack.insertTimeRange(sourceRange, of: sourceAudio, at: outputCursor)
                audioTrack.scaleTimeRange(
                    CMTimeRange(start: outputCursor, duration: sourceDuration), toDuration: outputDuration
                )
            }
            outputCursor = CMTimeAdd(outputCursor, outputDuration)
        }
    }

    /// Picks the concatenation strategy: hard cuts (fast, single track) when no
    /// transition is set, or a cross-dissolve build when the user wants fades.
    private func buildComposition(
        renderSize: CGSize? = nil, frameRate: Int = 30, includeSubtitles: Bool = false,
        excludedOverlayID: UUID? = nil
    ) async -> Assembled? {
        guard !clips.isEmpty else { return nil }
        let outputSize = renderSize ?? canvasFormat.renderSize
        if transitionDurations.contains(where: { $0 > 0.001 }), clips.count >= 2 {
            if let crossfade = await buildCrossfadeComposition(
                transitions: effectiveTransitions, renderSize: outputSize, frameRate: frameRate,
                includeSubtitles: includeSubtitles, excludedOverlayID: excludedOverlayID
            ) {
                return crossfade
            }
        }
        return await buildSimpleComposition(
            renderSize: outputSize, frameRate: frameRate, includeSubtitles: includeSubtitles,
            excludedOverlayID: excludedOverlayID
        )
    }

    /// Concatenates all clips (in order, after trimming) into one composition
    /// with hard cuts, then overlays looping background music if one is set.
    private func buildSimpleComposition(
        renderSize canvasSize: CGSize, frameRate: Int, includeSubtitles: Bool,
        excludedOverlayID: UUID?
    ) async -> Assembled? {
        guard !clips.isEmpty else { return nil }

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        var cursor = CMTime.zero
        var placements: [Placement] = []
        for clip in clips {
            let sourceURL = clip.playbackURL
            let asset = AVURLAsset(url: sourceURL)
            let scoped = sourceURL.startAccessingSecurityScopedResource()
            defer { if scoped { sourceURL.stopAccessingSecurityScopedResource() } }

            let outputDur = cmt(clip.trimmedDuration)

            do {
                guard let srcV = try await asset.loadTracks(withMediaType: .video).first else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                let srcA = try? await asset.loadTracks(withMediaType: .audio).first
                try insertClip(
                    clip, sourceVideo: srcV, sourceAudio: srcA, into: videoTrack,
                    audioTrack: audioTrack, at: cursor
                )
                let preferred = (try? await srcV.load(.preferredTransform)) ?? .identity
                let natural = (try? await srcV.load(.naturalSize)) ?? canvasSize
                placements.append(Placement(
                    clip: clip, start: cursor, dur: outputDur, trackIndex: 0, videoTrack: videoTrack,
                    renderSize: canvasSize,
                    transform: aspectFitTransform(natural: natural, preferred: preferred, canvas: canvasSize)
                ))
                cursor = CMTimeAdd(cursor, outputDur)
            } catch {
                statusMessage = AppLanguage.shared.isEnglish ? "Composition failed: \(error.localizedDescription)" : "合成失败: \(error.localizedDescription)"
                return nil
            }
        }

        // `cursor` now equals the full timeline length.
        let bgmTrack = await addBGMTrack(to: composition, coveringUpTo: cursor)
        let independentAudio = await addIndependentAudioTracks(to: composition, coveringUpTo: cursor)
        let overlayPlacements = await addOverlayTracks(
            to: composition, renderSize: canvasSize, coveringUpTo: cursor,
            excluding: excludedOverlayID
        )
        let audioMix = makeAudioMix(
            originalTrack: audioTrack, bgmTrack: bgmTrack, independentAudio: independentAudio
        )

        let videoComposition = makeCutVideoComposition(
            placements: placements, renderSize: canvasSize, frameRate: frameRate,
            includeSubtitles: includeSubtitles, overlays: overlayPlacements
        )
        return Assembled(composition: composition, audioMix: audioMix, videoComposition: videoComposition)
    }

    /// One clip successfully placed on the timeline, with the metadata the
    /// video-composition instructions need.
    private struct Placement {
        let clip: Clip
        let start: CMTime
        let dur: CMTime
        let trackIndex: Int          // 0 or 1 — clips alternate between two tracks
        let videoTrack: AVMutableCompositionTrack
        let renderSize: CGSize
        let transform: CGAffineTransform
    }

    private struct OverlayPlacement {
        let item: OverlayItem
        let videoTrack: AVMutableCompositionTrack
        let transform: CGAffineTransform
        let naturalSize: CGSize
        let preferredTransform: CGAffineTransform
        let renderSize: CGSize
    }

    private struct IndependentAudioPlacement {
        let item: AudioTrackItem
        let track: AVMutableCompositionTrack
    }

    /// Builds a composition with independently configured boundary overlaps.
    /// Alternating tracks allow dissolves and push transitions to share the same
    /// non-destructive timeline and matching audio crossfades.
    private func buildCrossfadeComposition(
        transitions: [ClipTransition], renderSize canvasSize: CGSize, frameRate: Int,
        includeSubtitles: Bool, excludedOverlayID: UUID?
    ) async -> Assembled? {
        let composition = AVMutableComposition()
        let videoTracks = (0..<2).compactMap { _ in
            composition.addMutableTrack(withMediaType: .video,
                                        preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        let audioTracks = (0..<2).map { _ in
            composition.addMutableTrack(withMediaType: .audio,
                                        preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        guard videoTracks.count == 2 else { return nil }

        var placements: [Placement] = []
        var cursorSeconds = 0.0
        for (index, clip) in clips.enumerated() {
            let sourceURL = clip.playbackURL
            let asset = AVURLAsset(url: sourceURL)
            let scoped = sourceURL.startAccessingSecurityScopedResource()
            defer { if scoped { sourceURL.stopAccessingSecurityScopedResource() } }

            guard let srcV = try? await asset.loadTracks(withMediaType: .video).first else { return nil }
            let preferred = (try? await srcV.load(.preferredTransform)) ?? .identity
            let naturalSize = (try? await srcV.load(.naturalSize)) ?? CGSize(width: 1280, height: 720)
            let transform = aspectFitTransform(natural: naturalSize, preferred: preferred, canvas: canvasSize)

            // Track assignment is based on placement order, so skipped clips
            // never break the strict A/B alternation.
            let trackIndex = placements.count % 2
            let startCM = cmt(cursorSeconds)
            let outputDurCM = cmt(clip.trimmedDuration)

            do {
                let srcA = try? await asset.loadTracks(withMediaType: .audio).first
                try insertClip(
                    clip, sourceVideo: srcV, sourceAudio: srcA, into: videoTracks[trackIndex],
                    audioTrack: audioTracks[trackIndex], at: startCM
                )
            } catch {
                return nil
            }

            placements.append(Placement(clip: clip, start: startCM, dur: outputDurCM,
                                        trackIndex: trackIndex,
                                        videoTrack: videoTracks[trackIndex],
                                        renderSize: canvasSize,
                                        transform: transform))
            let outgoing = index < transitions.count && transitions[index].style != .none
                ? transitions[index].duration : 0
            cursorSeconds += clip.trimmedDuration - outgoing
        }

        // Need at least two placed clips to dissolve; otherwise fall back.
        guard placements.count >= 2 else { return nil }

        // Total timeline length = last clip's placement end.
        let last = placements[placements.count - 1]
        let total = CMTimeAdd(last.start, last.dur)
        let bgmTrack = await addBGMTrack(to: composition, coveringUpTo: total)
        let independentAudio = await addIndependentAudioTracks(to: composition, coveringUpTo: total)
        let overlayPlacements = await addOverlayTracks(
            to: composition, renderSize: canvasSize, coveringUpTo: total,
            excluding: excludedOverlayID
        )
        let videoComposition = makeVideoComposition(placements: placements,
                                                     transitions: transitions,
                                                     renderSize: canvasSize,
                                                     frameRate: frameRate,
                                                     includeSubtitles: includeSubtitles,
                                                     overlays: overlayPlacements)
        let audioMix = makeCrossfadeAudioMix(placements: placements,
                                             audioTracks: audioTracks,
                                             transitions: transitions,
                                             bgmTrack: bgmTrack,
                                             independentAudio: independentAudio)

        return Assembled(composition: composition,
                         audioMix: audioMix,
                         videoComposition: videoComposition)
    }

    /// Applies source orientation, then aspect-fits and centers it in the chosen canvas.
    private func aspectFitTransform(natural: CGSize, preferred: CGAffineTransform, canvas: CGSize) -> CGAffineTransform {
        let sourceRect = CGRect(origin: .zero, size: natural).applying(preferred)
        let width = abs(sourceRect.width)
        let height = abs(sourceRect.height)
        guard width > 0, height > 0 else { return preferred }
        let scale = min(canvas.width / width, canvas.height / height)
        let offsetX = (canvas.width - width * scale) / 2
        let offsetY = (canvas.height - height * scale) / 2
        return CGAffineTransform(
            a: preferred.a * scale, b: preferred.b * scale,
            c: preferred.c * scale, d: preferred.d * scale,
            tx: (preferred.tx - sourceRect.minX) * scale + offsetX,
            ty: (preferred.ty - sourceRect.minY) * scale + offsetY
        )
    }

    private func makeCutVideoComposition(
        placements: [Placement], renderSize: CGSize, frameRate: Int, includeSubtitles: Bool,
        overlays: [OverlayPlacement]
    ) -> AVMutableVideoComposition {
        let instructions = placements.map { placement -> AVMutableVideoCompositionInstruction in
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: placement.start, duration: placement.dur)
            instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: placement.videoTrack)
            applyClipAnimation(placement, to: layer, within: instruction.timeRange)
            instruction.layerInstructions = makeOverlayLayerInstructions(
                overlays, within: instruction.timeRange
            ) + [layer]
            return instruction
        }
        let composition = AVMutableVideoComposition()
        composition.instructions = instructions
        composition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, frameRate)))
        composition.renderSize = renderSize
        if includeSubtitles { applySubtitleLayers(to: composition, renderSize: renderSize) }
        return composition
    }

    /// Builds gap-free hard-cut, dissolve and push instructions from the same
    /// per-boundary timing contract used by the visible timeline.
    private func makeVideoComposition(placements: [Placement],
                                      transitions: [ClipTransition],
                                      renderSize: CGSize,
                                      frameRate: Int,
                                      includeSubtitles: Bool,
                                      overlays: [OverlayPlacement]) -> AVMutableVideoComposition {
        var instructions: [AVMutableVideoCompositionInstruction] = []
        let activeDurations = transitions.map { transition in
            transition.style == .none ? 0 : transition.duration
        }
        let spans = TimelineMath.videoInstructionSpans(
            durations: placements.map { $0.clip.trimmedDuration },
            transitions: activeDurations
        )

        for span in spans {
            let range = CMTimeRange(start: cmt(span.start), duration: cmt(span.duration))
            switch span.kind {
            case let .solo(clipIndex):
                guard placements.indices.contains(clipIndex) else { continue }
                let placement = placements[clipIndex]
                let inst = AVMutableVideoCompositionInstruction()
                inst.timeRange = range
                inst.backgroundColor = CGColor(gray: 0, alpha: 1)
                let li = AVMutableVideoCompositionLayerInstruction(assetTrack: placement.videoTrack)
                applyClipAnimation(placement, to: li, within: inst.timeRange)
                inst.layerInstructions = makeOverlayLayerInstructions(
                    overlays, within: inst.timeRange
                ) + [li]
                instructions.append(inst)

            case let .transition(boundaryIndex):
                guard placements.indices.contains(boundaryIndex),
                      placements.indices.contains(boundaryIndex + 1),
                      transitions.indices.contains(boundaryIndex) else { continue }
                let placement = placements[boundaryIndex]
                let next = placements[boundaryIndex + 1]
                let boundary = transitions[boundaryIndex]
                guard boundary.style != .none else { continue }
                let inst = AVMutableVideoCompositionInstruction()
                inst.timeRange = range
                inst.backgroundColor = CGColor(gray: 0, alpha: 1)

                let fromLI = AVMutableVideoCompositionLayerInstruction(assetTrack: placement.videoTrack)
                let toLI = AVMutableVideoCompositionLayerInstruction(assetTrack: next.videoTrack)
                switch boundary.style {
                case .none:
                    break
                case .dissolve:
                    applyClipAnimation(
                        placement, to: fromLI, within: range,
                        opacityFactorFrom: 1, opacityFactorTo: 0
                    )
                    applyClipAnimation(next, to: toLI, within: range)
                case .pushLeft:
                    applyClipAnimation(
                        placement, to: fromLI, within: range,
                        transitionXFrom: 0, transitionXTo: -1
                    )
                    applyClipAnimation(
                        next, to: toLI, within: range,
                        transitionXFrom: 1, transitionXTo: 0
                    )
                case .pushRight:
                    applyClipAnimation(
                        placement, to: fromLI, within: range,
                        transitionXFrom: 0, transitionXTo: 1
                    )
                    applyClipAnimation(
                        next, to: toLI, within: range,
                        transitionXFrom: -1, transitionXTo: 0
                    )
                }

                inst.layerInstructions = makeOverlayLayerInstructions(
                    overlays, within: inst.timeRange
                ) + [fromLI, toLI]
                instructions.append(inst)
            }
        }

        let vc = AVMutableVideoComposition()
        vc.instructions = instructions
        vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, frameRate)))
        vc.renderSize = renderSize
        if includeSubtitles { applySubtitleLayers(to: vc, renderSize: renderSize) }
        return vc
    }

    private func applyClipAnimation(
        _ placement: Placement, to layer: AVMutableVideoCompositionLayerInstruction,
        within instructionRange: CMTimeRange, opacityFactorFrom: Double = 1,
        opacityFactorTo: Double = 1, transitionXFrom: Double = 0,
        transitionXTo: Double = 0
    ) {
        let rangeStart = CMTimeGetSeconds(instructionRange.start)
        let rangeDuration = max(0.0001, CMTimeGetSeconds(instructionRange.duration))
        let clipStart = CMTimeGetSeconds(placement.start)
        let clipDuration = max(0.0001, CMTimeGetSeconds(placement.dur))
        if placement.clip.transformKeyframes.isEmpty &&
            abs(transitionXFrom - transitionXTo) < 0.0001 {
            layer.setTransform(clipTransform(
                placement.clip.transform, placement: placement, transitionX: transitionXFrom
            ), at: instructionRange.start)
            if abs(opacityFactorFrom - opacityFactorTo) < 0.0001 {
                layer.setOpacity(
                    Float(placement.clip.transform.opacity * opacityFactorFrom),
                    at: instructionRange.start
                )
            } else {
                layer.setOpacityRamp(
                    fromStartOpacity: Float(placement.clip.transform.opacity * opacityFactorFrom),
                    toEndOpacity: Float(placement.clip.transform.opacity * opacityFactorTo),
                    timeRange: instructionRange
                )
            }
            return
        }
        let sampleCount = max(1, min(720, Int(ceil(rangeDuration * 12))))
        for index in 0..<sampleCount {
            let progressFrom = Double(index) / Double(sampleCount)
            let progressTo = Double(index + 1) / Double(sampleCount)
            let timelineFrom = rangeStart + rangeDuration * progressFrom
            let timelineTo = rangeStart + rangeDuration * progressTo
            let positionFrom = max(0, min(1, (timelineFrom - clipStart) / clipDuration))
            let positionTo = max(0, min(1, (timelineTo - clipStart) / clipDuration))
            let valueFrom = TimelineMath.clipTransformValue(
                at: positionFrom, base: placement.clip.transform,
                keyframes: placement.clip.transformKeyframes
            )
            let valueTo = TimelineMath.clipTransformValue(
                at: positionTo, base: placement.clip.transform,
                keyframes: placement.clip.transformKeyframes
            )
            let factorFrom = opacityFactorFrom + (opacityFactorTo - opacityFactorFrom) * progressFrom
            let factorTo = opacityFactorFrom + (opacityFactorTo - opacityFactorFrom) * progressTo
            let offsetFrom = transitionXFrom + (transitionXTo - transitionXFrom) * progressFrom
            let offsetTo = transitionXFrom + (transitionXTo - transitionXFrom) * progressTo
            let range = CMTimeRange(start: cmt(timelineFrom), duration: cmt(timelineTo - timelineFrom))
            layer.setTransformRamp(
                fromStart: clipTransform(valueFrom, placement: placement, transitionX: offsetFrom),
                toEnd: clipTransform(valueTo, placement: placement, transitionX: offsetTo),
                timeRange: range
            )
            layer.setOpacityRamp(
                fromStartOpacity: Float(valueFrom.opacity * factorFrom),
                toEndOpacity: Float(valueTo.opacity * factorTo), timeRange: range
            )
        }
    }

    private func clipTransform(
        _ value: ClipTransform, placement: Placement, transitionX: Double = 0
    ) -> CGAffineTransform {
        let scale = CGFloat(value.scale)
        let angle = CGFloat(value.rotation * .pi / 180)
        let cosine = cos(angle) * scale
        let sine = sin(angle) * scale
        let centerX = placement.renderSize.width / 2
        let centerY = placement.renderSize.height / 2
        let offsetX = CGFloat(value.x) * centerX + CGFloat(transitionX) * placement.renderSize.width
        let offsetY = CGFloat(value.y) * centerY
        let outputTransform = CGAffineTransform(
            a: cosine, b: sine, c: -sine, d: cosine,
            tx: centerX + offsetX - cosine * centerX + sine * centerY,
            ty: centerY + offsetY - sine * centerX - cosine * centerY
        )
        return placement.transform.concatenating(outputTransform)
    }

    private func makeOverlayLayerInstructions(
        _ overlays: [OverlayPlacement], within instructionRange: CMTimeRange
    ) -> [AVMutableVideoCompositionLayerInstruction] {
        let instructionStart = CMTimeGetSeconds(instructionRange.start)
        let instructionEnd = CMTimeGetSeconds(CMTimeRangeGetEnd(instructionRange))
        return overlays.reversed().compactMap { placement in
            guard placement.item.start < instructionEnd, placement.item.end > instructionStart else {
                return nil
            }
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: placement.videoTrack)
            layer.setOpacity(0, at: instructionRange.start)
            applyOverlayAnimation(placement, to: layer, within: instructionRange)
            return layer
        }
    }

    private func applyOverlayAnimation(
        _ placement: OverlayPlacement, to layer: AVMutableVideoCompositionLayerInstruction,
        within instructionRange: CMTimeRange
    ) {
        let item = placement.item
        let instructionStart = CMTimeGetSeconds(instructionRange.start)
        let instructionEnd = CMTimeGetSeconds(CMTimeRangeGetEnd(instructionRange))
        let activeStart = max(item.start, instructionStart)
        let activeEnd = min(item.end, instructionEnd)
        guard activeEnd - activeStart > 0.0001 else { return }
        let localStart = activeStart - item.start
        let activeDuration = activeEnd - activeStart
        guard !(item.keyframes ?? []).isEmpty else {
            layer.setTransform(placement.transform, at: cmt(activeStart))
            layer.setOpacity(Float(item.opacity), at: cmt(activeStart))
            layer.setOpacity(0, at: cmt(activeEnd))
            return
        }
        let base = OverlayKeyframe(
            id: item.id, time: 0, x: item.x, y: item.y, scale: item.scale,
            rotation: item.rotation, opacity: item.opacity, curve: .linear
        )
        let sampleCount = max(1, min(72, Int(ceil(activeDuration * 8))))
        for index in 0..<sampleCount {
            let fromTime = localStart + activeDuration * Double(index) / Double(sampleCount)
            let toTime = localStart + activeDuration * Double(index + 1) / Double(sampleCount)
            let from = TimelineMath.overlayValue(at: fromTime, base: base, keyframes: item.keyframes ?? [])
            let to = TimelineMath.overlayValue(at: toTime, base: base, keyframes: item.keyframes ?? [])
            let range = CMTimeRange(
                start: cmt(item.start + fromTime), duration: cmt(toTime - fromTime)
            )
            layer.setTransformRamp(
                fromStart: transform(for: from, placement: placement),
                toEnd: transform(for: to, placement: placement), timeRange: range
            )
            layer.setOpacityRamp(
                fromStartOpacity: Float(from.opacity), toEndOpacity: Float(to.opacity), timeRange: range
            )
        }
        layer.setOpacity(0, at: cmt(activeEnd))
    }

    private func transform(
        for keyframe: OverlayKeyframe, placement: OverlayPlacement
    ) -> CGAffineTransform {
        var item = placement.item
        item.x = keyframe.x; item.y = keyframe.y; item.scale = keyframe.scale
        item.rotation = keyframe.rotation; item.opacity = keyframe.opacity
        return overlayTransform(
            natural: placement.naturalSize, preferred: placement.preferredTransform,
            canvas: placement.renderSize, item: item
        )
    }

    private func addOverlayTracks(
        to composition: AVMutableComposition, renderSize: CGSize, coveringUpTo total: CMTime,
        excluding excludedOverlayID: UUID?
    ) async -> [OverlayPlacement] {
        var result: [OverlayPlacement] = []
        let totalSeconds = max(0, CMTimeGetSeconds(total))
        for item in overlays where item.id != excludedOverlayID {
            guard let asset = mediaAsset(id: item.assetID), asset.kind != .audio,
                  let track = composition.addMutableTrack(
                    withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid
                  ) else { continue }
            let sourceURL = asset.proxyURL ?? asset.url
            let source = AVURLAsset(url: sourceURL)
            guard let sourceTrack = try? await source.loadTracks(withMediaType: .video).first else {
                composition.removeTrack(track)
                continue
            }
            let sourceDuration = min(
                item.end - item.start, totalSeconds - item.start,
                asset.duration - (item.sourceStart ?? 0)
            )
            guard sourceDuration > 0 else {
                composition.removeTrack(track)
                continue
            }
            let sourceRange = CMTimeRange(start: cmt(item.sourceStart ?? 0), duration: cmt(sourceDuration))
            do {
                try track.insertTimeRange(sourceRange, of: sourceTrack, at: cmt(item.start))
                let preferred = (try? await sourceTrack.load(.preferredTransform)) ?? .identity
                let natural = (try? await sourceTrack.load(.naturalSize)) ?? renderSize
                result.append(OverlayPlacement(
                    item: item, videoTrack: track,
                    transform: overlayTransform(natural: natural, preferred: preferred, canvas: renderSize, item: item),
                    naturalSize: natural, preferredTransform: preferred, renderSize: renderSize
                ))
            } catch {
                composition.removeTrack(track)
            }
        }
        return result
    }

    private func overlayTransform(
        natural: CGSize, preferred: CGAffineTransform, canvas: CGSize, item: OverlayItem
    ) -> CGAffineTransform {
        let sourceRect = CGRect(origin: .zero, size: natural).applying(preferred)
        let width = max(1, abs(sourceRect.width))
        let height = max(1, abs(sourceRect.height))
        let targetWidth = canvas.width * CGFloat(item.scale)
        let targetHeight = canvas.height * CGFloat(item.scale)
        let scale = min(targetWidth / width, targetHeight / height)
        let center = CGPoint(x: canvas.width * CGFloat(item.x), y: canvas.height * CGFloat(item.y))
        let originX = center.x - width * scale / 2
        let originY = center.y - height * scale / 2
        let base = CGAffineTransform(
            a: preferred.a * scale, b: preferred.b * scale,
            c: preferred.c * scale, d: preferred.d * scale,
            tx: (preferred.tx - sourceRect.minX) * scale + originX,
            ty: (preferred.ty - sourceRect.minY) * scale + originY
        )
        let radians = CGFloat(item.rotation) * .pi / 180
        let cosine = cos(radians)
        let sine = sin(radians)
        return CGAffineTransform(
            a: cosine * base.a - sine * base.b,
            b: sine * base.a + cosine * base.b,
            c: cosine * base.c - sine * base.d,
            d: sine * base.c + cosine * base.d,
            tx: cosine * (base.tx - center.x) - sine * (base.ty - center.y) + center.x,
            ty: sine * (base.tx - center.x) + cosine * (base.ty - center.y) + center.y
        )
    }

    private func applySubtitleLayers(to composition: AVMutableVideoComposition, renderSize: CGSize) {
        let items = subtitles.filter { !$0.text.isEmpty && $0.end > $0.start }
        guard !items.isEmpty else { return }

        let parentLayer = CALayer()
        let videoLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: renderSize)
        videoLayer.frame = parentLayer.frame
        parentLayer.addSublayer(videoLayer)

        for item in items {
            let fontSize: CGFloat
            let y: CGFloat
            switch item.style {
            case .classic:
                fontSize = renderSize.width * 0.050
                y = renderSize.height * 0.10
            case .highlight:
                fontSize = renderSize.width * 0.052
                y = renderSize.height * 0.10
            case .center:
                fontSize = renderSize.width * 0.072
                y = renderSize.height * 0.44
            }
            let frame = CGRect(
                x: renderSize.width * 0.08, y: y,
                width: renderSize.width * 0.84, height: max(fontSize * 2.8, renderSize.height * 0.12)
            )
            let container = CALayer()
            container.frame = frame
            container.backgroundColor = PlatformColor.black.withAlphaComponent(0.42).cgColor
            container.cornerRadius = max(7, renderSize.width * 0.006)
            container.opacity = 0

            let layer = CATextLayer()
            layer.frame = container.bounds.insetBy(dx: renderSize.width * 0.012, dy: fontSize * 0.15)
            layer.contentsScale = 2
            layer.alignmentMode = .center
            layer.isWrapped = true
            layer.foregroundColor = item.style == .highlight
                ? PlatformColor.systemYellow.cgColor : PlatformColor.white.cgColor
            layer.shadowColor = PlatformColor.black.cgColor
            layer.shadowOpacity = 0.9
            layer.shadowRadius = max(2, renderSize.width * 0.003)
            layer.shadowOffset = CGSize(width: 0, height: max(1, renderSize.height * 0.0015))
            layer.string = item.text
            layer.font = PlatformFont.boldSystemFont(ofSize: fontSize)
            layer.fontSize = fontSize
            container.addSublayer(layer)

            let show = CABasicAnimation(keyPath: "opacity")
            show.fromValue = 0
            show.toValue = 1
            show.beginTime = AVCoreAnimationBeginTimeAtZero + item.start
            show.duration = 0.001
            show.fillMode = .forwards
            show.isRemovedOnCompletion = false
            let hide = CABasicAnimation(keyPath: "opacity")
            hide.fromValue = 1
            hide.toValue = 0
            hide.beginTime = AVCoreAnimationBeginTimeAtZero + item.end
            hide.duration = 0.001
            hide.fillMode = .forwards
            hide.isRemovedOnCompletion = false
            container.add(show, forKey: "show")
            container.add(hide, forKey: "hide")
            parentLayer.addSublayer(container)
        }
        composition.animationTool = AVVideoCompositionCoreAnimationTool(
            postProcessingAsVideoLayer: videoLayer, in: parentLayer
        )
    }

    /// Audio mix for the crossfade path: each clip fades its own audio in/out
    /// across the overlap, and the BGM (if any) plays at a constant level.
    private func makeCrossfadeAudioMix(placements: [Placement],
                                       audioTracks: [AVMutableCompositionTrack?],
                                       transitions: [ClipTransition],
                                       bgmTrack: AVMutableCompositionTrack?,
                                       independentAudio: [IndependentAudioPlacement]) -> AVAudioMix? {
        let n = placements.count
        let v = Float(originalVolume)
        var params: [AVMutableAudioMixInputParameters] = []

        for t in 0..<audioTracks.count {
            guard let track = audioTracks[t] else { continue }
            let p = AVMutableAudioMixInputParameters(track: track)
            // Clips on this track, in timeline order.
            for i in stride(from: t, to: n, by: 2) {
                let pl = placements[i]
                let end = CMTimeAdd(pl.start, pl.dur)
                let incoming = i > 0 && i - 1 < transitions.count && transitions[i - 1].style != .none
                    ? transitions[i - 1].duration : 0
                let outgoing = i < transitions.count && transitions[i].style != .none
                    ? transitions[i].duration : 0
                if incoming > 0.001 {
                    p.setVolumeRamp(fromStartVolume: 0, toEndVolume: v,
                                    timeRange: CMTimeRange(start: pl.start,
                                                           end: CMTimeAdd(pl.start, cmt(incoming))))
                } else {
                    p.setVolume(v, at: pl.start)
                }
                if i < n - 1, outgoing > 0.001 {
                    p.setVolumeRamp(fromStartVolume: v, toEndVolume: 0,
                                    timeRange: CMTimeRange(start: CMTimeSubtract(end, cmt(outgoing)),
                                                           end: end))
                }
            }
            params.append(p)
        }

        if let bgmTrack {
            let bp = AVMutableAudioMixInputParameters(track: bgmTrack)
            bp.setVolume(Float(bgmVolume), at: .zero)
            params.append(bp)
        }
        appendIndependentAudioParameters(independentAudio, to: &params)

        guard !params.isEmpty else { return nil }
        let mix = AVMutableAudioMix()
        mix.inputParameters = params
        return mix
    }

    /// Loops the chosen music file across the whole timeline. Returns the
    /// inserted composition track (or nil when there is no music).
    private func addBGMTrack(to composition: AVMutableComposition,
                             coveringUpTo total: CMTime) async -> AVMutableCompositionTrack? {
        guard let bgmURL, total > .zero else { return nil }

        let scoped = bgmURL.startAccessingSecurityScopedResource()
        defer { if scoped { bgmURL.stopAccessingSecurityScopedResource() } }

        let asset = AVURLAsset(url: bgmURL)
        guard
            let srcAudio = try? await asset.loadTracks(withMediaType: .audio).first,
            let musicDuration = try? await asset.load(.duration),
            musicDuration > .zero,
            let track = composition.addMutableTrack(
                withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { return nil }

        var cursor = CMTime.zero
        while cursor < total {
            let remaining = CMTimeSubtract(total, cursor)
            let chunk = CMTimeMinimum(musicDuration, remaining)
            let range = CMTimeRange(start: .zero, duration: chunk)
            do {
                try track.insertTimeRange(range, of: srcAudio, at: cursor)
            } catch {
                break
            }
            cursor = CMTimeAdd(cursor, chunk)
        }
        return track
    }

    private func addIndependentAudioTracks(
        to composition: AVMutableComposition, coveringUpTo total: CMTime
    ) async -> [IndependentAudioPlacement] {
        var result: [IndependentAudioPlacement] = []
        let totalSeconds = max(0, CMTimeGetSeconds(total))
        for item in audioTracks where !item.isMuted && item.start < totalSeconds {
            guard let media = mediaAsset(id: item.assetID),
                  let track = composition.addMutableTrack(
                    withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
                  ) else { continue }
            let asset = AVURLAsset(url: media.url)
            guard let sourceTrack = try? await asset.loadTracks(withMediaType: .audio).first else {
                composition.removeTrack(track)
                continue
            }
            let speed = max(0.25, min(4, item.speed ?? 1))
            let outputDuration = min(item.duration, totalSeconds - item.start)
            let sourceDuration = min(outputDuration * speed, media.duration - item.sourceStart)
            guard outputDuration > 0, sourceDuration > 0 else {
                composition.removeTrack(track)
                continue
            }
            let insertionTime = cmt(item.start)
            let sourceRange = CMTimeRange(start: cmt(item.sourceStart), duration: cmt(sourceDuration))
            do {
                try track.insertTimeRange(sourceRange, of: sourceTrack, at: insertionTime)
                track.scaleTimeRange(
                    CMTimeRange(start: insertionTime, duration: cmt(sourceDuration)),
                    toDuration: cmt(outputDuration)
                )
                var normalized = item
                normalized.duration = outputDuration
                result.append(IndependentAudioPlacement(item: normalized, track: track))
            } catch {
                composition.removeTrack(track)
            }
        }
        return result
    }

    private func appendIndependentAudioParameters(
        _ tracks: [IndependentAudioPlacement], to params: inout [AVMutableAudioMixInputParameters]
    ) {
        for placement in tracks {
            let item = placement.item
            let parameter = AVMutableAudioMixInputParameters(track: placement.track)
            let volume = Float(max(0, min(1, item.volume)))
            let start = cmt(item.start)
            let end = cmt(item.start + item.duration)
            let fadeIn = min(max(0, item.fadeIn), item.duration / 2)
            let fadeOut = min(max(0, item.fadeOut), item.duration / 2)
            if fadeIn > 0 {
                parameter.setVolumeRamp(
                    fromStartVolume: 0, toEndVolume: volume,
                    timeRange: CMTimeRange(start: start, duration: cmt(fadeIn))
                )
            } else {
                parameter.setVolume(volume, at: start)
            }
            if fadeOut > 0 {
                parameter.setVolumeRamp(
                    fromStartVolume: volume, toEndVolume: 0,
                    timeRange: CMTimeRange(start: CMTimeSubtract(end, cmt(fadeOut)), duration: cmt(fadeOut))
                )
            }
            params.append(parameter)
        }
    }

    /// Builds an audio mix that applies the original / BGM volume levels.
    private func makeAudioMix(originalTrack: AVMutableCompositionTrack?,
                              bgmTrack: AVMutableCompositionTrack?,
                              independentAudio: [IndependentAudioPlacement]) -> AVAudioMix? {
        var params: [AVMutableAudioMixInputParameters] = []
        if let originalTrack {
            let p = AVMutableAudioMixInputParameters(track: originalTrack)
            p.setVolume(Float(originalVolume), at: .zero)
            params.append(p)
        }
        if let bgmTrack {
            let p = AVMutableAudioMixInputParameters(track: bgmTrack)
            p.setVolume(Float(bgmVolume), at: .zero)
            params.append(p)
        }
        appendIndependentAudioParameters(independentAudio, to: &params)
        guard !params.isEmpty else { return nil }
        let mix = AVMutableAudioMix()
        mix.inputParameters = params
        return mix
    }

    /// Schedules a preview rebuild, cancelling any pending one. A short debounce
    /// coalesces bursts of edits (e.g. slider drags) into a single recomposition.
    /// Discrete edits pass `debounceMillis: 0` for an immediate refresh.
    private func schedulePreviewRebuild(debounceMillis: UInt64 = 120) {
        normalizeTimedItems()
        scheduleAutosave()
        previewTask?.cancel()
        previewGeneration += 1
        let generation = previewGeneration
        previewTask = Task { [weak self] in
            if debounceMillis > 0 {
                try? await Task.sleep(nanoseconds: debounceMillis * 1_000_000)
            }
            if Task.isCancelled { return }
            guard let self else { return }
            let excludedOverlayID = self.player.rate > 0 ? nil : self.editableOverlayPreviewID
            await self.rebuildPreview(
                excludedOverlayID: excludedOverlayID, expectedGeneration: generation
            )
        }
    }

    private func normalizeSubtitleTiming() {
        let duration = timelineDuration
        subtitles = subtitles.compactMap { item in
            let start = max(0, min(item.start, duration))
            let end = max(start, min(item.end, duration))
            guard duration > 0, end - start >= 0.05 else { return nil }
            var normalized = item
            normalized.start = start
            normalized.end = end
            return normalized
        }
        normalizeSubtitleSelection()
    }

    private func normalizeTimedItems() {
        normalizeSubtitleTiming()
        let timelineEnd = timelineDuration
        overlays = overlays.compactMap { item in
            guard let asset = mediaAsset(id: item.assetID), asset.kind != .audio, timelineEnd >= 0.05 else {
                return nil
            }
            guard asset.kind != .image || asset.proxyURL != nil else { return nil }
            var value = item
            value.sourceStart = max(0, min(value.sourceStart ?? 0, max(0, asset.duration - 0.05)))
            value.start = max(0, min(value.start, max(0, timelineEnd - 0.05)))
            let available = min(
                timelineEnd - value.start,
                asset.duration - (value.sourceStart ?? 0)
            )
            let duration = min(max(0.05, value.end - value.start), available)
            guard duration >= 0.05 else { return nil }
            value.end = value.start + duration
            value.x = max(0, min(1, value.x))
            value.y = max(0, min(1, value.y))
            value.scale = max(0.1, min(1.5, value.scale))
            value.rotation = max(-180, min(180, value.rotation))
            value.opacity = max(0, min(1, value.opacity))
            value.keyframes = (value.keyframes ?? []).map { frame in
                OverlayKeyframe(
                    id: frame.id, time: max(0, min(duration, frame.time)),
                    x: max(0, min(1, frame.x)), y: max(0, min(1, frame.y)),
                    scale: max(0.1, min(1.5, frame.scale)),
                    rotation: max(-180, min(180, frame.rotation)),
                    opacity: max(0, min(1, frame.opacity)), curve: frame.curve,
                    bezier: frame.curve == .custom ? (frame.bezier ?? KeyframeBezier()).normalized : nil
                )
            }.sorted { $0.time < $1.time }
            return value
        }
        audioTracks = audioTracks.compactMap { item in
            guard let asset = mediaAsset(id: item.assetID), timelineEnd >= 0.05 else { return nil }
            var value = item
            let speed = max(0.25, min(4, value.speed ?? 1))
            value.speed = speed
            value.sourceStart = max(0, min(value.sourceStart, max(0, asset.duration - 0.05)))
            value.start = max(0, min(value.start, max(0, timelineEnd - 0.05)))
            let available = min(timelineEnd - value.start, (asset.duration - value.sourceStart) / speed)
            value.duration = min(max(0.05, value.duration), available)
            guard value.duration >= 0.05 else { return nil }
            value.volume = max(0, min(1, value.volume))
            value.fadeIn = max(0, min(value.fadeIn, value.duration / 2))
            value.fadeOut = max(0, min(value.fadeOut, value.duration / 2))
            return value
        }
        normalizeOverlaySelection()
        normalizeAudioTrackSelection()
    }

    // MARK: - Project autosave

    private func projectDocument() -> ProjectDocument {
        ensureProjectCover()
        let now = Date()
        return ProjectDocument(
            projectID: projectID,
            name: projectName, createdAt: projectCreatedAt, updatedAt: now,
            timelineDuration: timelineDuration, coverPath: coverPath,
            mediaAssets: mediaAssets.map {
                StoredMediaAsset(
                    id: $0.id,
                    path: (try? ProjectDocumentStore.storedPath(for: $0.url, projectID: projectID)) ?? $0.url.path,
                    name: $0.name, duration: $0.duration, sourceIdentifier: $0.sourceIdentifier, kind: $0.kind,
                    proxyPath: $0.proxyURL.map {
                        (try? ProjectDocumentStore.storedPath(for: $0, projectID: projectID)) ?? $0.path
                    }
                )
            },
            clips: clips.map {
                StoredClip(
                    id: $0.id, assetID: $0.assetID, trimStart: $0.trimStart, trimEnd: $0.trimEnd,
                    speed: $0.speed, isMuted: $0.isMuted, colorAdjustments: $0.colorAdjustments,
                    effectProxyPath: $0.effectURL.map {
                        (try? ProjectDocumentStore.storedPath(for: $0, projectID: projectID)) ?? $0.path
                    }, speedPoints: $0.speedPoints, isReversed: $0.isReversed,
                    reverseProxyPath: $0.reverseURL.map {
                        (try? ProjectDocumentStore.storedPath(for: $0, projectID: projectID)) ?? $0.path
                    }, reverseIncludesAudio: $0.reverseIncludesAudio,
                    muteBeforeReverse: $0.muteBeforeReverse,
                    lutPath: $0.lutURL.map {
                        (try? ProjectDocumentStore.storedPath(for: $0, projectID: projectID)) ?? $0.path
                    }, lutName: $0.lutName, lutIntensity: $0.lutIntensity,
                    transform: $0.transform, transformKeyframes: $0.transformKeyframes,
                    visualEffects: $0.visualEffects, outgoingTransition: $0.outgoingTransition
                )
            },
            bgmPath: bgmURL.map {
                (try? ProjectDocumentStore.storedPath(for: $0, projectID: projectID)) ?? $0.path
            }, bgmName: bgmName,
            originalVolume: originalVolume, bgmVolume: bgmVolume,
            transitionDuration: transitionDuration, canvasFormat: canvasFormat.rawValue,
            exportSettings: StoredExportSettings(
                resolution: exportResolution.rawValue, frameRate: exportFrameRate, quality: exportQuality.rawValue
            ),
            subtitles: subtitles, overlays: overlays, audioTracks: audioTracks
        )
    }

    private func ensureProjectCover() {
        guard coverPath == nil, let thumbnail = mediaAssets.first?.thumbnail else { return }
        #if os(iOS)
        guard let data = thumbnail.jpegData(compressionQuality: 0.82),
              let url = try? ProjectDocumentStore.coverURL(for: projectID) else { return }
        do {
            try data.write(to: url, options: .atomic)
            coverPath = try ProjectDocumentStore.storedPath(for: url, projectID: projectID)
        } catch {
            // A missing cover must never prevent the actual project from saving.
        }
        #endif
    }

    private func scheduleAutosave() {
        guard !isLoadingProject, canPersistProject else { return }
        autosaveTask?.cancel()
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, let self else { return }
            let document = self.projectDocument()
            let projectID = self.projectID
            do {
                try await Task.detached(priority: .utility) {
                    try ProjectDocumentStore.save(document, projectID: projectID)
                }.value
            } catch {
                guard !Task.isCancelled else { return }
                self.statusMessage = AppLanguage.shared.isEnglish ? "Autosave failed: \(error.localizedDescription)" : "自动保存失败：\(error.localizedDescription)"
            }
        }
    }

    func saveProjectNow() {
        guard !isLoadingProject, canPersistProject else { return }
        autosaveTask?.cancel()
        do {
            try ProjectDocumentStore.save(projectDocument(), projectID: projectID)
        } catch {
            statusMessage = AppLanguage.shared.isEnglish ? "Autosave failed: \(error.localizedDescription)" : "自动保存失败：\(error.localizedDescription)"
        }
    }

    private func restoreProject() async {
        var repairedImageProxy = false
        defer {
            isLoadingProject = false
            if repairedImageProxy, canPersistProject { saveProjectNow() }
        }
        let document: ProjectDocument
        do {
            guard let loaded = try ProjectDocumentStore.load(projectID: projectID) else {
                statusMessage = AppLanguage.shared.text(
                    "无法打开草稿，工程文件不存在或版本过新",
                    "Could not open this draft because its project file is missing or newer than this app"
                )
                return
            }
            document = loaded
            canPersistProject = true
        } catch {
            statusMessage = AppLanguage.shared.isEnglish
                ? "Could not open draft: \(error.localizedDescription)"
                : "无法打开草稿：\(error.localizedDescription)"
            return
        }
        projectName = document.name ?? "未命名项目"
        projectCreatedAt = document.createdAt ?? Date()
        coverPath = document.coverPath
        var retainedURLs = Set<URL>()
        var restoredAssets: [MediaAsset] = []
        for item in document.mediaAssets {
            guard let url = try? ProjectDocumentStore.resolvedURL(for: item.path, projectID: projectID) else { continue }
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            retainedURLs.insert(url)
            let kind = item.kind ?? .video
            var proxyURL = item.proxyPath.flatMap {
                try? ProjectDocumentStore.resolvedURL(for: $0, projectID: projectID)
            }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
            if kind == .image, proxyURL == nil {
                proxyURL = try? await StillImageVideoGenerator.makeVideo(
                    from: url, duration: max(0.1, item.duration), projectID: projectID
                )
                if proxyURL != nil { repairedImageProxy = true }
            }
            if let proxyURL { retainedURLs.insert(proxyURL) }
            let thumbnail: PlatformImage?
            if kind == .image { thumbnail = PlatformImage(contentsOfFile: url.path) }
            else if kind == .video { thumbnail = await makeThumbnail(asset: AVURLAsset(url: url)) }
            else { thumbnail = nil }
            restoredAssets.append(MediaAsset(
                id: item.id, url: url, name: item.name, duration: max(0.1, item.duration),
                sourceIdentifier: item.sourceIdentifier, kind: kind, proxyURL: proxyURL, thumbnail: thumbnail
            ))
        }
        var assetsByID: [UUID: MediaAsset] = [:]
        restoredAssets = restoredAssets.filter { asset in
            guard assetsByID[asset.id] == nil else { return false }
            assetsByID[asset.id] = asset
            return true
        }
        var restoredClips = document.clips.enumerated().compactMap { index, item -> Clip? in
            guard let asset = assetsByID[item.assetID] else { return nil }
            let start = max(0, min(item.trimStart, asset.duration))
            let end = max(start, min(item.trimEnd, asset.duration))
            guard end - start >= 0.05 else { return nil }
            guard asset.kind != .audio else { return nil }
            guard asset.kind != .image || asset.proxyURL != nil else { return nil }
            let playbackURL = asset.proxyURL ?? asset.url
            var effectURL = item.effectProxyPath.flatMap {
                try? ProjectDocumentStore.resolvedURL(for: $0, projectID: projectID)
            }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
            let reverseURL = item.reverseProxyPath.flatMap {
                try? ProjectDocumentStore.resolvedURL(for: $0, projectID: projectID)
            }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
            let lutURL = item.lutPath.flatMap {
                try? ProjectDocumentStore.resolvedURL(for: $0, projectID: projectID)
            }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
            let storedLUTName = item.lutName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let lutName = storedLUTName?.isEmpty == false ? storedLUTName : item.lutPath.map {
                URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent
            }
            let lutIntensity = max(0, min(1, item.lutIntensity ?? 1))
            let wantsReverse = item.isReversed ?? false
            let reverseIncludesAudio = item.reverseIncludesAudio
            let restoredMute = wantsReverse && reverseIncludesAudio == nil
                ? (item.muteBeforeReverse ?? item.isMuted ?? false)
                : (item.isMuted ?? false)
            if wantsReverse, reverseURL == nil { effectURL = nil }
            if lutName != nil, lutIntensity > 0.001, lutURL == nil { effectURL = nil }
            let adjustments = item.colorAdjustments ?? ColorAdjustments()
            var visualEffects = item.visualEffects ?? ClipVisualEffects()
            visualEffects.vignette = max(0, min(1, visualEffects.vignette))
            visualEffects.grain = max(0, min(1, visualEffects.grain))
            let transform = Self.normalizedClipTransform(item.transform ?? ClipTransform())
            let transformKeyframes = (item.transformKeyframes ?? []).map { frame in
                let value = Self.normalizedClipTransform(frame.transform)
                return ClipTransformKeyframe(
                    id: frame.id, position: max(0, min(1, frame.position)),
                    scale: value.scale, x: value.x, y: value.y, rotation: value.rotation,
                    opacity: value.opacity, curve: frame.curve,
                    bezier: frame.curve == .custom ? (frame.bezier ?? KeyframeBezier()).normalized : nil
                )
            }.sorted { $0.position < $1.position }
            if adjustments.isIdentity && visualEffects.isIdentity &&
                (lutName == nil || lutIntensity <= 0.001) { effectURL = nil }
            if let effectURL { retainedURLs.insert(effectURL) }
            if let reverseURL { retainedURLs.insert(reverseURL) }
            if let lutURL { retainedURLs.insert(lutURL) }
            let outgoingTransition = document.resolvedOutgoingTransition(at: index)
            return Clip(id: item.id, assetID: asset.id, url: playbackURL, kind: asset.kind, sourceDuration: asset.duration,
                        trimStart: start, trimEnd: end, speed: max(0.25, min(4, item.speed ?? 1)),
                        isMuted: restoredMute, colorAdjustments: adjustments,
                        effectURL: effectURL, speedPoints: (item.speedPoints ?? []).map { point in
                            SpeedPoint(
                                id: point.id, position: max(0, min(1, point.position)),
                                speed: max(0.25, min(4, point.speed))
                            )
                        }.sorted { $0.position < $1.position },
                        isReversed: wantsReverse, reverseURL: reverseURL,
                        reverseIncludesAudio: reverseIncludesAudio, muteBeforeReverse: nil,
                        lutURL: lutURL, lutName: lutName,
                        lutIntensity: lutIntensity,
                        transform: transform, transformKeyframes: transformKeyframes,
                        visualEffects: visualEffects,
                        outgoingTransition: outgoingTransition,
                        thumbnail: asset.thumbnail)
        }
        // A transition belongs to an existing outgoing boundary. Clear a
        // formerly valid value if missing media made that clip the new tail.
        if !restoredClips.isEmpty {
            restoredClips[restoredClips.count - 1].outgoingTransition = ClipTransition()
        }
        mediaAssets = restoredAssets
        clips = restoredClips
        if let path = document.bgmPath,
           let url = try? ProjectDocumentStore.resolvedURL(for: path, projectID: projectID),
           FileManager.default.fileExists(atPath: url.path) {
            bgmURL = url
            bgmName = document.bgmName
            retainedURLs.insert(url)
        }
        if let directory = try? ProjectDocumentStore.mediaDirectory(for: projectID) {
            try? ProjectDocumentStore.cleanupMediaDirectory(directory, keeping: retainedURLs)
        }
        originalVolume = min(1, max(0, document.originalVolume))
        bgmVolume = min(1, max(0, document.bgmVolume))
        transitionDuration = max(0, min(2, document.transitionDuration))
        canvasFormat = CanvasFormat(rawValue: document.canvasFormat ?? "") ?? .portrait
        subtitles = document.subtitles.compactMap { item in
            let start = max(0, min(item.start, timelineDuration))
            let end = max(start, min(item.end, timelineDuration))
            guard !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, end - start >= 0.05 else {
                return nil
            }
            return SubtitleItem(id: item.id, text: item.text, start: start, end: end, style: item.style)
        }.sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        normalizeSubtitleSelection()
        overlays = document.overlays
        audioTracks = document.audioTracks
        normalizeTimedItems()
        if let settings = document.exportSettings {
            exportResolution = ExportResolution(rawValue: settings.resolution) ?? .fullHD
            exportFrameRate = [24, 25, 30, 50, 60].contains(settings.frameRate) ? settings.frameRate : 30
            exportQuality = ExportQuality(rawValue: settings.quality) ?? .standard
        }
        normalizeSelection()
        normalizeSpeedPointSelection()
        let reverseRepairs = clips.filter {
            $0.isReversed && ($0.reverseURL == nil || $0.reverseIncludesAudio == nil)
        }.map(\.id)
        let colorRepairs = clips.filter {
            $0.hasColorEffect && !$0.hasMissingLUT && $0.effectURL == nil &&
                (!$0.isReversed || $0.reverseURL != nil)
        }.map(\.id)
        scheduleDerivedMediaRepairs(reverseIDs: reverseRepairs, colorIDs: colorRepairs)
        if !clips.isEmpty {
            await rebuildPreview(excludedOverlayID: editableOverlayPreviewID)
            if clips.contains(where: \.hasMissingLUT) {
                statusMessage = AppLanguage.shared.text(
                    "草稿已打开，但部分 LUT 文件缺失，请重新导入",
                    "Draft opened, but one or more LUT files are missing; import them again"
                )
            } else {
                statusMessage = AppLanguage.shared.isEnglish ? "Opened \(projectName)" : "已打开：\(projectName)"
            }
        } else if !mediaAssets.isEmpty {
            statusMessage = AppLanguage.shared.isEnglish ? "Restored the media library" : "已恢复项目素材库"
        }
    }

    private func scheduleDerivedMediaRepairs(reverseIDs: [UUID], colorIDs: [UUID]) {
        guard !reverseIDs.isEmpty || !colorIDs.isEmpty else { return }
        derivedMediaRepairTask?.cancel()
        let token = beginMediaProcessing()
        derivedMediaRepairTask = Task { [weak self] in
            defer { self?.endMediaProcessing(token) }
            guard let self else { return }
            for id in reverseIDs {
                guard !Task.isCancelled else { return }
                await self.renderReverseProxy(for: id)
            }
            for id in colorIDs {
                guard !Task.isCancelled else { return }
                await self.renderColorProxy(for: id)
            }
        }
    }

    private func repairMissingDerivedMedia() {
        let reverseIDs = clips.filter {
            $0.isReversed && ($0.reverseURL == nil || $0.reverseIncludesAudio == nil) &&
                reverseRenderTasks[$0.id] == nil
        }.map(\.id)
        let colorIDs = clips.filter {
            $0.hasColorEffect && !$0.hasMissingLUT && $0.effectURL == nil &&
                (!$0.isReversed || $0.reverseURL != nil) && colorRenderTasks[$0.id] == nil
        }.map(\.id)
        scheduleDerivedMediaRepairs(reverseIDs: reverseIDs, colorIDs: colorIDs)
    }

    /// Rebuilds the preview item and loads it into the player.
    /// Building the composition is async; a newer edit may cancel us mid-flight,
    /// in which case we bail before swapping the player item.
    func rebuildPreview(
        excludedOverlayID: UUID? = nil, expectedGeneration: Int? = nil
    ) async {
        // Remember where the user was so an edit elsewhere doesn't reset playback.
        let rawTime = player.currentTime()
        // With no current item, currentTime() can be non-numeric; treat as zero.
        let previousTime = rawTime.isNumeric ? rawTime : .zero

        guard let assembled = await buildComposition(excludedOverlayID: excludedOverlayID) else {
            if Task.isCancelled { return }
            player.replaceCurrentItem(with: nil)
            statusMessage = AppLanguage.shared.text("时间线为空", "The timeline is empty")
            return
        }
        if Task.isCancelled { return }
        if let expectedGeneration, expectedGeneration != previewGeneration { return }

        let item = AVPlayerItem(asset: assembled.composition)
        item.audioMix = assembled.audioMix
        item.videoComposition = assembled.videoComposition
        player.replaceCurrentItem(with: item)

        // Keep the playhead within the (possibly shorter) new timeline.
        let total = CMTime(seconds: timelineDuration, preferredTimescale: 600)
        let target = CMTimeMinimum(previousTime, total)
        await player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        if wantsPlayback { player.play() }
        isPlaying = wantsPlayback

        statusMessage = AppLanguage.shared.isEnglish
            ? String(format: "Total duration %.1f s", timelineDuration)
            : String(format: "总时长 %.1f 秒", timelineDuration)
    }

    // MARK: - Export

    func export() async {
        guard !isExporting else { return }
        guard !isProcessingMedia else {
            statusMessage = AppLanguage.shared.text("请等待调色或倒放处理完成", "Wait for media processing to finish")
            return
        }
        guard !clips.contains(where: \.hasMissingLUT) else {
            statusMessage = AppLanguage.shared.text(
                "部分 LUT 文件缺失，请重新导入后再导出",
                "One or more LUT files are missing; import them again before exporting"
            )
            return
        }
        guard clips.allSatisfy({ clip in
            (!clip.isReversed || clip.reverseURL != nil) &&
                (!clip.hasColorEffect || clip.effectURL != nil)
        }) else {
            statusMessage = AppLanguage.shared.text(
                "部分调色或倒放媒体尚未就绪，请重试对应效果",
                "Some color or reverse media is not ready; retry the affected effect"
            )
            repairMissingDerivedMedia()
            return
        }
        let requiredBytes = Int64(estimatedExportMegabytes + 100) * 1_000_000
        if let attributes = try? FileManager.default.attributesOfFileSystem(
            forPath: FileManager.default.temporaryDirectory.path
        ), let freeBytes = attributes[.systemFreeSize] as? NSNumber, freeBytes.int64Value < requiredBytes {
            statusMessage = AppLanguage.shared.isEnglish
                ? "Not enough storage. Free at least \(estimatedExportMegabytes + 100) MB."
                : "存储空间不足，请至少释放 \(estimatedExportMegabytes + 100) MB。"
            return
        }
        let renderSize = exportRenderSize
        guard let assembled = await buildComposition(
            renderSize: renderSize, frameRate: exportFrameRate, includeSubtitles: true
        ) else {
            statusMessage = AppLanguage.shared.text("没有可导出的内容", "There is nothing to export")
            return
        }
        guard let session = AVAssetExportSession(
            asset: assembled.composition, presetName: AVAssetExportPresetHighestQuality) else {
            statusMessage = AppLanguage.shared.text("无法创建导出会话", "Could not create export session")
            return
        }

        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("MiniClip-\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: outURL)

        session.outputURL = outURL
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        if exportQuality != .high {
            let targetBytes = Double(targetExportBitrate) * max(1, timelineDuration) / 8
            session.fileLengthLimit = Int64(targetBytes * 1.1 + 2_000_000)
        }
        session.canPerformMultiplePassesOverSourceMediaData = exportQuality != .draft
        session.audioMix = assembled.audioMix
        session.videoComposition = assembled.videoComposition
        activeExportSession = session
        beginExportBackgroundTask()

        isExporting = true
        exportProgress = 0
        exportedURL = nil
        statusMessage = AppLanguage.shared.isEnglish
            ? "Exporting \(exportResolution.rawValue) · \(exportFrameRate) fps…"
            : "正在导出 \(exportResolution.rawValue) · \(exportFrameRate) fps…"

        // Poll progress while the export runs.
        let progressTask = Task { @MainActor in
            while isExporting {
                exportProgress = Double(session.progress)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }

        await session.export()
        progressTask.cancel()
        isExporting = false
        activeExportSession = nil
        endExportBackgroundTask()

        switch session.status {
        case .completed:
            exportedURL = outURL
            exportProgress = 1
            statusMessage = AppLanguage.shared.text("导出完成 ✅", "Export complete ✅")
        case .cancelled:
            statusMessage = AppLanguage.shared.text("已取消导出", "Export cancelled")
        case .failed:
            let unknownError = AppLanguage.shared.text("未知错误", "Unknown error")
            statusMessage = AppLanguage.shared.isEnglish
                ? "Export failed: \(session.error?.localizedDescription ?? unknownError)"
                : "导出失败: \(session.error?.localizedDescription ?? unknownError)"
        default:
            statusMessage = AppLanguage.shared.text("导出结束,状态未知", "Export finished with an unknown status")
        }
    }

    func cancelExport() {
        guard isExporting else { return }
        statusMessage = AppLanguage.shared.text("正在取消导出…", "Cancelling export…")
        activeExportSession?.cancelExport()
    }

    private func beginExportBackgroundTask() {
        #if os(iOS)
        guard exportBackgroundTask == .invalid else { return }
        exportBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "MiniClip Export") { [weak self] in
            Task { @MainActor [weak self] in self?.cancelExport() }
        }
        #endif
    }

    private func endExportBackgroundTask() {
        #if os(iOS)
        guard exportBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(exportBackgroundTask)
        exportBackgroundTask = .invalid
        #endif
    }

    #if os(iOS)
    func saveExportToPhotos() async {
        guard let exportedURL else {
            statusMessage = AppLanguage.shared.text("请先导出成片", "Export the video first")
            return
        }
        let permission = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard permission == .authorized || permission == .limited else {
            statusMessage = AppLanguage.shared.text("没有保存到相册的权限", "Photo library add permission was denied")
            return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: exportedURL)
            }
            statusMessage = AppLanguage.shared.text("成片已保存到系统相册 ✅", "Video saved to Photos ✅")
        } catch {
            statusMessage = AppLanguage.shared.isEnglish ? "Save failed: \(error.localizedDescription)" : "保存到相册失败：\(error.localizedDescription)"
        }
    }
    #endif
}
