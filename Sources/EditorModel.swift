import Foundation
import AVFoundation
import CoreImage
#if os(iOS)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

/// One trimmed segment of a source video that sits on the timeline.
struct Clip: Identifiable, Equatable {
    let id = UUID()
    let url: URL
    /// Full duration of the source file (seconds).
    let sourceDuration: Double
    /// Trim in-point (seconds from start of source).
    var trimStart: Double
    /// Trim out-point (seconds from start of source).
    var trimEnd: Double
    /// Small preview image for the timeline card.
    var thumbnail: PlatformImage?

    /// How long this clip plays after trimming.
    var trimmedDuration: Double { max(0, trimEnd - trimStart) }

    static func == (lhs: Clip, rhs: Clip) -> Bool { lhs.id == rhs.id }
}

/// Immutable capture of everything the user can edit. Pushed onto the
/// undo/redo stacks so any edit can be rolled back.
struct EditorSnapshot {
    var clips: [Clip]
    var bgmURL: URL?
    var bgmName: String?
    var originalVolume: Double
    var bgmVolume: Double
    var transitionDuration: Double
}

/// Holds all editor state and does the AVFoundation heavy lifting.
/// Marked @MainActor so every published change happens on the UI thread.
@MainActor
final class EditorModel: ObservableObject {
    @Published var clips: [Clip] = []
    @Published var exportedURL: URL?
    @Published var isExporting = false
    @Published var exportProgress: Double = 0
    @Published var statusMessage: String = AppLanguage.shared.text("导入一段视频开始", "Import a video to get started")

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

    /// The in-flight preview rebuild. Cancelled and replaced whenever a newer
    /// edit arrives so rapid changes don't pile up concurrent recompositions.
    private var previewTask: Task<Void, Never>?

    // MARK: - History

    /// Snapshot of the current editable state.
    private func currentSnapshot() -> EditorSnapshot {
        EditorSnapshot(clips: clips,
                       bgmURL: bgmURL,
                       bgmName: bgmName,
                       originalVolume: originalVolume,
                       bgmVolume: bgmVolume,
                       transitionDuration: transitionDuration)
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
        clips = s.clips
        bgmURL = s.bgmURL
        bgmName = s.bgmName
        originalVolume = s.originalVolume
        bgmVolume = s.bgmVolume
        transitionDuration = s.transitionDuration
    }

    private func refreshHistoryFlags() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
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

    /// Called with URLs coming from the file importer.
    func importVideos(urls: [URL]) async {
        guard !urls.isEmpty else { return }
        recordUndo()
        for url in urls {
            await addClip(from: url)
        }
        schedulePreviewRebuild(debounceMillis: 0)
    }

    private func addClip(from url: URL) async {
        // Files picked from outside the sandbox need explicit access.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0 else {
                statusMessage = AppLanguage.shared.text("无法读取该文件的时长", "Could not read this file's duration")
                return
            }
            var clip = Clip(url: url,
                            sourceDuration: seconds,
                            trimStart: 0,
                            trimEnd: seconds,
                            thumbnail: nil)
            clip.thumbnail = await makeThumbnail(asset: asset)
            clips.append(clip)
            statusMessage = AppLanguage.shared.isEnglish ? "Added \(clips.count) video clip(s)" : "已添加 \(clips.count) 段视频"
        } catch {
            statusMessage = AppLanguage.shared.isEnglish ? "Import failed: \(error.localizedDescription)" : "导入失败: \(error.localizedDescription)"
        }
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
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0 else {
                statusMessage = AppLanguage.shared.text("无法读取该音频的时长", "Could not read this audio file's duration")
                return
            }
            recordUndo()
            bgmURL = url
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

    func delete(_ clip: Clip) {
        guard clips.contains(where: { $0.id == clip.id }) else { return }
        recordUndo()
        clips.removeAll { $0.id == clip.id }
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func move(_ clip: Clip, by offset: Int) {
        guard let i = clips.firstIndex(of: clip) else { return }
        let j = i + offset
        guard j >= 0, j < clips.count else { return }
        recordUndo()
        clips.swapAt(i, j)
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
        schedulePreviewRebuild(debounceMillis: 0)
    }

    func setTransition(_ seconds: Double) {
        // Continuous slider: pre-drag snapshot comes from beginInteractiveEdit().
        transitionDuration = max(0, seconds)
        schedulePreviewRebuild()
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

    var totalDuration: Double { clips.reduce(0) { $0 + $1.trimmedDuration } }

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
        let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

        var cursor = CMTime.zero

        for clip in clips {
            let asset = AVURLAsset(url: clip.url)
            let scoped = clip.url.startAccessingSecurityScopedResource()
            defer { if scoped { clip.url.stopAccessingSecurityScopedResource() } }

            let start = cmt(clip.trimStart)
            let dur = cmt(clip.trimmedDuration)
            let range = CMTimeRange(start: start, duration: dur)

            do {
                if let srcV = try await asset.loadTracks(withMediaType: .video).first {
                    try videoTrack?.insertTimeRange(range, of: srcV, at: cursor)
                    // Preserve orientation from the source track.
                    if let t = try? await srcV.load(.preferredTransform) {
                        videoTrack?.preferredTransform = t
                    }
                }
                if let srcA = try await asset.loadTracks(withMediaType: .audio).first {
                    try audioTrack?.insertTimeRange(range, of: srcA, at: cursor)
                }
                cursor = CMTimeAdd(cursor, dur)
            } catch {
                statusMessage = AppLanguage.shared.isEnglish ? "Composition failed: \(error.localizedDescription)" : "合成失败: \(error.localizedDescription)"
            }
        }

        // `cursor` now equals the full timeline length.
        let bgmTrack = await addBGMTrack(to: composition, coveringUpTo: cursor)
        let audioMix = makeAudioMix(originalTrack: audioTrack, bgmTrack: bgmTrack)

        return Assembled(composition: composition, audioMix: audioMix, videoComposition: nil)
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
        var renderSize: CGSize?

        for clip in clips {
            let asset = AVURLAsset(url: clip.url)
            let scoped = clip.url.startAccessingSecurityScopedResource()
            defer { if scoped { clip.url.stopAccessingSecurityScopedResource() } }

            guard let srcV = try? await asset.loadTracks(withMediaType: .video).first else {
                continue  // skip audio-only inputs in transition mode
            }
            let transform = (try? await srcV.load(.preferredTransform)) ?? .identity
            let naturalSize = (try? await srcV.load(.naturalSize)) ?? CGSize(width: 1280, height: 720)

            // Track assignment is based on placement order, so skipped clips
            // never break the strict A/B alternation.
            let trackIndex = placements.count % 2
            let startCM = cmt(cursorSeconds)
            let durCM = cmt(clip.trimmedDuration)
            let range = CMTimeRange(start: cmt(clip.trimStart), duration: durCM)

            do {
                try videoTracks[trackIndex].insertTimeRange(range, of: srcV, at: startCM)
            } catch {
                continue
            }
            if let srcA = try? await asset.loadTracks(withMediaType: .audio).first {
                try? audioTracks[trackIndex]?.insertTimeRange(range, of: srcA, at: startCM)
            }

            placements.append(Placement(start: startCM, dur: durCM,
                                        trackIndex: trackIndex,
                                        videoTrack: videoTracks[trackIndex],
                                        transform: transform))
            if renderSize == nil {
                renderSize = self.renderSize(natural: naturalSize, transform: transform)
            }
            // Next clip starts T earlier so the two overlap.
            cursorSeconds += clip.trimmedDuration - T
        }

        // Need at least two placed clips to dissolve; otherwise fall back.
        guard placements.count >= 2 else { return nil }

        let videoComposition = makeVideoComposition(placements: placements,
                                                     transition: Tcm,
                                                     renderSize: renderSize ?? CGSize(width: 1280, height: 720))

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

    /// Applies a transform to a natural size and returns the resulting (positive)
    /// dimensions — used to pick a render size that respects rotation.
    private func renderSize(natural: CGSize, transform: CGAffineTransform) -> CGSize {
        let rect = CGRect(origin: .zero, size: natural).applying(transform)
        return CGSize(width: abs(rect.width), height: abs(rect.height))
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
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            if debounceMillis > 0 {
                try? await Task.sleep(nanoseconds: debounceMillis * 1_000_000)
            }
            if Task.isCancelled { return }
            await self?.rebuildPreview()
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
        let total = CMTime(seconds: totalDuration, preferredTimescale: 600)
        let target = CMTimeMinimum(previousTime, total)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        if wasPlaying { player.play() }

        statusMessage = AppLanguage.shared.isEnglish
            ? String(format: "Total duration %.1f s", totalDuration)
            : String(format: "总时长 %.1f 秒", totalDuration)
    }

    // MARK: - Export

    func export() async {
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

        switch session.status {
        case .completed:
            exportedURL = outURL
            exportProgress = 1
            statusMessage = AppLanguage.shared.text("导出完成 ✅", "Export complete ✅")
        case .failed, .cancelled:
            let unknownError = AppLanguage.shared.text("未知错误", "Unknown error")
            statusMessage = AppLanguage.shared.isEnglish
                ? "Export failed: \(session.error?.localizedDescription ?? unknownError)"
                : "导出失败: \(session.error?.localizedDescription ?? unknownError)"
        default:
            statusMessage = AppLanguage.shared.text("导出结束,状态未知", "Export finished with an unknown status")
        }
    }
}
