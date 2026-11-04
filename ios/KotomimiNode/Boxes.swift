import SwiftUI

/// The boxes a widget opens: sheets over the page, in the system's own Liquid Glass.

struct LanguagesBox: View {
    @Environment(Hearing.self) private var hearing
    @State private var failure: String?

    var body: some View {
        List {
            Section {
                ForEach(hearing.languages.filter { $0.state != .unsupported }) { language in
                    row(language)
                }
            } footer: {
                Text("电脑没有指定语言时，用打勾的语言。")
            }
            if let failure {
                Section { Text(failure).foregroundStyle(Palette.inkRed) }
            }
        }
        .navigationTitle("识别语言")
        .navigationBarTitleDisplayMode(.inline)
        .task { await hearing.refresh() }
    }

    @ViewBuilder private func row(_ language: Hearing.Language) -> some View {
        HStack {
            Text(language.name)
            Spacer()
            switch language.state {
            case .ready:
                if hearing.preferred == language.id { Image(systemName: "checkmark").foregroundStyle(Palette.good) }
            case .fetching(let done):
                ProgressView(value: done).frame(width: 90)
                Text("\(Int(done * 100))%").monospacedDigit().foregroundStyle(.secondary)
            case .offered, .unknown:
                Button("下载") { fetch(language.id) }.buttonStyle(.glass)
            case .unsupported:
                EmptyView()
            }
        }
        .contentShape(.rect)
        .onTapGesture { if language.state == .ready { hearing.preferred = language.id } }
        .swipeActions {
            if language.state == .ready {
                Button("移除", role: .destructive) { Task { await hearing.release(language.id) } }
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

struct DevicesBox: View {
    @Environment(Lending.self) private var lending

    var body: some View {
        List {
            Section("本机地址") {
                Text(lending.address ?? "未连接 Wi-Fi").monospaced().textSelection(.enabled)
            }
            Section("连接方法") {
                Label("在电脑上打开 Kotomimi", systemImage: "1.circle")
                Label("在设置的「另一台设备」中搜索", systemImage: "2.circle")
                Label("选择这台设备（需在同一 Wi-Fi 下）", systemImage: "3.circle")
            }
            Section {
                if let seen = lending.seen, let at = lending.seenAt {
                    Text("最近连接的电脑：\(seen) · \(at, style: .relative)前")
                } else {
                    Text(lending.phase == .off ? "启用共享后，电脑才能找到这台设备。" : "尚无电脑连接。")
                }
            } footer: {
                Text("共享期间请让 Kotomimi 留在前台：切到别的 App 或锁屏后，电脑就连不上了。共享时屏幕不会自动锁定。")
            }
        }
        .navigationTitle("设备连接")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ToolsBox: View {
    @Environment(Hearing.self) private var hearing
    @Environment(Lending.self) private var lending
    @Environment(SelfCheck.self) private var check

    var body: some View {
        List {
            Section {
                HStack(spacing: 20) {
                    DialThing(amount: (check.result?.speed ?? 0) / 3).frame(width: 72, height: 72)
                    VStack(alignment: .leading, spacing: 4) {
                        if let result = check.result {
                            Text(String(format: "%.1f 倍速", result.speed)).font(.title2.weight(.semibold)).monospacedDigit()
                            Text(result.speed >= 4 ? "可实时识别" : "会有延迟").foregroundStyle(.secondary)
                        } else {
                            Text("尚未检测").font(.title3.weight(.semibold))
                        }
                    }
                }
                .padding(.vertical, 6)
                if case .running(let done) = check.phase { ProgressView(value: done) }
                if case .failed(let why) = check.phase { Text(why).foregroundStyle(Palette.inkRed) }
                Button(check.running ? "停止检测" : check.result == nil ? "开始检测" : "重新检测") {
                    if check.running { check.cancel() } else { check.start(hearing) }
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.key)
                .disabled(lending.phase != .off && !check.running)
            } footer: {
                Text(lending.phase != .off ? "共享期间无法检测，请先停止共享。" : "用一段日语录音测试识别速度。")
            }
            if let result = check.result {
                Section("读出的内容") {
                    Text(result.text.isEmpty ? "（没有读出字）" : result.text)
                    if !result.right { Text("和录音差得较多").foregroundStyle(Palette.inkRed) }
                    LabeledContent("第一次（含加载）", value: String(format: "%.1f 秒", result.firstSeconds))
                }
            }
        }
        .navigationTitle("性能检测")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct SettingsBox: View {
    @AppStorage("look.appearance") private var appearance = "system"
    @AppStorage("device.name") private var deviceName = ""
    @State private var key = DoorKey.value
    @Environment(Lending.self) private var lending

    var body: some View {
        Form {
            Section("外观") {
                Picker("外观", selection: $appearance) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            Section {
                TextField(UIDevice.current.name, text: $deviceName)
                    .submitLabel(.done)
                    // The name goes out with every answer: a sharing door is opened again to carry the new one.
                    .onSubmit { if lending.phase != .off { lending.stop(); lending.start() } }
            } header: {
                Text("在电脑上显示的名称")
            }
            Section {
                if key.isEmpty {
                    Button("设置密钥") { key = DoorKey.made(); DoorKey.set(key) }
                } else {
                    LabeledContent("访问密钥") { Text(key).monospaced().textSelection(.enabled) }
                    Button("更换") { key = DoorKey.made(); DoorKey.set(key) }
                    Button("关闭", role: .destructive) { DoorKey.clear(); key = "" }
                }
            } header: {
                Text("访问密钥")
            } footer: {
                Text(key.isEmpty ? "同一 Wi-Fi 下的设备都能使用这台设备。" : "电脑连接这台设备时需要输入此密钥。")
            }
            Section {
                LabeledContent("Kotomimi 手机端", value: "版本 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
            }
        }
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
    }
}
