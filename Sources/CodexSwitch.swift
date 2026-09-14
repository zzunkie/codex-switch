import AppKit
import SwiftUI
import ServiceManagement

struct QuotaWindow: Decodable {
    var usedPercent: Double
    var remainingPercent: Double
    var durationMins: Double?
    var resetsAt: Double?
    var title: String {
        guard let minutes = durationMins else { return "사용 한도" }
        if minutes == 10080 { return "주간" }
        if minutes >= 1440 { return "\(Int(minutes / 1440))일" }
        if minutes >= 60 { return "\(Int(minutes / 60))시간" }
        return "\(Int(minutes))분"
    }
    var resetText: String {
        guard let resetsAt else { return "초기화 시간 미제공" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: Date(timeIntervalSince1970: resetsAt), relativeTo: Date()) + " 초기화"
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
    var displayName: String { email ?? label }
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
    var selectedName: String { accounts.first(where: { $0.id == selected })?.displayName ?? "현재 Codex 계정" }
}

@MainActor final class AppModel: ObservableObject {
    @Published var state = AppState()
    @Published var error: String?
    @Published var busy = false
    @Published var loginAtStartup = false
    @Published var codexRunning = false
    @Published var expandedAccounts: Set<String> = []
    private var process: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var requestID = 0
    private var quitting = false
    private var restartCount = 0
    private var lastRefresh = Date.distantPast
    var stateDidChange: (() -> Void)?
    var panelHeight: CGFloat {
        let accountHeight = state.accounts.reduce(0) { height, account in
            let details = expandedAccounts.contains(account.id) ? max(0, account.limits.count - 1) * 76 + 8 : 0
            let exceptional = account.status == "loggingIn" ? 48 : (account.error == nil && account.ordinaryUsageAllowed != false ? 0 : 24)
            return height + 112 + details + exceptional
        }
        let errorHeight: Int = (error ?? state.lastError) == nil ? 0 : 46
        return min(640, (NSScreen.main?.visibleFrame.height ?? 800) - 36, CGFloat(172 + max(108, accountHeight) + errorHeight))
    }
    func updateCodexStatus() {
        codexRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.openai.codex" }
    }
    func toggleDetails(_ id: String) {
        if expandedAccounts.contains(id) { expandedAccounts.remove(id) } else { expandedAccounts.insert(id) }
        stateDidChange?()
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
                for continuation in self.pending.values { continuation.resume(throwing: self.failure("로컬 연결이 종료됐습니다.")) }
                self.pending.removeAll()
                guard !self.quitting else { return }
                self.state.ready = false
                if self.restartCount < 2 {
                    self.restartCount += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.start() }
                } else { self.error = "로컬 서비스를 다시 시작하지 못했습니다. 앱을 다시 열어 주세요." }
            }
        }
        do { try child.run(); process = child } catch { self.error = "내장 실행 환경을 시작하지 못했습니다." }
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
        guard process?.isRunning == true, let input else { throw failure("로컬 서비스가 준비되지 않았습니다.") }
        requestID += 1
        let id = requestID
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
                data.append(10)
                try input.write(contentsOf: data)
            } catch { pending.removeValue(forKey: id)?.resume(throwing: failure("로컬 서비스에 연결하지 못했습니다.")) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 65) { [weak self] in
                guard let self else { return }
                self.pending.removeValue(forKey: id)?.resume(throwing: self.failure("응답이 늦어지고 있습니다. 다시 시도해 주세요."))
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
        guard url.scheme == "https", ["auth.openai.com", "chatgpt.com", "openai.com"].contains(url.host ?? "") else { error = "로그인 주소를 확인하지 못했습니다."; return }
        NSWorkspace.shared.open(url)
    }
    func remove(_ account: Account) {
        let alert = NSAlert()
        alert.messageText = "이 앱에서 계정을 제거할까요?"
        alert.informativeText = "\(account.displayName)의 로그인 정보를 Codex Switch에서 제거합니다."
        alert.addButton(withTitle: "제거")
        alert.addButton(withTitle: "취소")
        if alert.runModal() == .alertFirstButtonReturn { command("remove", ["id": account.id]) }
    }
    func setLoginAtStartup(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginAtStartup = SMAppService.mainApp.status == .enabled
            if enabled && !loginAtStartup { SMAppService.openSystemSettingsLoginItems() }
        } catch { self.error = "로그인 시 실행을 설정하지 못했습니다. 앱을 응용 프로그램 폴더에 넣은 뒤 다시 시도해 주세요." }
    }
    func quit() {
        if state.enabled || state.activeRequests > 0 {
            let alert = NSAlert()
            alert.messageText = "Codex 연결을 해제하고 종료할까요?"
            alert.informativeText = state.activeRequests > 0
                ? "진행 중인 요청 \(state.activeRequests)개가 중단될 수 있습니다. 종료 후 Codex를 다시 시작하면 원래 연결로 돌아갑니다."
                : "원래 Codex 설정을 복원합니다. 종료 후 Codex를 다시 시작해 주세요."
            alert.addButton(withTitle: "해제하고 종료")
            alert.addButton(withTitle: "취소")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        quitting = true
        Task {
            do { _ = try await request("disable") } catch {
                quitting = false
                self.error = "연결 설정을 복원하지 못했습니다. 설정 충돌을 확인한 뒤 종료해 주세요."
                return
            }
            try? input?.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
        }
    }
    func terminateHelper() { quitting = true; try? input?.close(); process?.terminate() }
}

private enum Palette {
    static let graphite = Color(red: 0.075, green: 0.12, blue: 0.11)
    static let ivory = Color(red: 0.96, green: 0.95, blue: 0.90)
    static let jade = Color(red: 0.59, green: 0.86, blue: 0.75)
    static let secondary = Color(red: 0.81, green: 0.86, blue: 0.82)
    static let muted = Color(red: 0.52, green: 0.63, blue: 0.58)
    static let amber = Color(red: 0.96, green: 0.75, blue: 0.44)
    static let coral = Color(red: 1.0, green: 0.58, blue: 0.54)
}
private let accent = Palette.jade
private let hairline = Palette.ivory.opacity(0.10)

// One native backdrop for the whole panel; cards share it instead of each
// running a separate blur. Accessibility settings can remove transparency.
private struct NativeGlass: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        view.appearance = NSAppearance(named: .darkAqua)
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

private struct PanelGlass: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        ZStack {
            if reduceTransparency { Palette.graphite }
            else {
                NativeGlass()
                Palette.graphite.opacity(0.60)
                LinearGradient(colors: [Palette.jade.opacity(0.17), .clear, Color.black.opacity(0.12)],
                               startPoint: .topTrailing, endPoint: .bottomLeading)
                // A broad reflection and a fine inner rim suggest polished
                // glass without another blur, image capture, or moving shader.
                LinearGradient(stops: [
                    .init(color: Palette.ivory.opacity(0.15), location: 0),
                    .init(color: Palette.ivory.opacity(0.045), location: 0.28),
                    .init(color: .clear, location: 0.29),
                    .init(color: .clear, location: 1)
                ], startPoint: .topLeading, endPoint: .bottomTrailing)
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(LinearGradient(colors: [Palette.ivory.opacity(0.58), Palette.ivory.opacity(0.04), Palette.jade.opacity(0.24)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
            }
        }.allowsHitTesting(false)
    }
}

private struct CardGlass: View {
    var active: Bool
    var hover: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        let rim = contrast == .increased ? 0.70 : 0.48
        ZStack {
            if reduceTransparency { shape.fill(Palette.graphite) }
            shape.fill(LinearGradient(
                colors: [active ? Palette.jade.opacity(0.11) : Palette.ivory.opacity(hover ? 0.07 : 0.035),
                         Color.black.opacity(active ? 0.025 : 0.045)],
                startPoint: .topLeading, endPoint: .bottomTrailing))
            shape.strokeBorder(LinearGradient(
                stops: [
                    .init(color: active ? Palette.jade.opacity(0.80) : Palette.ivory.opacity(rim), location: 0),
                    .init(color: Palette.ivory.opacity(0.08), location: 0.40),
                    .init(color: Color.black.opacity(0.18), location: 0.65),
                    .init(color: active ? Palette.jade.opacity(0.30) : Palette.ivory.opacity(0.20), location: 1)
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
            shape.inset(by: 1).strokeBorder(LinearGradient(colors: [Palette.ivory.opacity(0.13), .clear],
                                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
        }.allowsHitTesting(false)
    }
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

struct IconButton: View {
    var symbol: String
    var title: String
    var action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .medium))
                .foregroundStyle(Palette.secondary).frame(width: 26, height: 26)
                .background(hover ? Palette.ivory.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).onHover { hover = $0 }.help(title).accessibilityLabel(title)
    }
}

struct QuotaView: View {
    var window: QuotaWindow
    var compact = false
    var emphasized = true
    var tint: Color { window.remainingPercent <= 10 ? Palette.coral : window.remainingPercent <= 25 ? Palette.amber : emphasized ? accent : Palette.secondary }
    var exactReset: String {
        guard let time = window.resetsAt else { return "초기화 시간 미제공" }
        let f = DateFormatter(); f.locale = Locale(identifier: "ko_KR"); f.dateFormat = "M/d HH:mm"
        return f.string(from: Date(timeIntervalSince1970: time)) + " 초기화"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.title).font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.secondary)
                Spacer(minLength: 3)
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text("\(Int(window.remainingPercent))").font(.system(size: compact ? 13 : 16, weight: .semibold, design: .rounded)).monospacedDigit()
                    Text("%").font(.system(size: 11, weight: .medium))
                }.foregroundStyle(tint)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.ivory.opacity(0.08))
                    Capsule().fill(tint).frame(width: max(0, geometry.size.width * min(100, max(0, window.remainingPercent)) / 100))
                }
            }.frame(height: 3)
            Text(exactReset).font(.system(size: 10)).foregroundStyle(Palette.secondary).lineLimit(1).minimumScaleFactor(0.8)
        }.help(window.resetText)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.title), \(Int(window.remainingPercent))퍼센트 남음, \(exactReset)")
    }
}

struct AccountCard: View {
    @ObservedObject var model: AppModel
    var account: Account
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hover = false
    var selected: Bool { model.state.selected == account.id }
    var effective: Bool { model.state.enabled ? selected : account.isCurrent == true }
    var bucket: QuotaBucket? { account.limits.first(where: { $0.id == "codex" }) ?? account.limits.first }
    var expanded: Bool { model.expandedAccounts.contains(account.id) }
    var selectionDisabled: Bool { model.busy || account.status == "loggingIn" || (account.status == "signedOut" && account.isCurrent != true) }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 3) {
                    Button { model.command("select", ["id": account.id]) } label: {
                        Text(account.displayName).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                            .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(selectionDisabled)
                        .help("이 계정으로 요청").accessibilityLabel("\(account.displayName) 선택")
                        .accessibilityIdentifier("account-name-\(account.id)")
                    HStack(spacing: 6) {
                        if !account.planName.isEmpty {
                            Text(account.planName).font(.system(size: 9, weight: .semibold)).tracking(0.3)
                                .padding(.horizontal, 4).padding(.vertical, 2)
                                .background(Palette.ivory.opacity(0.07), in: RoundedRectangle(cornerRadius: 3))
                        }
                        if account.isCurrent == true { Text("Codex 로그인").font(.system(size: 10)) }
                        if effective { Text("요청 계정").font(.system(size: 10, weight: .medium)).foregroundStyle(accent) }
                        else if selected { Text("선택됨").font(.system(size: 10)).foregroundStyle(accent) }
                        if account.limits.count > 1 {
                            Spacer(minLength: 0)
                            Button {
                                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) { model.toggleDetails(account.id) }
                            } label: {
                                HStack(spacing: 3) {
                                    Text("모델별 한도").font(.system(size: 10))
                                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                                        .rotationEffect(.degrees(expanded ? 180 : 0))
                                }.fixedSize().frame(minHeight: 18).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityLabel("\(account.displayName) 모델별 한도 \(expanded ? "접기" : "펼치기")")
                        }
                    }.foregroundStyle(Palette.secondary)
                }
                Spacer(minLength: 0)
                if account.refreshing == true { ProgressView().controlSize(.mini) }
                if account.status != "loggingIn" {
                    Button { model.command("select", ["id": account.id]) } label: {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(selected ? accent : Palette.secondary.opacity(hover ? 0.7 : 0.3))
                            .frame(width: 26, height: 26).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(selectionDisabled)
                        .accessibilityLabel("\(account.displayName) 선택").accessibilityIdentifier("route-\(account.id)")
                }
                if account.isCurrent != true && account.status != "loggingIn" {
                    Menu { Button("계정 제거…", role: .destructive) { model.remove(account) } }
                        label: { Image(systemName: "ellipsis").font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 20, height: 26)
                }
            }
            if account.status == "loggingIn" {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("로그인 대기").font(.system(size: 11)) }
                    if let code = account.userCode { Text(code).font(.system(size: 13, weight: .medium, design: .monospaced)).textSelection(.enabled) }
                    HStack {
                        if let text = account.loginURL, let url = URL(string: text) { Button("로그인 열기") { model.openLoginURL(url) }.controlSize(.small) }
                        Button("취소") { model.command("cancelLogin") }.controlSize(.small)
                    }
                }
            } else if let bucket {
                HStack(alignment: .top, spacing: 14) {
                    if let primary = bucket.primary { QuotaView(window: primary, emphasized: effective) }
                    if let secondary = bucket.secondary { QuotaView(window: secondary, emphasized: effective) }
                }
                if bucket.primary == nil && bucket.secondary == nil {
                    Text(bucket.credits.map { "크레딧 \($0)" } ?? "한도 정보 없음").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                }
                if expanded {
                    VStack(spacing: 10) {
                        ForEach(account.limits.filter { $0.id != bucket.id }) { extra in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(extra.name).font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.secondary)
                                HStack(spacing: 14) { if let w = extra.primary { QuotaView(window: w, compact: true, emphasized: effective) }; if let w = extra.secondary { QuotaView(window: w, compact: true, emphasized: effective) } }
                            }
                        }
                    }.padding(.top, 2).transition(.opacity)
                }
            } else {
                Text(account.status == "loading" || account.status == "idle" ? "사용량 조회 중…" : account.error ?? "사용량 미확인")
                    .font(.system(size: 11)).foregroundStyle(Palette.secondary).padding(.vertical, 8)
            }
            if account.ordinaryUsageAllowed == false { Text("한도 소진").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.amber) }
            if let error = account.error, !account.limits.isEmpty { Text(error).font(.system(size: 10)).foregroundStyle(Palette.amber) }

        }
        .padding(10)
        .background(CardGlass(active: effective, hover: hover))
        .onHover { hover = $0 }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hover)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: effective)
        .accessibilityIdentifier("account-\(account.id)")
    }
}

struct ConnectionView: View {
    @ObservedObject var model: AppModel
    var verified: Bool { model.state.lastResponseAt != nil && model.state.lastResponseAccount == model.state.selected }
    var status: String {
        if !model.state.ready { return "프록시 시작 중" }
        if model.state.lastError != nil { return "요청 오류" }
        if !model.state.enabled { return "기본 연결" }
        if model.state.activeRequests > 0 { return "요청 \(model.state.activeRequests)개 처리 중" }
        if model.state.lastCodexRequestAt == nil { return "Codex 연결 대기" }
        return verified ? "응답 확인" : "응답 미확인"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Circle().fill(model.codexRunning ? accent : Palette.muted).frame(width: 5, height: 5)
                Text(model.codexRunning ? "Codex 실행 중" : "Codex 종료됨").font(.system(size: 11, weight: .medium))
                Spacer()
                Text("라우팅").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                Toggle("계정 라우팅", isOn: Binding(get: { model.state.enabled }, set: { model.command($0 ? "enable" : "disable") }))
                    .toggleStyle(.switch).labelsHidden().controlSize(.mini).tint(accent)
                    .disabled(!model.state.ready || model.busy).accessibilityLabel("계정 라우팅")
            }
            HStack(spacing: 6) {
                Text(status).font(.system(size: 10, weight: .medium))
                    .foregroundStyle(model.state.lastError != nil ? Palette.amber : Palette.secondary)
                if let modelName = model.state.lastModel, model.state.enabled && verified {
                    Text("·").foregroundStyle(Palette.muted)
                    Text(modelName).font(.system(size: 10)).foregroundStyle(Palette.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        }.padding(.horizontal, 11).padding(.vertical, 8)
        .background(Palette.graphite.opacity(0.30), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(hairline, lineWidth: 1))
        .help(model.state.enabled && model.state.lastCodexRequestAt == nil ? "아직 Codex 요청이 없습니다. 처음 연결했다면 Codex를 재시작해 주세요." : verified ? "최근 응답 \(Date(timeIntervalSince1970: model.state.lastResponseAt ?? 0).formatted(date: .omitted, time: .shortened))" : "모델 응답 미확인")
    }
}

struct PanelView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Image(nsImage: BrandAssets.icon).resizable().interpolation(.high).frame(width: 24, height: 24).accessibilityLabel("Codex Switch 로고")
                Text("Codex Switch").font(.system(size: 13, weight: .semibold))
                if model.state.demo { Text("DEMO").font(.system(size: 8, weight: .semibold)).foregroundStyle(Palette.amber) }
                Spacer()
                if model.busy { ProgressView().controlSize(.small).frame(width: 26, height: 26) }
                else { IconButton(symbol: "arrow.clockwise", title: "사용량 새로고침") { model.updateCodexStatus(); model.command("refresh") }.disabled(!model.state.ready) }
                Menu {
                    Toggle("Mac 로그인 시 실행", isOn: Binding(get: { model.loginAtStartup }, set: { model.setLoginAtStartup($0) }))
                    Divider()
                    Button("종료…") { model.quit() }
                } label: { Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.secondary).frame(width: 26, height: 26) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 26).accessibilityLabel("설정")
            }.padding(.horizontal, 12).padding(.vertical, 9)
            ConnectionView(model: model).padding(.horizontal, 10)
            if let message = model.error ?? model.state.lastError {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(Palette.amber)
                    Text(message).font(.system(size: 10)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button { model.error = nil; model.command("dismissError"); model.stateDidChange?() } label: { Image(systemName: "xmark").font(.system(size: 9)) }.buttonStyle(.plain).accessibilityLabel("오류 닫기")
                }.padding(10).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8)).padding(.horizontal, 10).padding(.top, 6)
            }
            HStack(spacing: 5) {
                Text("계정").font(.system(size: 11, weight: .semibold))
                Text("\(model.state.accounts.filter { $0.status != "loggingIn" }.count)").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted)
                Spacer()
                Text("남은 한도").font(.system(size: 10)).foregroundStyle(Palette.secondary)
            }.padding(.horizontal, 13).padding(.top, 10).padding(.bottom, 6)
            ScrollView {
                VStack(spacing: 6) {
                    if model.state.accounts.isEmpty { ProgressView().controlSize(.small).padding(35) }
                    ForEach(model.state.accounts) { AccountCard(model: model, account: $0) }
                }.padding(.horizontal, 10).padding(.bottom, 8)
            }.frame(maxHeight: .infinity)
            Rectangle().fill(hairline).frame(height: 1)
            HStack {
                Menu {
                    Button("브라우저로 로그인") { model.login() }
                    Button("기기 코드로 로그인") { model.login(device: true) }
                } label: { Label("계정 추가", systemImage: "plus").font(.system(size: 11, weight: .medium)).foregroundStyle(accent) }
                    primaryAction: { model.login() }
                    .menuStyle(.borderlessButton).fixedSize().disabled(model.busy || model.state.accounts.contains { $0.status == "loggingIn" })
                Spacer()
                if let updated = model.state.accounts.compactMap({ $0.updatedAt }).max() {
                    Text("\(Date(timeIntervalSince1970: updated).formatted(date: .omitted, time: .shortened)) 갱신")
                        .font(.system(size: 10)).foregroundStyle(Palette.secondary)
                        .help(model.state.ready ? "로컬 프록시 실행 중" : "로컬 프록시 중지됨")
                }

            }.padding(.horizontal, 13).padding(.vertical, 9)
        }
        .frame(width: 348, height: model.panelHeight)
        .foregroundStyle(Palette.ivory)
        .background(PanelGlass())
        .preferredColorScheme(.dark)
        .onAppear { model.refreshIfNeeded() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in model.updateCodexStatus() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in model.updateCodexStatus() }
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
        popover.appearance = NSAppearance(named: .darkAqua)
        popover.delegate = self
        popover.contentSize = NSSize(width: 348, height: model.panelHeight)
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model))
        model.stateDidChange = { [weak self] in
            guard let self else { return }
            self.statusItem.button?.toolTip = self.model.state.enabled ? "Codex Switch · \(self.model.state.selectedName)" : "Codex Switch · 연결 꺼짐"
            self.popover.contentSize = NSSize(width: 348, height: self.model.panelHeight)
        }
        model.start()
        if CommandLine.arguments.contains("--show-popover") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.togglePopover() }
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { togglePopover(); return false }
    func popoverDidShow(_ notification: Notification) {
        // Opening the panel should not preselect a button. Tab can still enter
        // the normal key-view loop and display its keyboard focus indicator.
        popover.contentViewController?.view.window?.makeFirstResponder(nil)
    }
    @objc func togglePopover() {
        if popover.isShown { popover.performClose(nil) }
        else if let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            popover.contentViewController?.view.window?.makeKey()
            popover.contentViewController?.view.window?.makeFirstResponder(nil)
            model.refreshIfNeeded()
        }
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
