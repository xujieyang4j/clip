import XCTest
@testable import MiniClip

final class TimelineMathTests: XCTestCase {
    func testTransitionClampsToHalfShortestClip() {
        XCTAssertEqual(TimelineMath.effectiveTransitionDuration(durations: [10, 2, 5], requested: 3), 1)
        XCTAssertEqual(TimelineMath.timelineDuration(durations: [10, 2, 5], transition: 3), 15)
    }

    func testPerBoundaryTransitionsDriveDurationAndClipStarts() {
        let durations = [6.0, 4.0, 8.0]
        let overlaps = TimelineMath.effectiveTransitionDurations(
            durations: durations, requested: [1.5, 0.25]
        )
        XCTAssertEqual(overlaps, [1.5, 0.25])
        XCTAssertEqual(
            TimelineMath.timelineDuration(durations: durations, transitions: overlaps), 16.25
        )
        XCTAssertEqual(
            TimelineMath.clipStart(index: 1, durations: durations, transitions: overlaps), 4.5
        )
        XCTAssertEqual(
            TimelineMath.clipStart(index: 2, durations: durations, transitions: overlaps), 8.25
        )
    }

    func testPerBoundaryTransitionClampsAgainstAdjacentClips() {
        XCTAssertEqual(
            TimelineMath.effectiveTransitionDurations(
                durations: [10, 2, 8], requested: [3, 4]
            ),
            [1, 1]
        )
        XCTAssertEqual(
            TimelineMath.effectiveTransitionDurations(
                durations: [10, 2, 8], requested: [.nan, -1, 4]
            ),
            [0, 0]
        )
    }

    func testSplitMapsThroughPerBoundaryTransitions() {
        XCTAssertEqual(TimelineMath.splitSourceTime(
            playhead: 10.5, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transitions: [1.5]
        ), 4)
    }

    func testMixedTransitionInstructionSpansCoverTimelineWithoutGaps() {
        let spans = TimelineMath.videoInstructionSpans(
            durations: [6, 4, 8, 2], transitions: [0, 1.5, 0]
        )
        XCTAssertEqual(spans.map(\.kind), [
            .solo(clipIndex: 0), .solo(clipIndex: 1),
            .transition(boundaryIndex: 1), .solo(clipIndex: 2),
            .solo(clipIndex: 3)
        ])
        XCTAssertEqual(spans.map(\.start), [0, 6, 8.5, 10, 16.5])
        XCTAssertEqual(spans.map(\.duration), [6, 2.5, 1.5, 6.5, 2])
        for pair in zip(spans, spans.dropFirst()) {
            XCTAssertEqual(pair.0.start + pair.0.duration, pair.1.start, accuracy: 0.000_001)
        }
        XCTAssertEqual(
            spans.last.map { $0.start + $0.duration },
            TimelineMath.timelineDuration(
                durations: [6, 4, 8, 2], transitions: [0, 1.5, 0]
            )
        )
    }

    func testBackToBackTransitionsRemainContiguousWhenInteriorSoloSpanIsEmpty() {
        let spans = TimelineMath.videoInstructionSpans(
            durations: [10, 2, 10], transitions: [1, 1]
        )
        XCTAssertEqual(spans.map(\.kind), [
            .solo(clipIndex: 0), .transition(boundaryIndex: 0),
            .transition(boundaryIndex: 1), .solo(clipIndex: 2)
        ])
        for pair in zip(spans, spans.dropFirst()) {
            XCTAssertEqual(pair.0.start + pair.0.duration, pair.1.start, accuracy: 0.000_001)
        }
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

    func testSpeedCurveDurationAndRoundTripMapping() {
        let points = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.5),
            SpeedPoint(id: UUID(), position: 1, speed: 2)
        ]
        let duration = TimelineMath.speedCurveDuration(sourceDuration: 8, baseSpeed: 1, points: points)
        XCTAssertGreaterThan(duration, 4)
        XCTAssertLessThan(duration, 16)
        let output = TimelineMath.outputTime(
            forSourceOffset: 3.25, sourceDuration: 8, baseSpeed: 1, points: points
        )
        XCTAssertEqual(
            TimelineMath.sourceOffset(
                forOutputTime: output, sourceDuration: 8, baseSpeed: 1, points: points
            ),
            3.25, accuracy: 0.001
        )
    }

    func testOverlayKeyframeInterpolationUsesCurve() {
        let base = OverlayKeyframe(
            id: UUID(), time: 0, x: 0, y: 0, scale: 0.2, rotation: 0, opacity: 1, curve: .linear
        )
        let end = OverlayKeyframe(
            id: UUID(), time: 2, x: 1, y: 1, scale: 1, rotation: 90, opacity: 0, curve: .easeIn
        )
        let value = TimelineMath.overlayValue(at: 1, base: base, keyframes: [base, end])
        XCTAssertEqual(value.x, 0.25, accuracy: 0.001)
        XCTAssertEqual(value.rotation, 22.5, accuracy: 0.001)
    }

    func testCustomBezierSolvesTimelineXAndRemainsMonotonic() {
        let controls = KeyframeBezier(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1)
        XCTAssertEqual(TimelineMath.cubicBezierProgress(at: 0, controls: controls), 0)
        XCTAssertEqual(TimelineMath.cubicBezierProgress(at: 1, controls: controls), 1)
        XCTAssertEqual(
            TimelineMath.cubicBezierProgress(at: 0.5, controls: controls),
            0.8024, accuracy: 0.0005
        )
        let values = stride(from: 0.0, through: 1.0, by: 0.02).map {
            TimelineMath.cubicBezierProgress(at: $0, controls: controls)
        }
        XCTAssertTrue(zip(values, values.dropFirst()).allSatisfy { $0 <= $1 })
    }

    func testCustomBezierDrivesOverlayAndMainTrackInterpolation() {
        let bezier = KeyframeBezier(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1)
        let overlayBase = OverlayKeyframe(
            id: UUID(), time: 0, x: 0, y: 0, scale: 1, rotation: 0,
            opacity: 1, curve: .linear
        )
        let overlayEnd = OverlayKeyframe(
            id: UUID(), time: 2, x: 1, y: 1, scale: 2, rotation: 100,
            opacity: 0, curve: .custom, bezier: bezier
        )
        let overlayValue = TimelineMath.overlayValue(
            at: 1, base: overlayBase, keyframes: [overlayEnd]
        )
        XCTAssertEqual(overlayValue.x, 0.8024, accuracy: 0.0005)
        XCTAssertEqual(overlayValue.rotation, 80.24, accuracy: 0.05)

        let transformEnd = ClipTransformKeyframe(
            id: UUID(), position: 1, scale: 2, x: 1, y: -1, rotation: 100,
            opacity: 0, curve: .custom, bezier: bezier
        )
        let transformValue = TimelineMath.clipTransformValue(
            at: 0.5, base: ClipTransform(), keyframes: [transformEnd]
        )
        XCTAssertEqual(transformValue.scale, 1.8024, accuracy: 0.0005)
        XCTAssertEqual(transformValue.rotation, 80.24, accuracy: 0.05)
    }

    func testBezierNormalizationKeepsTimeHandlesOrderedAndFinite() {
        let value = KeyframeBezier(x1: 0.9, y1: .nan, x2: 0.1, y2: 3).normalized
        XCTAssertEqual(value.x1, 0.9)
        XCTAssertEqual(value.x2, 0.9)
        XCTAssertEqual(value.y1, 0.1)
        XCTAssertEqual(value.y2, 1)
    }

    func testFirstOverlayKeyframeInterpolatesFromBaseState() {
        let base = OverlayKeyframe(
            id: UUID(), time: 0, x: 0.2, y: 0.2, scale: 0.2, rotation: 0, opacity: 1, curve: .linear
        )
        let first = OverlayKeyframe(
            id: UUID(), time: 2, x: 0.8, y: 0.6, scale: 0.8, rotation: 90, opacity: 0.5, curve: .linear
        )
        let value = TimelineMath.overlayValue(at: 1, base: base, keyframes: [first])
        XCTAssertEqual(value.x, 0.5, accuracy: 0.001)
        XCTAssertEqual(value.rotation, 45, accuracy: 0.001)
        XCTAssertEqual(value.opacity, 0.75, accuracy: 0.001)
    }

    func testClipTransformKeyframeInterpolationUsesOutputPosition() {
        let base = ClipTransform(scale: 1, x: 0, y: 0, rotation: 10, opacity: 1)
        let frame = ClipTransformKeyframe(
            id: UUID(), position: 1, scale: 2, x: 0.8, y: -0.4,
            rotation: 90, opacity: 0.2, curve: .easeIn
        )
        let value = TimelineMath.clipTransformValue(at: 0.5, base: base, keyframes: [frame])
        XCTAssertEqual(value.scale, 1.25, accuracy: 0.001)
        XCTAssertEqual(value.x, 0.2, accuracy: 0.001)
        XCTAssertEqual(value.y, -0.1, accuracy: 0.001)
        XCTAssertEqual(value.rotation, 30, accuracy: 0.001)
        XCTAssertEqual(value.opacity, 0.8, accuracy: 0.001)
    }

    func testClipTransformSplitPreservesBoundaryAndRemapsPositions() {
        let base = ClipTransform(scale: 1, x: 0, y: 0, opacity: 1)
        let frames = [
            ClipTransformKeyframe(
                id: UUID(), position: 0.25, scale: 1.5, x: 0.2, y: 0.1,
                opacity: 0.8, curve: .linear
            ),
            ClipTransformKeyframe(
                id: UUID(), position: 0.75, scale: 2.5, x: 0.6, y: -0.3,
                opacity: 0.4, curve: .linear
            )
        ]
        let expected = TimelineMath.clipTransformValue(at: 0.5, base: base, keyframes: frames)
        let split = TimelineMath.splitClipTransformKeyframes(base: base, keyframes: frames, at: 0.5)
        XCTAssertEqual(split.left.last?.position, 1)
        XCTAssertEqual(split.right.first?.position, 0.5)
        XCTAssertEqual(split.left.last?.scale ?? 0, expected.scale, accuracy: 0.001)
        XCTAssertEqual(split.rightBase, expected)
        XCTAssertEqual(
            TimelineMath.clipTransformValue(at: 1, base: split.leftBase, keyframes: split.left),
            expected
        )
        XCTAssertEqual(
            TimelineMath.clipTransformValue(at: 0, base: split.rightBase, keyframes: split.right),
            expected
        )
    }

    func testClipTransformSplitPreservesCustomBezierOnBothSides() {
        let bezier = KeyframeBezier(x1: 0.15, y1: 0.7, x2: 0.8, y2: 0.9)
        let frames = [ClipTransformKeyframe(
            id: UUID(), position: 0.8, scale: 2, x: 0.5, y: 0, rotation: 40,
            opacity: 0.4, curve: .custom, bezier: bezier
        )]
        let split = TimelineMath.splitClipTransformKeyframes(
            base: ClipTransform(), keyframes: frames, at: 0.4
        )
        XCTAssertEqual(split.left.last?.curve, .custom)
        XCTAssertEqual(split.left.last?.bezier, bezier)
        XCTAssertEqual(split.right.last?.curve, .custom)
        XCTAssertEqual(split.right.last?.bezier, bezier)
    }

    func testSpeedCurveSplitPreservesBoundarySpeedAndMapping() {
        let points = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.5),
            SpeedPoint(id: UUID(), position: 0.7, speed: 2),
            SpeedPoint(id: UUID(), position: 1, speed: 0.75)
        ]
        let split = TimelineMath.splitSpeedPoints(points, at: 0.4, baseSpeed: 1)
        let expected = TimelineMath.speedAt(position: 0.4, baseSpeed: 1, points: points)
        XCTAssertEqual(split.left.last?.position, 1)
        XCTAssertEqual(split.right.first?.position, 0)
        XCTAssertEqual(split.left.last?.speed ?? 0, expected, accuracy: 0.001)
        XCTAssertEqual(split.right.first?.speed ?? 0, expected, accuracy: 0.001)
        XCTAssertEqual(
            TimelineMath.speedAt(position: 0.5, baseSpeed: 1, points: split.left),
            TimelineMath.speedAt(position: 0.2, baseSpeed: 1, points: points),
            accuracy: 0.001
        )
        XCTAssertEqual(
            TimelineMath.speedAt(position: 0.5, baseSpeed: 1, points: split.right),
            TimelineMath.speedAt(position: 0.7, baseSpeed: 1, points: points),
            accuracy: 0.001
        )
        let originalDuration = TimelineMath.speedCurveDuration(
            sourceDuration: 10, baseSpeed: 1, points: points
        )
        let splitDuration = TimelineMath.speedCurveDuration(
            sourceDuration: 4, baseSpeed: 1, points: split.left
        ) + TimelineMath.speedCurveDuration(
            sourceDuration: 6, baseSpeed: 1, points: split.right
        )
        XCTAssertEqual(splitDuration, originalDuration, accuracy: 0.01)
    }

    func testCurveSplitUsesCurveDurationForNormalAndReversedClips() {
        let slow = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.25),
            SpeedPoint(id: UUID(), position: 1, speed: 0.25)
        ]
        XCTAssertEqual(TimelineMath.splitSourceTime(
            playhead: 8, clipIndex: 0, trimStart: 10, trimEnd: 20,
            speedPoints: slow, durations: [40], transition: 0
        ) ?? .nan, 12, accuracy: 0.001)
        XCTAssertEqual(TimelineMath.splitSourceTime(
            playhead: 8, clipIndex: 0, trimStart: 10, trimEnd: 20,
            speedPoints: slow, durations: [40], transition: 0, isReversed: true
        ) ?? .nan, 18, accuracy: 0.001)
    }

    func testCaptionRangeMapsThroughTheSameSpeedCurveAsVideo() {
        let points = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.5),
            SpeedPoint(id: UUID(), position: 1, speed: 2)
        ]
        let start = TimelineMath.outputTime(
            forSourceOffset: 2, sourceDuration: 8, baseSpeed: 1, points: points
        )
        let end = TimelineMath.outputTime(
            forSourceOffset: 4, sourceDuration: 8, baseSpeed: 1, points: points
        )
        XCTAssertGreaterThan(end, start)
        XCTAssertEqual(TimelineMath.sourceOffset(
            forOutputTime: start, sourceDuration: 8, baseSpeed: 1, points: points
        ), 2, accuracy: 0.001)
        XCTAssertEqual(TimelineMath.sourceOffset(
            forOutputTime: end, sourceDuration: 8, baseSpeed: 1, points: points
        ), 4, accuracy: 0.001)
    }
}
