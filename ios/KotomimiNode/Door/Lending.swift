import Foundation
import os
import UIKit

/// Sharing: the door, and what it answers. It answers what a Kotomimi on a computer asks of a phone — the Android
/// app's interface (`Share.kt`), unchanged, so that a published desktop finds this device in its "another device"
/// search and reads through it as it reads through a phone:
///
/// - `GET /v1/models` — in `data`, the one recognition model lent, with the device's name in `X-Kotomimi-Name`,
///   `X-Kotomimi-Node: engine`, and `X-Kotomimi-Form: tablet` on an iPad. The desktop takes every id in `data` for a
///   recognizer, so nothing else goes there; the text models are listed apart, in `text`.
/// - `POST /v1/audio/transcriptions` — one stretch of sound read whole: a form with a WAV recording and perhaps the
///   language. What goes back is `{"text": …}`.
///
/// The model's id is `apple-speech`. The desktop knows no model by it, and so tells the language by its code (`ja`),
/// and shows it as "Apple Speech". (Not `apple-speech:ja`: that is the desktop's name for the Mac's own recognizer
/// run on that computer.)
///
/// As a computer's door does, it turns away a request a web page made (one carrying an `Origin` that is not the
/// app's own) and one whose `Host` is a public name: the device is for the devices around it.
@Observable
final class Lending {
    enum Phase: Equatable { case off, starting, waiting, working, failed(String) }

    static let modelId = "apple-speech"
    /// The longest stretch read at once. A computer reading live sends a quarter of a minute at most.
    static let mostSeconds = 90.0
    /// Shorter than this is no sound: a click of a twentieth of a second has no word in it.
    static let leastSeconds = 0.05
    /// Whether it is working is told by whether anything was asked of it lately.
    private static let workingFor: TimeInterval = 4

    private(set) var phase: Phase = .off
    private(set) var address: String?
    /// The last computer that asked anything, and when.
    private(set) var seen: String?
    private(set) var seenAt: Date?
    /// What the last stretch was heard as, how long it was and how long it took, in which language.
    private(set) var lastText: String?
    private(set) var lastSeconds: Double = 0
    private(set) var lastTook: Double = 0
    private(set) var lastLanguage: String?
    private(set) var heardCount = 0

    enum Work: Equatable { case hear, translate, coach }
    /// What the device did last, which the big widget shows: a stretch heard, a sentence translated, a line of
    /// feedback written.
    private(set) var focus: Work = .hear
    /// When a stretch was last asked to be heard.
    private(set) var heardAt = Date.distantPast

    /// A kind of text work's last answer: what it was asked about, what it wrote, into which language, how long it
    /// took; how many there were, and when the last was.
    struct TextWork: Equatable {
        var said: String?
        var answer: String?
        var into: String?
        var ms: Double = 0
        var count = 0
        var at = Date.distantPast
    }
    private(set) var translated = TextWork()
    private(set) var coached = TextWork()
    func work(_ kind: TextModel.Kind) -> TextWork { kind == .translate ? translated : coached }

    /// How long a kind of work counts as going on after it was last asked for: a tablet shows a big widget for each
    /// kind going on. A computer asks for a translation and its feedback a sentence at a time, with talk between.
    static let goingFor: TimeInterval = 120

    /// The kinds of work going on, in the widgets' order: what was done last, and what else was asked for lately.
    func going(at now: Date) -> [Work] {
        guard phase == .waiting || phase == .working else { return [focus] }
        let lately = { (at: Date) in now.timeIntervalSince(at) < Lending.goingFor }
        return [Work.hear, .translate, .coach].filter { work in
            work == focus || lately(work == .hear ? heardAt : work == .translate ? translated.at : coached.at)
        }
    }

    /// Whether the owner wants it lent: the door is opened again whenever the app comes back to the front.
    var wanted: Bool {
        get { UserDefaults.standard.bool(forKey: "share.wanted") }
        set { UserDefaults.standard.set(newValue, forKey: "share.wanted") }
    }

    let hearing: Hearing
    let text: TextStore
    let engine = TextEngine()
    /// The desktop's recognition models, where one is downloaded and lent (`lentModel`).
    let hearEngine = HearingEngine()
    private var door: Door?
    private var lastUse = Date.distantPast
    private var watch: Task<Void, Never>?
    /// The text requests in the door, waiting or being answered.
    private var asking = 0
    private static let mostAsking = 4

    init(hearing: Hearing, text: TextStore) {
        self.hearing = hearing
        self.text = text
    }

    /// The recognizer the owner chose to lend: the device's own (`apple-speech`) or a downloaded model's id.
    var chosenRecognizer: String = UserDefaults.standard.string(forKey: "hearing.lent") ?? Lending.modelId {
        didSet { UserDefaults.standard.set(chosenRecognizer, forKey: "hearing.lent") }
    }

    /// The downloaded recognition model lent, or nil where the device's own recognition is: the one chosen where it
    /// is here, else the device's own where it has a language, else the first model downloaded. A computer takes the
    /// first recognizer listed for the one a device lends, so one is listed, as the Android app lists one.
    var lentModel: TextModel? {
        let models = text.ready.filter { $0.kind == .hear }
        if let chosen = models.first(where: { $0.id == chosenRecognizer }) { return chosen }
        return hearing.ready.isEmpty ? models.first : nil
    }

    /// Whether anything can be lent: a recognizer, or a text model.
    var lends: Bool { !hearing.ready.isEmpty || !text.ready.isEmpty }

    /// The name the computer lists this device by: the owner's, else the kind of device it is.
    static var name: String {
        let set = UserDefaults.standard.string(forKey: "device.name")?.trimmingCharacters(in: .whitespaces) ?? ""
        return set.isEmpty ? UIDevice.current.name : set
    }

    func start() {
        guard door == nil else { return }
        phase = .starting
        address = Network.address(port: Door.port)
        // The name as the Android app sends it: percent-encoded, a header being ASCII only.
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        let sent = Lending.name.addingPercentEncoding(withAllowedCharacters: plain) ?? "Kotomimi"
        // What kind of device it is, for the computer to call it by: a desktop before this listed every node as a phone.
        let form = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        let headers: @Sendable () -> [(String, String)] = { [("X-Kotomimi-Name", sent), ("X-Kotomimi-Node", "engine"), ("X-Kotomimi-Form", form)] }
        let made = Door(named: headers) { [weak self] request in
            guard let self else { return .error(503, "This device is no longer lent.") }
            return await self.answer(request)
        }
        door = made
        made.start(serviceName: Lending.name) { [weak self] why in
            Task { @MainActor in
                guard let self, self.door === made else { return }
                if let why { self.phase = .failed(why) } else if self.phase == .starting { self.phase = .waiting }
            }
        }
        watch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(700))
                guard let self else { return }
                self.address = Network.address(port: Door.port)
                switch self.phase {
                case .waiting, .working:
                    self.phase = Date().timeIntervalSince(self.lastUse) < Lending.workingFor ? .working : .waiting
                default: break
                }
            }
        }
    }

    func stop() {
        door?.stop()
        door = nil
        watch?.cancel()
        watch = nil
        phase = .off
    }

    #if DEBUG
    /// A state to look at, for screenshots in the simulator, where there is no recognizer (launch argument
    /// `-pretend standby|working`), as the Android app's `--es pretend`.
    func pretend(_ what: String) {
        address = "192.168.1.23:8792"
        seen = "192.168.1.8"
        seenAt = Date().addingTimeInterval(-90)
        text.pretend()
        if what == "translate" || what == "coach" || what == "all" {
            phase = .working
            lastUse = .distantFuture
            focus = what == "coach" ? .coach : .translate
            translated = TextWork(said: "飛べないおじさんはただのおじさんだ。", answer: "不会飞的叔叔只是个普通叔叔而已。", into: "中文", ms: 1400, count: 3, at: Date())
            if what != "translate" { coached = TextWork(said: "昨日、映画を見ます。", answer: "昨日、映画を見ました。\n说的是昨天的事，要用过去式。", ms: 600, count: 2, at: Date()) }
            guard what == "all" else { return }
        }
        guard what == "working" || what == "all" else { phase = .waiting; return }
        phase = .working
        heardAt = Date()
        lastText = "今日はいい天気ですね。後で一緒に公園を散歩しませんか。"
        lastSeconds = 6
        lastTook = 0.31
        lastLanguage = "ja"
        heardCount = 12
        lastUse = .distantFuture
    }
    #endif

    // ── The door's answers ────────────────────────────────────────────────────────────────────────────────────

    private func answer(_ request: Request) async -> Response {
        let origin = request.headers["origin"]
        let own = origin == nil || origin == "null" || origin!.hasPrefix("file://")
        guard own, Lending.localName(request.headers["host"]) else {
            return .error(403, "This device answers the devices around it only.")
        }
        // The app's own page, where it says where it comes from, is told it may read the answer.
        let allow: [(String, String)] = origin.map {
            [("Access-Control-Allow-Origin", $0), ("Vary", "Origin"), ("Access-Control-Expose-Headers", "X-Kotomimi-Name, X-Kotomimi-Node, X-Kotomimi-Form")]
        } ?? []
        // The owner's access key, where one is set: without it, nothing but the device's name is answered.
        let key = DoorKey.value
        if !key.isEmpty, request.method != "OPTIONS", request.headers["authorization"] != "Bearer \(key)" {
            return .error(401, "This device asks for its access key.", allow)
        }
        switch (request.method, request.path) {
        case ("OPTIONS", _):
            var answer = Response(status: 204, body: Data(), headers: allow + [("Access-Control-Allow-Methods", "GET, POST, OPTIONS"), ("Access-Control-Allow-Headers", "authorization, content-type")])
            answer.type = ""
            return answer
        case ("GET", "/v1/models"), ("GET", "/models"):
            return .json(200, modelsJson(), allow)
        case ("POST", "/v1/audio/transcriptions"), ("POST", "/audio/transcriptions"):
            return await transcribe(request, allow)
        case ("POST", "/v1/chat/completions"), ("POST", "/chat/completions"):
            return await chat(request, allow)
        default:
            return .error(404, "Not here.", allow)
        }
    }

    private func modelsJson() -> String {
        let lent: String
        if let model = lentModel {
            lent = #"{"id":"\#(model.id)","object":"model","owned_by":"kotomimi-phone","holds_mb":\#(model.holdsMb)}"#
        } else {
            lent = hearing.ready.isEmpty ? "" : #"{"id":"\#(Lending.modelId)","object":"model","owned_by":"kotomimi-phone","holds_mb":0}"#
        }
        let total = Int(ProcessInfo.processInfo.physicalMemory / 1_048_576)
        let free = Int(os_proc_available_memory() / 1_048_576)
        // The text models stand beside the recognizer in a list of their own, as the Android app's do: a computer
        // takes every id in `data` for a recognizer.
        let up = engine.up
        let textModels = text.ready.filter { $0.kind != .hear }.map {
            #"{"id":"\#($0.id)","object":"model","owned_by":"kotomimi-phone","holds_mb":\#($0.holdsMb),"kind":"\#($0.kind.rawValue)","name":\#(jsonQuoted($0.name)),"loaded":\#(up.contains($0.id))}"#
        }.joined(separator: ",")
        return #"{"object":"list","data":[\#(lent)],"text":[\#(textModels)],"memory_mb":{"total":\#(total),"available":\#(free)}}"#
    }

    // ── Text models ─────────────────────────────────────────────────────────────────────────────────────────

    /// One answer of a text model, as the Android app gives it (`Share.chat` and `Chat.requestOf`): a request held
    /// to the three plain kinds of message and the sampling the desktop sends, answered whole. (The desktop reads
    /// an answer that is not streamed as it reads one that is: `completeText` in src/providers/openai/textModel.ts.)
    private func chat(_ request: Request, _ allow: [(String, String)]) async -> Response {
        guard request.body.count <= 256 * 1024,
              let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] else {
            return .error(400, "The request is not JSON, or is too long.", allow)
        }
        guard let named = json["model"] as? String else { return .error(400, "The request names no model.", allow) }
        guard let model = text.ready.first(where: { $0.id == named && $0.kind != .hear }) else {
            let known = TextModel.all.contains { $0.id == named && $0.kind != .hear }
            return .error(404, known ? "This device does not lend \"\(named)\": it is not downloaded there." : "This device lends no text model called \"\(named.prefix(40))\".", allow)
        }
        guard let said = json["messages"] as? [[String: Any]], (1...64).contains(said.count) else {
            return .error(400, "The request has no messages, or more than 64.", allow)
        }
        var messages: [(role: String, content: String)] = []
        for message in said {
            guard let role = message["role"] as? String, ["system", "user", "assistant"].contains(role), let content = message["content"] as? String else {
                return .error(400, "Every message is said by \"system\", \"user\" or \"assistant\", in plain text.", allow)
            }
            messages.append((role, content))
        }
        guard messages.reduce(0, { $0 + $1.content.count }) <= 8000 else {
            return .error(413, "The messages are too long: at most 8000 letters in all.", allow)
        }
        var asked = TextEngine.Asked(messages: messages)
        let most = (json["max_tokens"] as? Int) ?? (json["max_completion_tokens"] as? Int)
        asked.maxTokens = Int32(min(max(most ?? 1024, 1), 1024))
        if let value = json["temperature"] as? Double, value.isFinite { asked.temperature = Float(min(max(value, 0), 2)) }
        if let value = json["top_p"] as? Double, value.isFinite { asked.topP = Float(min(max(value, 0), 1)) }
        if let value = json["repeat_penalty"] as? Double, value.isFinite { asked.repeatPenalty = Float(min(max(value, 0), 2)) }
        if let value = json["top_k"] as? Int { asked.topK = Int32(min(max(value, 0), 1000)) }
        if let value = json["seed"] as? Int { asked.seed = UInt32(truncatingIfNeeded: value) }
        let stops = (json["stop"] as? [String]) ?? ((json["stop"] as? String).map { [$0] } ?? [])
        asked.stops = Array(stops.filter { !$0.isEmpty && $0.count <= 64 }.prefix(4))
        if let kwargs = json["chat_template_kwargs"] as? [String: Any], let thinking = kwargs["enable_thinking"] as? Bool { asked.thinking = thinking ? 1 : 0 }

        guard asking < Lending.mostAsking else {
            return .error(429, "This device is busy: \(Lending.mostAsking) requests for its text models wait already.", allow + [("Retry-After", "2")])
        }
        asking += 1
        defer { asking -= 1 }
        seen = request.peer
        seenAt = Date()
        lastUse = Date()
        if phase == .waiting { phase = .working }
        do {
            let written = try await engine.answer(model, at: text.path(model), asked)
            lastUse = Date()
            let answer = written.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !answer.isEmpty {
                focus = model.kind == .translate ? .translate : .coach
                var done = work(model.kind)
                done.said = Lending.saidIn(messages)
                done.into = model.kind == .translate ? Lending.intoIn(messages) : nil
                done.answer = answer
                done.ms = written.tookMs
                done.count += 1
                done.at = Date()
                if model.kind == .translate { translated = done } else { coached = done }
            }
            let created = Int(Date().timeIntervalSince1970)
            let body = #"{"id":"chatcmpl-kotomimi-\#(created)","object":"chat.completion","created":\#(created),"model":"\#(model.id)","choices":[{"index":0,"message":{"role":"assistant","content":\#(jsonQuoted(written.text))},"finish_reason":"\#(written.finish)"}],"usage":{"prompt_tokens":\#(written.read),"completion_tokens":\#(written.written),"total_tokens":\#(written.read + written.written)}}"#
            return .json(200, body, allow)
        } catch let refusal as Refusal {
            let short = refusal.description.contains("memory")
            return .error(short ? 503 : 502, refusal.description, allow + (short ? [("Retry-After", "5")] : []))
        } catch {
            return .error(502, "The engine stopped: \(error.localizedDescription)", allow)
        }
    }

    /// The sentence a request asks about, for the screen: the last line of the last thing the person said (the
    /// desktop's translation prompt puts its instructions before it).
    static func saidIn(_ messages: [(role: String, content: String)]) -> String? {
        messages.last { $0.role == "user" }.flatMap { $0.content.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last }?
            .trimmingCharacters(in: .whitespaces).unlessBlank
    }

    /// The language a translation is asked for, as its prompt names it (翻译为中文, into English).
    static func intoIn(_ messages: [(role: String, content: String)]) -> String? {
        let all = messages.map(\.content).joined(separator: "\n")
        if let match = all.firstMatch(of: /翻译[为成](\p{Han}{1,6}?)[，,：:\n]/) { return String(match.1) }
        if let match = all.firstMatch(of: /into ([A-Z][a-z]+)/) { return String(match.1) }
        return nil
    }

    private func transcribe(_ request: Request, _ allow: [(String, String)]) async -> Response {
        let model = lentModel
        guard model != nil || !hearing.ready.isEmpty else {
            return .error(404, "This device lends no speech recognition now: no language is downloaded there.", allow)
        }
        let length = Int(request.headers["content-length"] ?? "")
        guard let length, length >= 0, length <= Door.bodyMost else {
            return .error(413, "The sound is too long, or its length was not said.", allow)
        }
        guard let form = Upload(type: request.headers["content-type"] ?? "", body: request.body) else {
            return .error(400, "The request is not a multipart form.", allow)
        }
        guard let file = form.file else { return .error(400, "The form has no file in it.", allow) }
        guard let wav = Wav(file) else { return .error(400, "The file is not a 16-bit WAV recording.", allow) }
        seen = request.peer
        seenAt = Date()
        // Nothing to hear.
        if wav.seconds < Lending.leastSeconds { return .json(200, #"{"text":""}"#, allow) }
        if wav.seconds > Lending.mostSeconds {
            return .error(413, "The sound is too long: this device reads at most \(Int(Lending.mostSeconds)) seconds at once.", allow)
        }
        let said = form.fields["language"]?.trimmingCharacters(in: .whitespaces) ?? ""
        if let model { return await engineRead(model, wav, said, allow) }
        let code: String
        if said.isEmpty || said.lowercased() == "auto" {
            code = hearing.preferred
        } else if let known = Hearing.code(for: said) {
            code = known
        } else {
            let names = hearing.ready.map(\.id).joined(separator: ", ")
            return .error(400, "This device reads \(names) only, not \"\(said.prefix(20))\".", allow)
        }
        lastUse = Date()
        heardAt = Date()
        if phase == .waiting { phase = .working }
        let began = Date()
        do {
            let text = try await hearing.read(wav, in: code)
            lastUse = Date()
            if !text.isEmpty {
                lastText = text
                lastSeconds = wav.seconds
                lastTook = Date().timeIntervalSince(began)
                lastLanguage = code
                heardCount += 1
            }
            return .json(200, #"{"text":\#(jsonQuoted(text))}"#, allow)
        } catch let refusal as Refusal {
            return .error(400, refusal.description, allow)
        } catch {
            return .error(502, "The recognizer stopped: \(error.localizedDescription)", allow)
        }
    }

    /// A stretch read by a downloaded model: told the language the computer says, by the app's code; where it says
    /// none, the model tells it where it can, else the language ticked here.
    private func engineRead(_ model: TextModel, _ wav: Wav, _ said: String, _ allow: [(String, String)]) async -> Response {
        let base = said.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
        let language: String?
        if base.isEmpty || base == "auto" {
            language = model.detects ? nil : model.languages.contains(hearing.preferred) ? hearing.preferred : nil
            if language == nil && !model.detects {
                return .error(400, "\(model.name) does not tell languages apart: the computer must say which it is to hear.", allow)
            }
        } else if model.languages.contains(base) {
            language = base
        } else if let named = Hearing.code(for: said) ?? TextModel.languageNames.first(where: { $0.value.lowercased() == said.lowercased() })?.key,
                  model.languages.contains(named) {
            // Named in English, as the desktop names R2T2's (`saidFor` in electron/remote-engine.js).
            language = named
        } else {
            return .error(400, "\(model.name) does not hear \"\(said.prefix(20))\".", allow)
        }
        lastUse = Date()
        heardAt = Date()
        if phase == .waiting { phase = .working }
        let began = Date()
        let samples = wav.samples.map { Float($0) / 32768 }
        do {
            let text = try await hearEngine.read(model, at: self.text.path(model), samples: samples, rate: Int(wav.rate), language: language)
            lastUse = Date()
            if !text.isEmpty {
                lastText = text
                lastSeconds = wav.seconds
                lastTook = Date().timeIntervalSince(began)
                lastLanguage = language
                heardCount += 1
            }
            return .json(200, #"{"text":\#(jsonQuoted(text))}"#, allow)
        } catch let refusal as HearingEngine.Refusal {
            let short = refusal.description.contains("memory")
            return .error(short ? 503 : 502, refusal.description, allow + (short ? [("Retry-After", "5")] : []))
        } catch {
            return .error(502, "The recognizer stopped: \(error.localizedDescription)", allow)
        }
    }

    /// An address, `localhost`, a bare name, or a name that exists on a local network only — not a public name pointed here.
    private static func localName(_ host: String?) -> Bool {
        guard let host else { return true }
        var name = host.lowercased()
        if name.hasPrefix("[") { return true }
        if let colon = name.lastIndex(of: ":") { name = String(name[..<colon]) }
        let ipv4 = name.split(separator: ".").count == 4 && name.split(separator: ".").allSatisfy { UInt8($0) != nil }
        return ipv4 || !name.contains(".") || name.hasSuffix(".local") || name.hasSuffix(".lan") || name.hasSuffix(".home")
    }
}

/// The owner's access key, where one is set: a computer must send it to use the device. Empty: anyone on the same
/// Wi-Fi may. Read from any thread (the door's).
nonisolated enum DoorKey {
    static var value: String { UserDefaults.standard.string(forKey: "door.key") ?? "" }
    static func set(_ key: String) { UserDefaults.standard.set(key, forKey: "door.key") }

    /// A new key, as the Android app makes one: six letters and figures nobody misreads (no O or 0, no I or 1).
    static func made() -> String {
        let letters = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<6).map { _ in letters.randomElement()! })
    }

    static func clear() { UserDefaults.standard.removeObject(forKey: "door.key") }
}

nonisolated enum Network {
    /// This device's address on the Wi-Fi it is on, with the port: nil where it is on none.
    static func address(port: UInt16) -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: String?
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: entry.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let text = String(decoding: host.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            guard !text.hasPrefix("169.254") else { continue }
            // Wi-Fi (en0) first.
            if name == "en0" { return "\(text):\(port)" }
            if found == nil { found = "\(text):\(port)" }
        }
        return found
    }
}

nonisolated extension String {
    /// Nil for an empty string.
    var unlessBlank: String? { isEmpty ? nil : self }
}
