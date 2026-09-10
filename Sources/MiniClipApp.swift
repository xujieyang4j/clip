import SwiftUI

// App 入口。Multiplatform 模板会生成同名 struct,直接用这个替换即可。
@main
struct MiniClipApp: App {
    var body: some Scene {
        WindowGroup {
            AppRootView()
        }
        #if os(macOS)
        .defaultSize(width: 720, height: 900)
        #endif
    }
}

struct AppRootView: View {
    @State private var selectedProjectID: UUID?

    var body: some View {
        Group {
            if let projectID = selectedProjectID {
                ContentView(projectID: projectID) { selectedProjectID = nil }
                    .id(projectID)
            } else {
                ProjectLibraryView { selectedProjectID = $0 }
            }
        }
    }
}
