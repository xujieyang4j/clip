import SwiftUI
import UniformTypeIdentifiers

/// Horizontal scrollable strip of clip cards, plus per-clip trim controls.
struct TimelineView: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(language.text("时间线", "Timeline"))
                    .font(.headline)
                Spacer()
                if model.clips.count >= 2 {
                    Text(language.text("拖动卡片可排序", "Drag cards to reorder"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)

            if model.clips.isEmpty {
                emptyState
            } else {
                ScrollView(.horizontal, showsIndicators: true) {
                    HStack(spacing: 10) {
                        ForEach(model.clips) { clip in
                            ClipCard(model: model, clip: clip)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            Spacer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "film.stack")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(language.text("还没有片段,点右上角「导入视频」", "No clips yet. Tap Import Video in the top-right corner."))
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
    }
}

/// A single clip on the timeline: thumbnail, trim sliders, reorder/delete.
struct ClipCard: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    let clip: Clip
    /// Highlights the card while another clip is dragged over it.
    @State private var isDropTarget = false

    var body: some View {
        VStack(spacing: 6) {
            thumbnail
            trimControls
            actions
        }
        .padding(8)
        .frame(width: 220)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.accentColor, lineWidth: isDropTarget ? 3 : 0)
        )
        // Drag this card out by its id…
        .draggable(clip.id.uuidString) {
            dragPreview
        }
        // …and accept another card dropped onto it to reorder.
        .dropDestination(for: String.self) { items, _ in
            guard let draggedID = items.first else { return false }
            model.moveClip(withID: draggedID, toCardOf: clip.id.uuidString)
            return true
        } isTargeted: { targeted in
            isDropTarget = targeted
        }
    }

    /// Small floating thumbnail shown under the cursor/finger while dragging.
    private var dragPreview: some View {
        Group {
            if let image = clip.thumbnail {
                #if os(iOS)
                Image(uiImage: image).resizable()
                #else
                Image(nsImage: image).resizable()
                #endif
            } else {
                Rectangle().fill(.gray.opacity(0.4))
            }
        }
        .aspectRatio(16/9, contentMode: .fill)
        .frame(width: 120, height: 68)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var thumbnail: some View {
        Group {
            if let image = clip.thumbnail {
                #if os(iOS)
                Image(uiImage: image).resizable()
                #else
                Image(nsImage: image).resizable()
                #endif
            } else {
                Rectangle().fill(.gray.opacity(0.3))
            }
        }
        .aspectRatio(16/9, contentMode: .fill)
        .frame(height: 110)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var trimControls: some View {
        VStack(spacing: 2) {
            HStack {
                Text(language.text("起", "In")).font(.caption2)
                Slider(
                    value: Binding(
                        get: { clip.trimStart },
                        set: { model.updateTrim(for: clip, start: $0, end: clip.trimEnd) }),
                    in: 0...max(0.1, clip.sourceDuration),
                    onEditingChanged: { editing in
                        if editing { model.beginInteractiveEdit() }
                    })
            }
            HStack {
                Text(language.text("止", "Out")).font(.caption2)
                Slider(
                    value: Binding(
                        get: { clip.trimEnd },
                        set: { model.updateTrim(for: clip, start: clip.trimStart, end: $0) }),
                    in: 0...max(0.1, clip.sourceDuration),
                    onEditingChanged: { editing in
                        if editing { model.beginInteractiveEdit() }
                    })
            }
            Text(language.isEnglish
                 ? String(format: "%.1fs → %.1fs (%.1fs total)", clip.trimStart, clip.trimEnd, clip.trimmedDuration)
                 : String(format: "%.1fs → %.1fs (共 %.1fs)", clip.trimStart, clip.trimEnd, clip.trimmedDuration))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        HStack {
            Button { model.move(clip, by: -1) } label: {
                Image(systemName: "arrow.left")
            }
            Button { model.move(clip, by: 1) } label: {
                Image(systemName: "arrow.right")
            }
            Spacer()
            Button(role: .destructive) { model.delete(clip) } label: {
                Image(systemName: "trash")
            }
        }
        .buttonStyle(.borderless)
        .font(.callout)
    }

    private var cardBackground: Color {
        #if os(iOS)
        Color(uiColor: .tertiarySystemBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}
