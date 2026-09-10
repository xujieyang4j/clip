import Foundation
import XCTest
@testable import MiniClip

final class SubtitleSRTTests: XCTestCase {
    func testDecodesMultilineAndCommaMilliseconds() throws {
        let source = """
        1
        00:00:01,250 --> 00:00:03,500
        第一行
        第二行

        2
        00:00:04.000 --> 00:00:05.125
        Hello
        """
        let items = try SubtitleSRT.decode(Data(source.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].text, "第一行\n第二行")
        XCTAssertEqual(items[0].start, 1.25, accuracy: 0.001)
        XCTAssertEqual(items[1].end, 5.125, accuracy: 0.001)
    }

    func testEncodeDecodeRoundTripPreservesTimingAndText() throws {
        let items = [
            SubtitleItem(id: UUID(), text: "Hello", start: 0.1, end: 1.234, style: .highlight),
            SubtitleItem(id: UUID(), text: "第二条", start: 2, end: 3.5, style: .center)
        ]
        let decoded = try SubtitleSRT.decode(Data(SubtitleSRT.encode(subtitles: items).utf8))
        XCTAssertEqual(decoded.map(\.text), items.map(\.text))
        XCTAssertEqual(decoded.map(\.start), items.map(\.start))
        XCTAssertEqual(decoded.map(\.end), items.map(\.end))
        XCTAssertTrue(decoded.allSatisfy { $0.style == .classic })
    }
}
