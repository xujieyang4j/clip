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
        let imageID = UUID()
        let audioID = UUID()
        let customBezier = KeyframeBezier(x1: 0.18, y1: 0.72, x2: 0.82, y2: 0.94)
        let overlay = OverlayItem(
            id: UUID(), assetID: imageID, start: 1, end: 4, x: 0.7, y: 0.3,
            scale: 0.35, rotation: 12, opacity: 0.8, sourceStart: 0,
            keyframes: [OverlayKeyframe(
                id: UUID(), time: 1.5, x: 0.3, y: 0.8, scale: 0.6, rotation: 45,
                opacity: 0.5, curve: .custom, bezier: customBezier
            )]
        )
        let audioTrack = AudioTrackItem(
            id: UUID(), assetID: audioID, start: 0.5, sourceStart: 1, duration: 6,
            volume: 0.75, fadeIn: 0.4, fadeOut: 0.8, isMuted: false, speed: 1
        )
        let document = ProjectDocument(
            mediaAssets: [
                StoredMediaAsset(
                    id: assetID, path: "Media/a.mov", name: "a.mov", duration: 12,
                    sourceIdentifier: "photos:1", kind: .video
                ),
                StoredMediaAsset(
                    id: imageID, path: "Media/still.jpg", name: "still.jpg", duration: 3,
                    sourceIdentifier: "photos:2", kind: .image, proxyPath: "Media/still.mov"
                ),
                StoredMediaAsset(
                    id: audioID, path: "Media/voice.m4a", name: "voice.m4a", duration: 8,
                    sourceIdentifier: "voice:1", kind: .audio
                )
            ],
            clips: [StoredClip(
                id: UUID(), assetID: assetID, trimStart: 1, trimEnd: 8,
                colorAdjustments: ColorAdjustments(
                    preset: .warm, brightness: 0.03, contrast: 1.05, saturation: 1.08, temperature: 35
                ),
                effectProxyPath: "Media/effect.mov",
                speedPoints: [
                    SpeedPoint(id: UUID(), position: 0, speed: 0.5),
                    SpeedPoint(id: UUID(), position: 1, speed: 2)
                ],
                isReversed: true, reverseProxyPath: "Media/reverse.mov",
                reverseIncludesAudio: true, muteBeforeReverse: false,
                lutPath: "Media/film.cube", lutName: "Film", lutIntensity: 0.65,
                transform: ClipTransform(scale: 1.4, x: 0.2, y: -0.1, rotation: 12, opacity: 0.8),
                transformKeyframes: [ClipTransformKeyframe(
                    id: UUID(), position: 0.6, scale: 2, x: -0.2, y: 0.3,
                    rotation: -35, opacity: 0.5, curve: .custom, bezier: customBezier
                )],
                visualEffects: ClipVisualEffects(preset: .vintageFilm, vignette: 0.4, grain: 0.2),
                outgoingTransition: ClipTransition(style: .pushLeft, duration: 0.65)
            )],
            bgmPath: "Media/music.m4a", bgmName: "music.m4a",
            originalVolume: 0.8, bgmVolume: 0.35, transitionDuration: 0.5, canvasFormat: "9:16",
            exportSettings: StoredExportSettings(resolution: "4K", frameRate: 60, quality: "high"),
            subtitles: [SubtitleItem(id: UUID(), text: "测试字幕", start: 1.2, end: 3.4, style: .highlight)],
            overlays: [overlay], audioTracks: [audioTrack]
        )

        try ProjectDocumentStore.save(document, to: file)
        XCTAssertEqual(try ProjectDocumentStore.load(from: file), document)
    }

    func testLegacyReverseProxyDecodesWithoutAudioCapabilityFlag() throws {
        let json = #"{"id":"00000000-0000-0000-0000-000000000001","assetID":"00000000-0000-0000-0000-000000000002","trimStart":0,"trimEnd":2,"isReversed":true,"reverseProxyPath":"Media/reverse.mov","muteBeforeReverse":false}"#
        let clip = try JSONDecoder().decode(StoredClip.self, from: Data(json.utf8))
        XCTAssertTrue(clip.isReversed == true)
        XCTAssertNil(clip.reverseIncludesAudio)
        XCTAssertEqual(clip.muteBeforeReverse, false)
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

    func testLoadsAndUpgradesLegacyV1Document() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("legacy.json")
        let assetID = UUID()
        let clipID = UUID()
        let json = """
        {
          "version": 1,
          "mediaAssets": [{"id": "\(assetID.uuidString)", "path": "Media/a.mov", "name": "a.mov", "duration": 8, "sourceIdentifier": "legacy:a"}],
          "clips": [{"id": "\(clipID.uuidString)", "assetID": "\(assetID.uuidString)", "trimStart": 1, "trimEnd": 7}],
          "bgmPath": null,
          "bgmName": null,
          "originalVolume": 1,
          "bgmVolume": 0.5,
          "transitionDuration": 0,
          "canvasFormat": "9:16"
        }
        """
        try Data(json.utf8).write(to: file)

        let document = try XCTUnwrap(ProjectDocumentStore.load(from: file))
        XCTAssertEqual(document.version, ProjectDocument.currentVersion)
        XCTAssertEqual(document.name, "未命名项目")
        XCTAssertEqual(document.timelineDuration, 6)
        XCTAssertEqual(document.exportSettings, StoredExportSettings())
        XCTAssertTrue(document.overlays.isEmpty)
        XCTAssertTrue(document.audioTracks.isEmpty)
        XCTAssertNil(document.mediaAssets.first?.kind)
        XCTAssertNil(document.clips.first?.colorAdjustments)
        XCTAssertNil(document.clips.first?.speedPoints)
        XCTAssertNil(document.clips.first?.isReversed)
        XCTAssertNil(document.clips.first?.outgoingTransition)
    }

    func testDerivedDurationUsesIndependentBoundariesAndIgnoresFinalOutgoingTransition() {
        let assetID = UUID()
        let document = ProjectDocument(
            timelineDuration: nil,
            mediaAssets: [],
            clips: [
                StoredClip(
                    id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 6,
                    outgoingTransition: ClipTransition(style: .dissolve, duration: 1)
                ),
                StoredClip(
                    id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 4,
                    outgoingTransition: ClipTransition(style: .none, duration: 2)
                ),
                StoredClip(
                    id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 8,
                    outgoingTransition: ClipTransition(style: .pushLeft, duration: 2)
                )
            ],
            bgmPath: nil, bgmName: nil, originalVolume: 1, bgmVolume: 0.5,
            transitionDuration: 0.5
        )

        XCTAssertEqual(document.upgraded().timelineDuration, 17)
    }

    func testDerivedDurationFallsBackToLegacyGlobalTransitionOnlyForMissingBoundaries() {
        let assetID = UUID()
        let document = ProjectDocument(
            timelineDuration: nil,
            mediaAssets: [],
            clips: [
                StoredClip(id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 4),
                StoredClip(
                    id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 6,
                    outgoingTransition: ClipTransition(style: .pushRight, duration: 1.25)
                ),
                StoredClip(id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 8)
            ],
            bgmPath: nil, bgmName: nil, originalVolume: 1, bgmVolume: 0.5,
            transitionDuration: 0.5
        )

        XCTAssertEqual(document.upgraded().timelineDuration, 16.25)
        XCTAssertEqual(
            document.resolvedOutgoingTransition(at: 0),
            ClipTransition(style: .dissolve, duration: 0.5)
        )
        XCTAssertEqual(
            document.resolvedOutgoingTransition(at: 1),
            ClipTransition(style: .pushRight, duration: 1.25)
        )
        XCTAssertEqual(document.resolvedOutgoingTransition(at: 2), ClipTransition())
    }

    func testClipTransformDecodesDocumentsSavedBeforeRotation() throws {
        let transform = try JSONDecoder().decode(
            ClipTransform.self, from: Data(#"{"scale":1.5,"x":0.2,"y":-0.1,"opacity":0.7}"#.utf8)
        )
        XCTAssertEqual(transform.rotation, 0)
        let keyframe = try JSONDecoder().decode(
            ClipTransformKeyframe.self,
            from: Data(#"{"id":"00000000-0000-0000-0000-000000000001","position":0.5,"scale":2,"x":0.1,"y":0.2,"opacity":0.8,"curve":"linear"}"#.utf8)
        )
        XCTAssertEqual(keyframe.rotation, 0)
        XCTAssertNil(keyframe.bezier)
        let overlayKeyframe = try JSONDecoder().decode(
            OverlayKeyframe.self,
            from: Data(#"{"id":"00000000-0000-0000-0000-000000000002","time":0.5,"x":0.1,"y":0.2,"scale":0.8,"rotation":0,"opacity":0.7,"curve":"easeInOut"}"#.utf8)
        )
        XCTAssertNil(overlayKeyframe.bezier)
    }

    func testProjectRelativePathCannotEscapeItsDirectory() throws {
        XCTAssertThrowsError(try ProjectDocumentStore.resolvedURL(for: "../Project.json", projectID: UUID()))
    }

    func testLegacyMigrationRemapsAllFileBackedPaths() throws {
        let assetID = UUID()
        var document = ProjectDocument(
            coverPath: "Cover.jpg",
            mediaAssets: [StoredMediaAsset(
                id: assetID, path: "Media/source.mov", name: "source.mov", duration: 2,
                sourceIdentifier: "legacy", kind: .video, proxyPath: "Media/image-proxy.mov"
            )],
            clips: [StoredClip(
                id: UUID(), assetID: assetID, trimStart: 0, trimEnd: 2,
                effectProxyPath: "Media/effect.mov", reverseProxyPath: "Media/reverse.mov",
                lutPath: "Media/look.cube"
            )],
            bgmPath: "Media/music.m4a", bgmName: "music.m4a",
            originalVolume: 1, bgmVolume: 0.5, transitionDuration: 0
        )
        var visited: [String] = []
        ProjectDocumentStore.remapStoredMediaPaths(in: &document) { path in
            visited.append(path)
            return "Migrated/" + URL(fileURLWithPath: path).lastPathComponent
        }

        XCTAssertEqual(Set(visited), Set([
            "Media/source.mov", "Media/image-proxy.mov", "Media/effect.mov",
            "Media/reverse.mov", "Media/look.cube", "Media/music.m4a", "Cover.jpg"
        ]))
        XCTAssertEqual(document.mediaAssets[0].proxyPath, "Migrated/image-proxy.mov")
        XCTAssertEqual(document.clips[0].effectProxyPath, "Migrated/effect.mov")
        XCTAssertEqual(document.clips[0].reverseProxyPath, "Migrated/reverse.mov")
        XCTAssertEqual(document.clips[0].lutPath, "Migrated/look.cube")
        XCTAssertEqual(document.bgmPath, "Migrated/music.m4a")
        XCTAssertEqual(document.coverPath, "Migrated/Cover.jpg")
    }

    func testCreateRenameDuplicateAndDeleteDraft() throws {
        let original = try ProjectDocumentStore.createProject(name: "  测试草稿  ")
        var duplicateID: UUID?
        defer {
            try? ProjectDocumentStore.deleteProject(original.id)
            if let duplicateID { try? ProjectDocumentStore.deleteProject(duplicateID) }
        }

        XCTAssertEqual(original.name, "测试草稿")
        let renamed = try ProjectDocumentStore.renameProject(original.id, to: "新名称")
        XCTAssertEqual(renamed.name, "新名称")

        let mediaDirectory = try ProjectDocumentStore.mediaDirectory(for: original.id)
        let media = mediaDirectory.appendingPathComponent("sample.mov")
        try Data([1, 2, 3]).write(to: media)
        var document = try XCTUnwrap(ProjectDocumentStore.load(projectID: original.id))
        document.mediaAssets = [StoredMediaAsset(
            id: UUID(), path: "Media/sample.mov", name: "sample.mov", duration: 3, sourceIdentifier: "test"
        )]
        try ProjectDocumentStore.save(document, projectID: original.id)

        let duplicate = try ProjectDocumentStore.duplicateProject(original.id, name: "新名称 副本")
        duplicateID = duplicate.id
        let copiedMedia = try ProjectDocumentStore.resolvedURL(
            for: "Media/sample.mov", projectID: duplicate.id
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: copiedMedia.path))

        try ProjectDocumentStore.deleteProject(original.id)
        XCTAssertNotNil(try ProjectDocumentStore.load(projectID: duplicate.id))
    }
}
