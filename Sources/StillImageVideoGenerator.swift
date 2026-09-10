import AVFoundation
import CoreImage
import Foundation

enum StillImageVideoGenerator {
    static func makeVideo(from imageURL: URL, duration: Double, projectID: UUID) async throws -> URL {
        let mediaDirectory = try ProjectDocumentStore.mediaDirectory(for: projectID)
        let outputURL = mediaDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov")
        do {
            try await render(imageURL: imageURL, outputURL: outputURL, duration: max(0.1, duration))
            return outputURL
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            throw error
        }
    }

    private static func render(imageURL: URL, outputURL: URL, duration: Double) async throws {
        guard let image = CIImage(contentsOf: imageURL, options: [.applyOrientationProperty: true]),
              image.extent.width > 0, image.extent.height > 0 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let size = proxySize(for: image.extent.size)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        let input = AVAssetWriterInput(
            mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width),
                AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 2_000_000,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                ]
            ]
        )
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(size.width),
                kCVPixelBufferHeightKey as String: Int(size.height),
                kCVPixelBufferIOSurfacePropertiesKey as String: [:]
            ]
        )
        guard writer.canAdd(input) else { throw CocoaError(.fileWriteUnknown) }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)

        guard let pool = adaptor.pixelBufferPool else { throw CocoaError(.fileWriteUnknown) }
        let context = CIContext(options: [.cacheIntermediates: false])
        let frame = try makePixelBuffer(image: image, size: size, pool: pool, context: context)
        try await waitUntilReady(input, writer: writer)
        guard adaptor.append(frame, withPresentationTime: .zero) else {
            writer.cancelWriting()
            throw writer.error ?? CocoaError(.fileWriteUnknown)
        }
        try await waitUntilReady(input, writer: writer)
        guard adaptor.append(frame, withPresentationTime: CMTime(seconds: duration, preferredTimescale: 600)) else {
            writer.cancelWriting()
            throw writer.error ?? CocoaError(.fileWriteUnknown)
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }

    private static func waitUntilReady(
        _ input: AVAssetWriterInput, writer: AVAssetWriter
    ) async throws {
        for _ in 0..<500 {
            if input.isReadyForMoreMediaData { return }
            if writer.status == .failed || writer.status == .cancelled {
                throw writer.error ?? CocoaError(.fileWriteUnknown)
            }
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        writer.cancelWriting()
        throw CocoaError(.fileWriteUnknown)
    }

    private static func proxySize(for source: CGSize) -> CGSize {
        let scale = min(1, 1280 / max(source.width, source.height))
        let width = max(2, Int(source.width * scale) / 2 * 2)
        let height = max(2, Int(source.height * scale) / 2 * 2)
        return CGSize(width: width, height: height)
    }

    private static func makePixelBuffer(
        image: CIImage, size: CGSize, pool: CVPixelBufferPool, context: CIContext
    ) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
              let buffer else { throw CocoaError(.fileWriteUnknown) }
        let source = image.extent
        let scale = min(size.width / source.width, size.height / source.height)
        let transformed = image
            .transformed(by: CGAffineTransform(translationX: -source.minX, y: -source.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let x = (size.width - transformed.extent.width) / 2
        let y = (size.height - transformed.extent.height) / 2
        let bounds = CGRect(origin: .zero, size: size)
        let foreground = transformed.transformed(by: CGAffineTransform(translationX: x, y: y))
        let background = CIImage(color: .black).cropped(to: bounds)
        context.render(
            foreground.composited(over: background), to: buffer, bounds: bounds,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return buffer
    }
}
