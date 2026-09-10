import Foundation

@main
enum TimelineMathSmoke {
    static func main() {
        precondition(TimelineMath.effectiveTransitionDuration(durations: [10, 2, 5], requested: 3) == 1)
        precondition(TimelineMath.timelineDuration(durations: [10, 2, 5], transition: 3) == 15)
        let boundaryTransitions = TimelineMath.effectiveTransitionDurations(
            durations: [6, 4, 8], requested: [1.5, 0.25]
        )
        precondition(boundaryTransitions == [1.5, 0.25])
        precondition(TimelineMath.timelineDuration(
            durations: [6, 4, 8], transitions: boundaryTransitions
        ) == 16.25)
        precondition(TimelineMath.clipStart(
            index: 2, durations: [6, 4, 8], transitions: boundaryTransitions
        ) == 8.25)
        precondition(TimelineMath.splitSourceTime(
            playhead: 11, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        ) == 4)
        precondition(TimelineMath.splitSourceTime(
            playhead: 10.5, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transitions: [1.5]
        ) == 4)
        let instructionSpans = TimelineMath.videoInstructionSpans(
            durations: [6, 4, 8, 2], transitions: [0, 1.5, 0]
        )
        precondition(instructionSpans.map(\.kind) == [
            .solo(clipIndex: 0), .solo(clipIndex: 1),
            .transition(boundaryIndex: 1), .solo(clipIndex: 2), .solo(clipIndex: 3)
        ])
        precondition(zip(instructionSpans, instructionSpans.dropFirst()).allSatisfy {
            abs(($0.start + $0.duration) - $1.start) < 0.000_001
        })
        precondition(abs((instructionSpans.last.map { $0.start + $0.duration } ?? 0) - 18.5) < 0.000_001)
        let points = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.5),
            SpeedPoint(id: UUID(), position: 1, speed: 2)
        ]
        let mapped = TimelineMath.outputTime(
            forSourceOffset: 3.25, sourceDuration: 8, baseSpeed: 1, points: points
        )
        precondition(abs(TimelineMath.sourceOffset(
            forOutputTime: mapped, sourceDuration: 8, baseSpeed: 1, points: points
        ) - 3.25) < 0.001)
        let keyframe = OverlayKeyframe(
            id: UUID(), time: 2, x: 1, y: 1, scale: 1, rotation: 90, opacity: 0, curve: .easeIn
        )
        let base = OverlayKeyframe(
            id: UUID(), time: 0, x: 0, y: 0, scale: 0.2, rotation: 0, opacity: 1, curve: .linear
        )
        precondition(abs(TimelineMath.overlayValue(at: 1, base: base, keyframes: [base, keyframe]).x - 0.25) < 0.001)
        let delayedKeyframe = OverlayKeyframe(
            id: UUID(), time: 2, x: 0.8, y: 0.6, scale: 0.8, rotation: 90, opacity: 0.5, curve: .linear
        )
        let delayedBase = OverlayKeyframe(
            id: UUID(), time: 0, x: 0.2, y: 0.2, scale: 0.2, rotation: 0, opacity: 1, curve: .linear
        )
        precondition(abs(TimelineMath.overlayValue(
            at: 1, base: delayedBase, keyframes: [delayedKeyframe]
        ).x - 0.5) < 0.001)
        let customBezier = KeyframeBezier(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1)
        precondition(abs(TimelineMath.cubicBezierProgress(
            at: 0.5, controls: customBezier
        ) - 0.8024) < 0.0005)
        let customOverlay = OverlayKeyframe(
            id: UUID(), time: 2, x: 1, y: 1, scale: 1, rotation: 100,
            opacity: 0, curve: .custom, bezier: customBezier
        )
        precondition(abs(TimelineMath.overlayValue(
            at: 1, base: base, keyframes: [customOverlay]
        ).x - 0.8024) < 0.0005)
        let clipTransformBase = ClipTransform(rotation: 10)
        let transformFrames = [ClipTransformKeyframe(
            id: UUID(), position: 1, scale: 2, x: 0.8, y: -0.4,
            rotation: 90, opacity: 0.2, curve: .easeIn
        )]
        let transformMidpoint = TimelineMath.clipTransformValue(
            at: 0.5, base: clipTransformBase, keyframes: transformFrames
        )
        precondition(abs(transformMidpoint.scale - 1.25) < 0.001)
        precondition(abs(transformMidpoint.rotation - 30) < 0.001)
        precondition(abs(transformMidpoint.opacity - 0.8) < 0.001)
        let transformSplit = TimelineMath.splitClipTransformKeyframes(
            base: clipTransformBase, keyframes: transformFrames, at: 0.5
        )
        precondition(abs((transformSplit.left.last?.scale ?? 0) - transformMidpoint.scale) < 0.001)
        precondition(transformSplit.rightBase == transformMidpoint)
        precondition(TimelineMath.splitSourceTime(
            playhead: 9.05, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        ) == nil)
        precondition(TimelineMath.splitSourceTime(
            playhead: 1, clipIndex: 0, trimStart: 2, trimEnd: 8, speed: 2,
            durations: [3], transition: 0
        ) == 4)
        let curveSplit = TimelineMath.splitSpeedPoints(points, at: 0.4, baseSpeed: 1)
        let boundarySpeed = TimelineMath.speedAt(position: 0.4, baseSpeed: 1, points: points)
        precondition(abs((curveSplit.left.last?.speed ?? 0) - boundarySpeed) < 0.001)
        precondition(abs((curveSplit.right.first?.speed ?? 0) - boundarySpeed) < 0.001)
        let originalCurveDuration = TimelineMath.speedCurveDuration(
            sourceDuration: 8, baseSpeed: 1, points: points
        )
        let splitCurveDuration = TimelineMath.speedCurveDuration(
            sourceDuration: 3.2, baseSpeed: 1, points: curveSplit.left
        ) + TimelineMath.speedCurveDuration(
            sourceDuration: 4.8, baseSpeed: 1, points: curveSplit.right
        )
        precondition(abs(splitCurveDuration - originalCurveDuration) < 0.01)
        let slow = [
            SpeedPoint(id: UUID(), position: 0, speed: 0.25),
            SpeedPoint(id: UUID(), position: 1, speed: 0.25)
        ]
        precondition(abs((TimelineMath.splitSourceTime(
            playhead: 8, clipIndex: 0, trimStart: 10, trimEnd: 20,
            speedPoints: slow, durations: [40], transition: 0, isReversed: true
        ) ?? 0) - 18) < 0.001)
        let captionStart = TimelineMath.outputTime(
            forSourceOffset: 2, sourceDuration: 8, baseSpeed: 1, points: points
        )
        let captionEnd = TimelineMath.outputTime(
            forSourceOffset: 4, sourceDuration: 8, baseSpeed: 1, points: points
        )
        precondition(captionEnd > captionStart)
        print("iOS timeline math smoke: passed")
    }
}
