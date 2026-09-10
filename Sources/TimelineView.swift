import SwiftUI
import UniformTypeIdentifiers

/// Compact multitrack timeline for touch editing. The upper lanes show the
/// temporal relationship between main clips, overlays and independent audio;
/// the lower inspector keeps precise trim and reorder controls for the selected
/// main-track clip.
struct TimelineView: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 8) {
                header
                if model.clips.isEmpty {
                    emptyState
                } else {
                    MultiTrackOverview(model: model)
                    if let clip = model.selectedClip {
                        SelectedClipInspector(model: model, clip: clip)
                    }
                }
            }
            .padding(.vertical, 8)
        }
    }

    private var header: some View {
        HStack {
            Text(language.text("多轨时间线", "Multitrack Timeline"))
                .font(.headline)
            Spacer()
            Text(language.isEnglish
                 ? "\(model.clips.count) clips · \(time(model.timelineDuration))"
                 : "\(model.clips.count) 段 · \(time(model.timelineDuration))")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal)
    }

    private func time(_ seconds: Double) -> String {
        String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "film.stack")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text(language.text("从素材面板将视频或图片加入主轨", "Add a video or photo from Media to the main track"))
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
    }
}

private struct MultiTrackOverview: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        GeometryReader { proxy in
            let scale: CGFloat = max(30, (proxy.size.width - 72) / CGFloat(max(1, model.timelineDuration)))
            let contentWidth = max(proxy.size.width - 72, CGFloat(model.timelineDuration) * scale)
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 5) {
                    ruler(width: contentWidth, scale: scale)
                    trackRow(language.text("主轨", "Main"), icon: "film") {
                        mainTrack(width: contentWidth, scale: scale)
                    }
                    trackRow(language.text("画中画", "Overlay"), icon: "rectangle.on.rectangle") {
                        overlayTrack(width: contentWidth, scale: scale)
                    }
                    trackRow(language.text("音频", "Audio"), icon: "waveform") {
                        audioTrack(width: contentWidth, scale: scale)
                    }
                }
                .overlay(alignment: .topLeading) {
                    Rectangle()
                        .fill(Color.red.opacity(0.9))
                        .frame(width: 1.5, height: 132)
                        .offset(x: 64 + CGFloat(model.playheadSeconds) * scale, y: 14)
                        .allowsHitTesting(false)
                }
                .padding(.horizontal, 8)
            }
        }
        .frame(height: 150)
    }

    private func ruler(width: CGFloat, scale: CGFloat) -> some View {
        let interval = max(1, Int(ceil(max(1, model.timelineDuration) / 8)))
        let ticks = Array(stride(from: 0, through: Int(ceil(model.timelineDuration)), by: interval))
        return HStack(spacing: 0) {
            Color.clear.frame(width: 56, height: 18)
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.secondary.opacity(0.12)).frame(height: 1)
                ForEach(ticks, id: \.self) { second in
                    VStack(spacing: 1) {
                        Text(time(Double(second))).font(.system(size: 8).monospacedDigit())
                        Rectangle().fill(Color.secondary).frame(width: 1, height: 4)
                    }
                    .foregroundStyle(.secondary)
                    .offset(x: CGFloat(second) * scale)
                }
            }
            .frame(width: width, height: 18, alignment: .leading)
        }
    }

    private func trackRow<Content: View>(
        _ title: String, icon: String, @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 8) {
            VStack(spacing: 1) {
                Image(systemName: icon).font(.caption2)
                Text(title).font(.system(size: 9)).lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .frame(width: 48)
            content()
        }
    }

    private func mainTrack(width: CGFloat, scale: CGFloat) -> some View {
        let durations = model.clips.map(\.trimmedDuration)
        let overlaps = TimelineMath.effectiveTransitionDurations(
            durations: durations, requested: model.transitionDurations
        )
        return ZStack(alignment: .leading) {
            laneBackground
            ForEach(Array(model.clips.enumerated()), id: \.element.id) { index, clip in
                let start = TimelineMath.clipStart(
                    index: index, durations: durations,
                    transitions: model.transitionDurations
                ) ?? 0
                Button { model.select(clip) } label: {
                    HStack(spacing: 3) {
                        Image(systemName: clip.kind == .image ? "photo" : "film")
                        Text(model.mediaAsset(id: clip.assetID)?.name ?? language.text("片段", "Clip"))
                            .lineLimit(1)
                    }
                    .font(.caption2)
                    .padding(.horizontal, 5)
                    .frame(width: max(34, CGFloat(clip.trimmedDuration) * scale), height: 30, alignment: .leading)
                    .background(
                        model.selectedClipID == clip.id ? Color.accentColor.opacity(0.72) : Color.blue.opacity(0.48),
                        in: RoundedRectangle(cornerRadius: 5)
                    )
                    .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .offset(x: CGFloat(start) * scale)
                .draggable(clip.id.uuidString)
                .dropDestination(for: String.self) { items, _ in
                    guard let draggedID = items.first else { return false }
                    model.moveClip(withID: draggedID, toCardOf: clip.id.uuidString)
                    return true
                }
            }
            ForEach(Array(model.clips.dropLast().enumerated()), id: \.element.id) { index, clip in
                let overlap = index < overlaps.count ? overlaps[index] : 0
                let nextStart = TimelineMath.clipStart(
                    index: index + 1, durations: durations, transitions: overlaps
                ) ?? 0
                let center = nextStart + overlap / 2
                let isActive = clip.outgoingTransition.style != .none && overlap > 0.001
                let markerWidth: CGFloat = isActive ? 49 : 24
                Button { model.select(clip) } label: {
                    HStack(spacing: 2) {
                        Image(systemName: transitionIcon(clip.outgoingTransition.style))
                            .font(.system(size: 9, weight: .bold))
                        if isActive {
                            Text(String(format: "%.1f", overlap))
                                .font(.system(size: 8).monospacedDigit())
                        }
                    }
                    .frame(width: markerWidth, height: 20)
                    .foregroundStyle(isActive ? Color.white : Color.secondary)
                    .background(
                        isActive ? Color.indigo.opacity(0.92) : Color(uiColor: .secondarySystemBackground),
                        in: Capsule()
                    )
                    .overlay(
                        Capsule().stroke(
                            model.selectedClipID == clip.id ? Color.accentColor : Color.secondary.opacity(0.35),
                            lineWidth: model.selectedClipID == clip.id ? 2 : 1
                        )
                    )
                }
                .buttonStyle(.plain)
                .offset(x: CGFloat(center) * scale - markerWidth / 2)
                .zIndex(2)
                .accessibilityLabel(transitionAccessibilityLabel(
                    clip.outgoingTransition.style, duration: overlap
                ))
            }
        }
        .frame(width: width, height: 32, alignment: .leading)
    }

    private func transitionIcon(_ style: TransitionStyle) -> String {
        switch style {
        case .none: return "plus"
        case .dissolve: return "circle.lefthalf.filled"
        case .pushLeft: return "arrow.left"
        case .pushRight: return "arrow.right"
        }
    }

    private func transitionAccessibilityLabel(_ style: TransitionStyle, duration: Double) -> String {
        let name: String
        switch style {
        case .none: name = language.text("无转场", "No transition")
        case .dissolve: name = language.text("叠化", "Dissolve")
        case .pushLeft: name = language.text("左推", "Push left")
        case .pushRight: name = language.text("右推", "Push right")
        }
        guard style != .none else {
            return language.text("添加到下一片段的转场", "Add transition to next clip")
        }
        return String(format: language.text("%@，%.1f 秒", "%@, %.1f seconds"), name, duration)
    }

    private func overlayTrack(width: CGFloat, scale: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            laneBackground
            ForEach(model.overlays) { item in
                Button { model.selectOverlay(item) } label: {
                    trackLabel(
                        model.mediaAsset(id: item.assetID)?.name ?? language.text("画中画", "Overlay"),
                        width: max(30, CGFloat(item.end - item.start) * scale),
                        color: model.selectedOverlayID == item.id ? .orange : .purple,
                        icon: "rectangle.on.rectangle"
                    )
                }
                .buttonStyle(.plain)
                .offset(x: CGFloat(item.start) * scale)
            }
        }
        .frame(width: width, height: 28, alignment: .leading)
    }

    private func audioTrack(width: CGFloat, scale: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            laneBackground
            ForEach(model.audioTracks) { item in
                Button { model.selectAudioTrack(item) } label: {
                    trackLabel(
                        model.mediaAsset(id: item.assetID)?.name ?? language.text("音频", "Audio"),
                        width: max(30, CGFloat(item.duration) * scale),
                        color: item.isMuted ? .gray : (model.selectedAudioTrackID == item.id ? .green : .teal),
                        icon: item.isMuted ? "speaker.slash" : "waveform"
                    )
                }
                .buttonStyle(.plain)
                .offset(x: CGFloat(item.start) * scale)
            }
        }
        .frame(width: width, height: 28, alignment: .leading)
    }

    private func trackLabel(_ title: String, width: CGFloat, color: Color, icon: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8))
            Text(title).lineLimit(1)
        }
        .font(.caption2)
        .padding(.horizontal, 4)
        .frame(width: width, height: 26, alignment: .leading)
        .background(color.opacity(0.68), in: RoundedRectangle(cornerRadius: 5))
        .foregroundStyle(.white)
    }

    private var laneBackground: some View {
        RoundedRectangle(cornerRadius: 5)
            .fill(Color.secondary.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.12)))
    }

    private func time(_ seconds: Double) -> String {
        String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

private struct SelectedClipInspector: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    let clip: Clip

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                Text(model.mediaAsset(id: clip.assetID)?.name ?? language.text("所选片段", "Selected clip"))
                    .font(.caption).fontWeight(.semibold).lineLimit(1)
                Text(String(format: "%.1fs", clip.trimmedDuration))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Button { model.move(clip, by: -1) } label: { Image(systemName: "arrow.left") }
                Button { model.move(clip, by: 1) } label: { Image(systemName: "arrow.right") }
                Button(role: .destructive) { model.delete(clip) } label: { Image(systemName: "trash") }
            }
            HStack(spacing: 6) {
                Text(language.text("入点", "In")).font(.caption2).frame(width: 30)
                Slider(
                    value: Binding(
                        get: { clip.trimStart },
                        set: { model.updateTrim(for: clip, start: $0, end: clip.trimEnd) }
                    ),
                    in: 0...max(0.1, clip.sourceDuration),
                    onEditingChanged: { if $0 { model.beginInteractiveEdit() } }
                )
                Text(language.text("出点", "Out")).font(.caption2).frame(width: 30)
                Slider(
                    value: Binding(
                        get: { clip.trimEnd },
                        set: { model.updateTrim(for: clip, start: clip.trimStart, end: $0) }
                    ),
                    in: 0...max(0.1, clip.sourceDuration),
                    onEditingChanged: { if $0 { model.beginInteractiveEdit() } }
                )
            }
        }
        .padding(.horizontal, 12)
        .disabled(model.isBusy)
    }
}
