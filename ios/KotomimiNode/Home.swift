import SwiftUI

/// The one screen, as the Android app lays it out (MainActivity's shapes), at its sizes: an Android dp and an iOS
/// point are near enough the same length.
///
/// - Wide (a tablet held across): the status and the hearing widget on the left, the widgets on the right.
/// - Tablet (held upright): the status with the share widget beside it, the hearing widget filling the middle, a row
///   of widgets under it.
/// - Phone: all of it in a column.
///
/// A widget opens its box over the page (a sheet), as a box does there.
struct Home: View {
    @Environment(Lending.self) private var lending
    @Environment(\.colorScheme) private var scheme
    @State private var open: Box?

    enum Box: String, Identifiable { case languages, devices, tools, settings; var id: String { rawValue } }

    var body: some View {
        GeometryReader { box in
            let size = box.size
            ZStack {
                Wall(lent: lending.phase != .off, working: lending.phase == .working)
                Group {
                    if size.width > size.height && size.width >= 900 { wide(size) }
                    else if size.width >= 700 { tablet }
                    else { phone }
                }
                if let which = open {
                    // The page beneath is dimmed, not left: a tap on it closes the box.
                    Color.black.opacity(scheme == .dark ? 0.55 : 0.22)
                        .ignoresSafeArea()
                        .onTapGesture { open = nil }
                        .transition(.opacity)
                    Group {
                        switch which {
                        case .languages: LanguagesBox { open = nil }
                        case .devices: DevicesBox { open = nil }
                        case .tools: ToolsBox { open = nil }
                        case .settings: SettingsBox { open = nil }
                        }
                    }
                    .transition(.asymmetric(insertion: .scale(scale: 0.94).combined(with: .opacity).combined(with: .offset(y: 30)),
                                            removal: .scale(scale: 0.97).combined(with: .opacity)))
                    .zIndex(1)
                }
            }
            .animation(.spring(duration: 0.42, bounce: 0.24), value: open)
        }
        #if DEBUG
        // A box open at launch, for screenshots in the simulator (`-box languages|devices|tools|settings`).
        .onAppear {
            let arguments = CommandLine.arguments
            if let at = arguments.firstIndex(of: "-box"), at + 1 < arguments.count { open = Box(rawValue: arguments[at + 1]) }
        }
        #endif
    }

    private var key: some View { SettingsKey { open = .settings } }

    private func wide(_ size: CGSize) -> some View {
        HStack(alignment: .top, spacing: Metrics.gap) {
            VStack(alignment: .leading, spacing: Metrics.gap) {
                Status(key: AnyView(key))
                HearingTile()
            }
            .frame(width: (size.width - Metrics.margin * 2 - Metrics.gap) * 0.49)
            VStack(spacing: Metrics.gap) {
                ShareTile().frame(height: 96)
                HStack(spacing: Metrics.gap) {
                    Button { open = .devices } label: { DevicesTile() }
                    Button { open = .tools } label: { CheckTile() }
                }
                Button { open = .languages } label: { LanguagesTile() }.frame(height: 172)
            }
            .buttonStyle(Pressed())
            .padding(.top, 34)
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.bottom, Metrics.margin)
    }

    private var tablet: some View {
        VStack(spacing: Metrics.gap) {
            HStack(alignment: .bottom, spacing: Metrics.gap) {
                Status()
                Spacer(minLength: 0)
                ShareTile().frame(width: 360, height: 96)
            }
            // The key stands at the end of the status word's line, above the share widget.
            .overlay(alignment: .topTrailing) { key.padding(.top, 36) }
            HearingTile()
            // Four columns, as the Android app's row of widgets: the languages take two.
            GeometryReader { row in
                let unit = (row.size.width - Metrics.gap * 3) / 4
                HStack(spacing: Metrics.gap) {
                    Button { open = .devices } label: { DevicesTile() }.frame(width: unit)
                    Button { open = .tools } label: { CheckTile() }.frame(width: unit)
                    Button { open = .languages } label: { LanguagesTile() }.frame(width: unit * 2 + Metrics.gap)
                }
                .buttonStyle(Pressed())
            }
            .frame(height: 172)
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.bottom, Metrics.margin)
    }

    private var phone: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.gap) {
                Status(key: AnyView(key))
                ShareTile().frame(height: 96)
                HearingTile().frame(height: 320)
                HStack(spacing: Metrics.gap) {
                    Button { open = .devices } label: { DevicesTile() }
                    Button { open = .tools } label: { CheckTile() }
                }
                .frame(height: 150)
                Button { open = .languages } label: { LanguagesTile() }.frame(height: 150)
            }
            .buttonStyle(Pressed())
            .padding(.horizontal, Metrics.margin)
            .padding(.bottom, 30)
        }
        .scrollIndicators(.hidden)
    }
}

/// The type and spacing, as the Android app sets them.
nonisolated enum Metrics {
    static let margin: CGFloat = 24
    static let gap: CGFloat = 16
    static let radius: CGFloat = 28
    static let headline = Font.system(size: 52, weight: .regular)
    static let kicker = Font.system(size: 14, weight: .bold)
    static let title = Font.system(size: 18, weight: .semibold)
    static let line = Font.system(size: 14)
    static let small = Font.system(size: 13)
}

/// A widget pressed sinks a little, as the Android app's do.
private struct Pressed: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(.spring(duration: 0.3, bounce: 0.35), value: configuration.isPressed)
    }
}

/// The settings: three dots at the end of the status word's line, as the Android app has them, on a round glass key.
private struct SettingsKey: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Palette.ink2)
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("设置")
    }
}

// ── The status ─────────────────────────────────────────────────────────────────────────────────────────────

private struct Status: View {
    /// The settings key, at the end of the status word's line, where it has room there.
    var key: AnyView?
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(kicker)
                    .font(Metrics.kicker)
                    .tracking(7)
                    .foregroundStyle(Palette.kicker)
                Spacer(minLength: 0)
                if let key { key }
            }
            .frame(height: 34)
            .padding(.bottom, 22)
            Text(title)
                .font(Metrics.headline)
                .foregroundStyle(Palette.ink)
                .contentTransition(.opacity)
                .padding(.bottom, 10)
            Text(line)
                .font(Metrics.line)
                .foregroundStyle(Palette.ink2)
                .lineLimit(2)
        }
        .padding(.top, 36)
        .padding(.leading, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.3), value: title)
    }

    private var kicker: String {
        switch lending.phase {
        case .off: "READY"
        case .starting, .waiting: "STANDBY"
        case .working: "HEARING"
        case .failed: "STOPPED"
        }
    }

    private var title: String {
        switch lending.phase {
        case .off: "未启用"
        case .starting: "启动中"
        case .waiting: "待命"
        case .working: "工作中"
        case .failed: "未能启用"
        }
    }

    private var line: String {
        if !hearing.available { return "这台设备不支持系统的语音识别。" }
        switch lending.phase {
        case .off: return hearing.ready.isEmpty ? "请先在「识别语言」中下载一个语言。" : "启用共享后，电脑可在局域网找到这台设备。"
        case .starting: return "正在打开局域网服务"
        case .waiting: return lending.seen.map { "最近连接 \($0)" } ?? "等待电脑连接"
        case .working: return lending.seen.map { "正在识别 · 来自 \($0)" } ?? "正在识别"
        case .failed(let why): return why
        }
    }
}

// ── The widgets ────────────────────────────────────────────────────────────────────────────────────────────

private struct ShareTile: View {
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Tile(padding: 20) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(Metrics.title).foregroundStyle(Palette.ink)
                    Text(line).font(Metrics.small).foregroundStyle(Palette.ink2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Toggle("启用共享", isOn: Binding(get: { lending.phase != .off }, set: { on in
                    lending.wanted = on
                    if on { lending.start() } else { lending.stop() }
                }))
                .labelsHidden()
                .tint(Palette.accent)
                .disabled(hearing.ready.isEmpty && lending.phase == .off)
                .scaleEffect(1.25)
                // By night the switch that is on gives light, in the work's accent.
                .shadow(color: scheme == .dark && lending.phase != .off ? Palette.accent.opacity(0.55) : .clear, radius: 12)
                .padding(.trailing, 6)
            }
            .frame(maxHeight: .infinity)
        }
    }

    private var title: String {
        switch lending.phase {
        case .off, .failed: "启用共享"
        case .starting: "正在启动"
        case .waiting, .working: "共享中"
        }
    }

    private var line: String {
        switch lending.phase {
        case .off, .failed: hearing.ready.isEmpty ? "请先下载一个语言" : "将这台设备的语音识别提供给电脑使用"
        default: lending.address.map { "本机 \($0)" } ?? "这台设备未连接 Wi-Fi"
        }
    }
}

/// Hearing: the dark glass of water. The speed of the last reading at the top left, what is lent at the top right,
/// what was heard last in the middle, the water below, swelling while a computer is at work.
private struct HearingTile: View {
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing

    var body: some View {
        ZStack(alignment: .bottom) {
            Palette.waterTile
            Water(moving: lending.phase == .working)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(speed).font(.system(size: 30, weight: .regular).monospacedDigit()).foregroundStyle(Palette.waterNumber)
                        Text(verdict).font(Metrics.line).foregroundStyle(Palette.waterSub)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        Text("语音识别").font(Metrics.title).foregroundStyle(Palette.waterNumber)
                        Text(lent).font(Metrics.line).foregroundStyle(Palette.waterSub)
                    }
                }
                Spacer(minLength: 12)
                if let text = lending.lastText {
                    Text(text)
                        .font(.system(size: 22))
                        .lineSpacing(6)
                        .foregroundStyle(Palette.waterNumber)
                        .lineLimit(6)
                        .minimumScaleFactor(0.7)
                        .contentTransition(.opacity)
                        .animation(.easeOut(duration: 0.25), value: text)
                } else {
                    Dotted()
                }
                Spacer(minLength: 12)
                Spacer().frame(height: 70)
            }
            .padding(.horizontal, 28)
            .padding(.top, 28)
        }
        .clipShape(.rect(cornerRadius: 32))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var speed: String {
        guard lending.lastTook > 0 else { return "—" }
        return String(format: "%.1f×", lending.lastSeconds / lending.lastTook)
    }

    private var verdict: String {
        guard lending.lastTook > 0 else { return "等待第一段语音" }
        return lending.lastSeconds / lending.lastTook >= 2 ? "快于说话速度，可实时识别" : "慢于说话速度，会有延迟"
    }

    private var lent: String {
        guard !hearing.ready.isEmpty else { return "未下载" }
        let state = lending.phase == .working ? "工作中" : "待命"
        return "\(state) · \(hearing.name(of: lending.lastLanguage ?? hearing.preferred))"
    }
}

/// A small widget: its object at the top left, its name and how it stands at the bottom.
private struct SmallTile<Thing: View>: View {
    let title: String
    let line: String
    @ViewBuilder var thing: Thing

    var body: some View {
        Tile(padding: 20) {
            VStack(alignment: .leading, spacing: 0) {
                thing.frame(width: 50, height: 50)
                Spacer(minLength: 10)
                Text(title).font(Metrics.title).foregroundStyle(Palette.ink).padding(.bottom, 4)
                Text(line).font(Metrics.small).foregroundStyle(Palette.ink2).lineLimit(1)
            }
        }
    }
}

private struct DevicesTile: View {
    @Environment(Lending.self) private var lending

    var body: some View {
        SmallTile(title: "设备连接", line: line) { LensThing(lit: lending.phase == .working) }
    }

    private var line: String {
        switch lending.phase {
        case .off, .failed, .starting: "未启用"
        case .working: lending.seen ?? "在用"
        case .waiting: lending.seen ?? "尚无电脑连接"
        }
    }
}

private struct CheckTile: View {
    @Environment(SelfCheck.self) private var check

    var body: some View {
        SmallTile(title: "性能检测", line: line) { DialThing(amount: (check.result?.speed ?? 0) / 3) }
    }

    private var line: String {
        if case .running(let done) = check.phase { return "检测中 \(Int(done * 100))%" }
        guard let result = check.result else { return "尚未检测" }
        return result.speed >= 4 ? "可流畅使用" : "可能跟不上说话"
    }
}

private struct LanguagesTile: View {
    @Environment(Hearing.self) private var hearing

    var body: some View {
        Tile(padding: 20) {
            VStack(alignment: .leading, spacing: 0) {
                Text("识别语言").font(Metrics.title).foregroundStyle(Palette.ink).padding(.bottom, 14)
                HStack(spacing: 10) {
                    if hearing.ready.isEmpty {
                        LetterThing(letter: "あ").opacity(0.4)
                    } else {
                        ForEach(hearing.ready.prefix(6)) { language in LetterThing(letter: LetterThing.letters[language.id] ?? language.id) }
                    }
                }
                .frame(height: 44)
                Spacer(minLength: 10)
                Text(hearing.ready.isEmpty ? "尚未下载语言" : "已下载 \(hearing.ready.count) 种语言")
                    .font(Metrics.small).foregroundStyle(Palette.ink2)
            }
        }
    }
}
