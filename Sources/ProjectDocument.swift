import Foundation

enum MediaKind: String, Codable, CaseIterable, Sendable {
    case video
    case image
    case audio
}

struct StoredMediaAsset: Codable, Equatable, Sendable {
    var id: UUID
    var path: String
    var name: String
    var duration: Double
    var sourceIdentifier: String
    var kind: MediaKind? = nil
    var proxyPath: String? = nil
}

struct StoredClip: Codable, Equatable, Sendable {
    var id: UUID
    var assetID: UUID
    var trimStart: Double
    var trimEnd: Double
    var speed: Double? = nil
    var isMuted: Bool? = nil
    var colorAdjustments: ColorAdjustments? = nil
    var effectProxyPath: String? = nil
    var speedPoints: [SpeedPoint]? = nil
    var isReversed: Bool? = nil
    var reverseProxyPath: String? = nil
    var reverseIncludesAudio: Bool? = nil
    /// Legacy field from video-only reverse proxies. Kept for migration.
    var muteBeforeReverse: Bool? = nil
    var lutPath: String? = nil
    var lutName: String? = nil
    var lutIntensity: Double? = nil
    var transform: ClipTransform? = nil
    var transformKeyframes: [ClipTransformKeyframe]? = nil
    var visualEffects: ClipVisualEffects? = nil
    var outgoingTransition: ClipTransition? = nil
}

enum TransitionStyle: String, Codable, CaseIterable, Identifiable, Sendable {
    case none, dissolve, pushLeft, pushRight
    var id: String { rawValue }
}

/// Transition from this clip into the following main-track clip.
struct ClipTransition: Codable, Equatable, Sendable {
    var style: TransitionStyle = .none
    var duration: Double = 0

    var isActive: Bool { style != .none && duration > 0.001 }
}

enum ColorPreset: String, Codable, CaseIterable, Identifiable, Sendable {
    case original, warm, cool, vivid, mono
    var id: String { rawValue }
}

struct ColorAdjustments: Codable, Equatable, Sendable {
    var preset: ColorPreset = .original
    var brightness: Double = 0
    var contrast: Double = 1
    var saturation: Double = 1
    var temperature: Double = 0

    var isIdentity: Bool {
        preset == .original && abs(brightness) < 0.0001 &&
            abs(contrast - 1) < 0.0001 && abs(saturation - 1) < 0.0001 &&
            abs(temperature) < 0.0001
    }
}

enum ClipEffectPreset: String, Codable, CaseIterable, Identifiable, Sendable {
    case none, monochromeFilm, vintageFilm, softGlow, sharpen
    var id: String { rawValue }
}

struct ClipVisualEffects: Codable, Equatable, Sendable {
    var preset: ClipEffectPreset = .none
    var vignette: Double = 0
    var grain: Double = 0

    var isIdentity: Bool {
        preset == .none && vignette <= 0.001 && grain <= 0.001
    }
}

struct SpeedPoint: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    /// Normalized playback position inside the trimmed clip (0...1). For a
    /// reversed clip, zero corresponds to the original source out-point.
    var position: Double
    var speed: Double
}

struct ClipTransform: Codable, Equatable, Sendable {
    var scale: Double = 1
    /// Horizontal offset in half-canvas units (-1...1).
    var x: Double = 0
    /// Vertical offset in half-canvas units (-1...1).
    var y: Double = 0
    /// Clockwise rotation in degrees.
    var rotation: Double = 0
    var opacity: Double = 1

    var isIdentity: Bool {
        abs(scale - 1) < 0.0001 && abs(x) < 0.0001 && abs(y) < 0.0001 &&
            abs(rotation) < 0.0001 && abs(opacity - 1) < 0.0001
    }

    init(
        scale: Double = 1, x: Double = 0, y: Double = 0,
        rotation: Double = 0, opacity: Double = 1
    ) {
        self.scale = scale
        self.x = x
        self.y = y
        self.rotation = rotation
        self.opacity = opacity
    }

    private enum CodingKeys: String, CodingKey {
        case scale, x, y, rotation, opacity
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        scale = try values.decodeIfPresent(Double.self, forKey: .scale) ?? 1
        x = try values.decodeIfPresent(Double.self, forKey: .x) ?? 0
        y = try values.decodeIfPresent(Double.self, forKey: .y) ?? 0
        rotation = try values.decodeIfPresent(Double.self, forKey: .rotation) ?? 0
        opacity = try values.decodeIfPresent(Double.self, forKey: .opacity) ?? 1
    }
}

struct ClipTransformKeyframe: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    /// Normalized output-time position inside the clip (0...1).
    var position: Double
    var scale: Double
    var x: Double
    var y: Double
    var rotation: Double
    var opacity: Double
    var curve: KeyframeCurve
    var bezier: KeyframeBezier? = nil

    var transform: ClipTransform {
        ClipTransform(scale: scale, x: x, y: y, rotation: rotation, opacity: opacity)
    }

    init(
        id: UUID, position: Double, scale: Double, x: Double, y: Double,
        rotation: Double = 0, opacity: Double, curve: KeyframeCurve,
        bezier: KeyframeBezier? = nil
    ) {
        self.id = id
        self.position = position
        self.scale = scale
        self.x = x
        self.y = y
        self.rotation = rotation
        self.opacity = opacity
        self.curve = curve
        self.bezier = bezier
    }

    private enum CodingKeys: String, CodingKey {
        case id, position, scale, x, y, rotation, opacity, curve, bezier
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        position = try values.decode(Double.self, forKey: .position)
        scale = try values.decode(Double.self, forKey: .scale)
        x = try values.decode(Double.self, forKey: .x)
        y = try values.decode(Double.self, forKey: .y)
        rotation = try values.decodeIfPresent(Double.self, forKey: .rotation) ?? 0
        opacity = try values.decode(Double.self, forKey: .opacity)
        curve = try values.decode(KeyframeCurve.self, forKey: .curve)
        bezier = try values.decodeIfPresent(KeyframeBezier.self, forKey: .bezier)
    }
}

struct StoredExportSettings: Codable, Equatable, Sendable {
    var resolution: String = "1080p"
    var frameRate: Int = 30
    var quality: String = "standard"
}

enum SubtitleStylePreset: String, Codable, CaseIterable, Identifiable, Sendable {
    case classic
    case highlight
    case center
    var id: String { rawValue }
}

struct SubtitleItem: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var text: String
    var start: Double
    var end: Double
    var style: SubtitleStylePreset
}

struct OverlayItem: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var assetID: UUID
    var start: Double
    var end: Double
    var x: Double
    var y: Double
    var scale: Double
    var rotation: Double
    var opacity: Double
    var sourceStart: Double? = nil
    var keyframes: [OverlayKeyframe]? = nil
}

enum KeyframeCurve: String, Codable, CaseIterable, Identifiable, Sendable {
    case linear, easeIn, easeOut, easeInOut, custom
    var id: String { rawValue }
}

struct KeyframeBezier: Codable, Equatable, Sendable {
    var x1: Double = 0.25
    var y1: Double = 0.1
    var x2: Double = 0.25
    var y2: Double = 1

    var normalized: KeyframeBezier {
        let firstX = max(0, min(1, x1.isFinite ? x1 : 0.25))
        let secondX = max(firstX, min(1, x2.isFinite ? x2 : 0.25))
        return KeyframeBezier(
            x1: firstX, y1: max(0, min(1, y1.isFinite ? y1 : 0.1)),
            x2: secondX, y2: max(0, min(1, y2.isFinite ? y2 : 1))
        )
    }
}

struct OverlayKeyframe: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    /// Seconds relative to the overlay start.
    var time: Double
    var x: Double
    var y: Double
    var scale: Double
    var rotation: Double
    var opacity: Double
    var curve: KeyframeCurve
    var bezier: KeyframeBezier? = nil
}

struct AudioTrackItem: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var assetID: UUID
    var start: Double
    var sourceStart: Double
    var duration: Double
    var volume: Double
    var fadeIn: Double
    var fadeOut: Double
    var isMuted: Bool
    var speed: Double? = nil
}

/// The on-disk project contract. Version 2 adds draft metadata and export
/// settings; newer optional fields extend it with captions and multitrack media
/// while retaining a lossless decoder for the original v1 autosave.
struct ProjectDocument: Codable, Equatable, Sendable {
    static let currentVersion = 2

    var version: Int
    var projectID: UUID?
    var name: String?
    var createdAt: Date?
    var updatedAt: Date?
    var timelineDuration: Double?
    var coverPath: String?
    var mediaAssets: [StoredMediaAsset]
    var clips: [StoredClip]
    var bgmPath: String?
    var bgmName: String?
    var originalVolume: Double
    var bgmVolume: Double
    var transitionDuration: Double
    var canvasFormat: String?
    var exportSettings: StoredExportSettings?
    var subtitles: [SubtitleItem]
    var overlays: [OverlayItem]
    var audioTracks: [AudioTrackItem]

    init(
        version: Int = currentVersion,
        projectID: UUID? = nil,
        name: String? = nil,
        createdAt: Date? = nil,
        updatedAt: Date? = nil,
        timelineDuration: Double? = nil,
        coverPath: String? = nil,
        mediaAssets: [StoredMediaAsset],
        clips: [StoredClip],
        bgmPath: String?,
        bgmName: String?,
        originalVolume: Double,
        bgmVolume: Double,
        transitionDuration: Double,
        canvasFormat: String? = nil,
        exportSettings: StoredExportSettings? = nil,
        subtitles: [SubtitleItem] = [],
        overlays: [OverlayItem] = [],
        audioTracks: [AudioTrackItem] = []
    ) {
        self.version = version
        self.projectID = projectID
        self.name = name
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.timelineDuration = timelineDuration
        self.coverPath = coverPath
        self.mediaAssets = mediaAssets
        self.clips = clips
        self.bgmPath = bgmPath
        self.bgmName = bgmName
        self.originalVolume = originalVolume
        self.bgmVolume = bgmVolume
        self.transitionDuration = transitionDuration
        self.canvasFormat = canvasFormat
        self.exportSettings = exportSettings
        self.subtitles = subtitles
        self.overlays = overlays
        self.audioTracks = audioTracks
    }

    private enum CodingKeys: String, CodingKey {
        case version, projectID, name, createdAt, updatedAt, timelineDuration, coverPath
        case mediaAssets, clips, bgmPath, bgmName, originalVolume, bgmVolume
        case transitionDuration, canvasFormat, exportSettings, subtitles, overlays, audioTracks
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decodeIfPresent(Int.self, forKey: .version) ?? 1
        projectID = try values.decodeIfPresent(UUID.self, forKey: .projectID)
        name = try values.decodeIfPresent(String.self, forKey: .name)
        createdAt = try values.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt)
        timelineDuration = try values.decodeIfPresent(Double.self, forKey: .timelineDuration)
        coverPath = try values.decodeIfPresent(String.self, forKey: .coverPath)
        mediaAssets = try values.decodeIfPresent([StoredMediaAsset].self, forKey: .mediaAssets) ?? []
        clips = try values.decodeIfPresent([StoredClip].self, forKey: .clips) ?? []
        bgmPath = try values.decodeIfPresent(String.self, forKey: .bgmPath)
        bgmName = try values.decodeIfPresent(String.self, forKey: .bgmName)
        originalVolume = try values.decodeIfPresent(Double.self, forKey: .originalVolume) ?? 1
        bgmVolume = try values.decodeIfPresent(Double.self, forKey: .bgmVolume) ?? 0.5
        transitionDuration = try values.decodeIfPresent(Double.self, forKey: .transitionDuration) ?? 0
        canvasFormat = try values.decodeIfPresent(String.self, forKey: .canvasFormat)
        exportSettings = try values.decodeIfPresent(StoredExportSettings.self, forKey: .exportSettings)
        subtitles = try values.decodeIfPresent([SubtitleItem].self, forKey: .subtitles) ?? []
        overlays = try values.decodeIfPresent([OverlayItem].self, forKey: .overlays) ?? []
        audioTracks = try values.decodeIfPresent([AudioTrackItem].self, forKey: .audioTracks) ?? []
    }

    /// Resolves the transition for a real clip boundary. Documents written
    /// before per-boundary transitions inherit the legacy global dissolve,
    /// while the final clip can never expose a latent transition after restore.
    func resolvedOutgoingTransition(at index: Int) -> ClipTransition {
        guard clips.indices.contains(index), index < clips.count - 1 else {
            return ClipTransition()
        }
        let stored = clips[index].outgoingTransition ?? ClipTransition(
            style: transitionDuration > 0 ? .dissolve : .none,
            duration: transitionDuration
        )
        return ClipTransition(
            style: stored.style,
            duration: max(0, min(2, stored.duration.isFinite ? stored.duration : 0))
        )
    }

    func upgraded(projectID fallbackID: UUID? = nil, now: Date = Date()) -> ProjectDocument {
        var result = self
        result.version = Self.currentVersion
        result.projectID = result.projectID ?? fallbackID
        result.name = result.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.name?.isEmpty != false { result.name = "未命名项目" }
        result.createdAt = result.createdAt ?? result.updatedAt ?? now
        result.updatedAt = result.updatedAt ?? now
        result.timelineDuration = result.timelineDuration ?? Self.derivedDuration(
            clips: result.clips, transition: result.transitionDuration
        )
        result.exportSettings = result.exportSettings ?? StoredExportSettings()
        return result
    }

    private static func derivedDuration(clips: [StoredClip], transition: Double) -> Double {
        let durations = clips.map { clip in
            max(0, clip.trimEnd - clip.trimStart) / max(0.25, min(4, clip.speed ?? 1))
        }
        let requested = clips.dropLast().map { clip in
            if let boundary = clip.outgoingTransition {
                return boundary.style == .none ? 0 : boundary.duration
            }
            return transition
        }
        let overlaps = (0..<max(0, durations.count - 1)).map { index in
            min(max(0, requested[index]), durations[index] / 2, durations[index + 1] / 2)
        }
        return max(0, durations.reduce(0, +) - overlaps.reduce(0, +))
    }
}

struct ProjectSummary: Identifiable, Equatable {
    let id: UUID
    var name: String
    var createdAt: Date
    var updatedAt: Date
    var duration: Double
    var mediaCount: Int
    var coverURL: URL?
}

enum ProjectDocumentStore {
    static func rootDirectory(fileManager: FileManager = .default) throws -> URL {
        let root = try fileManager.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("Clip", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// The legacy v1 autosave URL. Retained for migration and isolated tests.
    static func defaultURL(fileManager: FileManager = .default) throws -> URL {
        try rootDirectory(fileManager: fileManager).appendingPathComponent("Autosave.json")
    }

    static func projectsDirectory(fileManager: FileManager = .default) throws -> URL {
        let directory = try rootDirectory(fileManager: fileManager).appendingPathComponent("Projects", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func projectDirectory(for projectID: UUID, fileManager: FileManager = .default) throws -> URL {
        try projectsDirectory(fileManager: fileManager)
            .appendingPathComponent(projectID.uuidString, isDirectory: true)
    }

    static func documentURL(for projectID: UUID, fileManager: FileManager = .default) throws -> URL {
        try projectDirectory(for: projectID, fileManager: fileManager).appendingPathComponent("Project.json")
    }

    static func mediaDirectory(fileManager: FileManager = .default) throws -> URL {
        let directory = try rootDirectory(fileManager: fileManager).appendingPathComponent("Media", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func mediaDirectory(for projectID: UUID, fileManager: FileManager = .default) throws -> URL {
        let directory = try projectDirectory(for: projectID, fileManager: fileManager)
            .appendingPathComponent("Media", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func coverURL(for projectID: UUID, fileManager: FileManager = .default) throws -> URL {
        try projectDirectory(for: projectID, fileManager: fileManager).appendingPathComponent("Cover.jpg")
    }

    static func storedPath(for fileURL: URL, fileManager: FileManager = .default) throws -> String {
        try storedPath(for: fileURL, relativeTo: rootDirectory(fileManager: fileManager))
    }

    static func storedPath(
        for fileURL: URL, projectID: UUID, fileManager: FileManager = .default
    ) throws -> String {
        try storedPath(for: fileURL, relativeTo: projectDirectory(for: projectID, fileManager: fileManager))
    }

    private static func storedPath(for fileURL: URL, relativeTo rootURL: URL) throws -> String {
        let root = rootURL.standardizedFileURL.path
        let file = fileURL.standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return file.hasPrefix(prefix) ? String(file.dropFirst(prefix.count)) : file
    }

    static func resolvedURL(for storedPath: String, fileManager: FileManager = .default) throws -> URL {
        try resolvedURL(for: storedPath, relativeTo: rootDirectory(fileManager: fileManager))
    }

    static func resolvedURL(
        for storedPath: String, projectID: UUID, fileManager: FileManager = .default
    ) throws -> URL {
        try resolvedURL(for: storedPath, relativeTo: projectDirectory(for: projectID, fileManager: fileManager))
    }

    private static func resolvedURL(for storedPath: String, relativeTo root: URL) throws -> URL {
        if storedPath.hasPrefix("/") { return URL(fileURLWithPath: storedPath) }
        let standardizedRoot = root.standardizedFileURL
        let resolved = standardizedRoot.appendingPathComponent(storedPath).standardizedFileURL
        let prefix = standardizedRoot.path.hasSuffix("/") ? standardizedRoot.path : standardizedRoot.path + "/"
        guard resolved.path.hasPrefix(prefix) else { throw CocoaError(.fileReadInvalidFileName) }
        return resolved
    }

    static func load(from url: URL? = nil, fileManager: FileManager = .default) throws -> ProjectDocument? {
        let fileURL = try url ?? defaultURL(fileManager: fileManager)
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let document = try decoder.decode(ProjectDocument.self, from: Data(contentsOf: fileURL))
        guard document.version <= ProjectDocument.currentVersion else { return nil }
        return document.version < ProjectDocument.currentVersion ? document.upgraded() : document
    }

    static func load(projectID: UUID, fileManager: FileManager = .default) throws -> ProjectDocument? {
        guard let document = try load(from: documentURL(for: projectID, fileManager: fileManager), fileManager: fileManager) else {
            return nil
        }
        return document.upgraded(projectID: projectID)
    }

    static func save(_ document: ProjectDocument, to url: URL? = nil, fileManager: FileManager = .default) throws {
        let fileURL = try url ?? defaultURL(fileManager: fileManager)
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(document).write(to: fileURL, options: .atomic)
    }

    static func save(_ document: ProjectDocument, projectID: UUID, fileManager: FileManager = .default) throws {
        var upgraded = document.upgraded(projectID: projectID)
        upgraded.projectID = projectID
        try save(upgraded, to: documentURL(for: projectID, fileManager: fileManager), fileManager: fileManager)
    }

    @discardableResult
    static func createProject(name: String, fileManager: FileManager = .default) throws -> ProjectSummary {
        let id = UUID()
        let now = Date()
        let cleanName = normalizedProjectName(name)
        let document = ProjectDocument(
            projectID: id, name: cleanName, createdAt: now, updatedAt: now, timelineDuration: 0,
            mediaAssets: [], clips: [], bgmPath: nil, bgmName: nil,
            originalVolume: 1, bgmVolume: 0.5, transitionDuration: 0, canvasFormat: "9:16",
            exportSettings: StoredExportSettings()
        )
        try save(document, projectID: id, fileManager: fileManager)
        return summary(for: document, projectID: id, fileManager: fileManager)
    }

    static func listProjects(fileManager: FileManager = .default) throws -> [ProjectSummary] {
        try migrateLegacyProjectIfNeeded(fileManager: fileManager)
        let projectsURL = try projectsDirectory(fileManager: fileManager)
        let children = try fileManager.contentsOfDirectory(
            at: projectsURL, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        )
        return children.compactMap { directory -> ProjectSummary? in
            guard let id = UUID(uuidString: directory.lastPathComponent),
                  let document = try? load(projectID: id, fileManager: fileManager) else { return nil }
            return summary(for: document, projectID: id, fileManager: fileManager)
        }.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    @discardableResult
    static func renameProject(
        _ projectID: UUID, to name: String, fileManager: FileManager = .default
    ) throws -> ProjectSummary {
        guard var document = try load(projectID: projectID, fileManager: fileManager) else {
            throw CocoaError(.fileNoSuchFile)
        }
        document.name = normalizedProjectName(name)
        document.updatedAt = Date()
        try save(document, projectID: projectID, fileManager: fileManager)
        return summary(for: document, projectID: projectID, fileManager: fileManager)
    }

    @discardableResult
    static func duplicateProject(
        _ projectID: UUID, name: String, fileManager: FileManager = .default
    ) throws -> ProjectSummary {
        guard var document = try load(projectID: projectID, fileManager: fileManager) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let newID = UUID()
        let sourceDirectory = try projectDirectory(for: projectID, fileManager: fileManager)
        let targetDirectory = try projectsDirectory(fileManager: fileManager)
            .appendingPathComponent(newID.uuidString, isDirectory: true)
        guard !fileManager.fileExists(atPath: targetDirectory.path) else { throw CocoaError(.fileWriteFileExists) }
        try fileManager.copyItem(at: sourceDirectory, to: targetDirectory)
        do {
            let now = Date()
            document.projectID = newID
            document.name = normalizedProjectName(name)
            document.createdAt = now
            document.updatedAt = now
            try save(document, projectID: newID, fileManager: fileManager)
            return summary(for: document, projectID: newID, fileManager: fileManager)
        } catch {
            try? fileManager.removeItem(at: targetDirectory)
            throw error
        }
    }

    static func deleteProject(_ projectID: UUID, fileManager: FileManager = .default) throws {
        let directory = try projectsDirectory(fileManager: fileManager)
            .appendingPathComponent(projectID.uuidString, isDirectory: true)
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }

    private static func normalizedProjectName(_ name: String) -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "未命名项目" : String(cleaned.prefix(80))
    }

    private static func summary(
        for document: ProjectDocument, projectID: UUID, fileManager: FileManager
    ) -> ProjectSummary {
        let now = Date()
        let coverURL = document.coverPath.flatMap {
            try? resolvedURL(for: $0, projectID: projectID, fileManager: fileManager)
        }.flatMap { fileManager.fileExists(atPath: $0.path) ? $0 : nil }
        return ProjectSummary(
            id: projectID, name: normalizedProjectName(document.name ?? ""),
            createdAt: document.createdAt ?? now, updatedAt: document.updatedAt ?? now,
            duration: max(0, document.timelineDuration ?? 0), mediaCount: document.mediaAssets.count,
            coverURL: coverURL
        )
    }

    /// Rewrites every file-backed path in a document. Keeping this traversal in
    /// one place prevents schema additions such as LUTs or render proxies from
    /// being silently omitted during legacy-project migration.
    static func remapStoredMediaPaths(
        in document: inout ProjectDocument,
        using transform: (String) throws -> String
    ) rethrows {
        for index in document.mediaAssets.indices {
            document.mediaAssets[index].path = try transform(document.mediaAssets[index].path)
            if let path = document.mediaAssets[index].proxyPath {
                document.mediaAssets[index].proxyPath = try transform(path)
            }
        }
        for index in document.clips.indices {
            if let path = document.clips[index].effectProxyPath {
                document.clips[index].effectProxyPath = try transform(path)
            }
            if let path = document.clips[index].reverseProxyPath {
                document.clips[index].reverseProxyPath = try transform(path)
            }
            if let path = document.clips[index].lutPath {
                document.clips[index].lutPath = try transform(path)
            }
        }
        if let path = document.bgmPath { document.bgmPath = try transform(path) }
        if let path = document.coverPath { document.coverPath = try transform(path) }
    }

    /// Moves the one-file v1 autosave into an isolated v2 project. Sources are
    /// copied first; the legacy autosave and copied originals are removed only
    /// after the new Project.json has been atomically installed.
    static func migrateLegacyProjectIfNeeded(fileManager: FileManager = .default) throws {
        let legacyURL = try defaultURL(fileManager: fileManager)
        guard fileManager.fileExists(atPath: legacyURL.path),
              var document = try load(from: legacyURL, fileManager: fileManager) else { return }

        let projectID = document.projectID ?? UUID()
        let projectURL = try documentURL(for: projectID, fileManager: fileManager)
        if fileManager.fileExists(atPath: projectURL.path) {
            try fileManager.removeItem(at: legacyURL)
            return
        }

        let destinationMedia = try mediaDirectory(for: projectID, fileManager: fileManager)
        let legacyMediaPath = try mediaDirectory(fileManager: fileManager).standardizedFileURL.path
        let legacyMediaPrefix = legacyMediaPath.hasSuffix("/") ? legacyMediaPath : legacyMediaPath + "/"
        var copiedSources: Set<URL> = []
        var migratedPaths: [String: String] = [:]

        func migratePath(_ storedPath: String) throws -> String {
            if let existing = migratedPaths[storedPath] { return existing }
            let source = try resolvedURL(for: storedPath, fileManager: fileManager)
            guard fileManager.fileExists(atPath: source.path) else { return storedPath }
            var destination = destinationMedia.appendingPathComponent(source.lastPathComponent)
            if fileManager.fileExists(atPath: destination.path) {
                destination = destinationMedia.appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension(source.pathExtension)
            }
            try fileManager.copyItem(at: source, to: destination)
            if source.standardizedFileURL.path.hasPrefix(legacyMediaPrefix) {
                copiedSources.insert(source.standardizedFileURL)
            }
            let migrated = try self.storedPath(for: destination, projectID: projectID, fileManager: fileManager)
            migratedPaths[storedPath] = migrated
            return migrated
        }

        do {
            try remapStoredMediaPaths(in: &document, using: migratePath)
            let now = Date()
            document = document.upgraded(projectID: projectID, now: now)
            document.projectID = projectID
            document.name = normalizedProjectName(document.name ?? "未命名项目")
            document.createdAt = document.createdAt ?? now
            document.updatedAt = now
            try save(document, projectID: projectID, fileManager: fileManager)
            try fileManager.removeItem(at: legacyURL)
            for source in copiedSources { try? fileManager.removeItem(at: source) }
        } catch {
            try? fileManager.removeItem(at: try projectDirectory(for: projectID, fileManager: fileManager))
            throw error
        }
    }

    /// Removes only direct child files from an app-owned media directory.
    static func cleanupMediaDirectory(
        _ directory: URL? = nil, keeping keepURLs: Set<URL>, fileManager: FileManager = .default
    ) throws {
        let mediaURL = try directory ?? mediaDirectory(fileManager: fileManager)
        let keepPaths = Set(keepURLs.map { $0.standardizedFileURL.path })
        let children = try fileManager.contentsOfDirectory(
            at: mediaURL, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]
        )
        for child in children {
            let values = try? child.resourceValues(forKeys: [.isRegularFileKey])
            guard values?.isRegularFile == true, !keepPaths.contains(child.standardizedFileURL.path) else { continue }
            try fileManager.removeItem(at: child)
        }
    }
}
