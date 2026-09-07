import SwiftUI

struct MediaLibraryView: View {
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        if model.mediaAssets.isEmpty {
            Text(language.text("导入后，素材会留在这里并可重复加入时间线", "Imported media stays here and can be reused on the timeline"))
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 68)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(model.mediaAssets) { asset in
                        Button { model.addAssetToTimeline(asset) } label: {
                            HStack(spacing: 8) {
                                assetImage(asset)
                                    .frame(width: 74, height: 48)
                                    .clipShape(RoundedRectangle(cornerRadius: 7))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(asset.name).font(.caption).lineLimit(1)
                                    Text(String(format: "%.1fs · ×%d", asset.duration, model.mediaUsageCount(asset)))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                Image(systemName: "plus.circle.fill").foregroundStyle(.tint)
                            }
                            .padding(6)
                            .frame(width: 210, alignment: .leading)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isBusy)
                        .contextMenu {
                            Button { model.addAssetToTimeline(asset) } label: {
                                Label(language.text("加入时间线", "Add to Timeline"), systemImage: "plus.rectangle.on.rectangle")
                            }
                            Button(role: .destructive) { model.removeMediaAsset(asset) } label: {
                                Label(language.text("移出素材库", "Remove from Library"), systemImage: "trash")
                            }
                            .disabled(model.mediaUsageCount(asset) > 0)
                        }
                    }
                }
                .padding(.horizontal, 12)
            }
        }
    }

    @ViewBuilder private func assetImage(_ asset: MediaAsset) -> some View {
        if let image = asset.thumbnail {
            #if os(iOS)
            Image(uiImage: image).resizable().scaledToFill()
            #else
            Image(nsImage: image).resizable().scaledToFill()
            #endif
        } else {
            Rectangle().fill(.gray.opacity(0.3)).overlay(Image(systemName: "film"))
        }
    }
}
