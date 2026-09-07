import Foundation

struct StoredMediaAsset: Codable, Equatable {
    var id: UUID
    var path: String
    var name: String
    var duration: Double
    var sourceIdentifier: String
}

struct StoredClip: Codable, Equatable {
    var id: UUID
    var assetID: UUID
    var trimStart: Double
    var trimEnd: Double
    var speed: Double? = nil
    var isMuted: Bool? = nil
}

struct ProjectDocument: Codable, Equatable {
    static let currentVersion = 1

    var version = currentVersion
    var mediaAssets: [StoredMediaAsset]
    var clips: [StoredClip]
    var bgmPath: String?
    var bgmName: String?
    var originalVolume: Double
    var bgmVolume: Double
    var transitionDuration: Double
    var canvasFormat: String? = nil
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

    static func defaultURL(fileManager: FileManager = .default) throws -> URL {
        try rootDirectory(fileManager: fileManager).appendingPathComponent("Autosave.json")
    }

    static func mediaDirectory(fileManager: FileManager = .default) throws -> URL {
        let directory = try rootDirectory(fileManager: fileManager).appendingPathComponent("Media", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func storedPath(for fileURL: URL, fileManager: FileManager = .default) throws -> String {
        let root = try rootDirectory(fileManager: fileManager).standardizedFileURL.path
        let file = fileURL.standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return file.hasPrefix(prefix) ? String(file.dropFirst(prefix.count)) : file
    }

    static func resolvedURL(for storedPath: String, fileManager: FileManager = .default) throws -> URL {
        if storedPath.hasPrefix("/") { return URL(fileURLWithPath: storedPath) }
        let root = try rootDirectory(fileManager: fileManager).standardizedFileURL
        let resolved = root.appendingPathComponent(storedPath).standardizedFileURL
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard resolved.path.hasPrefix(prefix) else { throw CocoaError(.fileReadInvalidFileName) }
        return resolved
    }

    static func load(from url: URL? = nil, fileManager: FileManager = .default) throws -> ProjectDocument? {
        let fileURL = try url ?? defaultURL(fileManager: fileManager)
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }
        let document = try JSONDecoder().decode(ProjectDocument.self, from: Data(contentsOf: fileURL))
        guard document.version == ProjectDocument.currentVersion else { return nil }
        return document
    }

    static func save(_ document: ProjectDocument, to url: URL? = nil, fileManager: FileManager = .default) throws {
        let fileURL = try url ?? defaultURL(fileManager: fileManager)
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(document).write(to: fileURL, options: .atomic)
    }

    /// Removes only direct child files from the app-owned media directory.
    /// Call this after loading the persisted project so undoable in-memory media
    /// is never deleted while the app is running.
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
