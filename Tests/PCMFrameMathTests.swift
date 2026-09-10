import Foundation
import XCTest
@testable import MiniClip

final class PCMFrameMathTests: XCTestCase {
    func testStereoReversePreservesChannelPairs() {
        let samples: [Int16] = [1, 101, 2, 102, 3, 103]
        let input = samples.withUnsafeBytes { Data($0) }
        let reversed = PCMFrameMath.reversedPCM16(input, channels: 2)
        let output = reversed.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(output, [3, 103, 2, 102, 1, 101])
    }

    func testMonoReverseAndIncompleteFrameTruncation() {
        let samples: [Int16] = [10, 20, 30]
        var input = samples.withUnsafeBytes { Data($0) }
        input.append(0x7f)
        let reversed = PCMFrameMath.reversedPCM16(input, channels: 1)
        let output = reversed.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(output, [30, 20, 10])
        XCTAssertEqual(reversed.count, samples.count * MemoryLayout<Int16>.size)
    }
}
