import SwiftUI
import UniformTypeIdentifiers

struct ColorPanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    @State private var showLUTImporter = false

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 8) {
                if let clip = model.selectedClip {
                Picker(language.text("调色预设", "Color Preset"), selection: Binding(
                    get: { clip.colorAdjustments.preset }, set: { model.setColorPreset($0) }
                )) {
                    Text(language.text("原始", "Original")).tag(ColorPreset.original)
                    Text(language.text("暖色", "Warm")).tag(ColorPreset.warm)
                    Text(language.text("冷色", "Cool")).tag(ColorPreset.cool)
                    Text(language.text("鲜艳", "Vivid")).tag(ColorPreset.vivid)
                    Text(language.text("黑白", "Mono")).tag(ColorPreset.mono)
                }
                .pickerStyle(.segmented)

                HStack(spacing: 8) {
                    Button { showLUTImporter = true } label: {
                        Label(language.text("导入 LUT", "Import LUT"), systemImage: "cube.transparent")
                    }
                    .buttonStyle(.bordered)
                    if let name = clip.lutName {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(name).font(.caption).lineLimit(1)
                            if clip.hasMissingLUT {
                                Label(
                                    language.text("文件缺失，请重新导入", "File missing; import again"),
                                    systemImage: "exclamationmark.triangle.fill"
                                )
                                .font(.caption2)
                                .foregroundStyle(.red)
                            }
                        }
                        Button(role: .destructive) { model.removeSelectedClipLUT() } label: {
                            Image(systemName: "xmark.circle")
                        }
                        .buttonStyle(.borderless)
                    } else {
                        Text(language.text("未使用 LUT", "No LUT"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if clip.lutName != nil {
                    colorSlider(
                        language.text("LUT 强度", "LUT Mix"), value: clip.lutIntensity, range: 0...1,
                        display: { String(format: "%.0f%%", $0 * 100) }
                    ) { model.updateSelectedClipLUTIntensity($0) }
                }

                Picker(language.text("片段特效", "Clip Effect"), selection: Binding(
                    get: { clip.visualEffects.preset },
                    set: { model.setSelectedClipEffectPreset($0) }
                )) {
                    Text(language.text("无", "None")).tag(ClipEffectPreset.none)
                    Text(language.text("黑白", "Noir")).tag(ClipEffectPreset.monochromeFilm)
                    Text(language.text("复古", "Vintage")).tag(ClipEffectPreset.vintageFilm)
                    Text(language.text("柔光", "Glow")).tag(ClipEffectPreset.softGlow)
                    Text(language.text("锐化", "Sharpen")).tag(ClipEffectPreset.sharpen)
                }
                .pickerStyle(.segmented)
                HStack(spacing: 8) {
                    compactEffectSlider(
                        language.text("暗角", "Vignette"), value: clip.visualEffects.vignette
                    ) { model.updateSelectedClipEffects(vignette: $0) }
                    compactEffectSlider(
                        language.text("颗粒", "Grain"), value: clip.visualEffects.grain
                    ) { model.updateSelectedClipEffects(grain: $0) }
                }
                if !clip.visualEffects.isIdentity {
                    Button { model.resetSelectedClipEffects() } label: {
                        Label(language.text("重置片段特效", "Reset Clip Effects"), systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.bordered)
                }

                colorSlider(
                    language.text("亮度", "Brightness"), value: clip.colorAdjustments.brightness,
                    range: -0.5...0.5, display: { String(format: "%.2f", $0) }
                ) { model.updateSelectedClipColor(brightness: $0) }
                colorSlider(
                    language.text("对比度", "Contrast"), value: clip.colorAdjustments.contrast,
                    range: 0.5...2, display: { String(format: "%.2f", $0) }
                ) { model.updateSelectedClipColor(contrast: $0) }
                colorSlider(
                    language.text("饱和度", "Saturation"), value: clip.colorAdjustments.saturation,
                    range: 0...2, display: { String(format: "%.2f", $0) }
                ) { model.updateSelectedClipColor(saturation: $0) }
                colorSlider(
                    language.text("色温", "Temperature"), value: clip.colorAdjustments.temperature,
                    range: -100...100, display: { String(format: "%.0f", $0) }
                ) { model.updateSelectedClipColor(temperature: $0) }
                } else {
                    Text(language.text("选择主轨片段后调整颜色。", "Select a main-track clip to adjust its color."))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
        }
        .disabled(model.isBusy)
        .fileImporter(
            isPresented: $showLUTImporter, allowedContentTypes: [Self.cubeType],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            Task { await model.importLUT(from: url) }
        }
    }

    private func colorSlider(
        _ title: String, value: Double, range: ClosedRange<Double>,
        display: @escaping (Double) -> String, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.caption).frame(width: 48, alignment: .leading)
            Slider(
                value: Binding(get: { value }, set: onChange), in: range,
                onEditingChanged: { editing in
                    if editing { model.beginInteractiveEdit() }
                    else { model.commitSelectedClipColor() }
                }
            )
            Text(display(value)).font(.caption.monospacedDigit()).frame(width: 42)
        }
    }

    private static var cubeType: UTType {
        UTType(filenameExtension: "cube") ?? .data
    }

    private func compactEffectSlider(
        _ title: String, value: Double, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).frame(width: 34, alignment: .leading)
            Slider(
                value: Binding(get: { value }, set: onChange), in: 0...1,
                onEditingChanged: { editing in
                    if editing { model.beginInteractiveEdit() }
                    else { model.commitSelectedClipColor() }
                }
            )
        }
    }
}
