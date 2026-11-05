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
    /// Where the models box opens: at the part of the widget that opened it.
    @State private var part: ModelsBox.Part = .hearing
    /// What stands in front of the wallpaper, for its dots to keep clear of.
    @State private var covered: [CGRect] = []

    enum Box: String, Identifiable { case models, devices, tools, settings; var id: String { rawValue } }

    var body: some View {
        GeometryReader { box in
            let size = box.size
            ZStack {
                Living(mood: lending.mood, lent: lending.phase == .waiting || lending.phase == .working, working: lending.phase == .working,
                       heard: lending.heardCount, translated: lending.translated.count, coached: lending.coached.count, covered: covered)
                Group {
                    if size.width > size.height && size.width >= 900 { wide(size) }
                    else if size.width >= 700 { tablet(size) }
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
                        case .models: ModelsBox(start: part) { open = nil }
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
            .coordinateSpace(name: Living.space)
            .onPreferenceChange(CoverKey.self) { covered = $0 }
        }
        #if DEBUG
        // A box open at launch, for screenshots in the simulator (`-box models|devices|tools|settings`).
        .onAppear {
            let arguments = CommandLine.arguments
            if let at = arguments.firstIndex(of: "-part"), at + 1 < arguments.count { part = ModelsBox.Part(rawValue: arguments[at + 1]) ?? .hearing }
            if let at = arguments.firstIndex(of: "-box"), at + 1 < arguments.count { open = Box(rawValue: arguments[at + 1]) }
        }
        #endif
    }

    private var key: some View { SettingsKey { open = .settings } }

    private func models(_ at: ModelsBox.Part) {
        part = at
        open = .models
    }

    /// The widgets that open a box, each for one kind of thing: hearing, translation, feedback, the devices, the check.
    private var hearButton: some View { Button { models(.hearing) } label: { HearTile() } }
    private var translateButton: some View { Button { models(.translate) } label: { TranslateTile() } }
    private var coachButton: some View { Button { models(.coach) } label: { CoachTile() } }
    private var devicesButton: some View { Button { open = .devices } label: { DevicesTile() } }
    private var checkButton: some View { Button { open = .tools } label: { CheckTile() } }

    /// Held across: the status and the big widgets take the larger part on the left, where every kind of work going
    /// on has room. On the right, the settings key on the status word's line, the switch level with the status
    /// word, and six small widgets of one size in a grid of two by three, sharing the height left: a widget is never
    /// stretched to fill a row of its own.
    private func wide(_ size: CGSize) -> some View {
        HStack(alignment: .top, spacing: Metrics.gap) {
            VStack(alignment: .leading, spacing: Metrics.gap) {
                Status()
                FocusTiles(several: true)
            }
            .frame(width: (size.width - Metrics.margin * 2 - Metrics.gap) * 0.6)
            VStack(spacing: Metrics.gap) {
                // The status's kicker line: 36 from the top, 34 high, as `Status` lays it out.
                HStack { Spacer(); key }.frame(height: 34).padding(.top, 36)
                ShareTile().frame(height: 92)
                Grid(horizontalSpacing: Metrics.gap, verticalSpacing: Metrics.gap) {
                    GridRow { hearButton; translateButton }
                    GridRow { coachButton; devicesButton }
                    GridRow { checkButton; Button { models(.hearing) } label: { ModelsTile(compact: true) } }
                }
            }
            .buttonStyle(Pressed())
        }
        .padding(.horizontal, Metrics.margin)
        .padding(.bottom, Metrics.margin)
    }

    private func tablet(_ size: CGSize) -> some View {
        VStack(spacing: Metrics.gap) {
            HStack(alignment: .bottom, spacing: Metrics.gap) {
                Status()
                Spacer(minLength: 0)
                ShareTile().frame(width: 340, height: 92)
            }
            // The key stands at the end of the status word's line, above the share widget.
            .overlay(alignment: .topTrailing) { key.padding(.top, 36) }
            FocusTiles(several: true)
            HStack(spacing: Metrics.gap) { hearButton; translateButton; coachButton; devicesButton; checkButton }
                .frame(height: 148)
            Button { models(.hearing) } label: { ModelsTile() }.frame(height: 120)
        }
        .buttonStyle(Pressed())
        .padding(.horizontal, Metrics.margin)
        .padding(.bottom, Metrics.margin)
    }

    private var phone: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.gap) {
                Status(key: AnyView(key))
                ShareTile().frame(height: 92)
                FocusTiles(several: false).frame(height: 300)
                HStack(spacing: Metrics.gap) { hearButton; translateButton }.frame(height: 140)
                HStack(spacing: Metrics.gap) { coachButton; devicesButton }.frame(height: 140)
                HStack(spacing: Metrics.gap) { checkButton; Button { models(.hearing) } label: { ModelsTile(compact: true) } }.frame(height: 140)
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
    static let margin: CGFloat = 28
    static let gap: CGFloat = 14
    static let radius: CGFloat = 26
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
        .covers()
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
        case .off: return lending.lends ? "启用共享后，电脑可在局域网找到这台设备。" : "请先在「模型管理」中下载一个模型或语言。"
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
                .disabled(!lending.lends && lending.phase == .off)
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
        case .off, .failed: lending.lends ? "将这台设备的模型提供给电脑使用" : "请先下载一个模型"
        default: lending.address.map { "本机 \($0)" } ?? "这台设备未连接 Wi-Fi"
        }
    }
}

/// The big widgets: what the device did last, as the Android app's — the glass of water while it hears, a glass of
/// apricot while it translates, a sheet of paper while it writes feedback. A phone has room for one, the one done
/// last; a tablet shows one for each kind of work going on, one under another, sharing the height, as the Android
/// app's tablet does.
private struct FocusTiles: View {
    let several: Bool
    @Environment(Lending.self) private var lending

    var body: some View {
        let shown = several ? lending.going() : [lending.focus]
        let texts = shown.filter { $0 != .hear }
        // Hearing across the top where it is going on, the text work side by side under it.
        VStack(spacing: Metrics.gap) {
            if shown.contains(.hear) { HearingTile().transition(.opacity) }
            if !texts.isEmpty {
                HStack(spacing: Metrics.gap) {
                    ForEach(texts, id: \.self) { work in
                        TextTile(kind: work == .translate ? .translate : .coach).transition(.opacity.combined(with: .scale(scale: 0.98)))
                    }
                }
            }
        }
        .animation(.spring(duration: 0.45, bounce: 0.15), value: shown)
    }
}

/// A text model's last answer: how long it took at the top left, what it is at the top right, what was said and
/// what came of it in the middle.
private struct TextTile: View {
    let kind: TextModel.Kind
    @Environment(Lending.self) private var lending

    var body: some View {
        let work = lending.work(kind)
        // Feedback is a bare ✓ where the sentence was right, else the sentence put right over one line of why.
        let lines = (work.answer ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let fine = kind == .coach && lines.first == "✓"
        let answer = kind == .coach ? (fine ? "没有问题" : lines.first ?? "") : work.answer ?? ""
        let why = kind == .coach && !fine ? lines.dropFirst().joined(separator: " ") : ""
        let face = kind == .translate ? Color(day: 0xF4E3C8, night: 0x26262A) : Color(day: 0xFBF7F0, night: 0x26262A)
        let number = kind == .translate ? Color(day: 0x3A3026, night: 0xF5F5F7) : Color(day: 0x3A2E2C, night: 0xF5F5F7)
        let sub = kind == .translate ? Color(day: 0x8A7660, night: 0x9C9CA4) : Color(day: 0x8E7A76, night: 0x9C9CA4)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if work.count > 0 {
                        Text(String(format: "%.1f", work.ms / 1000)).font(.system(size: 30).monospacedDigit()).foregroundStyle(number)
                        Text("秒 · 上一句").font(Metrics.line).foregroundStyle(sub)
                    } else {
                        Text("—").font(.system(size: 30)).foregroundStyle(number)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text(kind == .translate ? "文本翻译" : "语法反馈").font(Metrics.title).foregroundStyle(number)
                    Text(lending.phase == .working ? "工作中" : "待命").font(Metrics.line).foregroundStyle(sub)
                }
            }
            Spacer(minLength: 12)
            Text(work.said ?? (kind == .translate ? "原文将显示在这里" : "等待第一句")).font(.system(size: 17)).foregroundStyle(sub).lineLimit(3)
                .strikethrough(kind == .coach && work.answer != nil && !fine, color: sub.opacity(0.6))
                .padding(.bottom, 12)
            if let failed = work.failed {
                Text(failed).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.inkRed).lineLimit(3)
            } else if work.answer != nil {
                Text(answer).font(.system(size: 22, weight: kind == .coach ? .semibold : .regular))
                    .lineSpacing(5).foregroundStyle(kind == .coach && !fine ? Palette.inkRed : number).lineLimit(6).minimumScaleFactor(0.7)
                if !why.isEmpty {
                    Text(why).font(.system(size: 15)).foregroundStyle(sub).lineLimit(3).padding(.top, 8)
                }
            }
            Spacer(minLength: 12)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(face, in: .rect(cornerRadius: 32))
        .covers()
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
        .covers()
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
        let state = lending.phase == .working ? "工作中" : "待命"
        if let model = lending.lentModel { return "\(state) · \(model.name)" }
        guard !hearing.ready.isEmpty else { return "未下载" }
        return "\(state) · \(hearing.name(of: lending.lastLanguage ?? hearing.preferred))"
    }
}

/// A small widget: its object at the top left, its name and how it stands at the bottom.
private struct SmallTile<Thing: View>: View {
    let title: String
    let line: String
    /// The object's width: one object is 50 square; the models widget's three stand in a row.
    var thingWidth: CGFloat = 50
    @ViewBuilder var thing: Thing

    var body: some View {
        Tile(padding: 20) {
            VStack(alignment: .leading, spacing: 0) {
                thing.frame(width: thingWidth, height: 50, alignment: .leading)
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
    @Environment(Lending.self) private var lending

    var body: some View {
        SmallTile(title: "性能检测", line: line) { DialThing(amount: (check.result(lending)?.speed ?? 0) / 3) }
    }

    private var line: String {
        if case .running(let done, _) = check.phase { return "检测中 \(Int(done * 100))%" }
        guard let result = check.result(lending) else { return "尚未检测" }
        return result.speed >= 4 ? "可流畅使用" : "可能跟不上说话"
    }
}

/// What hears for the computer: the model lent, or the device's own recognition in the language ticked.
private struct HearTile: View {
    @Environment(Hearing.self) private var hearing
    @Environment(Lending.self) private var lending

    var body: some View {
        SmallTile(title: "语音识别", line: line) { WaterThing() }
    }

    private var line: String {
        if let model = lending.lentModel { return model.name }
        return hearing.ready.isEmpty ? "未下载" : "系统 · \(hearing.name(of: hearing.preferred))"
    }
}

private struct TranslateTile: View {
    @Environment(TextStore.self) private var text
    @Environment(Lending.self) private var lending

    var body: some View {
        SmallTile(title: "文本翻译", line: TextLine.of(.translate, text, lending)) { PanesThing() }
    }
}

private struct CoachTile: View {
    @Environment(TextStore.self) private var text
    @Environment(Lending.self) private var lending

    var body: some View {
        SmallTile(title: "语法反馈", line: TextLine.of(.coach, text, lending)) { NoteThing() }
    }
}

/// How a kind of text model stands, in a few words.
private enum TextLine {
    static func of(_ kind: TextModel.Kind, _ text: TextStore, _ lending: Lending) -> String {
        let models = TextModel.all.filter { $0.kind == kind }
        if models.contains(where: { if case .fetching = text.state($0) { true } else { false } }) { return "下载中" }
        guard models.contains(where: { text.state($0) == .ready }) else { return "未下载" }
        let done = lending.work(kind).count
        if done > 0 { return kind == .translate ? "已翻译 \(done) 句" : "已批改 \(done) 句" }
        return lending.phase == .off ? "未启用" : "待命"
    }
}

/// The models: the objects of what is here, and how many.
private struct ModelsTile: View {
    /// As a small widget, its objects small above its name.
    var compact = false
    @Environment(Hearing.self) private var hearing
    @Environment(TextStore.self) private var text

    var body: some View {
        if compact {
            SmallTile(title: "模型管理", line: "\(hearing.ready.count + text.ready.count) 项已下载", thingWidth: 112) {
                HStack(spacing: 6) {
                    WaterThing().frame(width: 32, height: 32).opacity(hearing.ready.isEmpty && !text.ready.contains { $0.kind == .hear } ? 0.35 : 1)
                    PanesThing().frame(width: 32, height: 32).opacity(text.ready.contains { $0.kind == .translate } ? 1 : 0.35)
                    NoteThing().frame(width: 32, height: 32).opacity(text.ready.contains { $0.kind == .coach } ? 1 : 0.35)
                }
            }
        } else {
            wide
        }
    }

    private var wide: some View {
        Tile(padding: 20) {
            HStack(alignment: .center, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("模型管理").font(Metrics.title).foregroundStyle(Palette.ink)
                    Text(line).font(Metrics.small).foregroundStyle(Palette.ink2)
                }
                Spacer(minLength: 12)
                HStack(spacing: 14) {
                    WaterThing().frame(width: 40, height: 40).opacity(hearing.ready.isEmpty && !text.ready.contains { $0.kind == .hear } ? 0.35 : 1)
                    PanesThing().frame(width: 40, height: 40).opacity(text.ready.contains { $0.kind == .translate } ? 1 : 0.35)
                    NoteThing().frame(width: 40, height: 40).opacity(text.ready.contains { $0.kind == .coach } ? 1 : 0.35)
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private var line: String {
        let languages = hearing.ready.count
        let hearers = text.ready.filter { $0.kind == .hear }.count, models = text.ready.count - hearers
        if languages == 0 && models == 0 && hearers == 0 { return "尚未下载" }
        return [languages > 0 ? "\(languages) 种识别语言" : nil, hearers > 0 ? "\(hearers) 个识别模型" : nil, models > 0 ? "\(models) 个文本模型" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }
}
