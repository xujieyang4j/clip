import Foundation
import SwiftUI

/// Shared UI-language preference for the Swift prototype. Chinese is the
/// intentional first-launch default and the choice is retained locally.
@MainActor
final class AppLanguage: ObservableObject {
    static let shared = AppLanguage()

    private static let preferenceKey = "MiniClip.interfaceLanguage"

    @Published var code: String {
        didSet { UserDefaults.standard.set(code, forKey: Self.preferenceKey) }
    }

    private init() {
        code = UserDefaults.standard.string(forKey: Self.preferenceKey) == "en" ? "en" : "zh-CN"
    }

    var isEnglish: Bool { code == "en" }

    func text(_ chinese: String, _ english: String) -> String {
        isEnglish ? english : chinese
    }
}
