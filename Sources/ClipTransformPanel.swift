import SwiftUI

struct ClipTransformPanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    @State private var keyframeCurve: KeyframeCurve = .easeInOut
    @State private var keyframeBezier = KeyframeBezier()

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 8) {
                if let clip = model.selectedClip {
                let displayed = model.displayedClipTransform(clip)
                HStack(spacing: 8) {
                    Button { model.addOrUpdateClipTransformKeyframe(
                        curve: keyframeCurve, bezier: keyframeBezier
                    ) } label: {
                        Label(language.text("记录关键帧", "Record Keyframe"), systemImage: "diamond.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    Button { model.removeNearestClipTransformKeyframe() } label: {
                        Label(language.text("删除附近帧", "Remove Nearby"), systemImage: "diamond.slash")
                    }
                    .buttonStyle(.bordered)
                    .disabled(clip.transformKeyframes.isEmpty)
                    Button(language.text("重置", "Reset")) { model.resetSelectedClipTransform() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Text(language.isEnglish
                         ? "\(clip.transformKeyframes.count) keyframes"
                         : "\(clip.transformKeyframes.count) 个关键帧")
                        .font(.caption).foregroundStyle(.secondary)
                }

                KeyframeCurveEditor(curve: $keyframeCurve, bezier: $keyframeBezier)

                if !clip.transformKeyframes.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 5) {
                            ForEach(clip.transformKeyframes) { frame in
                                Button {
                                    keyframeCurve = frame.curve
                                    keyframeBezier = frame.bezier ?? KeyframeBezier()
                                    seek(to: frame, in: clip)
                                } label: {
                                    Label(
                                        String(format: "%.1fs", frame.position * clip.trimmedDuration),
                                        systemImage: "diamond"
                                    )
                                }
                                .buttonStyle(.bordered)
                                .font(.caption2)
                            }
                        }
                    }
                }

                valueSlider(
                    language.text("缩放", "Scale"), value: displayed.scale, range: 0.25...4,
                    display: { String(format: "%.2f×", $0) }
                ) { model.updateSelectedClipTransform(scale: $0) }
                HStack(spacing: 8) {
                    compactSlider(language.text("水平", "X"), value: displayed.x) {
                        model.updateSelectedClipTransform(x: $0)
                    }
                    compactSlider(language.text("垂直", "Y"), value: displayed.y) {
                        model.updateSelectedClipTransform(y: $0)
                    }
                }
                valueSlider(
                    language.text("旋转", "Rotation"), value: displayed.rotation, range: -180...180,
                    display: { String(format: "%.0f°", $0) }
                ) { model.updateSelectedClipTransform(rotation: $0) }
                valueSlider(
                    language.text("透明度", "Opacity"), value: displayed.opacity, range: 0...1,
                    display: { String(format: "%.0f%%", $0 * 100) }
                ) { model.updateSelectedClipTransform(opacity: $0) }
                } else {
                    Text(language.text("选择主轨片段后调整画面。", "Select a main-track clip to transform it."))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
        }
        .disabled(model.isBusy)
    }

    private func valueSlider(
        _ title: String, value: Double, range: ClosedRange<Double>,
        display: @escaping (Double) -> String, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.caption).frame(width: 52, alignment: .leading)
            Slider(
                value: Binding(get: { value }, set: onChange), in: range,
                onEditingChanged: finishInteractiveEdit
            )
            Text(display(value)).font(.caption.monospacedDigit()).frame(width: 48)
        }
    }

    private func compactSlider(
        _ title: String, value: Double, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).frame(width: 30, alignment: .leading)
            Slider(
                value: Binding(get: { value }, set: onChange), in: -1...1,
                onEditingChanged: finishInteractiveEdit
            )
            Text(String(format: "%.2f", value)).font(.caption2.monospacedDigit()).frame(width: 34)
        }
    }

    private func finishInteractiveEdit(_ editing: Bool) {
        if editing { model.beginInteractiveEdit() }
        else { model.commitSelectedClipTransform() }
    }

    private func seek(to frame: ClipTransformKeyframe, in clip: Clip) {
        guard let start = model.timelineStart(of: clip) else { return }
        model.seek(to: start + frame.position * clip.trimmedDuration)
    }
}
