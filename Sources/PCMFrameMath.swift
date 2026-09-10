import Foundation

enum PCMFrameMath {
    /// Reverses interleaved signed 16-bit PCM by complete sample frames. The
    /// channel order inside every frame is preserved (for stereo: L/R stays
    /// L/R), and an incomplete trailing frame is discarded.
    static func reversedPCM16(_ data: Data, channels: Int) -> Data {
        let channelCount = max(1, channels)
        let frameBytes = channelCount * MemoryLayout<Int16>.size
        let frameCount = data.count / frameBytes
        guard frameCount > 0 else { return Data() }
        let alignedCount = frameCount * frameBytes
        guard frameCount > 1 else { return data.prefix(alignedCount) }
        var result = Data(count: alignedCount)
        data.withUnsafeBytes { source in
            result.withUnsafeMutableBytes { destination in
                guard let sourceBase = source.baseAddress,
                      let destinationBase = destination.baseAddress else { return }
                for outputIndex in 0..<frameCount {
                    memcpy(
                        destinationBase.advanced(by: outputIndex * frameBytes),
                        sourceBase.advanced(by: (frameCount - 1 - outputIndex) * frameBytes),
                        frameBytes
                    )
                }
            }
        }
        return result
    }
}
