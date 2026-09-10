import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let subRipSubtitle = UTType(filenameExtension: "srt") ?? .plainText
}

struct SubtitleDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.subRipSubtitle, .plainText] }
    var text: String

    init(text: String = "") {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents,
              let value = String(data: data, encoding: .utf8)
                ?? String(data: data, encoding: .utf16) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        text = value
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
