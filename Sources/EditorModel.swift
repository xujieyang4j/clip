import Foundation
import AVFoundation
import CoreImage
#if os(iOS)
import UIKit
import Photos
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
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
}

/// One reusable source video in the project's media library.
struct MediaAsset: Identifiable, Equatable {
    let id: UUID
    let url: URL
    let name: String
    let duration: Double
    let sourceIdentifier: String
    var thumbnail: PlatformImage?

    static func == (lhs: MediaAsset, rhs: MediaAsset) -> Bool { lhs.id == rhs.id }
}

/// One trimmed use of a source video that sits on the timeline.
struct Clip: Identifiable, Equatable {
    let id: UUID
    let assetID: UUID
    let url: URL
    /// Full duration of the source file (seconds).
    let sourceDuration: Double
    /// Trim in-point (seconds from start of source).
    var trimStart: Double
    /// Trim out-point (seconds from start of source).
    var trimEnd: Double
    /// Playback speed. The exported duration is source trim duration / speed.
    var speed: Double
    var isMuted: Bool
    /// Small preview image for the timeline card.
    var thumbnail: PlatformImage?

    /// How long this clip plays after trimming.
    var sourceTrimDuration: Double { max(0, trimEnd - trimStart) }
    var trimmedDuration: Double { sourceTrimDuration / max(0.25, min(4, speed)) }

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
}

/// Holds all editor state and does the AVFoundation heavy lifting.
/// Marked @MainActor so every published change happens on the UI thread.
@MainActor
final class EditorModel: ObservableObject {
    @Published var mediaAssets: [MediaAsset] = []
    @Published var clips: [Clip] = []
    @Published var selectedClipID: UUID?
    @Published var exportedURL: URL?
    @Published var isImporting = false
    @Published var importProgress: Double = 0
    @Published var isExporting = false
    @Published var exportProgress: Double = 0
    @Published var statusMessage: String = AppLanguage.shared.text("导入一段视频开始", "Import a video to get started")
    @Published var playheadSeconds: Double = 0
    @Published var isPlaying = false

    var isBusy: Bool { isImporting || isExporting }

    // MARK: - Background music
    /// Optional background music track. Loops to cover the whole timeline.
    @Published var bgmURL: URL?
    @Published var bgmName: String?
    /// Volume of the clips' own audio, 0…1.
    @Published var originalVolume: Double = 1.0
    /// Volume of the background music, 0…1.
    @Published var bgmVolume: Double = 0.5

    // MARK: - Transition
    /// Cross-dissolve duration between adjacent clips, in seconds.
    /// 0 means hard cuts (no transition). Adjacent clips overlap by this amount.
    @Published var transitionDuration: Double = 0
    @Published var canvasFormat: CanvasFormat = .portrait

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
    private var playerTimeObserver: Any?
    private var playerEndObserver: NSObjectProtocol?

    /// The in-flight preview rebuild. Cancelled and replaced whenever a newer
    /// edit arrives so rapid changes don't pile up concurrent recompositions.
    private var previewTask: Task<Void, Never>?
    private var autosaveTask: Task<Void, Never>?
    private var activeExportSession: AVAssetExportSession?
    #if os(iOS)
    private var exportBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    #endif

    init() {
        playerTimeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let seconds = CMTimeGetSeconds(time)
                if seconds.isFinite { self.playheadSeconds = max(0, seconds) }
                self.isPlaying = self.player.rate > 0
            }
        }
        playerEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] note in
            Task { @MainActor [weak self] in
                guard let self, let ended = note.object as? AVPlayerItem, ended === self.player.currentItem else { return }
                self.player.pause()
                self.isPlaying = false
                self.seek(to: 0)
            }
        }
        Task { [weak self] in await self?.restoreAutosave() }
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
                       canvasFormat: canvasFormat)
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
        normalizeSelection()
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

    var selectedClip: Clip? {
        clips.first { $0.id == selectedClipID }
    }

    func select(_ clip: Clip) {
        guard clips.contains(where: { $0.id == clip.id }) else { return }
        selectedClipID = clip.id
    }

    func startNewProject() {
        guard !isBusy else {
            statusMessage = AppLanguage.shared.text("请等待当前任务完成", "Wait for the current task to finish")
            return
        }
        pausePlayback()
        previewTask?.cancel()
        autosaveTask?.cancel()
        player.replaceCurrentItem(with: nil)
        mediaAssets = []
        clips = []
        selectedClipID = nil
        bgmURL = nil
        bgmName = nil
        originalVolume = 1
        bgmVolume = 0.5
        transitionDuration = 0
        canvasFormat = .portrait
        playheadSeconds = 0
        exportedURL = nil
        exportProgress = 0
        undoStack.removeAll()
        redoStack.removeAll()
        refreshHistoryFlags()
        statusMessage = AppLanguage.shared.text("已新建空白项目", "Created a new project")
        saveProjectNow()
        try? ProjectDocumentStore.cleanupMediaDirectory(keeping: [])
    }

    /// Records a pre-edit snapshot for a continuous gesture (slider drag).
    /// Called once at drag start so the whole drag collapses into one undo step.
    func beginInteractiveEdit() {
        recordUndo()
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(currentSnapshot())
        apply(previous)
        refreshHistoryFlags()
        statusMessage = AppLanguage.shared.text("已撤销", "Undone")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(currentSnapshot())
        apply(next)
        refreshHistoryFlags()
        statusMessage = AppLanguage.shared.text("已重做", "Redone")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    // MARK: - Import

    /// Called with URLs coming from PhotosPicker or the Files document picker.
    /// Every source is copied into the app sandbox first, so later previews and
    /// exports never depend on a temporary picker URL or a stale security scope.
    func importVideos(urls: [URL], sourceIdentifiers: [String]? = nil, displayNames: [String]? = nil, addToTimeline: Bool = true) async {
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
            if let existing = mediaAssets.first(where: { $0.sourceIdentifier == identifier }) {
                reused.append(existing)
                continue
            }
            do {
                imported.append(try await makeMediaAsset(from: url, sourceIdentifier: identifier, displayName: displayName))
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
            clips.append(contentsOf: available.map(makeClip))
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

    private func makeMediaAsset(from sourceURL: URL, sourceIdentifier: String, displayName: String) async throws -> MediaAsset {
        let scoped = sourceURL.startAccessingSecurityScopedResource()
        defer { if scoped { sourceURL.stopAccessingSecurityScopedResource() } }
        let url = try await Task.detached(priority: .userInitiated) {
            try Self.persistImportedFile(sourceURL)
        }.value
        do {
            let avAsset = AVURLAsset(url: url)
            let duration = try await avAsset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0, !(try await avAsset.loadTracks(withMediaType: .video)).isEmpty else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return MediaAsset(
                id: UUID(), url: url, name: displayName, duration: seconds,
                sourceIdentifier: sourceIdentifier, thumbnail: await makeThumbnail(asset: avAsset)
            )
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    nonisolated private static func persistImportedFile(_ sourceURL: URL) throws -> URL {
        let fileManager = FileManager.default
        let root = try ProjectDocumentStore.rootDirectory(fileManager: fileManager)
            .appendingPathComponent("Media", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
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
        Clip(id: UUID(), assetID: asset.id, url: asset.url, sourceDuration: asset.duration,
             trimStart: 0, trimEnd: asset.duration, speed: 1, isMuted: false, thumbnail: asset.thumbnail)
    }

    func addAssetToTimeline(_ asset: MediaAsset) {
        guard mediaAssets.contains(where: { $0.id == asset.id }) else { return }
        recordUndo()
        let clip = makeClip(from: asset)
        clips.append(clip)
        selectedClipID = clip.id
        statusMessage = AppLanguage.shared.isEnglish ? "Added to timeline: \(asset.name)" : "已加入时间线：\(asset.name)"
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func mediaUsageCount(_ asset: MediaAsset) -> Int {
        clips.filter { $0.assetID == asset.id }.count
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
            let localURL = try await Task.detached(priority: .userInitiated) {
                try Self.persistImportedFile(url)
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
        if player.rate > 0 {
            player.pause()
            isPlaying = false
        } else {
            if playheadSeconds >= max(0, timelineDuration - 0.05) { seek(to: 0) }
            player.play()
            isPlaying = true
        }
    }

    func pausePlayback() {
        player.pause()
        isPlaying = false
    }

    func seek(to seconds: Double) {
        let bounded = max(0, min(seconds, timelineDuration))
        player.seek(
            to: CMTime(seconds: bounded, preferredTimescale: 600),
            toleranceBefore: .zero, toleranceAfter: .zero
        )
        playheadSeconds = bounded
    }

    func splitSelectedClipAtPlayhead() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        let clip = clips[index]
        guard let sourceSplit = TimelineMath.splitSourceTime(
            playhead: playheadSeconds, clipIndex: index, trimStart: clip.trimStart, trimEnd: clip.trimEnd,
            speed: clip.speed, durations: clips.map(\.trimmedDuration), transition: transitionDuration
        ) else {
            statusMessage = AppLanguage.shared.text("请把播放头移到片段内部再分割", "Move the playhead inside the clip before splitting")
            return
        }
        recordUndo()
        var left = clip
        left.trimEnd = sourceSplit
        let right = Clip(id: UUID(), assetID: clip.assetID, url: clip.url, sourceDuration: clip.sourceDuration,
                         trimStart: sourceSplit, trimEnd: clip.trimEnd, speed: clip.speed, isMuted: clip.isMuted, thumbnail: clip.thumbnail)
        clips.replaceSubrange(index...index, with: [left, right])
        self.selectedClipID = right.id
        statusMessage = AppLanguage.shared.text("已在播放头分割片段", "Split clip at the playhead")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func duplicateSelectedClip() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        let source = clips[index]
        let copy = Clip(id: UUID(), assetID: source.assetID, url: source.url, sourceDuration: source.sourceDuration,
                        trimStart: source.trimStart, trimEnd: source.trimEnd, speed: source.speed, isMuted: source.isMuted, thumbnail: source.thumbnail)
        clips.insert(copy, at: index + 1)
        self.selectedClipID = copy.id
        statusMessage = AppLanguage.shared.text("已复制片段", "Duplicated clip")
        schedulePreviewRebuild(debounceMillis: 0)
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
        // Continuous slider: pre-drag snapshot comes from beginInteractiveEdit().
        transitionDuration = max(0, seconds)
        schedulePreviewRebuild()
    }

    func setCanvasFormat(_ format: CanvasFormat) {
        guard canvasFormat != format else { return }
        recordUndo()
        canvasFormat = format
        statusMessage = AppLanguage.shared.isEnglish ? "Canvas: \(format.rawValue)" : "画布比例：\(format.rawValue)"
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

    func toggleMuteSelectedClip() {
        guard let selectedClipID, let index = clips.firstIndex(where: { $0.id == selectedClipID }) else { return }
        recordUndo()
        clips[index].isMuted.toggle()
        statusMessage = clips[index].isMuted
            ? AppLanguage.shared.text("已静音片段原声", "Muted clip audio")
            : AppLanguage.shared.text("已恢复片段原声", "Restored clip audio")
        schedulePreviewRebuild(debounceMillis: 0)
    }

    var totalDuration: Double { clips.reduce(0) { $0 + $1.trimmedDuration } }

    private var effectiveTransitionDuration: Double {
        TimelineMath.effectiveTransitionDuration(durations: clips.map(\.trimmedDuration), requested: transitionDuration)
    }

    var timelineDuration: Double {
        TimelineMath.timelineDuration(durations: clips.map(\.trimmedDuration), transition: transitionDuration)
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

    /// Picks the concatenation strategy: hard cuts (fast, single track) when no
    /// transition is set, or a cross-dissolve build when the user wants fades.
    private func buildComposition() async -> Assembled? {
        guard !clips.isEmpty else { return nil }
        if transitionDuration > 0, clips.count >= 2 {
            if let crossfade = await buildCrossfadeComposition(transition: transitionDuration) {
                return crossfade
            }
        }
        return await buildSimpleComposition()
    }

    /// Concatenates all clips (in order, after trimming) into one composition
    /// with hard cuts, then overlays looping background music if one is set.
    private func buildSimpleComposition() async -> Assembled? {
        guard !clips.isEmpty else { return nil }

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        var cursor = CMTime.zero
        var placements: [Placement] = []
        let canvasSize = canvasFormat.renderSize

        for clip in clips {
            let asset = AVURLAsset(url: clip.url)
            let scoped = clip.url.startAccessingSecurityScopedResource()
            defer { if scoped { clip.url.stopAccessingSecurityScopedResource() } }

            let start = cmt(clip.trimStart)
            let sourceDur = cmt(clip.sourceTrimDuration)
            let outputDur = cmt(clip.trimmedDuration)
            let range = CMTimeRange(start: start, duration: sourceDur)

            do {
                guard let srcV = try await asset.loadTracks(withMediaType: .video).first else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                try videoTrack.insertTimeRange(range, of: srcV, at: cursor)
                videoTrack.scaleTimeRange(CMTimeRange(start: cursor, duration: sourceDur), toDuration: outputDur)
                let preferred = (try? await srcV.load(.preferredTransform)) ?? .identity
                let natural = (try? await srcV.load(.naturalSize)) ?? canvasSize
                placements.append(Placement(
                    start: cursor, dur: outputDur, trackIndex: 0, videoTrack: videoTrack,
                    transform: aspectFitTransform(natural: natural, preferred: preferred, canvas: canvasSize)
                ))
                if !clip.isMuted, let srcA = try await asset.loadTracks(withMediaType: .audio).first {
                    try audioTrack?.insertTimeRange(range, of: srcA, at: cursor)
                    audioTrack?.scaleTimeRange(CMTimeRange(start: cursor, duration: sourceDur), toDuration: outputDur)
                }
                cursor = CMTimeAdd(cursor, outputDur)
            } catch {
                statusMessage = AppLanguage.shared.isEnglish ? "Composition failed: \(error.localizedDescription)" : "合成失败: \(error.localizedDescription)"
                return nil
            }
        }

        // `cursor` now equals the full timeline length.
        let bgmTrack = await addBGMTrack(to: composition, coveringUpTo: cursor)
        let audioMix = makeAudioMix(originalTrack: audioTrack, bgmTrack: bgmTrack)

        let videoComposition = makeCutVideoComposition(placements: placements, renderSize: canvasSize)
        return Assembled(composition: composition, audioMix: audioMix, videoComposition: videoComposition)
    }

    /// One clip successfully placed on the timeline, with the metadata the
    /// video-composition instructions need.
    private struct Placement {
        let start: CMTime
        let dur: CMTime
        let trackIndex: Int          // 0 or 1 — clips alternate between two tracks
        let videoTrack: AVMutableCompositionTrack
        let transform: CGAffineTransform
    }

    /// Builds a composition where adjacent clips overlap by `rawT` seconds and
    /// cross-dissolve. Uses two alternating video tracks so neighbours can be on
    /// screen at once, plus an AVVideoComposition with opacity ramps for the
    /// dissolve and an audio mix with matching volume ramps. Returns nil to let
    /// the caller fall back to hard cuts (e.g. clips too short to overlap).
    private func buildCrossfadeComposition(transition rawT: Double) async -> Assembled? {
        // Clamp the transition so every clip keeps a non-negative solo region:
        // interior clips need dur >= 2T, so T <= shortestClip / 2.
        let shortest = clips.map { $0.trimmedDuration }.min() ?? 0
        let T = max(0, min(rawT, shortest / 2))
        guard T > 0 else { return nil }
        let Tcm = cmt(T)

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
        let canvasSize = canvasFormat.renderSize

        for clip in clips {
            let asset = AVURLAsset(url: clip.url)
            let scoped = clip.url.startAccessingSecurityScopedResource()
            defer { if scoped { clip.url.stopAccessingSecurityScopedResource() } }

            guard let srcV = try? await asset.loadTracks(withMediaType: .video).first else {
                continue  // skip audio-only inputs in transition mode
            }
            let preferred = (try? await srcV.load(.preferredTransform)) ?? .identity
            let naturalSize = (try? await srcV.load(.naturalSize)) ?? CGSize(width: 1280, height: 720)
            let transform = aspectFitTransform(natural: naturalSize, preferred: preferred, canvas: canvasSize)

            // Track assignment is based on placement order, so skipped clips
            // never break the strict A/B alternation.
            let trackIndex = placements.count % 2
            let startCM = cmt(cursorSeconds)
            let sourceDurCM = cmt(clip.sourceTrimDuration)
            let outputDurCM = cmt(clip.trimmedDuration)
            let range = CMTimeRange(start: cmt(clip.trimStart), duration: sourceDurCM)

            do {
                try videoTracks[trackIndex].insertTimeRange(range, of: srcV, at: startCM)
                videoTracks[trackIndex].scaleTimeRange(
                    CMTimeRange(start: startCM, duration: sourceDurCM), toDuration: outputDurCM
                )
            } catch {
                continue
            }
            if !clip.isMuted, let srcA = try? await asset.loadTracks(withMediaType: .audio).first {
                try? audioTracks[trackIndex]?.insertTimeRange(range, of: srcA, at: startCM)
                audioTracks[trackIndex]?.scaleTimeRange(
                    CMTimeRange(start: startCM, duration: sourceDurCM), toDuration: outputDurCM
                )
            }

            placements.append(Placement(start: startCM, dur: outputDurCM,
                                        trackIndex: trackIndex,
                                        videoTrack: videoTracks[trackIndex],
                                        transform: transform))
            // Next clip starts T earlier so the two overlap.
            cursorSeconds += clip.trimmedDuration - T
        }

        // Need at least two placed clips to dissolve; otherwise fall back.
        guard placements.count >= 2 else { return nil }

        let videoComposition = makeVideoComposition(placements: placements,
                                                     transition: Tcm,
                                                     renderSize: canvasSize)

        // Total timeline length = last clip's placement end.
        let last = placements[placements.count - 1]
        let total = CMTimeAdd(last.start, last.dur)
        let bgmTrack = await addBGMTrack(to: composition, coveringUpTo: total)
        let audioMix = makeCrossfadeAudioMix(placements: placements,
                                             audioTracks: audioTracks,
                                             transition: Tcm,
                                             bgmTrack: bgmTrack)

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

    private func makeCutVideoComposition(placements: [Placement], renderSize: CGSize) -> AVMutableVideoComposition {
        let instructions = placements.map { placement -> AVMutableVideoCompositionInstruction in
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: placement.start, duration: placement.dur)
            instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
            let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: placement.videoTrack)
            layer.setTransform(placement.transform, at: placement.start)
            instruction.layerInstructions = [layer]
            return instruction
        }
        let composition = AVMutableVideoComposition()
        composition.instructions = instructions
        composition.frameDuration = CMTime(value: 1, timescale: 30)
        composition.renderSize = renderSize
        return composition
    }

    /// Builds the opacity-ramp instructions that produce the cross-dissolves.
    private func makeVideoComposition(placements: [Placement],
                                      transition Tcm: CMTime,
                                      renderSize: CGSize) -> AVMutableVideoComposition {
        let n = placements.count
        var instructions: [AVMutableVideoCompositionInstruction] = []

        for i in 0..<n {
            let p = placements[i]
            // Solo region: only this clip is visible (full opacity).
            let soloStart = (i == 0) ? p.start : CMTimeAdd(p.start, Tcm)
            let soloEnd = (i == n - 1) ? CMTimeAdd(p.start, p.dur) : placements[i + 1].start
            if soloEnd > soloStart {
                let inst = AVMutableVideoCompositionInstruction()
                inst.timeRange = CMTimeRange(start: soloStart, end: soloEnd)
                inst.backgroundColor = CGColor(gray: 0, alpha: 1)
                let li = AVMutableVideoCompositionLayerInstruction(assetTrack: p.videoTrack)
                li.setTransform(p.transform, at: soloStart)
                inst.layerInstructions = [li]
                instructions.append(inst)
            }
            // Transition region: outgoing clip on top fades out, revealing next.
            if i < n - 1 {
                let next = placements[i + 1]
                let transRange = CMTimeRange(start: next.start,
                                             end: CMTimeAdd(next.start, Tcm))
                let inst = AVMutableVideoCompositionInstruction()
                inst.timeRange = transRange
                inst.backgroundColor = CGColor(gray: 0, alpha: 1)

                let fromLI = AVMutableVideoCompositionLayerInstruction(assetTrack: p.videoTrack)
                fromLI.setTransform(p.transform, at: transRange.start)
                fromLI.setOpacityRamp(fromStartOpacity: 1, toEndOpacity: 0, timeRange: transRange)

                let toLI = AVMutableVideoCompositionLayerInstruction(assetTrack: next.videoTrack)
                toLI.setTransform(next.transform, at: transRange.start)

                inst.layerInstructions = [fromLI, toLI]  // from is listed first = on top
                instructions.append(inst)
            }
        }

        let vc = AVMutableVideoComposition()
        vc.instructions = instructions
        vc.frameDuration = CMTime(value: 1, timescale: 30)
        vc.renderSize = renderSize
        return vc
    }

    /// Audio mix for the crossfade path: each clip fades its own audio in/out
    /// across the overlap, and the BGM (if any) plays at a constant level.
    private func makeCrossfadeAudioMix(placements: [Placement],
                                       audioTracks: [AVMutableCompositionTrack?],
                                       transition Tcm: CMTime,
                                       bgmTrack: AVMutableCompositionTrack?) -> AVAudioMix? {
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
                if i > 0 {
                    p.setVolumeRamp(fromStartVolume: 0, toEndVolume: v,
                                    timeRange: CMTimeRange(start: pl.start,
                                                           end: CMTimeAdd(pl.start, Tcm)))
                } else {
                    p.setVolume(v, at: pl.start)
                }
                if i < n - 1 {
                    p.setVolumeRamp(fromStartVolume: v, toEndVolume: 0,
                                    timeRange: CMTimeRange(start: CMTimeSubtract(end, Tcm),
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

    /// Builds an audio mix that applies the original / BGM volume levels.
    private func makeAudioMix(originalTrack: AVMutableCompositionTrack?,
                              bgmTrack: AVMutableCompositionTrack?) -> AVAudioMix? {
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
        guard !params.isEmpty else { return nil }
        let mix = AVMutableAudioMix()
        mix.inputParameters = params
        return mix
    }

    /// Schedules a preview rebuild, cancelling any pending one. A short debounce
    /// coalesces bursts of edits (e.g. slider drags) into a single recomposition.
    /// Discrete edits pass `debounceMillis: 0` for an immediate refresh.
    private func schedulePreviewRebuild(debounceMillis: UInt64 = 120) {
        scheduleAutosave()
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            if debounceMillis > 0 {
                try? await Task.sleep(nanoseconds: debounceMillis * 1_000_000)
            }
            if Task.isCancelled { return }
            await self?.rebuildPreview()
        }
    }

    // MARK: - Project autosave

    private func projectDocument() -> ProjectDocument {
        ProjectDocument(
            mediaAssets: mediaAssets.map {
                StoredMediaAsset(id: $0.id, path: (try? ProjectDocumentStore.storedPath(for: $0.url)) ?? $0.url.path, name: $0.name, duration: $0.duration, sourceIdentifier: $0.sourceIdentifier)
            },
            clips: clips.map {
                StoredClip(id: $0.id, assetID: $0.assetID, trimStart: $0.trimStart, trimEnd: $0.trimEnd, speed: $0.speed, isMuted: $0.isMuted)
            },
            bgmPath: bgmURL.map { (try? ProjectDocumentStore.storedPath(for: $0)) ?? $0.path }, bgmName: bgmName,
            originalVolume: originalVolume, bgmVolume: bgmVolume,
            transitionDuration: transitionDuration, canvasFormat: canvasFormat.rawValue
        )
    }

    private func scheduleAutosave() {
        autosaveTask?.cancel()
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, let document = self?.projectDocument() else { return }
            do {
                try await Task.detached(priority: .utility) {
                    try ProjectDocumentStore.save(document)
                }.value
            } catch {
                guard !Task.isCancelled else { return }
                self?.statusMessage = AppLanguage.shared.isEnglish ? "Autosave failed: \(error.localizedDescription)" : "自动保存失败：\(error.localizedDescription)"
            }
        }
    }

    func saveProjectNow() {
        autosaveTask?.cancel()
        do {
            try ProjectDocumentStore.save(projectDocument())
        } catch {
            statusMessage = AppLanguage.shared.isEnglish ? "Autosave failed: \(error.localizedDescription)" : "自动保存失败：\(error.localizedDescription)"
        }
    }

    private func restoreAutosave() async {
        guard let document = try? ProjectDocumentStore.load() else { return }
        var retainedURLs = Set<URL>()
        var restoredAssets: [MediaAsset] = []
        for item in document.mediaAssets {
            guard let url = try? ProjectDocumentStore.resolvedURL(for: item.path) else { continue }
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            retainedURLs.insert(url)
            let thumbnail = await makeThumbnail(asset: AVURLAsset(url: url))
            restoredAssets.append(MediaAsset(
                id: item.id, url: url, name: item.name, duration: max(0.1, item.duration),
                sourceIdentifier: item.sourceIdentifier, thumbnail: thumbnail
            ))
        }
        var assetsByID: [UUID: MediaAsset] = [:]
        restoredAssets = restoredAssets.filter { asset in
            guard assetsByID[asset.id] == nil else { return false }
            assetsByID[asset.id] = asset
            return true
        }
        let restoredClips = document.clips.compactMap { item -> Clip? in
            guard let asset = assetsByID[item.assetID] else { return nil }
            let start = max(0, min(item.trimStart, asset.duration))
            let end = max(start, min(item.trimEnd, asset.duration))
            guard end - start >= 0.05 else { return nil }
            return Clip(id: item.id, assetID: asset.id, url: asset.url, sourceDuration: asset.duration,
                        trimStart: start, trimEnd: end, speed: max(0.25, min(4, item.speed ?? 1)),
                        isMuted: item.isMuted ?? false, thumbnail: asset.thumbnail)
        }
        mediaAssets = restoredAssets
        clips = restoredClips
        if let path = document.bgmPath, let url = try? ProjectDocumentStore.resolvedURL(for: path), FileManager.default.fileExists(atPath: url.path) {
            bgmURL = url
            bgmName = document.bgmName
            retainedURLs.insert(url)
        }
        try? ProjectDocumentStore.cleanupMediaDirectory(keeping: retainedURLs)
        originalVolume = min(1, max(0, document.originalVolume))
        bgmVolume = min(1, max(0, document.bgmVolume))
        transitionDuration = max(0, min(2, document.transitionDuration))
        canvasFormat = CanvasFormat(rawValue: document.canvasFormat ?? "") ?? .portrait
        normalizeSelection()
        if !clips.isEmpty {
            await rebuildPreview()
            statusMessage = AppLanguage.shared.isEnglish ? "Restored the last project" : "已恢复上次编辑的项目"
        } else if !mediaAssets.isEmpty {
            statusMessage = AppLanguage.shared.isEnglish ? "Restored the media library" : "已恢复项目素材库"
        }
    }

    /// Rebuilds the preview item and loads it into the player.
    /// Building the composition is async; a newer edit may cancel us mid-flight,
    /// in which case we bail before swapping the player item.
    func rebuildPreview() async {
        // Remember where the user was so an edit elsewhere doesn't reset playback.
        let wasPlaying = player.rate > 0
        let rawTime = player.currentTime()
        // With no current item, currentTime() can be non-numeric; treat as zero.
        let previousTime = rawTime.isNumeric ? rawTime : .zero

        guard let assembled = await buildComposition() else {
            if Task.isCancelled { return }
            player.replaceCurrentItem(with: nil)
            statusMessage = AppLanguage.shared.text("时间线为空", "The timeline is empty")
            return
        }
        if Task.isCancelled { return }

        let item = AVPlayerItem(asset: assembled.composition)
        item.audioMix = assembled.audioMix
        item.videoComposition = assembled.videoComposition
        player.replaceCurrentItem(with: item)

        // Keep the playhead within the (possibly shorter) new timeline.
        let total = CMTime(seconds: timelineDuration, preferredTimescale: 600)
        let target = CMTimeMinimum(previousTime, total)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        if wasPlaying { player.play() }

        statusMessage = AppLanguage.shared.isEnglish
            ? String(format: "Total duration %.1f s", timelineDuration)
            : String(format: "总时长 %.1f 秒", timelineDuration)
    }

    // MARK: - Export

    func export() async {
        guard !isExporting else { return }
        guard let assembled = await buildComposition() else {
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
        session.audioMix = assembled.audioMix
        session.videoComposition = assembled.videoComposition
        activeExportSession = session
        beginExportBackgroundTask()

        isExporting = true
        exportProgress = 0
        exportedURL = nil
        statusMessage = AppLanguage.shared.text("正在导出…", "Exporting…")

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
