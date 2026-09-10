import Foundation

@main
enum PCMFrameMathSmoke {
    static func main() {
        let stereo: [Int16] = [1, 101, 2, 102, 3, 103]
        let input = stereo.withUnsafeBytes { Data($0) }
        let reversed = PCMFrameMath.reversedPCM16(input, channels: 2)
        let output = reversed.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        precondition(output == [3, 103, 2, 102, 1, 101])
        print("iOS reverse PCM smoke: passed")
    }
}
