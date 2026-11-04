import SwiftUI

/// The one screen, as the Android app lays it out (MainActivity's "tablet" and "phone" shapes): on a wide screen the
/// status and the hearing widget on the left and the widgets on the right; on a narrow one, all of it in a column.
/// A widget opens its box over the page (a sheet), as a box does there.
struct Home: View {
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing
    @Environment(SelfCheck.self) private var check
    @State private var open: Box?

    enum Box: String, Identifiable { case languages, devices, tools, settings; var id: String { rawValue } }

    var body: some View {
        GeometryReader { box in
            let wide = box.size.width > box.size.height && box.size.width >= 900
            ZStack(alignment: .topTrailing) {
                Wall(working: lending.phase == .working)
                if wide { wideLayout(box.size) } else { narrowLayout }
                Button { open = .settings } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 17, weight: .medium)).frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("设置")
                .padding(.top, 8)
                .padding(.trailing, 24)
            }
        }
        .sheet(item: $open) { which in
            NavigationStack {
                switch which {
                case .languages: LanguagesBox()
                case .devices: DevicesBox()
                case .tools: ToolsBox()
                case .settings: SettingsBox()
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func wideLayout(_ size: CGSize) -> some View {
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 24) {
                Status()
                HearingTile()
            }
            .frame(width: size.width * 0.48)
            VStack(spacing: 20) {
                ShareTile().frame(height: 118)
                HStack(spacing: 20) {
                    Button { open = .devices } label: { DevicesTile() }
                    Button { open = .tools } label: { CheckTile() }
                }
                .buttonStyle(.plain)
                Button { open = .languages } label: { LanguagesTile().frame(height: 200) }.buttonStyle(.plain)
            }
            .padding(.top, 48)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var narrowLayout: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Status()
                ShareTile().frame(height: 118)
                HearingTile().frame(height: 340)
                HStack(spacing: 18) {
                    Button { open = .devices } label: { DevicesTile().frame(height: 190) }
                    Button { open = .tools } label: { CheckTile().frame(height: 190) }
                }
                .buttonStyle(.plain)
                Button { open = .languages } label: { LanguagesTile().frame(height: 180) }.buttonStyle(.plain)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
        .scrollIndicators(.hidden)
    }
}

// ── The status ─────────────────────────────────────────────────────────────────────────────────────────────

private struct Status: View {
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(kicker)
                .font(.system(size: 17, weight: .semibold))
                .tracking(8)
                .foregroundStyle(Palette.inkRed)
            Text(title)
                .font(.system(size: 64, weight: .medium))
                .foregroundStyle(Palette.ink)
                .contentTransition(.opacity)
            Text(line)
                .font(.system(size: 17))
                .foregroundStyle(Palette.ink2)
                .lineLimit(2)
        }
        .padding(.top, 40)
        .padding(.leading, 12)
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
        case .off: return hearing.ready.isEmpty ? "尚未下载语言。请先在「识别语言」中下载。" : "启用共享后，电脑可在局域网找到这台设备。"
        case .starting: return "正在打开局域网服务"
        case .waiting: return lending.seen.map { "待命 · 最近连接 \($0)" } ?? "等待电脑连接"
        case .working: return lending.seen.map { "正在识别 · 来自 \($0)" } ?? "正在识别"
        case .failed(let why): return why
        }
    }
}

// ── The widgets ────────────────────────────────────────────────────────────────────────────────────────────

private struct ShareTile: View {
    @Environment(Lending.self) private var lending
    @Environment(Hearing.self) private var hearing

    var body: some View {
        Tile {
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                    Text(line).font(.system(size: 15)).foregroundStyle(Palette.ink2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Toggle("启用共享", isOn: Binding(get: { lending.phase != .off }, set: { on in
                    lending.wanted = on
                    if on { lending.start() } else { lending.stop() }
                }))
                .labelsHidden()
                .tint(Palette.accent)
                .disabled(hearing.ready.isEmpty && lending.phase == .off)
                .controlSize(.large)
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
                    VStack(alignment: .leading, spacing: 6) {
                        Text(speed).font(.system(size: 40, weight: .medium).monospacedDigit()).foregroundStyle(Palette.waterNumber)
                        Text(verdict).font(.system(size: 15)).foregroundStyle(Palette.waterSub)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        Text("语音识别").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.waterNumber)
                        Text(lent).font(.system(size: 15)).foregroundStyle(Palette.waterSub)
                    }
                }
                Spacer(minLength: 16)
                if let text = lending.lastText {
                    Text(text)
                        .font(.system(size: 26, weight: .regular))
                        .foregroundStyle(Palette.waterNumber)
                        .lineLimit(5)
                        .minimumScaleFactor(0.6)
                        .contentTransition(.opacity)
                        .animation(.easeOut(duration: 0.25), value: text)
                } else {
                    Dotted()
                }
                Spacer(minLength: 16)
                Spacer().frame(height: 60)
            }
            .padding(28)
        }
        .clipShape(.rect(cornerRadius: 36))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var speed: String {
        guard lending.lastTook > 0 else { return "—" }
        return String(format: "%.1f 倍速", lending.lastSeconds / lending.lastTook)
    }

    private var verdict: String {
        guard lending.lastTook > 0 else { return "等待第一段语音" }
        return lending.lastSeconds / lending.lastTook >= 2 ? "快于说话速度，可实时识别" : "慢于说话速度，会有延迟"
    }

    private var lent: String {
        let state = lending.phase == .working ? "工作中" : "待命"
        let language = hearing.name(of: lending.lastLanguage ?? hearing.preferred)
        return hearing.ready.isEmpty ? "未下载" : "\(state) · 系统语音识别 · \(language)"
    }
}

private struct DevicesTile: View {
    @Environment(Lending.self) private var lending

    var body: some View {
        Tile {
            VStack(alignment: .leading) {
                LensThing(lit: lending.phase == .working).frame(width: 66, height: 66)
                Spacer(minLength: 12)
                Text("设备连接").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                Text(line).font(.system(size: 15)).foregroundStyle(Palette.ink2).lineLimit(1)
            }
        }
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
        Tile {
            VStack(alignment: .leading) {
                DialThing(amount: (check.result?.speed ?? 0) / 3).frame(width: 66, height: 66)
                Spacer(minLength: 12)
                Text("性能检测").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                Text(line).font(.system(size: 15)).foregroundStyle(Palette.ink2).lineLimit(1)
            }
        }
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
        Tile {
            VStack(alignment: .leading, spacing: 14) {
                Text("识别语言").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.ink)
                HStack(spacing: 14) {
                    ForEach(shown, id: \.self) { letters in CardsThing(letters: letters).frame(width: 54, height: 54) }
                    if shown.isEmpty { CardsThing(letters: "あ").frame(width: 54, height: 54).opacity(0.45) }
                }
                Spacer(minLength: 0)
                Text(hearing.ready.isEmpty ? "尚未下载语言" : "已下载 \(hearing.ready.count) 种语言")
                    .font(.system(size: 15)).foregroundStyle(Palette.ink2)
            }
        }
    }

    private var shown: [String] { hearing.ready.prefix(5).map { Self.letters[$0.id] ?? $0.id.uppercased() } }

    private static let letters = ["ja": "あ", "en": "A", "zh": "中", "yue": "粤", "ko": "한", "es": "Ñ", "fr": "É", "de": "ß", "it": "I", "pt": "Ã", "hi": "अ"]
}
