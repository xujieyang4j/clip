import SwiftUI
import Foundation

struct SpeedCurvePanel: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    @State private var draggingPointID: UUID?
    @State private var hasRecordedDragUndo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(language.text("速度曲线", "Speed Curve")).font(.caption)
                Button(language.text("无", "None")) { model.applySpeedCurvePreset("none") }
                Button(language.text("蒙太奇", "Montage")) { model.applySpeedCurvePreset("montage") }
                Button(language.text("子弹时间", "Bullet")) { model.applySpeedCurvePreset("bullet") }
                Button(language.text("英雄时刻", "Hero")) { model.applySpeedCurvePreset("hero") }
            }
            .buttonStyle(.bordered)
            .font(.caption2)

            if let clip = model.selectedClip {
                curveEditor(clip)
                    .frame(height: 116)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                HStack(spacing: 8) {
                    Button { model.addSpeedPointAtPlayhead() } label: {
                        Label(language.text("播放头加点", "Add at Playhead"), systemImage: "plus.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    Button(role: .destructive) { model.removeSelectedSpeedPoint() } label: {
                        Label(language.text("删除点", "Remove Point"), systemImage: "minus.circle")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.selectedSpeedPointID == nil)
                    Spacer()
                    if let point = model.selectedSpeedPoint {
                        Text(String(format: "%.0f%% · %.2f×", point.position * 100, point.speed))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .disabled(model.isBusy)
    }

    private func curveEditor(_ clip: Clip) -> some View {
        GeometryReader { geometry in
            Canvas { context, size in
                for speed in [0.25, 0.5, 1.0, 2.0, 4.0] {
                    var grid = Path()
                    let y = yPosition(for: speed, height: size.height)
                    grid.move(to: CGPoint(x: 0, y: y))
                    grid.addLine(to: CGPoint(x: size.width, y: y))
                    context.stroke(grid, with: .color(speed == 1 ? .secondary : .secondary.opacity(0.22)), lineWidth: 0.6)
                }
                var curve = Path()
                for sample in 0...96 {
                    let position = Double(sample) / 96
                    let speed = TimelineMath.speedAt(
                        position: position, baseSpeed: clip.speed, points: clip.speedPoints
                    )
                    let point = CGPoint(
                        x: size.width * CGFloat(position), y: yPosition(for: speed, height: size.height)
                    )
                    if sample == 0 { curve.move(to: point) } else { curve.addLine(to: point) }
                }
                context.stroke(curve, with: .color(.accentColor), lineWidth: 2.5)
                for point in clip.speedPoints {
                    let center = CGPoint(
                        x: size.width * CGFloat(point.position), y: yPosition(for: point.speed, height: size.height)
                    )
                    let radius: CGFloat = model.selectedSpeedPointID == point.id ? 7 : 5
                    context.fill(
                        Path(ellipseIn: CGRect(
                            x: center.x - radius, y: center.y - radius,
                            width: radius * 2, height: radius * 2
                        )),
                        with: .color(model.selectedSpeedPointID == point.id ? .orange : .accentColor)
                    )
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                guard !clip.speedPoints.isEmpty else { return }
                if draggingPointID == nil {
                    let nearest = clip.speedPoints.min { lhs, rhs in
                        distance(from: lhs, to: value.location, size: geometry.size) <
                            distance(from: rhs, to: value.location, size: geometry.size)
                    }
                    guard let nearest, distance(from: nearest, to: value.location, size: geometry.size) <= 34 else {
                        return
                    }
                    draggingPointID = nearest.id
                    model.selectSpeedPoint(nearest.id)
                }
                guard let draggingPointID,
                      let current = model.selectedClip?.speedPoints.first(where: { $0.id == draggingPointID })
                else { return }
                let position = Double(
                    max(0, min(geometry.size.width, value.location.x)) / max(1, geometry.size.width)
                )
                let speed = speed(forY: value.location.y, height: geometry.size.height)
                guard abs(current.position - position) > 0.0005 || abs(current.speed - speed) > 0.002 else {
                    return
                }
                if !hasRecordedDragUndo {
                    model.beginInteractiveEdit()
                    hasRecordedDragUndo = true
                }
                model.updateSpeedPoint(
                    draggingPointID, position: position, speed: speed
                )
            }.onEnded { _ in
                draggingPointID = nil
                if hasRecordedDragUndo { model.commitSpeedCurveEdit() }
                hasRecordedDragUndo = false
            })
        }
        .accessibilityLabel(language.text("自定义速度曲线", "Custom speed curve"))
    }

    private func yPosition(for speed: Double, height: CGFloat) -> CGFloat {
        let level = max(-2, min(2, log2(max(0.25, min(4, speed)))))
        return height * CGFloat((2 - level) / 4)
    }

    private func speed(forY y: CGFloat, height: CGFloat) -> Double {
        let normalized = Double(max(0, min(height, y)) / max(1, height))
        return max(0.25, min(4, pow(2, 2 - normalized * 4)))
    }

    private func distance(from point: SpeedPoint, to location: CGPoint, size: CGSize) -> CGFloat {
        let dx = size.width * CGFloat(point.position) - location.x
        let dy = yPosition(for: point.speed, height: size.height) - location.y
        return (dx * dx + dy * dy).squareRoot()
    }
}
