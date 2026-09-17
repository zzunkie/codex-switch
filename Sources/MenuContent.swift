import AppKit
import SwiftUI

// Compatibility wrappers contain no custom paint or hover handling. Native
// controls own their appearance, contrast, and motion on supported systems.
private struct SystemGlassSurface: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
#if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.glassEffect(in: .rect(cornerRadius: 16))
        } else {
            content.background(.regularMaterial, in: .rect(cornerRadius: 16))
        }
#else
        content.background(.regularMaterial, in: .rect(cornerRadius: 16))
#endif
    }
}

private struct SystemActionStyle: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
#if compiler(>=6.2)
        if #available(macOS 26.0, *) { content.buttonStyle(.glass) }
        else { content.buttonStyle(.bordered) }
#else
        content.buttonStyle(.bordered)
#endif
    }
}

private struct SystemGlassGroup<Content: View>: View {
    var content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    @ViewBuilder var body: some View {
#if compiler(>=6.2)
        if #available(macOS 26.0, *) { GlassEffectContainer(spacing: 0) { content } }
        else { content }
#else
        content
#endif
    }
}

private extension QuotaWindow {
    var resetDateText: String {
        guard let resetsAt else { return L("초기화 시간 미제공") }
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("Mdjm")
        return L("%@ 초기화", formatter.string(from: Date(timeIntervalSince1970: resetsAt)))
    }
    var displayPercent: String { (remainingPercent / 100).formatted(.percent.precision(.fractionLength(0))) }
}

private struct UsageMeter: View {
    var window: QuotaWindow
    var active: Bool
    private var color: Color {
        window.remainingPercent <= 10 ? .red : window.remainingPercent <= 25 ? .orange : active ? .accentColor : .secondary
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(window.title).font(.caption)
                Spacer()
                Text(window.displayPercent).fontWeight(.semibold).monospacedDigit()
            }
            ProgressView(value: window.remainingPercent, total: 100)
                .progressViewStyle(.linear).tint(color)
            Text(window.resetDateText).font(.caption2).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
        }
        .help(window.resetText)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("%@, %d퍼센트 남음, %@", window.title, Int(window.remainingPercent), window.resetDateText))
    }
}

private struct AccountSection: View {
    @ObservedObject var model: AppModel
    var account: Account
    private var selected: Bool { model.state.selected == account.id }
    private var active: Bool { model.state.enabled ? selected : account.isCurrent == true }
    private var bucket: QuotaBucket? { account.limits.first { $0.id == "codex" } ?? account.limits.first }
    private var metadata: String {
        [account.planName, account.isCurrent == true ? L("Codex 로그인") : "",
         active ? L("요청 계정") : selected ? L("선택됨") : ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private var selectionDisabled: Bool {
        model.busy || account.status == "loggingIn" || (account.status == "signedOut" && account.isCurrent != true)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { model.command("select", ["id": account.id]) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.displayName).font(.headline).lineLimit(1).truncationMode(.middle)
                            Text(metadata).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .imageScale(.large).foregroundStyle(selected ? Color.accentColor : .secondary)
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.borderless).disabled(selectionDisabled)
                .accessibilityLabel(L("%@ 선택", account.displayName))
                if account.refreshing == true { ProgressView().controlSize(.mini) }
                if account.isCurrent != true && account.status != "loggingIn" {
                    Menu("…") {
                        Button(L("계정 제거…"), role: .destructive) { model.remove(account) }
                    }
                    .menuIndicator(.hidden).fixedSize().disabled(model.busy)
                    .accessibilityLabel(L("계정 제거…"))
                }
            }
            if account.status == "loggingIn" {
                Label(L("로그인 대기"), systemImage: "person.crop.circle.badge.clock")
                if let code = account.userCode { Text(code).monospaced().textSelection(.enabled) }
                HStack {
                    if let text = account.loginURL, let url = URL(string: text) {
                        Button(L("로그인 열기")) { model.openLoginURL(url) }
                    }
                    Button(L("취소")) { model.command("cancelLogin") }
                }
            } else {
                if let bucket {
                    HStack(alignment: .top, spacing: 16) {
                        if let window = bucket.primary { UsageMeter(window: window, active: active) }
                        if let window = bucket.secondary { UsageMeter(window: window, active: active) }
                    }
                    if bucket.primary == nil && bucket.secondary == nil {
                        Text(bucket.credits.map { L("크레딧 %@", L($0)) } ?? L("한도 정보 없음")).foregroundStyle(.secondary)
                    }
                } else {
                    Text(account.status == "loading" || account.status == "idle" ? L("사용량 조회 중…") : L("사용량 미확인"))
                        .foregroundStyle(.secondary)
                }
                ResetActions(model: model, account: account, mainBucket: bucket?.id)
            }
            if account.ordinaryUsageAllowed == false {
                Label(L("한도 소진"), systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
            }
            if let error = account.error {
                Text(L(error)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .modifier(SystemGlassSurface())
        .accessibilityIdentifier("account-\(account.id)")
    }
}

private struct ResetActions: View {
    @ObservedObject var model: AppModel
    var account: Account
    var mainBucket: String?
    private var pending: Bool { account.resetCredits?.pending == true }
    private var available: Bool { pending || ((account.resetCredits?.availableCount ?? 0) > 0 && account.resetCredits?.eligible == true) }
    private var help: String {
        if pending { return L("응답이 확인되지 않은 이전 리셋 요청을 다시 확인합니다.") }
        if account.resetCredits?.availableCount == nil { return L("리셋권 정보를 확인하지 못했습니다. Codex 업데이트 또는 새로고침이 필요합니다.") }
        if account.resetCredits?.availableCount == 0 { return L("사용할 리셋권이 없습니다.") }
        return L("기본 5시간 또는 주간 한도가 10% 이하로 남았을 때 사용할 수 있습니다.")
    }
    private var result: String? {
        switch account.resetCredits?.outcome {
        case "reset": return L("초기화 완료")
        case "alreadyRedeemed": return L("처리 완료 확인")
        case "noCredit": return L("리셋권 없음")
        case "nothingToReset": return L("초기화 불필요")
        default: return nil
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(account.resetCredits?.availableCount.map { L("리셋권 %d개", $0) } ?? L("리셋권 미확인"), systemImage: "ticket")
                    .font(.caption).foregroundStyle(.secondary).help(help)
                Spacer(minLength: 4)
                if account.limits.count > 1 {
                    Menu(L("모델별 한도")) {
                        ForEach(account.limits.filter { $0.id != mainBucket }) { extra in
                            Section(extra.name) {
                                ForEach([extra.primary, extra.secondary].compactMap { $0 }.indices, id: \.self) { index in
                                    let window = [extra.primary, extra.secondary].compactMap { $0 }[index]
                                    Text("\(window.title) · \(window.displayPercent)")
                                    Text(window.resetDateText)
                                }
                            }
                        }
                    }.fixedSize().font(.caption)
                }
                Button(pending ? L("결과 확인") : L("사용…")) { model.useResetCredit(account) }
                    .help(help)
                    .disabled(!available || model.busy || account.refreshing == true || account.status != "ready")
                    .accessibilityLabel(pending ? L("%@ 리셋 결과 확인", account.displayName) : L("%@ 리셋권 사용", account.displayName))
            }
            if let result { Text(result).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

private struct ConnectionSummary: View {
    @ObservedObject var model: AppModel
    private var verified: Bool { model.state.lastResponseAt != nil && model.state.lastResponseAccount == model.state.selected }
    private var status: String {
        if !model.state.ready { return L("프록시 시작 중") }
        if model.state.lastError != nil { return L("요청 오류") }
        if !model.state.enabled { return L("기본 연결") }
        if model.state.activeRequests > 0 { return L("요청 %d개 처리 중", model.state.activeRequests) }
        if model.state.lastCodexRequestAt == nil { return L("Codex 연결 대기") }
        return verified ? L("응답 확인") : L("응답 미확인")
    }
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("계정 라우팅")).font(.headline)
                Text([model.codexRunning ? L("Codex 실행 중") : L("Codex 종료됨"), status, verified ? model.state.lastModel ?? "" : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Toggle(L("계정 라우팅"), isOn: Binding(get: { model.state.enabled }, set: { model.command($0 ? "enable" : "disable") }))
                .labelsHidden().toggleStyle(.switch).disabled(!model.state.ready || model.busy)
        }
        .padding(12).modifier(SystemGlassSurface())
    }
}

private enum MenuArea: Hashable { case top, accounts, footer, panel }
private struct MenuMeasurements: PreferenceKey {
    static var defaultValue: [MenuArea: CGFloat] { [:] }
    static func reduce(value: inout [MenuArea: CGFloat], nextValue: () -> [MenuArea: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}
private extension View {
    func measured(_ area: MenuArea) -> some View {
        background { GeometryReader { proxy in Color.clear.preference(key: MenuMeasurements.self, value: [area: proxy.size.height]) } }
    }
}

struct PanelView: View {
    @ObservedObject var model: AppModel
    @State private var sizes: [MenuArea: CGFloat] = [:]
    private var listHeight: CGFloat {
        let maximum = min(640, (NSScreen.main?.visibleFrame.height ?? 800) - 40)
        return min(sizes[.accounts] ?? 160, max(100, maximum - (sizes[.top] ?? 130) - (sizes[.footer] ?? 40) - 40))
    }
    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 8) {
                HStack {
                    Image(nsImage: BrandAssets.icon).resizable().frame(width: 24, height: 24).accessibilityLabel(L("Codex Switch 로고"))
                    Text("Codex Switch").font(.headline)
                    if model.state.demo { Text("DEMO").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    else {
                        Button(L("사용량 새로고침"), systemImage: "arrow.clockwise") { model.updateCodexStatus(); model.command("refresh") }
                            .labelStyle(.iconOnly).modifier(SystemActionStyle()).help(L("사용량 새로고침")).disabled(!model.state.ready)
                    }
                    Menu(L("설정")) {
                        Toggle(L("Mac 로그인 시 실행"), isOn: Binding(get: { model.loginAtStartup }, set: { model.setLoginAtStartup($0) }))
                        Divider()
                        Button(L("종료…")) { model.quit() }
                    }
                    .fixedSize().modifier(SystemActionStyle())
                }
                ConnectionSummary(model: model)
                if let message = model.error ?? model.state.lastError {
                    HStack(alignment: .top) {
                        Label(L(message), systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button(L("오류 닫기"), systemImage: "xmark") { model.error = nil; model.command("dismissError") }
                            .labelStyle(.iconOnly).buttonStyle(.borderless)
                    }
                }
                HStack {
                    Text(L("계정")).font(.subheadline).fontWeight(.semibold)
                    Text("\(model.state.accounts.count)").foregroundStyle(.secondary)
                    Spacer()
                    Text(L("남은 한도")).foregroundStyle(.secondary)
                }.font(.caption)
            }.padding(.horizontal, 16).measured(.top)
            ScrollView {
                SystemGlassGroup {
                    VStack(spacing: 8) {
                        if model.state.accounts.isEmpty { ProgressView().padding() }
                        ForEach(model.state.accounts) { AccountSection(model: model, account: $0) }
                    }
                }
                // Keep the glass rim and its shadow inside the scroll viewport.
                // Padding belongs outside the glass group, not outside ScrollView.
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .measured(.accounts)
            }.frame(height: listHeight)
            VStack(spacing: 8) {
                Divider()
                HStack {
                    Menu {
                        Button(L("브라우저로 로그인")) { model.login() }
                        Button(L("기기 코드로 로그인")) { model.login(device: true) }
                    } label: { Label(L("계정 추가"), systemImage: "plus") }
                        primaryAction: { model.login() }
                        .fixedSize().modifier(SystemActionStyle())
                        .disabled(model.busy || model.state.accounts.contains { $0.status == "loggingIn" })
                    Spacer()
                    if let updated = model.state.accounts.compactMap({ $0.updatedAt }).max() {
                        Text(L("%@ 갱신", Date(timeIntervalSince1970: updated).formatted(date: .omitted, time: .shortened)))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }.padding(.horizontal, 16).measured(.footer)
        }
        .padding(.vertical, 12)
        .frame(width: 360).fixedSize(horizontal: false, vertical: true)
        .font(.callout).controlSize(.small)
        .background(.background)
        .measured(.panel)
        .onPreferenceChange(MenuMeasurements.self) { values in
            DispatchQueue.main.async {
                if values != sizes { sizes = values }
                if let height = values[.panel] { model.updatePanelHeight(height) }
            }
        }
        .onAppear { model.refreshIfNeeded() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in model.updateCodexStatus() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in model.updateCodexStatus() }
    }
}
