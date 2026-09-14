import Foundation

// Bundle localization follows the ordered macOS language preferences (including
// the per-app language setting). English is the bundle's development language.
enum AppLocalization {
    static let language = Bundle.main.preferredLocalizations.first ?? "en"
    static let bundle = Bundle.main.path(forResource: language, ofType: "lproj")
        .flatMap(Bundle.init(path:)) ?? Bundle.main

    static func text(_ key: String, arguments: [CVarArg] = []) -> String {
        if arguments.isEmpty {
            // The helper keeps stable Korean messages internally. Translate its
            // three parameterized errors at the presentation boundary only.
            let patterns = [
                ("선택한 계정의 요청이 거절됐습니다. (HTTP ", ")", "선택한 계정의 요청이 거절됐습니다. (HTTP %@)"),
                ("연결 거절 (HTTP ", ")", "연결 거절 (HTTP %@)"),
                ("Codex 계정 요청을 완료하지 못했습니다. (", ")", "Codex 계정 요청을 완료하지 못했습니다. (%@)")
            ]
            for (prefix, suffix, format) in patterns where key.hasPrefix(prefix) && key.hasSuffix(suffix) {
                let value = String(key.dropFirst(prefix.count).dropLast(suffix.count))
                return text(format, arguments: [text(value)])
            }
        }
        let format = bundle.localizedString(forKey: key, value: key, table: nil)
        return arguments.isEmpty ? format : String(format: format, locale: Locale.autoupdatingCurrent, arguments: arguments)
    }
}

func L(_ key: String, _ arguments: CVarArg...) -> String {
    AppLocalization.text(key, arguments: arguments)
}
