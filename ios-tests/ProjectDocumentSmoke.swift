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
                ], isReversed: true, reverseProxyPath: "Media/reverse.mov",
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
        guard try ProjectDocumentStore.load(from: file) == document else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 1)
        }
        let legacyReverse = try JSONDecoder().decode(
            StoredClip.self,
            from: Data(#"{"id":"00000000-0000-0000-0000-000000000001","assetID":"00000000-0000-0000-0000-000000000002","trimStart":0,"trimEnd":2,"isReversed":true,"reverseProxyPath":"Media/reverse.mov","muteBeforeReverse":false}"#.utf8)
        )
        guard legacyReverse.reverseIncludesAudio == nil else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 12)
        }
        let legacyTransform = try JSONDecoder().decode(
            ClipTransform.self, from: Data(#"{"scale":1.5,"x":0.2,"y":-0.1,"opacity":0.7}"#.utf8)
        )
        guard legacyTransform.rotation == 0 else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 8)
        }
        let legacyKeyframe = try JSONDecoder().decode(
            ClipTransformKeyframe.self,
            from: Data(#"{"id":"00000000-0000-0000-0000-000000000001","position":0.5,"scale":2,"x":0.1,"y":0.2,"opacity":0.8,"curve":"linear"}"#.utf8)
        )
        guard legacyKeyframe.rotation == 0, legacyKeyframe.bezier == nil else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 9)
        }
        let legacyOverlayKeyframe = try JSONDecoder().decode(
            OverlayKeyframe.self,
            from: Data(#"{"id":"00000000-0000-0000-0000-000000000002","time":0.5,"x":0.1,"y":0.2,"scale":0.8,"rotation":0,"opacity":0.7,"curve":"easeInOut"}"#.utf8)
        )
        guard legacyOverlayKeyframe.bezier == nil else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 13)
        }
        var pathDocument = document
        ProjectDocumentStore.remapStoredMediaPaths(in: &pathDocument) {
            "Migrated/" + URL(fileURLWithPath: $0).lastPathComponent
        }
        guard pathDocument.mediaAssets[1].proxyPath == "Migrated/still.mov",
              pathDocument.clips[0].effectProxyPath == "Migrated/effect.mov",
              pathDocument.clips[0].reverseProxyPath == "Migrated/reverse.mov",
              pathDocument.clips[0].lutPath == "Migrated/film.cube",
              pathDocument.bgmPath == "Migrated/music.m4a" else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 10)
        }
        let legacyFile = root.appendingPathComponent("legacy.json")
        let legacyJSON = """
        {"version":1,"mediaAssets":[],"clips":[],"bgmPath":null,"bgmName":null,"originalVolume":1,"bgmVolume":0.5,"transitionDuration":0}
        """
        try Data(legacyJSON.utf8).write(to: legacyFile)
        guard let upgraded = try ProjectDocumentStore.load(from: legacyFile),
              upgraded.version == ProjectDocument.currentVersion,
              upgraded.exportSettings == StoredExportSettings(),
              upgraded.overlays.isEmpty, upgraded.audioTracks.isEmpty else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 4)
        }
        let transitionAssetID = UUID()
        let transitionDocument = ProjectDocument(
            timelineDuration: nil, mediaAssets: [], clips: [
                StoredClip(id: UUID(), assetID: transitionAssetID, trimStart: 0, trimEnd: 4),
                StoredClip(
                    id: UUID(), assetID: transitionAssetID, trimStart: 0, trimEnd: 6,
                    outgoingTransition: ClipTransition(style: .pushRight, duration: 1.25)
                ),
                StoredClip(
                    id: UUID(), assetID: transitionAssetID, trimStart: 0, trimEnd: 8,
                    outgoingTransition: ClipTransition(style: .pushLeft, duration: 2)
                )
            ], bgmPath: nil, bgmName: nil, originalVolume: 1, bgmVolume: 0.5,
            transitionDuration: 0.5
        )
        guard transitionDocument.upgraded().timelineDuration == 16.25,
              transitionDocument.resolvedOutgoingTransition(at: 0) ==
                ClipTransition(style: .dissolve, duration: 0.5),
              transitionDocument.resolvedOutgoingTransition(at: 1) ==
                ClipTransition(style: .pushRight, duration: 1.25),
              transitionDocument.resolvedOutgoingTransition(at: 2) == ClipTransition() else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 11)
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

        let project = try ProjectDocumentStore.createProject(name: " Smoke Draft " )
        var duplicateID: UUID?
        defer {
            try? ProjectDocumentStore.deleteProject(project.id)
            if let duplicateID { try? ProjectDocumentStore.deleteProject(duplicateID) }
        }
        guard project.name == "Smoke Draft" else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 5)
        }
        let projectMedia = try ProjectDocumentStore.mediaDirectory(for: project.id)
            .appendingPathComponent("sample.mov")
        try Data([1, 2, 3]).write(to: projectMedia)
        var projectDocument = try ProjectDocumentStore.load(projectID: project.id)!
        projectDocument.mediaAssets = [StoredMediaAsset(
            id: UUID(), path: "Media/sample.mov", name: "sample.mov", duration: 1, sourceIdentifier: "smoke"
        )]
        try ProjectDocumentStore.save(projectDocument, projectID: project.id)
        let renamed = try ProjectDocumentStore.renameProject(project.id, to: "Renamed")
        guard renamed.name == "Renamed" else { throw NSError(domain: "ProjectDocumentSmoke", code: 6) }
        let duplicate = try ProjectDocumentStore.duplicateProject(project.id, name: "Duplicate")
        duplicateID = duplicate.id
        let copiedMedia = try ProjectDocumentStore.resolvedURL(
            for: "Media/sample.mov", projectID: duplicate.id
        )
        guard FileManager.default.fileExists(atPath: copiedMedia.path) else {
            throw NSError(domain: "ProjectDocumentSmoke", code: 7)
        }
        print("iOS project document smoke: passed")
    }
}
