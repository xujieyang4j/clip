import SwiftUI
import AVKit
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = EditorModel()
    @ObservedObject private var language = AppLanguage.shared
    @State private var showImporter = false
    @State private var showAudioImporter = false

    var body: some View {
        VStack(spacing: 0) {
            header
            PreviewView(player: model.player)
                .frame(maxWidth: .infinity)
                .frame(height: 280)
                .background(Color.black)

            statusBar
            musicBar
            transitionBar

            TimelineView(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(platformBackground)
        }
        .fileImporter(
            isPresented: $showImporter,
            allowedContentTypes: [.movie, .video, .mpeg4Movie, .quickTimeMovie],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                Task { await model.importVideos(urls: urls) }
            }
        }
        .fileImporter(
            isPresented: $showAudioImporter,
            allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await model.importBGM(url: url) }
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack {
            Text("MiniClip")
                .font(.title2).bold()
            Picker(language.text("语言", "Language"), selection: $language.code) {
                Text("中文").tag("zh-CN")
                Text("English").tag("en")
            }
            .labelsHidden()
            .pickerStyle(.menu)
            Spacer()
            Button {
                model.undo()
            } label: {
                Label(language.text("撤销", "Undo"), systemImage: "arrow.uturn.backward")
            }
            .disabled(!model.canUndo)
            Button {
                model.redo()
            } label: {
                Label(language.text("重做", "Redo"), systemImage: "arrow.uturn.forward")
            }
            .disabled(!model.canRedo)
            Button {
                showImporter = true
            } label: {
                Label(language.text("导入视频", "Import Video"), systemImage: "plus")
            }
            Button {
                Task { await model.export() }
            } label: {
                Label(language.text("导出", "Export"), systemImage: "square.and.arrow.up")
            }
            .disabled(model.clips.isEmpty || model.isExporting)
        }
        .padding()
    }

    private var statusBar: some View {
        HStack(spacing: 12) {
            Text(model.statusMessage)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if model.isExporting {
                ProgressView(value: model.exportProgress)
                    .frame(width: 120)
            }
            Spacer()
            if let url = model.exportedURL {
                ShareLink(item: url) {
                    Label(language.text("分享成片", "Share Video"), systemImage: "square.and.arrow.up.on.square")
                }
                .font(.footnote)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var musicBar: some View {
        VStack(spacing: 6) {
            HStack {
                Button {
                    showAudioImporter = true
                } label: {
                    Label(model.bgmName == nil
                          ? language.text("添加背景音乐", "Add Background Music")
                          : language.text("更换背景音乐", "Change Background Music"),
                          systemImage: "music.note")
                }
                .font(.footnote)

                if let name = model.bgmName {
                    Text(name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Button(role: .destructive) {
                        model.removeBGM()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote)
                }
                Spacer()
            }

            if model.bgmName != nil {
                HStack(spacing: 12) {
                    volumeSlider(
                        title: language.text("原声", "Original"),
                        value: Binding(
                            get: { model.originalVolume },
                            set: { model.setOriginalVolume($0) }))
                    volumeSlider(
                        title: language.text("音乐", "Music"),
                        value: Binding(
                            get: { model.bgmVolume },
                            set: { model.setBGMVolume($0) }))
                }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 4)
        .disabled(model.clips.isEmpty)
    }

    /// Cross-dissolve control. Only meaningful with 2+ clips to transition between.
    @ViewBuilder private var transitionBar: some View {
        if model.clips.count >= 2 {
            HStack(spacing: 8) {
                Label(language.text("转场", "Transition"), systemImage: "wand.and.stars")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Slider(
                    value: Binding(
                        get: { model.transitionDuration },
                        set: { model.setTransition($0) }),
                    in: 0...2,
                    onEditingChanged: { editing in
                        if editing { model.beginInteractiveEdit() }
                    })
                Text(model.transitionDuration < 0.05
                     ? language.text("无", "None")
                     : String(format: "%.1fs", model.transitionDuration))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 34, alignment: .trailing)
            }
            .padding(.horizontal)
            .padding(.bottom, 4)
        }
    }

    private func volumeSlider(title: String, value: Binding<Double>) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.caption2)
            Slider(value: value, in: 0...1, onEditingChanged: { editing in
                if editing { model.beginInteractiveEdit() }
            })
            Text(String(format: "%.0f%%", value.wrappedValue * 100))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 34, alignment: .trailing)
        }
    }

    private var platformBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemBackground)
        #else
        Color(nsColor: .underPageBackgroundColor)
        #endif
    }
}

/// Bridges AVPlayer into SwiftUI with playback controls.
struct PreviewView: View {
    let player: AVPlayer
    var body: some View {
        VideoPlayer(player: player)
    }
}
