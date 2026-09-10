import SwiftUI

struct OverlayPanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    @State private var keyframeCurve: KeyframeCurve = .easeInOut
    @State private var keyframeBezier = KeyframeBezier()

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 8) {
            if model.overlays.isEmpty {
                Text(language.text("在素材库中点视频或图片，选择“添加为画中画”。",
                                   "Choose a video or image in Media, then select Add as Overlay."))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.overlays) { item in
                            Button { model.selectOverlay(item) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(model.mediaAsset(id: item.assetID)?.name ?? language.text("失效素材", "Missing Media"))
                                        .lineLimit(1)
                                    Text(String(format: "%.1f–%.1fs", item.start, item.end))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 6)
                                .background(model.selectedOverlayID == item.id ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.10))
                                .clipShape(RoundedRectangle(cornerRadius: 7))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }

            if let item = model.selectedOverlay {
                let displayed = model.displayedOverlay(item)
                HStack(spacing: 8) {
                    Button { model.addOrUpdateOverlayKeyframe(
                        curve: keyframeCurve, bezier: keyframeBezier
                    ) } label: {
                        Label(language.text("添加关键帧", "Add Keyframe"), systemImage: "diamond.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    Button { model.removeNearestOverlayKeyframe() } label: {
                        Label(language.text("删除附近帧", "Remove Nearby"), systemImage: "diamond.slash")
                    }
                    .buttonStyle(.bordered)
                    Text(language.isEnglish
                         ? "\(item.keyframes?.count ?? 0) keyframes"
                         : "\(item.keyframes?.count ?? 0) 个关键帧")
                        .font(.caption).foregroundStyle(.secondary)
                }
                KeyframeCurveEditor(curve: $keyframeCurve, bezier: $keyframeBezier)
                if let frames = item.keyframes, !frames.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 5) {
                            ForEach(frames) { frame in
                                Button {
                                    keyframeCurve = frame.curve
                                    keyframeBezier = frame.bezier ?? KeyframeBezier()
                                    model.seek(to: item.start + frame.time)
                                } label: {
                                    Label(String(format: "%.1fs", frame.time), systemImage: "diamond")
                                }
                                .buttonStyle(.bordered)
                                .font(.caption2)
                            }
                        }
                    }
                }
                HStack(spacing: 8) {
                    valueSlider(language.text("X", "X"), value: displayed.x, range: 0...1) { model.updateOverlay(item, x: $0) }
                    valueSlider(language.text("Y", "Y"), value: displayed.y, range: 0...1) { model.updateOverlay(item, y: $0) }
                }
                HStack(spacing: 8) {
                    valueSlider(language.text("大小", "Size"), value: displayed.scale, range: 0.1...1.5) { model.updateOverlay(item, scale: $0) }
                    valueSlider(language.text("透明", "Opacity"), value: displayed.opacity, range: 0...1) { model.updateOverlay(item, opacity: $0) }
                }
                HStack(spacing: 8) {
                    valueSlider(language.text("开始", "Start"), value: item.start, range: 0...max(0.1, model.timelineDuration)) {
                        model.updateOverlay(item, start: $0)
                    }
                    valueSlider(language.text("结束", "End"), value: item.end, range: 0...max(0.1, model.timelineDuration)) {
                        model.updateOverlay(item, end: $0)
                    }
                }
                if let asset = model.mediaAsset(id: item.assetID) {
                    valueSlider(
                        language.text("素材起点", "Source"), value: item.sourceStart ?? 0,
                        range: 0...max(0.1, asset.duration - (item.end - item.start))
                    ) { model.updateOverlay(item, sourceStart: $0) }
                }
                HStack {
                    Text(language.text("旋转", "Rotation")).font(.caption)
                    Slider(value: Binding(get: { displayed.rotation }, set: { model.updateOverlay(item, rotation: $0) }),
                           in: -180...180, onEditingChanged: { if $0 { model.beginInteractiveEdit() } })
                    Text(String(format: "%.0f°", displayed.rotation)).font(.caption.monospacedDigit()).frame(width: 44)
                    Button(role: .destructive) { model.deleteSelectedOverlay() } label: { Image(systemName: "trash") }
                        .buttonStyle(.bordered)
                }
            }
            }
            .padding(.horizontal, 12)
        }
        .disabled(model.isBusy)
    }

    private func valueSlider(
        _ title: String, value: Double, range: ClosedRange<Double>, onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption).frame(width: 34, alignment: .leading)
            Slider(value: Binding(get: { value }, set: onChange), in: range,
                   onEditingChanged: { if $0 { model.beginInteractiveEdit() } })
        }
    }
}
