import Foundation

@main
enum TimelineMathSmoke {
    static func main() {
        precondition(TimelineMath.effectiveTransitionDuration(durations: [10, 2, 5], requested: 3) == 1)
        precondition(TimelineMath.timelineDuration(durations: [10, 2, 5], transition: 3) == 15)
        precondition(TimelineMath.splitSourceTime(
            playhead: 11, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        ) == 4)
        precondition(TimelineMath.splitSourceTime(
            playhead: 9.05, clipIndex: 1, trimStart: 2, trimEnd: 8,
            durations: [10, 6], transition: 1
        ) == nil)
        precondition(TimelineMath.splitSourceTime(
            playhead: 1, clipIndex: 0, trimStart: 2, trimEnd: 8, speed: 2,
            durations: [3], transition: 0
        ) == 4)
        print("iOS timeline math smoke: passed")
    }
}
