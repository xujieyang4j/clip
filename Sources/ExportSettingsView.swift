import SwiftUI

struct ExportSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: EditorModel
    @ObservedObject private var language = AppLanguage.shared
    let onExport: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section(language.text("画面", "Video")) {
                    Picker(language.text("分辨率", "Resolution"), selection: Binding(
                        get: { model.exportResolution }, set: { model.setExportResolution($0) }
                    )) {
                        ForEach(ExportResolution.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Picker(language.text("帧率", "Frame Rate"), selection: Binding(
                        get: { model.exportFrameRate }, set: { model.setExportFrameRate($0) }
                    )) {
                        ForEach([24, 25, 30, 50, 60], id: \.self) { Text("\($0) fps").tag($0) }
                    }
                    Picker(language.text("质量", "Quality"), selection: Binding(
                        get: { model.exportQuality }, set: { model.setExportQuality($0) }
                    )) {
                        Text(language.text("草稿", "Draft")).tag(ExportQuality.draft)
                        Text(language.text("标准", "Standard")).tag(ExportQuality.standard)
                        Text(language.text("高质量", "High")).tag(ExportQuality.high)
                    }
                }

                Section(language.text("导出信息", "Export Info")) {
                    LabeledContent(language.text("画布", "Canvas"), value: model.canvasFormat.rawValue)
                    LabeledContent(language.text("输出尺寸", "Output Size"),
                                   value: "\(Int(model.exportRenderSize.width)) × \(Int(model.exportRenderSize.height))")
                    LabeledContent(language.text("预计大小", "Estimated Size"),
                                   value: "≈ \(model.estimatedExportMegabytes) MB")
                    Text(language.text("预计大小用于导出前检查，实际文件取决于画面复杂度和系统编码器。",
                                       "The estimate is for a preflight check; actual size depends on content and the system encoder."))
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        dismiss()
                        onExport()
                    } label: {
                        Label(language.text("开始导出", "Start Export"), systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.clips.isEmpty || model.isBusy)
                }
            }
            .navigationTitle(language.text("导出设置", "Export Settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(language.text("取消", "Cancel")) { dismiss() }
                }
            }
        }
    }
}
