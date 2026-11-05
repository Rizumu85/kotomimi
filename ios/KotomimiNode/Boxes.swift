import SwiftUI

/// The boxes a widget opens, as the Android app opens them: a box over the page, not a new page — here one pane of
/// Liquid Glass, the same for every box, rising from the foot on a phone and standing in the middle on a tablet, with
/// its contents on cards (`card` in colors.xml). The page stays where it was beneath.
struct BoxPanel<Thing: View, Content: View>: View {
    let title: String
    /// The card it opens at, by its `id`, where the widget that opened it is about one part of it.
    var start: String? = nil
    let close: () -> Void
    @ViewBuilder var thing: Thing
    @ViewBuilder var content: Content
    @Environment(\.horizontalSizeClass) private var width

    var body: some View {
        GeometryReader { box in
            let regular = width == .regular && box.size.width >= 700
            VStack(spacing: 0) {
                if !regular { Capsule().fill(Palette.ink3.opacity(0.5)).frame(width: 36, height: 5).padding(.top, 8) }
                HStack(spacing: 14) {
                    thing.frame(width: 36, height: 36)
                    Text(title).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.ink)
                    Spacer(minLength: 0)
                    Button(action: close) {
                        Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink2).frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("关闭")
                }
                .padding(.horizontal, 20)
                .padding(.top, regular ? 18 : 10)
                .padding(.bottom, 12)
                ScrollViewReader { scroll in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) { content }
                            .padding(.horizontal, 14)
                            .padding(.bottom, 16)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .onAppear {
                        guard let start else { return }
                        // After the box has its size: before it, there is nothing yet to scroll.
                        Task { @MainActor in scroll.scrollTo(start, anchor: .top) }
                    }
                }
            }
            .frame(width: regular ? 480 : box.size.width - 16)
            .frame(maxHeight: box.size.height * (regular ? 0.72 : 0.86), alignment: .top)
            .fixedSize(horizontal: false, vertical: true)
            .glassEffect(.regular.tint(Palette.tile.opacity(0.55)), in: .rect(cornerRadius: 36))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: regular ? .center : .bottom)
            .padding(.bottom, regular ? 0 : 8)
            .gesture(DragGesture().onEnded { drag in if !regular && drag.translation.height > 80 { close() } })
        }
    }
}

/// One card of a box.
struct BoxCard<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title { Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink) }
            content
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.card.opacity(0.9), in: .rect(cornerRadius: 20))
    }
}

/// A line under a card, said once where it is needed.
private struct Note: View {
    let text: String
    var body: some View { Text(text).font(.system(size: 13)).foregroundStyle(Palette.ink2).padding(.horizontal, 6) }
}

// ── The boxes ─────────────────────────────────────────────────────────────────────────────────────────────────

struct ModelsBox: View {
    /// The parts of the box, by the widgets that open it there.
    enum Part: String { case hearing, translate, coach }
    var start: Part = .hearing
    let close: () -> Void
    @Environment(Hearing.self) private var hearing
    @Environment(TextStore.self) private var text
    @Environment(Lending.self) private var lending
    @State private var failure: String?

    var body: some View {
        BoxPanel(title: "模型管理", start: start == .hearing ? nil : start.rawValue, close: close) { WaterThing() } content: {
            // What is lent to hear with: the device's own recognition, or one of the desktop's models. One at a time,
            // the one ticked: a computer takes the first a device lists.
            BoxCard(title: "语音识别") {
                let shown = TextModel.all.filter { $0.kind == .hear }
                Rows(count: shown.count + 1) { at in at == 0 ? AnyView(system) : AnyView(model(shown[at - 1])) }
            }
            BoxCard(title: "系统识别语言") {
                let shown = hearing.languages.filter { $0.state != .unsupported }
                Rows(count: shown.count) { at in language(shown[at]) }
            }
            Note(text: "电脑没有指定语言时，用打勾的语言。")
            if let failure { Note(text: failure).foregroundStyle(Palette.inkRed) }
            BoxCard(title: "文本翻译") {
                let shown = TextModel.all.filter { $0.kind == .translate }
                Rows(count: shown.count) { at in model(shown[at]) }
            }
            .id(Part.translate.rawValue)
            BoxCard(title: "语法反馈") {
                let shown = TextModel.all.filter { $0.kind == .coach }
                Rows(count: shown.count) { at in model(shown[at]) }
            }
            .id(Part.coach.rawValue)
            Note(text: "按住已下载的一行可以删除。")
        }
        .task { await hearing.refresh() }
    }

    /// The device's own recognition, as a row beside the models: ticked while it is the one lent.
    private var system: some View {
        let languages = hearing.ready.count
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("系统语音识别").font(.system(size: 16)).foregroundStyle(Palette.ink)
                Text(languages > 0 ? "\(languages) 种语言" : "尚未下载语言").font(.system(size: 13)).foregroundStyle(Palette.ink3)
            }
            Spacer()
            if languages > 0 && lending.lentModel == nil {
                Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.good)
            }
        }
        .frame(minHeight: 50)
        .contentShape(.rect)
        .onTapGesture { if languages > 0 { lending.chosenRecognizer = Lending.modelId } }
    }

    @ViewBuilder private func language(_ language: Hearing.Language) -> some View {
        HStack(spacing: 12) {
            Text(language.name).font(.system(size: 16)).foregroundStyle(Palette.ink)
            Spacer()
            switch language.state {
            case .ready:
                if hearing.preferred == language.id {
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.good)
                } else {
                    Text("已下载").font(.system(size: 14)).foregroundStyle(Palette.ink3)
                }
            case .fetching(let done):
                ProgressView(value: done).tint(Palette.good).frame(width: 80)
                Text("\(Int(done * 100))%").font(.system(size: 14).monospacedDigit()).foregroundStyle(Palette.ink2)
            case .offered, .unknown:
                Button("下载") { fetch(language.id) }.buttonStyle(.glass).controlSize(.small)
            case .unsupported:
                EmptyView()
            }
        }
        .frame(minHeight: 46)
        .contentShape(.rect)
        .onTapGesture { if language.state == .ready { hearing.preferred = language.id } }
        .contextMenu {
            if language.state == .ready {
                Button("移除", systemImage: "trash", role: .destructive) { Task { await hearing.release(language.id) } }
            }
        }
    }

    @ViewBuilder private func model(_ model: TextModel) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.name).font(.system(size: 16)).foregroundStyle(Palette.ink)
                Text(String(format: "%.1f GB", Double(model.bytes) / 1_073_741_824)).font(.system(size: 13)).foregroundStyle(Palette.ink3)
            }
            Spacer()
            switch text.state(model) {
            case .ready:
                if model.kind == .hear && lending.lentModel?.id == model.id {
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.good)
                } else {
                    Text("已下载").font(.system(size: 14)).foregroundStyle(Palette.ink3)
                }
            case .fetching(let done, let from):
                VStack(alignment: .trailing, spacing: 3) {
                    ProgressView(value: done).tint(Palette.good).frame(width: 80)
                    Text(from.isEmpty ? "\(Int(done * 100))%" : "\(Int(done * 100))% · \(from)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Palette.ink2)
                }
                Button { text.cancel(model) } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.small).accessibilityLabel("停止下载")
            case .checking:
                ProgressView().controlSize(.small)
                Text("核对中").font(.system(size: 14)).foregroundStyle(Palette.ink2)
            case .missing:
                Button("下载") { text.fetch(model) }.buttonStyle(.glass).controlSize(.small)
            case .failed(let why):
                VStack(alignment: .trailing, spacing: 4) {
                    Button("重试") { text.fetch(model) }.buttonStyle(.glass).controlSize(.small)
                    Text(why).font(.system(size: 12)).foregroundStyle(Palette.inkRed).lineLimit(6).multilineTextAlignment(.trailing)
                }
            }
        }
        .frame(minHeight: 50)
        .contentShape(.rect)
        .onTapGesture { if model.kind == .hear && text.state(model) == .ready { lending.chosenRecognizer = model.id } }
        .contextMenu {
            if text.state(model) == .ready {
                Button("删除 \(model.name)", systemImage: "trash", role: .destructive) {
                    // The engine holds the file it reads from: it lets it go first.
                    if model.kind == .hear { lending.hearEngine.release() }
                    text.delete(model)
                }
            }
        }
    }

    private func fetch(_ code: String) {
        failure = nil
        Task {
            do { try await hearing.install(code) } catch { failure = "下载没有完成：\(error.localizedDescription)" }
        }
    }
}

/// Rows of a card, with a hairline between them.
private struct Rows<Row: View>: View {
    let count: Int
    @ViewBuilder let row: (Int) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { at in
                row(at)
                if at < count - 1 { Rectangle().fill(Palette.cardLine).frame(height: 1) }
            }
        }
    }
}

struct DevicesBox: View {
    let close: () -> Void
    @Environment(Lending.self) private var lending

    var body: some View {
        BoxPanel(title: "设备连接", close: close) { LensThing(lit: lending.phase == .working) } content: {
            BoxCard(title: "本机地址") {
                Text(lending.address ?? "未连接 Wi-Fi")
                    .font(.system(size: 26, weight: .regular).monospacedDigit())
                    .foregroundStyle(lending.phase == .off ? Palette.ink3 : Palette.ink)
                    .textSelection(.enabled)
            }
            BoxCard(title: "连接方法") {
                ForEach(Array(["在电脑上打开 Kotomimi", "在设置的「另一台设备」中搜索", "选择这台设备（需在同一 Wi-Fi 下）"].enumerated()), id: \.offset) { at, step in
                    HStack(spacing: 12) {
                        Text("\(at + 1)").font(.system(size: 12, weight: .bold)).foregroundStyle(Color(day: 0xC4432F, night: 0x111113))
                            .frame(width: 24, height: 24).background(Color(day: 0xF3D5CC, night: 0xF2F2F4), in: .circle)
                        Text(step).font(.system(size: 15)).foregroundStyle(Palette.ink)
                    }
                }
            }
            BoxCard {
                if let seen = lending.seen, let at = lending.seenAt {
                    Text("最近连接的电脑：\(seen) · \(at.formatted(.relative(presentation: .named)))").font(.system(size: 15)).foregroundStyle(Palette.ink)
                } else {
                    Text(lending.phase == .off ? "启用共享后，电脑才能找到这台设备。" : "尚无电脑连接。").font(.system(size: 15)).foregroundStyle(Palette.ink)
                }
            }
            Note(text: "共享期间请让 Kotomimi 留在前台：切到别的 App 或锁屏后，电脑就连不上了。共享时屏幕不会自动锁定。")
        }
    }
}

struct ToolsBox: View {
    let close: () -> Void
    @Environment(Hearing.self) private var hearing
    @Environment(Lending.self) private var lending
    @Environment(SelfCheck.self) private var check

    var body: some View {
        BoxPanel(title: "性能检测", close: close) { DialThing(amount: (check.result?.speed ?? 0) / 3) } content: {
            BoxCard {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let result = check.result {
                        Text(String(format: "%.1f", result.speed)).font(.system(size: 44, weight: .light).monospacedDigit()).foregroundStyle(Palette.ink)
                        Text("倍速").font(.system(size: 15)).foregroundStyle(Palette.ink2)
                        Spacer()
                        Text(result.speed >= 4 ? "可实时识别" : "会有延迟")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(result.speed >= 4 ? Palette.mint : Color(day: 0xF3D5CC, night: 0x2E2E33), in: .capsule)
                    } else {
                        Text("尚未检测").font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.ink)
                    }
                }
                if case .running(let done) = check.phase { ProgressView(value: done).tint(Palette.good) }
                if case .failed(let why) = check.phase { Text(why).font(.system(size: 14)).foregroundStyle(Palette.inkRed) }
                Button(check.running ? "停止检测" : check.result == nil ? "开始检测" : "重新检测") {
                    if check.running { check.cancel() } else { check.start(hearing) }
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.key)
                .foregroundStyle(Color(day: 0xFFFDF8, night: 0x111113))
                .disabled(lending.phase != .off && !check.running)
            }
            Note(text: lending.phase != .off ? "共享期间无法检测，请先停止共享。" : "用一段日语录音测试识别速度。")
            if let result = check.result {
                BoxCard(title: "读出的内容") {
                    Text(result.text.isEmpty ? "（没有读出字）" : result.text).font(.system(size: 15)).foregroundStyle(Palette.ink)
                    if !result.right { Text("和录音差得较多").font(.system(size: 14)).foregroundStyle(Palette.inkRed) }
                    Text(String(format: "第一次 %.1f 秒（含加载）", result.firstSeconds)).font(.system(size: 13)).foregroundStyle(Palette.ink2)
                }
            }
        }
    }
}

struct SettingsBox: View {
    let close: () -> Void
    @AppStorage("look.appearance") private var appearance = "system"
    @AppStorage("device.name") private var deviceName = ""
    @State private var key = DoorKey.value
    @Environment(Lending.self) private var lending

    var body: some View {
        BoxPanel(title: "设置", close: close) { FadersThing() } content: {
            BoxCard(title: "外观") {
                Picker("外观", selection: $appearance) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            BoxCard(title: "在电脑上显示的名称") {
                TextField(UIDevice.current.name, text: $deviceName)
                    .font(.system(size: 16))
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .background(Palette.tile.opacity(0.9), in: .rect(cornerRadius: 12))
                    .submitLabel(.done)
                    // The name goes out with every answer: a sharing door is opened again to carry the new one.
                    .onSubmit { if lending.phase != .off { lending.stop(); lending.start() } }
            }
            BoxCard(title: "访问密钥") {
                Text(key.isEmpty ? "未设置" : key)
                    .font(.system(size: 30, weight: .semibold, design: .monospaced))
                    .tracking(4)
                    .foregroundStyle(key.isEmpty ? Palette.ink3 : Palette.ink)
                    .textSelection(.enabled)
                Text(key.isEmpty ? "同一 Wi-Fi 下的设备都能使用这台设备。" : "电脑连接这台设备时需要输入此密钥。").font(.system(size: 13)).foregroundStyle(Palette.ink2)
                HStack(spacing: 10) {
                    Button(key.isEmpty ? "设置密钥" : "更换") { key = DoorKey.made(); DoorKey.set(key) }.buttonStyle(.glass)
                    if !key.isEmpty { Button("关闭", role: .destructive) { DoorKey.clear(); key = "" }.buttonStyle(.glass) }
                }
            }
            BoxCard {
                HStack {
                    Text("Kotomimi").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink)
                    Spacer()
                    Text("版本 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")").font(.system(size: 14)).foregroundStyle(Palette.ink2)
                }
            }
        }
    }
}
