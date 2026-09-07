import Foundation
import XCTest
@testable import MiniClip

final class ProjectDocumentTests: XCTestCase {
    func testRoundTripProjectDocument() throws {
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
        XCTAssertEqual(try ProjectDocumentStore.load(from: file), document)
    }

    func testRejectsFutureProjectVersion() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("future.json")
        let document = ProjectDocument(
            version: ProjectDocument.currentVersion + 1, mediaAssets: [], clips: [],
            bgmPath: nil, bgmName: nil,
            originalVolume: 1, bgmVolume: 0.5, transitionDuration: 0, canvasFormat: nil
        )
        try ProjectDocumentStore.save(document, to: file)
        XCTAssertNil(try ProjectDocumentStore.load(from: file))
    }

    func testCleanupRemovesOnlyOrphanedDirectFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let kept = root.appendingPathComponent("kept.mov")
        let orphan = root.appendingPathComponent("orphan.mov")
        let nested = root.appendingPathComponent("nested", isDirectory: true)
        try Data([1]).write(to: kept)
        try Data([2]).write(to: orphan)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)

        try ProjectDocumentStore.cleanupMediaDirectory(root, keeping: [kept])

        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: nested.path))
    }

    func testRelativeProjectPathCannotEscapeAppDirectory() throws {
        XCTAssertThrowsError(try ProjectDocumentStore.resolvedURL(for: "../outside.mov"))
    }
}
