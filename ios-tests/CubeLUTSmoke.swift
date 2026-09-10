import Foundation

@main
enum CubeLUTSmoke {
    static func main() throws {
        let text = """
        TITLE "Identity"
        LUT_3D_SIZE 2
        DOMAIN_MIN -1 -1 -1
        DOMAIN_MAX 1 1 1
        0 0 0
        1 0 0
        0 1 0
        1 1 0
        0 0 1
        1 0 1
        0 1 1
        1 1 1
        """
        let lut = try CubeLUT.parse(text: text)
        precondition(lut.dimension == 2)
        precondition(lut.entries.count == 8)
        precondition(lut.rgbaData.count == 8 * 4 * MemoryLayout<Float>.size)
        do {
            _ = try CubeLUT.parse(text: "LUT_3D_SIZE 2\n0 0 0")
            preconditionFailure("Incomplete LUT should fail")
        } catch let error as CubeLUTError {
            guard case .invalidEntryCount(expected: 8, actual: 1) = error else { throw error }
        }
        do {
            _ = try CubeLUT.parse(data: Data(
                repeating: 0x20, count: CubeLUT.maximumFileSize + 1
            ))
            preconditionFailure("Oversized LUT should fail")
        } catch let error as CubeLUTError {
            guard case .fileTooLarge = error else { throw error }
        }
        print("iOS cube LUT smoke: passed")
    }
}
