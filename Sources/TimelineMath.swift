import Foundation

struct TimelineSpeedSegment: Equatable {
    var sourceOffset: Double
    var sourceDuration: Double
    var outputDuration: Double
}

struct TimelineVideoInstructionSpan: Equatable {
    enum Kind: Equatable {
        case solo(clipIndex: Int)
        case transition(boundaryIndex: Int)
    }

    var kind: Kind
    var start: Double
    var duration: Double
}

enum TimelineMath {
    static func speedAt(position: Double, baseSpeed: Double, points: [SpeedPoint]) -> Double {
        let boundedBase = max(0.25, min(4, baseSpeed))
        let ordered = points
            .map { SpeedPoint(id: $0.id, position: max(0, min(1, $0.position)), speed: max(0.25, min(4, $0.speed))) }
            .sorted { $0.position < $1.position }
        guard !ordered.isEmpty else { return boundedBase }
        let p = max(0, min(1, position))
        if p <= ordered[0].position { return ordered[0].speed }
        if p >= ordered[ordered.count - 1].position { return ordered[ordered.count - 1].speed }
        for index in 0..<(ordered.count - 1) {
            let left = ordered[index]
            let right = ordered[index + 1]
            guard left.position <= p, p <= right.position else { continue }
            let span = max(0.0001, right.position - left.position)
            let progress = (p - left.position) / span
            return left.speed + (right.speed - left.speed) * progress
        }
        return boundedBase
    }

    static func speedCurveDuration(
        sourceDuration: Double, baseSpeed: Double, points: [SpeedPoint], slices: Int = 48
    ) -> Double {
        let duration = max(0, sourceDuration)
        guard duration > 0 else { return 0 }
        guard !points.isEmpty else { return duration / max(0.25, min(4, baseSpeed)) }
        let count = max(8, slices)
        let sourceStep = duration / Double(count)
        return (0..<count).reduce(0) { result, index in
            let position = (Double(index) + 0.5) / Double(count)
            return result + sourceStep / speedAt(position: position, baseSpeed: baseSpeed, points: points)
        }
    }

    static func speedSegments(
        sourceDuration: Double, baseSpeed: Double, points: [SpeedPoint], slices: Int = 48
    ) -> [TimelineSpeedSegment] {
        let duration = max(0, sourceDuration)
        guard duration > 0 else { return [] }
        guard !points.isEmpty else {
            return [TimelineSpeedSegment(
                sourceOffset: 0, sourceDuration: duration,
                outputDuration: duration / max(0.25, min(4, baseSpeed))
            )]
        }
        let count = max(8, slices)
        let step = duration / Double(count)
        return (0..<count).map { index in
            let position = (Double(index) + 0.5) / Double(count)
            return TimelineSpeedSegment(
                sourceOffset: Double(index) * step, sourceDuration: step,
                outputDuration: step / speedAt(position: position, baseSpeed: baseSpeed, points: points)
            )
        }
    }

    /// Splits a normalized playback-speed curve without changing its shape.
    /// The speed sampled at the cut becomes the right/left boundary point, so
    /// neither resulting clip inherits a flat gap around the split.
    static func splitSpeedPoints(
        _ points: [SpeedPoint], at position: Double, baseSpeed: Double
    ) -> (left: [SpeedPoint], right: [SpeedPoint]) {
        guard !points.isEmpty else { return ([], []) }
        let split = max(0.0001, min(0.9999, position))
        let boundarySpeed = speedAt(position: split, baseSpeed: baseSpeed, points: points)
        let ordered = points
            .map { SpeedPoint(
                id: $0.id, position: max(0, min(1, $0.position)),
                speed: max(0.25, min(4, $0.speed))
            ) }
            .sorted { $0.position < $1.position }

        var left = ordered.filter { $0.position < split }.map { point in
            SpeedPoint(id: point.id, position: point.position / split, speed: point.speed)
        }
        var right = ordered.filter { $0.position > split }.map { point in
            SpeedPoint(
                id: point.id, position: (point.position - split) / (1 - split), speed: point.speed
            )
        }
        left.append(SpeedPoint(id: UUID(), position: 1, speed: boundarySpeed))
        right.insert(SpeedPoint(id: UUID(), position: 0, speed: boundarySpeed), at: 0)
        return (left, right)
    }

    static func sourceOffset(
        forOutputTime outputTime: Double, sourceDuration: Double, baseSpeed: Double, points: [SpeedPoint]
    ) -> Double {
        let segments = speedSegments(sourceDuration: sourceDuration, baseSpeed: baseSpeed, points: points)
        var outputCursor = 0.0
        for segment in segments {
            let end = outputCursor + segment.outputDuration
            if outputTime <= end {
                let progress = max(0, min(1, (outputTime - outputCursor) / max(0.0001, segment.outputDuration)))
                return segment.sourceOffset + segment.sourceDuration * progress
            }
            outputCursor = end
        }
        return max(0, sourceDuration)
    }

    static func outputTime(
        forSourceOffset sourceOffset: Double, sourceDuration: Double, baseSpeed: Double, points: [SpeedPoint]
    ) -> Double {
        let segments = speedSegments(sourceDuration: sourceDuration, baseSpeed: baseSpeed, points: points)
        let target = max(0, min(sourceDuration, sourceOffset))
        var outputCursor = 0.0
        for segment in segments {
            let sourceEnd = segment.sourceOffset + segment.sourceDuration
            if target <= sourceEnd {
                let progress = max(0, min(1, (target - segment.sourceOffset) / max(0.0001, segment.sourceDuration)))
                return outputCursor + segment.outputDuration * progress
            }
            outputCursor += segment.outputDuration
        }
        return outputCursor
    }

    static func overlayValue(
        at relativeTime: Double, base: OverlayKeyframe, keyframes: [OverlayKeyframe]
    ) -> OverlayKeyframe {
        var ordered = keyframes.sorted { $0.time < $1.time }
        guard !ordered.isEmpty else { return base }
        if ordered[0].time > 0.0001 {
            var initial = base
            initial.time = 0
            ordered.insert(initial, at: 0)
        }
        let time = max(0, relativeTime)
        if time <= ordered[0].time { return ordered[0] }
        if time >= ordered[ordered.count - 1].time { return ordered[ordered.count - 1] }
        for index in 0..<(ordered.count - 1) {
            let left = ordered[index]
            let right = ordered[index + 1]
            guard left.time <= time, time <= right.time else { continue }
            let raw = (time - left.time) / max(0.0001, right.time - left.time)
            let progress = eased(raw, curve: right.curve, bezier: right.bezier)
            return OverlayKeyframe(
                id: left.id, time: time,
                x: mix(left.x, right.x, progress), y: mix(left.y, right.y, progress),
                scale: mix(left.scale, right.scale, progress),
                rotation: mix(left.rotation, right.rotation, progress),
                opacity: mix(left.opacity, right.opacity, progress), curve: right.curve,
                bezier: right.bezier
            )
        }
        return base
    }

    static func clipTransformValue(
        at position: Double, base: ClipTransform, keyframes: [ClipTransformKeyframe]
    ) -> ClipTransform {
        var ordered = keyframes.sorted { $0.position < $1.position }
        guard !ordered.isEmpty else { return base }
        if ordered[0].position > 0.0001 {
            ordered.insert(ClipTransformKeyframe(
                id: UUID(), position: 0, scale: base.scale, x: base.x, y: base.y,
                rotation: base.rotation, opacity: base.opacity, curve: .linear
            ), at: 0)
        }
        let value = max(0, min(1, position))
        if value <= ordered[0].position { return ordered[0].transform }
        if value >= ordered[ordered.count - 1].position { return ordered[ordered.count - 1].transform }
        for index in 0..<(ordered.count - 1) {
            let left = ordered[index]
            let right = ordered[index + 1]
            guard left.position <= value, value <= right.position else { continue }
            let raw = (value - left.position) / max(0.0001, right.position - left.position)
            let progress = eased(raw, curve: right.curve, bezier: right.bezier)
            return ClipTransform(
                scale: mix(left.scale, right.scale, progress),
                x: mix(left.x, right.x, progress),
                y: mix(left.y, right.y, progress),
                rotation: mix(left.rotation, right.rotation, progress),
                opacity: mix(left.opacity, right.opacity, progress)
            )
        }
        return base
    }

    struct ClipTransformSplit: Equatable {
        var leftBase: ClipTransform
        var left: [ClipTransformKeyframe]
        var rightBase: ClipTransform
        var right: [ClipTransformKeyframe]
    }

    static func splitClipTransformKeyframes(
        base: ClipTransform, keyframes: [ClipTransformKeyframe], at rawPosition: Double
    ) -> ClipTransformSplit {
        let split = max(0.0001, min(0.9999, rawPosition))
        guard !keyframes.isEmpty else {
            return ClipTransformSplit(leftBase: base, left: [], rightBase: base, right: [])
        }
        let ordered = keyframes.sorted { $0.position < $1.position }
        let boundaryValue = clipTransformValue(at: split, base: base, keyframes: ordered)
        let boundaryCurve = ordered.first(where: { $0.position >= split })?.curve ??
            ordered.last?.curve ?? .linear
        let boundaryBezier = ordered.first(where: { $0.position >= split })?.bezier ??
            ordered.last?.bezier
        var left = ordered.filter { $0.position < split - 0.0001 }.map { frame in
            var value = frame
            value.position = max(0, min(1, frame.position / split))
            return value
        }
        if let exact = ordered.first(where: { abs($0.position - split) <= 0.0001 }) {
            var value = exact
            value.position = 1
            left.append(value)
        } else {
            left.append(ClipTransformKeyframe(
                id: UUID(), position: 1, scale: boundaryValue.scale, x: boundaryValue.x,
                y: boundaryValue.y, rotation: boundaryValue.rotation,
                opacity: boundaryValue.opacity, curve: boundaryCurve, bezier: boundaryBezier
            ))
        }
        let right = ordered.filter { $0.position > split + 0.0001 }.map { frame in
            var value = frame
            value.position = max(0, min(1, (frame.position - split) / (1 - split)))
            return value
        }
        return ClipTransformSplit(
            leftBase: base, left: left.sorted { $0.position < $1.position },
            rightBase: boundaryValue, right: right.sorted { $0.position < $1.position }
        )
    }

    private static func mix(_ from: Double, _ to: Double, _ progress: Double) -> Double {
        from + (to - from) * progress
    }

    private static func eased(
        _ value: Double, curve: KeyframeCurve, bezier: KeyframeBezier? = nil
    ) -> Double {
        let x = max(0, min(1, value))
        switch curve {
        case .linear: return x
        case .easeIn: return x * x
        case .easeOut: return 1 - (1 - x) * (1 - x)
        case .easeInOut: return x * x * (3 - 2 * x)
        case .custom: return cubicBezierProgress(at: x, controls: bezier ?? KeyframeBezier())
        }
    }

    /// Solves x(t) for a monotonic cubic Bezier, then evaluates y(t). Newton
    /// iterations make the common case fast; bisection guarantees stability
    /// for nearly vertical handles where the derivative approaches zero.
    static func cubicBezierProgress(at value: Double, controls: KeyframeBezier) -> Double {
        let target = max(0, min(1, value))
        guard target > 0, target < 1 else { return target }
        let curve = controls.normalized
        func coordinate(_ t: Double, _ first: Double, _ second: Double) -> Double {
            let inverse = 1 - t
            return 3 * inverse * inverse * t * first +
                3 * inverse * t * t * second + t * t * t
        }
        func derivative(_ t: Double, _ first: Double, _ second: Double) -> Double {
            let inverse = 1 - t
            return 3 * inverse * inverse * first +
                6 * inverse * t * (second - first) + 3 * t * t * (1 - second)
        }

        var parameter = target
        for _ in 0..<8 {
            let error = coordinate(parameter, curve.x1, curve.x2) - target
            if abs(error) < 0.000_001 { break }
            let slope = derivative(parameter, curve.x1, curve.x2)
            if abs(slope) < 0.000_001 { break }
            let next = parameter - error / slope
            guard next >= 0, next <= 1 else { break }
            parameter = next
        }
        if abs(coordinate(parameter, curve.x1, curve.x2) - target) > 0.000_01 {
            var lower = 0.0
            var upper = 1.0
            for _ in 0..<24 {
                parameter = (lower + upper) / 2
                if coordinate(parameter, curve.x1, curve.x2) < target {
                    lower = parameter
                } else {
                    upper = parameter
                }
            }
        }
        return max(0, min(1, coordinate(parameter, curve.y1, curve.y2)))
    }

    static func effectiveTransitionDuration(durations: [Double], requested: Double) -> Double {
        let valid = durations.filter { $0 > 0 && $0.isFinite }
        guard valid.count >= 2 else { return 0 }
        return max(0, min(requested, (valid.min() ?? 0) / 2))
    }

    /// Clamps each boundary independently while ensuring an interior clip's
    /// incoming and outgoing overlaps can never consume more than its duration.
    static func effectiveTransitionDurations(
        durations: [Double], requested: [Double]
    ) -> [Double] {
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        guard valid.count >= 2 else { return [] }
        return (0..<(valid.count - 1)).map { index in
            let value = index < requested.count && requested[index].isFinite
                ? max(0, requested[index]) : 0
            return min(value, valid[index] / 2, valid[index + 1] / 2)
        }
    }

    static func timelineDuration(durations: [Double], transition: Double) -> Double {
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        let overlap = effectiveTransitionDuration(durations: valid, requested: transition)
        return max(0, valid.reduce(0, +) - overlap * Double(max(0, valid.count - 1)))
    }

    static func timelineDuration(durations: [Double], transitions: [Double]) -> Double {
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        let overlaps = effectiveTransitionDurations(durations: valid, requested: transitions)
        return max(0, valid.reduce(0, +) - overlaps.reduce(0, +))
    }

    static func clipStart(index: Int, durations: [Double], transition: Double) -> Double? {
        guard index >= 0, index < durations.count else { return nil }
        let overlap = effectiveTransitionDuration(durations: durations, requested: transition)
        return durations.prefix(index).reduce(0) { $0 + max(0, $1) - overlap }
    }

    static func clipStart(index: Int, durations: [Double], transitions: [Double]) -> Double? {
        guard index >= 0, index < durations.count else { return nil }
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        let overlaps = effectiveTransitionDurations(durations: valid, requested: transitions)
        return valid.prefix(index).reduce(0, +) - overlaps.prefix(index).reduce(0, +)
    }

    /// Produces a gap-free instruction schedule for an alternating-track video
    /// composition. A zero-duration boundary becomes a hard cut between two
    /// adjacent solo spans; a positive boundary occupies exactly one transition
    /// span and is excluded from both neighboring solo spans.
    static func videoInstructionSpans(
        durations: [Double], transitions: [Double]
    ) -> [TimelineVideoInstructionSpan] {
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        guard !valid.isEmpty else { return [] }
        let overlaps = effectiveTransitionDurations(durations: valid, requested: transitions)
        var starts = Array(repeating: 0.0, count: valid.count)
        if valid.count > 1 {
            for index in 1..<valid.count {
                starts[index] = starts[index - 1] + valid[index - 1] - overlaps[index - 1]
            }
        }

        var result: [TimelineVideoInstructionSpan] = []
        for index in valid.indices {
            let incoming = index > 0 ? overlaps[index - 1] : 0
            let soloStart = starts[index] + incoming
            let soloEnd = index == valid.count - 1
                ? starts[index] + valid[index]
                : starts[index + 1]
            if soloEnd - soloStart > 0.000_001 {
                result.append(TimelineVideoInstructionSpan(
                    kind: .solo(clipIndex: index), start: soloStart,
                    duration: soloEnd - soloStart
                ))
            }
            if index < overlaps.count, overlaps[index] > 0.000_001 {
                result.append(TimelineVideoInstructionSpan(
                    kind: .transition(boundaryIndex: index), start: starts[index + 1],
                    duration: overlaps[index]
                ))
            }
        }
        return result
    }

    static func splitSourceTime(
        playhead: Double, clipIndex: Int, trimStart: Double, trimEnd: Double,
        speed: Double = 1, speedPoints: [SpeedPoint] = [], durations: [Double],
        transition: Double, isReversed: Bool = false, minimumSegment: Double = 0.1
    ) -> Double? {
        guard let start = clipStart(index: clipIndex, durations: durations, transition: transition) else { return nil }
        let local = playhead - start
        let boundedSpeed = max(0.25, min(4, speed))
        let sourceDuration = max(0, trimEnd - trimStart)
        let outputDuration = speedCurveDuration(
            sourceDuration: sourceDuration, baseSpeed: boundedSpeed, points: speedPoints
        )
        guard local > minimumSegment, local < outputDuration - minimumSegment else { return nil }
        let offset: Double
        if speedPoints.isEmpty { offset = local * boundedSpeed }
        else { offset = sourceOffset(
            forOutputTime: local, sourceDuration: sourceDuration,
            baseSpeed: boundedSpeed, points: speedPoints
        ) }
        return isReversed ? trimEnd - offset : trimStart + offset
    }

    static func splitSourceTime(
        playhead: Double, clipIndex: Int, trimStart: Double, trimEnd: Double,
        speed: Double = 1, speedPoints: [SpeedPoint] = [], durations: [Double],
        transitions: [Double], isReversed: Bool = false, minimumSegment: Double = 0.1
    ) -> Double? {
        guard let start = clipStart(
            index: clipIndex, durations: durations, transitions: transitions
        ) else { return nil }
        let local = playhead - start
        let boundedSpeed = max(0.25, min(4, speed))
        let sourceDuration = max(0, trimEnd - trimStart)
        let outputDuration = speedCurveDuration(
            sourceDuration: sourceDuration, baseSpeed: boundedSpeed, points: speedPoints
        )
        guard local > minimumSegment, local < outputDuration - minimumSegment else { return nil }
        let offset = speedPoints.isEmpty
            ? local * boundedSpeed
            : sourceOffset(
                forOutputTime: local, sourceDuration: sourceDuration,
                baseSpeed: boundedSpeed, points: speedPoints
            )
        return isReversed ? trimEnd - offset : trimStart + offset
    }
}
