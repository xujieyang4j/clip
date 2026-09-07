import Foundation

@main
enum ProjectDocumentSmoke {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("project.json")
        let assetID = UUID()
        let document = ProjectDocument(
            mediaAssets: [StoredMediaAsset(id: assetID, path: "Media/a.mov", name: "a.mov", duration: 12, sourceIdentifier: "photos:1")],
            clips: [StoredClip(id: UUID(), assetID: assetID, trimStart: 1, trimEnd: 8)],
            bgmPath: "Media/music.m4a", bgmName: "music.m4a",
            originalVolume: 0.8, bgmVolume: 0.35, transitionDuration: 0.5, canvasFormat: "9:16"
        )
        try ProjectDocumentStore.save(document, to: file)
        guard try ProjectDocumentStore.load(from: file) == document else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 1)
        }
        let media = root.appendingPathComponent("Media", isDirectory: true)
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
        let kept = media.appendingPathComponent("kept.mov")
        let orphan = media.appendingPathComponent("orphan.mov")
        try Data([1]).write(to: kept)
        try Data([2]).write(to: orphan)
        try ProjectDocumentStore.cleanupMediaDirectory(media, keeping: [kept])
        guard FileManager.default.fileExists(atPath: kept.path), !FileManager.default.fileExists(atPath: orphan.path) else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 2)
        }
        do {
            _ = try ProjectDocumentStore.resolvedURL(for: "../outside.mov")
            throw NSError(domain: "ProjectDocumentSmoke", code: 3)
        } catch let error as CocoaError where error.code == .fileReadInvalidFileName {}
        print("iOS project document smoke: passed")
    }
}
