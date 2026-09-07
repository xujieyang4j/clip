import Foundation

enum TimelineMath {
    static func effectiveTransitionDuration(durations: [Double], requested: Double) -> Double {
        let valid = durations.filter { $0 > 0 && $0.isFinite }
        guard valid.count >= 2 else { return 0 }
        return max(0, min(requested, (valid.min() ?? 0) / 2))
    }

    static func timelineDuration(durations: [Double], transition: Double) -> Double {
        let valid = durations.map { max(0, $0.isFinite ? $0 : 0) }
        let overlap = effectiveTransitionDuration(durations: valid, requested: transition)
        return max(0, valid.reduce(0, +) - overlap * Double(max(0, valid.count - 1)))
    }

    static func clipStart(index: Int, durations: [Double], transition: Double) -> Double? {
        guard index >= 0, index < durations.count else { return nil }
        let overlap = effectiveTransitionDuration(durations: durations, requested: transition)
        return durations.prefix(index).reduce(0) { $0 + max(0, $1) - overlap }
    }

    static func splitSourceTime(
        playhead: Double, clipIndex: Int, trimStart: Double, trimEnd: Double,
        speed: Double = 1, durations: [Double], transition: Double, minimumSegment: Double = 0.1
    ) -> Double? {
        guard let start = clipStart(index: clipIndex, durations: durations, transition: transition) else { return nil }
        let local = playhead - start
        let boundedSpeed = max(0.25, min(4, speed))
        let outputDuration = max(0, trimEnd - trimStart) / boundedSpeed
        guard local > minimumSegment, local < outputDuration - minimumSegment else { return nil }
        return trimStart + local * boundedSpeed
    }
}
