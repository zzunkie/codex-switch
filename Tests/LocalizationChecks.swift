import Foundation

@main struct LocalizationChecks {
    static func main() {
        let expected = CommandLine.arguments.first(where: { $0.hasPrefix("--expect=") })!.dropFirst(9)
        precondition(AppLocalization.language == expected, "Unexpected language: \(AppLocalization.language)")
        if expected == "ko" {
            precondition(L("계정 추가") == "계정 추가")
            precondition(L("%d시간", 5) == "5시간")
            precondition(L("연결 거절 (HTTP 403)") == "연결 거절 (HTTP 403)")
        } else {
            precondition(L("계정 추가") == "Add account")
            precondition(L("%d시간", 5) == "5-hour")
            precondition(L("연결 거절 (HTTP 403)") == "Connection rejected (HTTP 403)")
            precondition(L("Codex 계정 요청을 완료하지 못했습니다. (오류)") == "Could not complete the Codex account request. (Error)")
        }
        precondition(L("%@ 선택", "100%@example.com").contains("100%@example.com"))
        precondition(L("Unknown upstream message") == "Unknown upstream message")
        print("Localization passed: \(expected)")
    }
}
