import SwiftUI
#if os(iOS)
import UIKit
#endif

struct ProjectLibraryView: View {
    let onOpen: (UUID) -> Void

    @ObservedObject private var language = AppLanguage.shared
    @State private var projects: [ProjectSummary] = []
    @State private var projectToRename: ProjectSummary?
    @State private var projectToDelete: ProjectSummary?
    @State private var pendingName = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if projects.isEmpty { emptyState } else { projectList }
            }
            .navigationTitle(language.text("我的草稿", "My Drafts"))
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Menu {
                        Button("中文") { language.code = "zh-CN" }
                        Button("English") { language.code = "en" }
                    } label: {
                        Image(systemName: "globe")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: createProject) {
                        Label(language.text("新建", "New"), systemImage: "plus")
                    }
                }
            }
        }
        .onAppear(perform: reload)
        .alert(
            language.text("重命名草稿", "Rename Draft"),
            isPresented: Binding(
                get: { projectToRename != nil },
                set: { if !$0 { projectToRename = nil } }
            )
        ) {
            TextField(language.text("草稿名称", "Draft Name"), text: $pendingName)
            Button(language.text("保存", "Save"), action: renameProject)
            Button(language.text("取消", "Cancel"), role: .cancel) {}
        }
        .confirmationDialog(
            language.text("删除后将同时移除这个草稿复制的全部素材，且无法撤销。",
                          "Deleting also removes all media copied into this draft and cannot be undone."),
            isPresented: Binding(
                get: { projectToDelete != nil },
                set: { if !$0 { projectToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(language.text("删除草稿", "Delete Draft"), role: .destructive, action: deleteProject)
            Button(language.text("取消", "Cancel"), role: .cancel) {}
        }
        .alert(
            language.text("无法完成操作", "Could Not Complete Action"),
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button(language.text("好", "OK"), role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "rectangle.stack.badge.plus")
                .font(.system(size: 54))
                .foregroundStyle(.secondary)
            Text(language.text("还没有草稿", "No Drafts Yet"))
                .font(.title2.bold())
            Text(language.text("创建项目后，素材、时间线和导出设置都会自动保存。",
                               "Create a project and its media, timeline, and export settings will be saved automatically."))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            Button(action: createProject) {
                Label(language.text("创建第一个项目", "Create First Project"), systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var projectList: some View {
        List {
            ForEach(projects) { project in
                Button { onOpen(project.id) } label: {
                    ProjectRow(project: project)
                }
                .buttonStyle(.plain)
                .contextMenu { projectActions(for: project) }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) { projectToDelete = project } label: {
                        Label(language.text("删除", "Delete"), systemImage: "trash")
                    }
                    Button { beginRename(project) } label: {
                        Label(language.text("重命名", "Rename"), systemImage: "pencil")
                    }
                    .tint(.blue)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { reload() }
    }

    @ViewBuilder private func projectActions(for project: ProjectSummary) -> some View {
        Button { beginRename(project) } label: {
            Label(language.text("重命名", "Rename"), systemImage: "pencil")
        }
        Button { duplicate(project) } label: {
            Label(language.text("复制草稿", "Duplicate Draft"), systemImage: "plus.square.on.square")
        }
        Button(role: .destructive) { projectToDelete = project } label: {
            Label(language.text("删除", "Delete"), systemImage: "trash")
        }
    }

    private func createProject() {
        do {
            let base = language.text("未命名项目", "Untitled Project")
            let existing = Set(projects.map(\.name))
            var name = base
            var suffix = 2
            while existing.contains(name) {
                name = "\(base) \(suffix)"
                suffix += 1
            }
            let project = try ProjectDocumentStore.createProject(name: name)
            projects.insert(project, at: 0)
            onOpen(project.id)
        } catch {
            show(error)
        }
    }

    private func beginRename(_ project: ProjectSummary) {
        pendingName = project.name
        projectToRename = project
    }

    private func renameProject() {
        guard let project = projectToRename else { return }
        do {
            _ = try ProjectDocumentStore.renameProject(project.id, to: pendingName)
            projectToRename = nil
            reload()
        } catch {
            projectToRename = nil
            show(error)
        }
    }

    private func duplicate(_ project: ProjectSummary) {
        do {
            let suffix = language.text("副本", "Copy")
            _ = try ProjectDocumentStore.duplicateProject(project.id, name: "\(project.name) \(suffix)")
            reload()
        } catch {
            show(error)
        }
    }

    private func deleteProject() {
        guard let project = projectToDelete else { return }
        do {
            try ProjectDocumentStore.deleteProject(project.id)
            projectToDelete = nil
            reload()
        } catch {
            projectToDelete = nil
            show(error)
        }
    }

    private func reload() {
        do { projects = try ProjectDocumentStore.listProjects() }
        catch { show(error) }
    }

    private func show(_ error: Error) {
        errorMessage = error.localizedDescription
    }
}

private struct ProjectRow: View {
    let project: ProjectSummary
    @ObservedObject private var language = AppLanguage.shared

    var body: some View {
        HStack(spacing: 14) {
            ProjectCover(url: project.coverURL)
                .frame(width: 112, height: 68)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 7) {
                Text(project.name).font(.headline).lineLimit(1)
                Text("\(formatTime(project.duration)) · \(project.mediaCount) \(language.text("个素材", "items"))")
                    .font(.caption).foregroundStyle(.secondary)
                Text(project.updatedAt, style: .relative)
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func formatTime(_ seconds: Double) -> String {
        String(format: "%d:%02d", Int(max(0, seconds)) / 60, Int(max(0, seconds)) % 60)
    }
}

private struct ProjectCover: View {
    let url: URL?

    var body: some View {
        ZStack {
            Color.black
            #if os(iOS)
            if let url, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "film").font(.title2).foregroundStyle(.white.opacity(0.65))
            }
            #else
            Image(systemName: "film").font(.title2).foregroundStyle(.white.opacity(0.65))
            #endif
        }
        .clipped()
    }
}
