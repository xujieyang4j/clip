import XCTest
@testable import MiniClip

final class CubeLUTTests: XCTestCase {
    func testParsesThreeDimensionalCubeAndBuildsRGBAData() throws {
        let lut = try CubeLUT.parse(text: Self.validCube)
        XCTAssertEqual(lut.dimension, 2)
        XCTAssertEqual(lut.entries.count, 8)
        XCTAssertEqual(lut.domainMinimum, .init(red: -1, green: -1, blue: -1))
        XCTAssertEqual(lut.domainMaximum, .init(red: 1, green: 1, blue: 1))
        XCTAssertEqual(lut.rgbaData.count, 8 * 4 * MemoryLayout<Float>.size)
    }

    func testRejectsIncompleteCube() {
        XCTAssertThrowsError(try CubeLUT.parse(text: "LUT_3D_SIZE 2\n0 0 0"))
    }

    func testRejectsOversizedDataBeforeParsing() {
        let data = Data(repeating: 0x20, count: CubeLUT.maximumFileSize + 1)
        XCTAssertThrowsError(try CubeLUT.parse(data: data)) { error in
            XCTAssertEqual(error as? CubeLUTError, .fileTooLarge)
        }
    }

    private static let validCube = """
    # identity cube
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
}
