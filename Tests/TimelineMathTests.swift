import XCTest
@testable import MiniClip

final class TimelineMathTests: XCTestCase {
    func testTransitionClampsToHalfShortestClip() {
        XCTAssertEqual(TimelineMath.effectiveTransitionDuration(durations: [10, 2, 5], requested: 3), 1)
        XCTAssertEqual(TimelineMath.timelineDuration(durations: [10, 2, 5], transition: 3), 15)
    }

    func testSplitMapsTimelineTimeThroughOverlap() {
        let split = TimelineMath.splitSourceTime(
            playhead: 11, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        )
        XCTAssertEqual(split, 4)
    }

    func testSplitRejectsEdgesAndInvalidClip() {
        XCTAssertNil(TimelineMath.splitSourceTime(
            playhead: 9.05, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        ))
        XCTAssertNil(TimelineMath.clipStart(index: 2, durations: [3, 4], transition: 0.5))
    }

    func testSplitMapsFastClipBackToSourceTime() {
        XCTAssertEqual(TimelineMath.splitSourceTime(
            playhead: 1, clipIndex: 0, trimStart: 2, trimEnd: 8, speed: 2,
            durations: [3], transition: 0
        ), 4)
        XCTAssertNil(TimelineMath.splitSourceTime(
            playhead: 2.95, clipIndex: 0, trimStart: 2, trimEnd: 8, speed: 2,
            durations: [3], transition: 0
        ))
    }
}
