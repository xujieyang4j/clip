import Foundation

@main
enum SubtitleSRTSmoke {
    static func main() throws {
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
        guard items.count == 2, items[0].text == "第一行\n第二行",
              abs(items[0].start - 1.25) < 0.001, abs(items[1].end - 5.125) < 0.001 else {
            throw NSError(domain: "SubtitleSRTSmoke", code: 1)
        }
        let roundTrip = try SubtitleSRT.decode(Data(SubtitleSRT.encode(subtitles: items).utf8))
        guard roundTrip.map(\.text) == items.map(\.text),
              roundTrip.map(\.start) == items.map(\.start),
              roundTrip.map(\.end) == items.map(\.end) else {
            throw NSError(domain: "SubtitleSRTSmoke", code: 2)
        }
        print("iOS subtitle SRT smoke: passed")
    }
}
