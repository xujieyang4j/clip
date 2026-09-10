import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation

/// Builds a reversed video-and-audio proxy in bounded-memory chunks. Video is
/// reversed frame-by-frame; compressed source audio is first decoded to
/// interleaved PCM, reversed by complete channel frames, then encoded as AAC.
enum ReverseMediaGenerator {
    struct Result {
        let url: URL
        let includesAudio: Bool
    }

    private struct Frame {
        let image: CVPixelBuffer
        let presentation: CMTime
        let duration: CMTime
    }

    static func makeReversedVideo(from sourceURL: URL, projectID: UUID) async throws -> Result {
        let directory = try ProjectDocumentStore.mediaDirectory(for: projectID)
        let outputURL = directory
            .appendingPathComponent("Reverse-\(UUID().uuidString)")
            .appendingPathExtension("mov")
        let asset = AVURLAsset(url: sourceURL)
        guard let sourceTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let natural = try await sourceTrack.load(.naturalSize)
        let preferred = try await sourceTrack.load(.preferredTransform)
        let nominalFrameRate = Double(try await sourceTrack.load(.nominalFrameRate))
        let duration = try await asset.load(.duration)
        guard duration.isNumeric, duration > .zero else { throw CocoaError(.fileReadCorruptFile) }
        let totalSeconds = CMTimeGetSeconds(duration)

        let width = max(2, Int(natural.width) / 2 * 2)
        let height = max(2, Int(natural.height) / 2 * 2)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        let videoInput = AVAssetWriterInput(
            mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width, AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000]
            ]
        )
        videoInput.transform = preferred
        videoInput.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height
            ]
        )
        guard writer.canAdd(videoInput) else { throw CocoaError(.fileWriteUnknown) }
        writer.add(videoInput)

        let sourceAudioTrack = try await asset.loadTracks(withMediaType: .audio).first
        var audioInput: AVAssetWriterInput?
        var audioSourceStart = 0.0
        var audioSourceEnd = 0.0
        var audioSampleRate = 48_000.0
        var audioChannels = 2
        if let sourceAudioTrack,
           let format = try await sourceAudioTrack.load(.formatDescriptions).first,
           let sourceFormat = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee {
            let audioTimeRange = try await sourceAudioTrack.load(.timeRange)
            let rawStart = CMTimeGetSeconds(audioTimeRange.start)
            let rawEnd = CMTimeGetSeconds(CMTimeRangeGetEnd(audioTimeRange))
            audioSourceStart = rawStart.isFinite ? max(0, min(totalSeconds, rawStart)) : 0
            audioSourceEnd = rawEnd.isFinite ? max(audioSourceStart, min(totalSeconds, rawEnd)) : 0
            if audioSourceEnd - audioSourceStart > 0.0001 {
                audioSampleRate = min(48_000, max(8_000, sourceFormat.mSampleRate))
                audioChannels = min(2, max(1, Int(sourceFormat.mChannelsPerFrame)))
                let candidate = AVAssetWriterInput(
                    mediaType: .audio, outputSettings: [
                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                        AVSampleRateKey: audioSampleRate,
                        AVNumberOfChannelsKey: audioChannels,
                        AVEncoderBitRateKey: audioChannels == 1 ? 96_000 : 192_000
                    ]
                )
                candidate.expectsMediaDataInRealTime = false
                guard writer.canAdd(candidate) else { throw CocoaError(.fileWriteUnknown) }
                writer.add(candidate)
                audioInput = candidate
            }
        }
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)

        let framesPerSecond = nominalFrameRate.isFinite && nominalFrameRate > 0 ? nominalFrameRate : 30
        // Decoded BGRA frames are large (about 32 MB each at 4K). Adapt the
        // chunk length to keep the frame array near a 48 MB budget.
        let decodedBytesPerFrame = max(1, width * height * 4)
        let framesPerChunk = max(1, 48 * 1_024 * 1_024 / decodedBytesPerFrame)
        let chunkSeconds = max(
            1 / framesPerSecond, min(0.12, Double(framesPerChunk) / framesPerSecond)
        )
        let fallbackFrameDuration = CMTime(
            seconds: 1 / framesPerSecond, preferredTimescale: 60_000
        )
        do {
            async let videoEnd = appendReversedVideo(
                asset: asset, track: sourceTrack, input: videoInput, adaptor: adaptor,
                writer: writer, totalSeconds: totalSeconds, chunkSeconds: chunkSeconds,
                fallbackFrameDuration: fallbackFrameDuration
            )
            let audioEnd: CMTime
            if let sourceAudioTrack, let audioInput {
                audioEnd = try await appendReversedAudio(
                    asset: asset, track: sourceAudioTrack, input: audioInput, writer: writer,
                    totalSeconds: totalSeconds, sourceStart: audioSourceStart,
                    sourceEnd: audioSourceEnd, sampleRate: audioSampleRate, channels: audioChannels
                )
            } else {
                audioEnd = .zero
            }
            let videoDuration = try await videoEnd
            writer.endSession(atSourceTime: CMTimeMaximum(videoDuration, audioEnd))
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
            return Result(url: outputURL, includesAudio: audioInput != nil)
        } catch {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: outputURL)
            throw error
        }
    }

    private static func appendReversedVideo(
        asset: AVAsset, track: AVAssetTrack, input: AVAssetWriterInput,
        adaptor: AVAssetWriterInputPixelBufferAdaptor, writer: AVAssetWriter,
        totalSeconds: Double, chunkSeconds: Double, fallbackFrameDuration initialFallback: CMTime
    ) async throws -> CMTime {
        var chunkEnd = totalSeconds
        var outputTime = CMTime.zero
        var fallbackFrameDuration = initialFallback
        while chunkEnd > 0.0001 {
            try Task.checkCancellation()
            let chunkStart = max(0, chunkEnd - chunkSeconds)
            let frames = try readFrames(
                asset: asset, track: track, start: chunkStart, duration: chunkEnd - chunkStart
            )
            let ordered = frames.sorted { $0.presentation < $1.presentation }
            if ordered.count >= 2 {
                let candidate = CMTimeSubtract(ordered[1].presentation, ordered[0].presentation)
                if candidate.isNumeric, candidate > .zero { fallbackFrameDuration = candidate }
            }
            for index in ordered.indices.reversed() {
                let frame = ordered[index]
                try await waitUntilReady(input, writer: writer)
                guard adaptor.append(frame.image, withPresentationTime: outputTime) else {
                    throw writer.error ?? CocoaError(.fileWriteUnknown)
                }
                let frameDuration = frame.duration.isNumeric && frame.duration > .zero
                    ? frame.duration : fallbackFrameDuration
                outputTime = CMTimeAdd(outputTime, frameDuration)
            }
            chunkEnd = chunkStart
        }
        input.markAsFinished()
        return outputTime
    }

    private static func appendReversedAudio(
        asset: AVAsset, track: AVAssetTrack, input: AVAssetWriterInput,
        writer: AVAssetWriter, totalSeconds: Double, sourceStart: Double,
        sourceEnd: Double, sampleRate: Double, channels: Int
    ) async throws -> CMTime {
        let bytesPerFrame = channels * MemoryLayout<Int16>.size
        let framesPerChunk = max(1, 8 * 1_024 * 1_024 / bytesPerFrame)
        let chunkSeconds = max(0.25, Double(framesPerChunk) / sampleRate)
        var chunkEnd = max(sourceStart, min(totalSeconds, sourceEnd))
        let totalFrames = Int64((totalSeconds * sampleRate).rounded())
        var outputFrame = Int64(0)
        let leadingSilence = Int64((max(0, totalSeconds - chunkEnd) * sampleRate).rounded())
        outputFrame = try await appendSilence(
            frameCount: leadingSilence, startingAt: outputFrame, sampleRate: sampleRate,
            channels: channels, maximumFramesPerBuffer: framesPerChunk, input: input, writer: writer
        )
        while chunkEnd > sourceStart + 0.0001 {
            try Task.checkCancellation()
            let chunkStart = max(sourceStart, chunkEnd - chunkSeconds)
            let pcm = try readAudioPCM(
                asset: asset, track: track, start: chunkStart, duration: chunkEnd - chunkStart,
                sampleRate: sampleRate, channels: channels
            )
            if !pcm.isEmpty {
                let reversed = PCMFrameMath.reversedPCM16(pcm, channels: channels)
                let sample = try makeAudioSampleBuffer(
                    pcm: reversed, sampleRate: sampleRate, channels: channels,
                    presentationFrame: outputFrame
                )
                try await waitUntilReady(input, writer: writer)
                guard input.append(sample) else {
                    throw writer.error ?? CocoaError(.fileWriteUnknown)
                }
                outputFrame += Int64(reversed.count / bytesPerFrame)
            }
            chunkEnd = chunkStart
        }
        outputFrame = try await appendSilence(
            frameCount: max(0, totalFrames - outputFrame), startingAt: outputFrame,
            sampleRate: sampleRate, channels: channels, maximumFramesPerBuffer: framesPerChunk,
            input: input, writer: writer
        )
        input.markAsFinished()
        return CMTime(value: outputFrame, timescale: CMTimeScale(sampleRate.rounded()))
    }

    private static func appendSilence(
        frameCount: Int64, startingAt initialFrame: Int64, sampleRate: Double, channels: Int,
        maximumFramesPerBuffer: Int, input: AVAssetWriterInput, writer: AVAssetWriter
    ) async throws -> Int64 {
        guard frameCount > 0 else { return initialFrame }
        let bytesPerFrame = channels * MemoryLayout<Int16>.size
        var remaining = frameCount
        var outputFrame = initialFrame
        while remaining > 0 {
            try Task.checkCancellation()
            let count = min(remaining, Int64(maximumFramesPerBuffer))
            let silence = Data(count: Int(count) * bytesPerFrame)
            let sample = try makeAudioSampleBuffer(
                pcm: silence, sampleRate: sampleRate, channels: channels,
                presentationFrame: outputFrame
            )
            try await waitUntilReady(input, writer: writer)
            guard input.append(sample) else {
                throw writer.error ?? CocoaError(.fileWriteUnknown)
            }
            outputFrame += count
            remaining -= count
        }
        return outputFrame
    }

    private static func readAudioPCM(
        asset: AVAsset, track: AVAssetTrack, start: Double, duration: Double,
        sampleRate: Double, channels: Int
    ) throws -> Data {
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 60_000),
            duration: CMTime(seconds: duration, preferredTimescale: 60_000)
        )
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw CocoaError(.fileReadUnknown) }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadUnknown) }
        var data = Data()
        while let sample = output.copyNextSampleBuffer() {
            if Task.isCancelled { reader.cancelReading(); throw CancellationError() }
            guard let buffer = CMSampleBufferGetDataBuffer(sample) else { continue }
            let length = CMBlockBufferGetDataLength(buffer)
            guard length > 0 else { continue }
            var bytes = Data(count: length)
            let status = bytes.withUnsafeMutableBytes { rawBuffer -> OSStatus in
                guard let base = rawBuffer.baseAddress else { return kCMBlockBufferBadPointerParameterErr }
                return CMBlockBufferCopyDataBytes(
                    buffer, atOffset: 0, dataLength: length, destination: base
                )
            }
            guard status == noErr else { throw CocoaError(.fileReadUnknown) }
            data.append(bytes)
        }
        if reader.status == .failed { throw reader.error ?? CocoaError(.fileReadUnknown) }
        let alignedLength = data.count - data.count % max(1, channels * MemoryLayout<Int16>.size)
        return data.prefix(alignedLength)
    }

    private static func makeAudioSampleBuffer(
        pcm: Data, sampleRate: Double, channels: Int, presentationFrame: Int64
    ) throws -> CMSampleBuffer {
        var description: CMAudioFormatDescription?
        var format = AudioStreamBasicDescription(
            mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(channels * MemoryLayout<Int16>.size),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(channels * MemoryLayout<Int16>.size),
            mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 16, mReserved: 0
        )
        guard CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description
        ) == noErr, let description else { throw CocoaError(.fileReadUnknown) }

        var blockBuffer: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: pcm.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
            dataLength: pcm.count, flags: 0, blockBufferOut: &blockBuffer
        ) == kCMBlockBufferNoErr, let blockBuffer else { throw CocoaError(.fileWriteUnknown) }
        let copied = pcm.withUnsafeBytes { bytes -> OSStatus in
            guard let base = bytes.baseAddress else { return kCMBlockBufferBadPointerParameterErr }
            return CMBlockBufferReplaceDataBytes(
                with: base, blockBuffer: blockBuffer, offsetIntoDestination: 0, dataLength: pcm.count
            )
        }
        guard copied == noErr else { throw CocoaError(.fileWriteUnknown) }

        let frameCount = pcm.count / max(1, channels * MemoryLayout<Int16>.size)
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(sampleRate.rounded())),
            presentationTimeStamp: CMTime(
                value: presentationFrame, timescale: CMTimeScale(sampleRate.rounded())
            ), decodeTimeStamp: .invalid
        )
        var sampleSize = channels * MemoryLayout<Int16>.size
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: blockBuffer,
            formatDescription: description, sampleCount: frameCount,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample
        ) == noErr, let sample else { throw CocoaError(.fileWriteUnknown) }
        return sample
    }

    private static func readFrames(
        asset: AVAsset, track: AVAssetTrack, start: Double, duration: Double
    ) throws -> [Frame] {
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 600),
            duration: CMTime(seconds: duration, preferredTimescale: 600)
        )
        let output = AVAssetReaderTrackOutput(
            track: track, outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
        )
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw CocoaError(.fileReadUnknown) }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadUnknown) }
        var frames: [Frame] = []
        while let sample = output.copyNextSampleBuffer(),
              let image = CMSampleBufferGetImageBuffer(sample) {
            if Task.isCancelled { reader.cancelReading(); throw CancellationError() }
            let presentation = CMSampleBufferGetPresentationTimeStamp(sample)
            var frameDuration = CMSampleBufferGetDuration(sample)
            if !frameDuration.isNumeric || frameDuration <= .zero { frameDuration = .invalid }
            CVPixelBufferLockBaseAddress(image, .readOnly)
            CVPixelBufferUnlockBaseAddress(image, .readOnly)
            frames.append(Frame(image: image, presentation: presentation, duration: frameDuration))
        }
        if reader.status == .failed { throw reader.error ?? CocoaError(.fileReadUnknown) }
        return frames
    }

    private static func waitUntilReady(
        _ input: AVAssetWriterInput, writer: AVAssetWriter
    ) async throws {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed || writer.status == .cancelled {
                throw writer.error ?? CocoaError(.fileWriteUnknown)
            }
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}
