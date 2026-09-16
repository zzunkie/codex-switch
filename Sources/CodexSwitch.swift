import AppKit
import SwiftUI
import ServiceManagement

struct QuotaWindow: Decodable {
    var usedPercent: Double
    var remainingPercent: Double
    var durationMins: Double?
    var resetsAt: Double?
    var title: String {
        guard let minutes = durationMins else { return L("사용 한도") }
        if minutes == 10080 { return L("주간") }
        if minutes >= 1440 { return L("%d일", Int(minutes / 1440)) }
        if minutes >= 60 { return L("%d시간", Int(minutes / 60)) }
        return L("%d분", Int(minutes))
    }
    var resetText: String {
        guard let resetsAt else { return L("초기화 시간 미제공") }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale.autoupdatingCurrent
        formatter.unitsStyle = .abbreviated
        return L("%@ 초기화", formatter.localizedString(for: Date(timeIntervalSince1970: resetsAt), relativeTo: Date()))
    }
}
struct QuotaBucket: Decodable, Identifiable {
    var id: String
    var name: String
    var primary: QuotaWindow?
    var secondary: QuotaWindow?
    var blocked: Bool?
    var credits: String?
}
struct Account: Decodable, Identifiable {
    var id: String
    var label: String
    var isCurrent: Bool?
    var email: String?
    var plan: String?
    var status: String
    var limits: [QuotaBucket]
    var updatedAt: Double?
    var refreshing: Bool?
    var error: String?
    var ordinaryUsageAllowed: Bool?
    var loginURL: String?
    var userCode: String?
    var resetCredits: ResetCreditState?
    var displayName: String { email ?? L(label) }
    var planName: String {
        switch plan {
        case "pro": return "PRO"
        case "plus": return "PLUS"
        case "prolite": return "PRO LITE"
        case "team", "business", "self_serve_business_prolite", "self_serve_business_usage_based": return "BUSINESS"
        case "enterprise", "ent26": return "ENTERPRISE"
        case "free": return "FREE"
        case nil: return ""
        default: return plan!.uppercased()
        }
    }
}
struct ResetCreditState: Decodable {
    var availableCount: Int?
    var eligible: Bool?
    var pending: Bool?
    var outcome: String?
}
struct AppState: Decodable {
    var ready: Bool = false
    var enabled: Bool = false
    var selected: String = "current"
    var port: Int = 0
    var binaryAvailable: Bool = true
    var accounts: [Account] = []
    var activeRequests: Int = 0
    var totalRequests: Int = 0
    var lastError: String?
    var configConflict: Bool = false
    var demo: Bool = false
    var lastResponseAt: Double?
    var lastResponseAccount: String?
    var lastModel: String?
    var lastErrorAt: Double?
    var lastCodexRequestAt: Double?
    var lastProbeResponseAt: Double?
    var selectedName: String { accounts.first(where: { $0.id == selected })?.displayName ?? L("현재 Codex 계정") }
}

@MainActor final class AppModel: ObservableObject {
    @Published var state = AppState()
    @Published var error: String?
    @Published var busy = false
    @Published var loginAtStartup = false
    @Published var codexRunning = false
    @Published private(set) var panelHeight: CGFloat = 360
    private var process: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var requestID = 0
    private var quitting = false
    private var restartCount = 0
    private var lastRefresh = Date.distantPast
    var stateDidChange: (() -> Void)?
    func updatePanelHeight(_ height: CGFloat) {
        guard height.isFinite, height > 0, abs(panelHeight - height) > 1 else { return }
        panelHeight = height.rounded(.up)
        stateDidChange?()
    }
    func updateCodexStatus() {
        codexRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.openai.codex" }
    }

    init() {
        loginAtStartup = SMAppService.mainApp.status == .enabled
    }
    func start() {
        guard process == nil, let resources = Bundle.main.resourceURL else { return }
        let node = resources.appendingPathComponent("Runtime/node")
        let helper = resources.appendingPathComponent("Backend/main.mjs")
        let child = Process()
        child.executableURL = node
        var arguments = [helper.path]
        if CommandLine.arguments.contains("--demo") { arguments.append("--demo") }
        if let directory = CommandLine.arguments.first(where: { $0.hasPrefix("--state-directory=") }) { arguments.append(directory) }
        child.arguments = arguments
        let stdinPipe = Pipe(), stdoutPipe = Pipe()
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        input = stdinPipe.fileHandleForWriting
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.process = nil
                for continuation in self.pending.values { continuation.resume(throwing: self.failure(L("로컬 연결이 종료됐습니다."))) }
                self.pending.removeAll()
                guard !self.quitting else { return }
                self.state.ready = false
                if self.restartCount < 2 {
                    self.restartCount += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start() }
                } else { self.error = L("로컬 서비스를 다시 시작하지 못했습니다. 앱을 다시 열어 주세요.") }
            }
        }
        do { try child.run(); process = child } catch { self.error = L("내장 실행 환경을 시작하지 못했습니다.") }
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "CodexSwitch", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func receive(_ data: Data) {
        outputBuffer.append(data)
        while let end = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer[..<end]
            outputBuffer.removeSubrange(...end)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if message["event"] as? String == "state", let object = message["data"],
               let data = try? JSONSerialization.data(withJSONObject: object), let state = try? JSONDecoder().decode(AppState.self, from: data) {
                self.state = state
                stateDidChange?()
            } else if let id = message["id"] as? Int, let continuation = pending.removeValue(forKey: id) {
                if let error = message["error"] as? String { continuation.resume(throwing: failure(error)) }
                else { continuation.resume(returning: message["result"] as? [String: Any] ?? [:]) }
            }
        }
    }
    func request(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        guard process?.isRunning == true, let input else { throw failure(L("로컬 서비스가 준비되지 않았습니다.")) }
        requestID += 1
        let id = requestID
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
                data.append(10)
                try input.write(contentsOf: data)
            } catch { pending.removeValue(forKey: id)?.resume(throwing: failure(L("로컬 서비스에 연결하지 못했습니다."))) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 65) { [weak self] in
                guard let self else { return }
                self.pending.removeValue(forKey: id)?.resume(throwing: self.failure(L("응답이 늦어지고 있습니다. 다시 시도해 주세요.")))
            }
        }
    }
    func command(_ method: String, _ params: [String: Any] = [:]) {
        Task {
            busy = true
            defer { busy = false }
            do { _ = try await request(method, params) } catch { self.error = error.localizedDescription }
        }
    }
    func refreshIfNeeded() {
        updateCodexStatus()
        guard state.ready else { return }
        if Date().timeIntervalSince(lastRefresh) > 60 { lastRefresh = Date(); command("refresh") }
    }
    func login(device: Bool = false) {
        Task {
            busy = true
            defer { busy = false }
            do {
                let response = try await request("login", ["mode": device ? "device" : "chatgpt"])
                if let text = response["url"] as? String, let url = URL(string: text) { openLoginURL(url) }
                if let code = response["userCode"] as? String { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string) }
            } catch { self.error = error.localizedDescription }
        }
    }
    func openLoginURL(_ url: URL) {
        guard url.scheme == "https", ["auth.openai.com", "chatgpt.com", "openai.com"].contains(url.host ?? "") else { error = L("로그인 주소를 확인하지 못했습니다."); return }
        NSWorkspace.shared.open(url)
    }
    func remove(_ account: Account) {
        let alert = NSAlert()
        alert.messageText = L("이 앱에서 계정을 제거할까요?")
        alert.informativeText = L("%@의 로그인 정보를 Codex Switch에서 제거합니다.", account.displayName)
        alert.addButton(withTitle: L("제거"))
        alert.addButton(withTitle: L("취소"))
        if alert.runModal() == .alertFirstButtonReturn { command("remove", ["id": account.id]) }
    }
    func useResetCredit(_ account: Account) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let preview = try await request("prepareReset", ["id": account.id])
                guard let token = preview["token"] as? String, let email = preview["email"] as? String else {
                    throw failure(L("리셋할 계정 정보를 확인하지 못했습니다. 새로고침해 주세요."))
                }
                let retry = preview["retry"] as? Bool == true
                let alert = NSAlert()
                alert.messageText = retry ? L("이전 리셋 결과를 확인할까요?") : L("리셋권 1개를 사용할까요?")
                alert.informativeText = retry
                    ? L("%@ 계정의 이전 요청을 같은 번호로 다시 시도합니다. 아직 처리되지 않았다면 리셋권 1개가 사용될 수 있습니다. 이미 처리됐다면 추가로 사용하지 않습니다.", email)
                    : L("%@ 계정의 리셋권 1개를 소모해 사용 가능한 기본 한도를 초기화합니다. 이 사용은 되돌릴 수 없습니다.", email)
                // Return cancels. Spending a credit needs an explicit choice.
                alert.addButton(withTitle: L("취소")).keyEquivalent = "\r"
                alert.addButton(withTitle: retry ? L("결과 확인") : L("1개 사용")).keyEquivalent = ""
                alert.window.defaultButtonCell = alert.buttons[0].cell as? NSButtonCell
                alert.window.initialFirstResponder = alert.buttons[0]
                guard alert.runModal() == .alertSecondButtonReturn else {
                    _ = try? await request("cancelReset", ["token": token]); return
                }
                _ = try await request("consumeReset", ["id": account.id, "token": token])
            } catch { self.error = error.localizedDescription }
        }
    }
    func setLoginAtStartup(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginAtStartup = SMAppService.mainApp.status == .enabled
            if enabled && !loginAtStartup { SMAppService.openSystemSettingsLoginItems() }
        } catch { self.error = L("로그인 시 실행을 설정하지 못했습니다. 앱을 응용 프로그램 폴더에 넣은 뒤 다시 시도해 주세요.") }
    }
    func quit() {
        if state.enabled || state.activeRequests > 0 {
            let alert = NSAlert()
            alert.messageText = L("Codex 연결을 해제하고 종료할까요?")
            alert.informativeText = state.activeRequests > 0
                ? L("진행 중인 요청 %d개가 중단될 수 있습니다. 종료 후 Codex를 다시 시작하면 원래 연결로 돌아갑니다.", state.activeRequests)
                : L("원래 Codex 설정을 복원합니다. 종료 후 Codex를 다시 시작해 주세요.")
            alert.addButton(withTitle: L("해제하고 종료"))
            alert.addButton(withTitle: L("취소"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        quitting = true
        Task {
            do { _ = try await request("disable") } catch {
                quitting = false
                self.error = L("연결 설정을 복원하지 못했습니다. 설정 충돌을 확인한 뒤 종료해 주세요.")
                return
            }
            try? input?.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
        }
    }
    func terminateHelper() { quitting = true; try? input?.close(); process?.terminate() }
}

enum BrandAssets {
    static let icon: NSImage = {
        guard let url = Bundle.main.url(forResource: "BrandIcon", withExtension: "png"), let image = NSImage(contentsOf: url) else { return NSImage() }
        return image
    }()
    static func menuIcon() -> NSImage {
        guard let url = Bundle.main.url(forResource: "MenuMark", withExtension: "png"), let image = NSImage(contentsOf: url) else { return icon }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        image.accessibilityDescription = "Codex Switch"
        return image
    }
}


@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let model = AppModel()
    var statusItem: NSStatusItem!
    let popover = NSPopover()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.codex-switch").filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !CommandLine.arguments.contains("--demo"), let other = others.first { other.activate(); NSApp.terminate(nil); return }
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = BrandAssets.menuIcon()
            button.setAccessibilityLabel("Codex Switch")
            button.toolTip = "Codex Switch"
            button.target = self
            button.action = #selector(togglePopover)
        }
        popover.behavior = .transient
        popover.delegate = self
        popover.contentSize = NSSize(width: 360, height: model.panelHeight)
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model))
        model.stateDidChange = { [weak self] in
            guard let self else { return }
            self.statusItem.button?.toolTip = self.model.state.enabled ? "Codex Switch · \(self.model.state.selectedName)" : L("Codex Switch · 연결 꺼짐")
            self.popover.contentSize = NSSize(width: 360, height: self.model.panelHeight)
        }
        model.start()
        if CommandLine.arguments.contains("--show-popover") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showPopover() }
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPopover(); return false }
    func popoverDidShow(_ notification: Notification) {
        // Opening the panel should not preselect a button. Tab can still enter
        // the normal key-view loop and display its keyboard focus indicator.
        popover.contentViewController?.view.window?.makeFirstResponder(nil)
    }
    @objc func togglePopover() {
        if popover.isShown { popover.performClose(nil) }
        else { showPopover() }
    }
    private func showPopover() {
        if !popover.isShown, let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
        popover.contentViewController?.view.window?.makeFirstResponder(nil)
        model.refreshIfNeeded()
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { model.terminateHelper(); return .terminateNow }
}

@main struct CodexSwitchMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
