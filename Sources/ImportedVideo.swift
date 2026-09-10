#if os(iOS)
import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// File-backed PhotosPicker transfer. Copying the provider-owned URL here
/// avoids loading a potentially multi-gigabyte movie into memory as Data.
struct ImportedVideo: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return ImportedVideo(url: copy, name: received.file.lastPathComponent)
        }
    }
}

struct ImportedImage: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .image) { image in
            SentTransferredFile(image.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "jpg" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return ImportedImage(url: copy, name: received.file.lastPathComponent)
        }
    }
}
#endif
