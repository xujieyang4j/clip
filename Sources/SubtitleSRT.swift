import Foundation

enum SubtitleSRT {
    static func decode(_ data: Data) throws -> [SubtitleItem] {
        guard let raw = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        let normalized = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{feff}", with: "")
        let blocks = normalized.components(separatedBy: "\n\n")
        return blocks.compactMap(parseBlock).sorted { lhs, rhs in
            lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
        }
    }

    static func encode(subtitles: [SubtitleItem]) -> String {
        subtitles.sorted { lhs, rhs in
            lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
        }.enumerated().map { index, item in
            "\(index + 1)\n\(format(item.start)) --> \(format(item.end))\n\(item.text)"
        }.joined(separator: "\n\n") + (subtitles.isEmpty ? "" : "\n")
    }

    private static func parseBlock(_ block: String) -> SubtitleItem? {
        var lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        while lines.first?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true { lines.removeFirst() }
        guard !lines.isEmpty else { return nil }
        if Int(lines[0].trimmingCharacters(in: .whitespaces)) != nil { lines.removeFirst() }
        guard let timing = lines.first else { return nil }
        lines.removeFirst()
        let parts = timing.components(separatedBy: "-->")
        guard parts.count == 2,
              let start = parseTime(parts[0]),
              let end = parseTime(parts[1]),
              end > start else { return nil }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return SubtitleItem(id: UUID(), text: text, start: start, end: end, style: .classic)
    }

    private static func parseTime(_ value: String) -> Double? {
        let cleaned = value.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: ",", with: ".")
        let pieces = cleaned.split(separator: ":", omittingEmptySubsequences: false)
        guard pieces.count == 3, let hours = Double(pieces[0]),
              let minutes = Double(pieces[1]), let seconds = Double(pieces[2]) else { return nil }
        let total = hours * 3600 + minutes * 60 + seconds
        return total.isFinite && total >= 0 ? total : nil
    }

    private static func format(_ seconds: Double) -> String {
        let milliseconds = Int((max(0, seconds) * 1000).rounded())
        let hours = milliseconds / 3_600_000
        let minutes = milliseconds / 60_000 % 60
        let secs = milliseconds / 1_000 % 60
        let millis = milliseconds % 1_000
        return String(format: "%02d:%02d:%02d,%03d", hours, minutes, secs, millis)
    }
}
