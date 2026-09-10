import SwiftUI

struct KeyframeCurveEditor: View {
    @Binding var curve: KeyframeCurve
    @Binding var bezier: KeyframeBezier
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(language.text("关键帧曲线", "Keyframe Curve"), selection: $curve) {
                Text(language.text("线性", "Linear")).tag(KeyframeCurve.linear)
                Text(language.text("缓入", "Ease In")).tag(KeyframeCurve.easeIn)
                Text(language.text("缓出", "Ease Out")).tag(KeyframeCurve.easeOut)
                Text(language.text("缓入缓出", "Ease Both")).tag(KeyframeCurve.easeInOut)
                Text(language.text("自定义", "Custom")).tag(KeyframeCurve.custom)
            }
            .pickerStyle(.menu)
            if curve == .custom {
                BezierCurvePreview(bezier: $bezier)
                    .frame(height: 96)
                    .accessibilityHidden(true)
                Text(language.text(
                    "拖动曲线手柄快速调整，或使用下方滑块精调。",
                    "Drag the curve handles, or fine-tune with the sliders below."
                ))
                    .font(.caption2).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    handle(language.text("入手柄 X", "In X"), value: x1Binding)
                    handle(language.text("入手柄 Y", "In Y"), value: y1Binding)
                }
                HStack(spacing: 8) {
                    handle(language.text("出手柄 X", "Out X"), value: x2Binding)
                    handle(language.text("出手柄 Y", "Out Y"), value: y2Binding)
                }
                Text(String(format: "cubic-bezier(%.2f, %.2f, %.2f, %.2f)",
                            bezier.x1, bezier.y1, bezier.x2, bezier.y2))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }

    private var x1Binding: Binding<Double> {
        Binding(get: { bezier.x1 }, set: { bezier.x1 = max(0, min(bezier.x2, $0)) })
    }
    private var y1Binding: Binding<Double> {
        Binding(get: { bezier.y1 }, set: { bezier.y1 = max(0, min(1, $0)) })
    }
    private var x2Binding: Binding<Double> {
        Binding(get: { bezier.x2 }, set: { bezier.x2 = max(bezier.x1, min(1, $0)) })
    }
    private var y2Binding: Binding<Double> {
        Binding(get: { bezier.y2 }, set: { bezier.y2 = max(0, min(1, $0)) })
    }

    private func handle(_ title: String, value: Binding<Double>) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption2).frame(width: 56, alignment: .leading)
            Slider(value: value, in: 0...1)
            Text(String(format: "%.2f", value.wrappedValue))
                .font(.caption2.monospacedDigit()).frame(width: 34)
        }
    }
}

private struct BezierCurvePreview: View {
    @Binding var bezier: KeyframeBezier
    private let inset: CGFloat = 10

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let curve = bezier.normalized
            let start = CGPoint(x: inset, y: size.height - inset)
            let end = CGPoint(x: size.width - inset, y: inset)
            let first = point(x: curve.x1, y: curve.y1, in: size)
            let second = point(x: curve.x2, y: curve.y2, in: size)
            ZStack {
                RoundedRectangle(cornerRadius: 7).fill(Color.secondary.opacity(0.08))
                Path { path in
                    path.move(to: start)
                    path.addLine(to: first)
                    path.move(to: end)
                    path.addLine(to: second)
                }
                .stroke(
                    Color.secondary.opacity(0.55),
                    style: StrokeStyle(lineWidth: 1, dash: [4, 3])
                )
                Path { path in
                    path.move(to: start)
                    path.addCurve(
                        to: end, control1: first, control2: second
                    )
                }
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                handle(at: first)
                    .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                        let value = normalizedPoint(gesture.location, in: size)
                        bezier.x1 = min(bezier.x2, value.x)
                        bezier.y1 = value.y
                    })
                handle(at: second)
                    .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                        let value = normalizedPoint(gesture.location, in: size)
                        bezier.x2 = max(bezier.x1, value.x)
                        bezier.y2 = value.y
                    })
            }
            .contentShape(Rectangle())
        }
    }

    private func point(x: Double, y: Double, in size: CGSize) -> CGPoint {
        let width = max(1, size.width - inset * 2)
        let height = max(1, size.height - inset * 2)
        return CGPoint(
            x: inset + width * CGFloat(x),
            y: size.height - inset - height * CGFloat(y)
        )
    }

    private func normalizedPoint(_ point: CGPoint, in size: CGSize) -> (x: Double, y: Double) {
        let width = max(1, size.width - inset * 2)
        let height = max(1, size.height - inset * 2)
        let x = max(0, min(1, (point.x - inset) / width))
        let y = max(0, min(1, (size.height - inset - point.y) / height))
        return (Double(x), Double(y))
    }

    private func handle(at point: CGPoint) -> some View {
        Circle()
            .fill(Color.accentColor)
            .overlay(Circle().stroke(Color.white, lineWidth: 2))
            .frame(width: 18, height: 18)
            .shadow(color: Color.black.opacity(0.18), radius: 2, y: 1)
            .position(point)
            .contentShape(Circle().inset(by: -8))
    }
}
