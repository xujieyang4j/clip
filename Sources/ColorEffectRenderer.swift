import AVFoundation
import CoreImage
import Foundation

enum ColorEffectRenderer {
    static func render(
        sourceURL: URL, adjustments: ColorAdjustments, lutURL: URL?,
        lutIntensity: Double, effects: ClipVisualEffects, projectID: UUID
    ) async throws -> URL {
        let directory = try ProjectDocumentStore.mediaDirectory(for: projectID)
        let outputURL = directory
            .appendingPathComponent("Effect-\(UUID().uuidString)")
            .appendingPathExtension("mov")
        let asset = AVURLAsset(url: sourceURL)
        let lut = try lutURL.map { try CubeLUT.parse(data: Data(contentsOf: $0)) }
        let cubeData = lut?.rgbaData
        let composition = AVVideoComposition(asset: asset) { request in
            let outputExtent = request.sourceImage.extent
            let source = request.sourceImage.clampedToExtent()
            let controls = source.applyingFilter(
                "CIColorControls",
                parameters: [
                    kCIInputBrightnessKey: adjustments.brightness,
                    kCIInputContrastKey: adjustments.contrast,
                    kCIInputSaturationKey: adjustments.saturation
                ]
            )
            var result: CIImage
            if abs(adjustments.temperature) > 0.001 {
                let neutral = CIVector(x: 6500, y: 0)
                let target = CIVector(x: 6500 + CGFloat(adjustments.temperature) * 18, y: 0)
                result = controls.applyingFilter(
                    "CITemperatureAndTint",
                    parameters: ["inputNeutral": neutral, "inputTargetNeutral": target]
                )
            } else {
                result = controls
            }
            if let lut, let cubeData, lutIntensity > 0.001 {
                let minimum = lut.domainMinimum
                let maximum = lut.domainMaximum
                let redScale = 1 / max(0.0001, maximum.red - minimum.red)
                let greenScale = 1 / max(0.0001, maximum.green - minimum.green)
                let blueScale = 1 / max(0.0001, maximum.blue - minimum.blue)
                let normalized = result.applyingFilter(
                    "CIColorMatrix", parameters: [
                        "inputRVector": CIVector(x: CGFloat(redScale), y: 0, z: 0, w: 0),
                        "inputGVector": CIVector(x: 0, y: CGFloat(greenScale), z: 0, w: 0),
                        "inputBVector": CIVector(x: 0, y: 0, z: CGFloat(blueScale), w: 0),
                        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                        "inputBiasVector": CIVector(
                            x: CGFloat(-minimum.red * redScale),
                            y: CGFloat(-minimum.green * greenScale),
                            z: CGFloat(-minimum.blue * blueScale), w: 0
                        )
                    ]
                )
                let filtered = normalized.applyingFilter(
                    "CIColorCube", parameters: [
                        "inputCubeDimension": lut.dimension,
                        "inputCubeData": cubeData
                    ]
                )
                if lutIntensity >= 0.999 {
                    result = filtered
                } else {
                    let amount = CGFloat(max(0, min(1, lutIntensity)))
                    let mask = CIImage(color: CIColor(
                        red: amount, green: amount, blue: amount, alpha: 1
                    )).cropped(to: outputExtent)
                    result = filtered.cropped(to: outputExtent).applyingFilter(
                        "CIBlendWithMask", parameters: [
                            kCIInputBackgroundImageKey: result.cropped(to: outputExtent),
                            kCIInputMaskImageKey: mask
                        ]
                    )
                }
            }
            switch effects.preset {
            case .none:
                break
            case .monochromeFilm:
                result = result.applyingFilter("CIPhotoEffectNoir")
            case .vintageFilm:
                result = result.applyingFilter("CIPhotoEffectTransfer")
            case .softGlow:
                result = result.applyingFilter(
                    "CIBloom", parameters: [
                        kCIInputRadiusKey: max(2, min(outputExtent.width, outputExtent.height) * 0.012),
                        kCIInputIntensityKey: 0.55
                    ]
                )
            case .sharpen:
                result = result.applyingFilter(
                    "CISharpenLuminance", parameters: [kCIInputSharpnessKey: 0.65]
                )
            }
            if effects.vignette > 0.001 {
                result = result.applyingFilter(
                    "CIVignette", parameters: [
                        kCIInputIntensityKey: effects.vignette * 2.2,
                        kCIInputRadiusKey: min(outputExtent.width, outputExtent.height) * 0.45
                    ]
                )
            }
            if effects.grain > 0.001 {
                let amount = CGFloat(effects.grain * 0.16)
                let noise = CIFilter(name: "CIRandomGenerator")?.outputImage?
                    .applyingFilter(
                        "CIColorMatrix", parameters: [
                            "inputRVector": CIVector(x: amount, y: 0, z: 0, w: 0),
                            "inputGVector": CIVector(x: 0, y: amount, z: 0, w: 0),
                            "inputBVector": CIVector(x: 0, y: 0, z: amount, w: 0),
                            "inputBiasVector": CIVector(x: 0.5 - amount / 2, y: 0.5 - amount / 2, z: 0.5 - amount / 2, w: 0)
                        ]
                    )
                    .cropped(to: outputExtent)
                if let noise {
                    result = noise.applyingFilter(
                        "CISoftLightBlendMode",
                        parameters: [kCIInputBackgroundImageKey: result.cropped(to: outputExtent)]
                    )
                }
            }
            request.finish(with: result.cropped(to: outputExtent), context: nil)
        }
        guard let session = AVAssetExportSession(
            asset: asset, presetName: AVAssetExportPresetHighestQuality
        ) else { throw CocoaError(.fileWriteUnknown) }
        session.outputURL = outputURL
        session.outputFileType = .mov
        session.videoComposition = composition
        session.shouldOptimizeForNetworkUse = true
        await withTaskCancellationHandler {
            await session.export()
        } onCancel: {
            session.cancelExport()
        }
        if Task.isCancelled {
            try? FileManager.default.removeItem(at: outputURL)
            throw CancellationError()
        }
        guard session.status == .completed else {
            try? FileManager.default.removeItem(at: outputURL)
            throw session.error ?? CocoaError(.fileWriteUnknown)
        }
        return outputURL
    }
}
