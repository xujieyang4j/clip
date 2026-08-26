import SwiftUI

// App 入口。Multiplatform 模板会生成同名 struct,直接用这个替换即可。
@main
struct MiniClipApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
        .defaultSize(width: 720, height: 900)
        #endif
    }
}
