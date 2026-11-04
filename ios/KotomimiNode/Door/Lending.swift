import Foundation
import os
import UIKit

/// Sharing: the door, and what it answers. It answers what a Kotomimi on a computer asks of a phone — the Android
/// app's interface (`Share.kt`), unchanged, so that a published desktop finds this device in its "another device"
/// search and reads through it as it reads through a phone:
///
/// - `GET /v1/models` — in `data`, the one recognition model lent, with the device's name in `X-Kotomimi-Name` and
///   `X-Kotomimi-Node: engine`. The desktop takes every id in `data` for a recognizer, so nothing else goes there;
///   the text models' list, `text`, is empty until this app lends translation.
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

    /// Whether the owner wants it lent: the door is opened again whenever the app comes back to the front.
    var wanted: Bool {
        get { UserDefaults.standard.bool(forKey: "share.wanted") }
        set { UserDefaults.standard.set(newValue, forKey: "share.wanted") }
    }

    let hearing: Hearing
    private var door: Door?
    private var lastUse = Date.distantPast
    private var watch: Task<Void, Never>?

    init(hearing: Hearing) { self.hearing = hearing }

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
        let headers: @Sendable () -> [(String, String)] = { [("X-Kotomimi-Name", sent), ("X-Kotomimi-Node", "engine")] }
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
        guard what == "working" else { phase = .waiting; return }
        phase = .working
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
            [("Access-Control-Allow-Origin", $0), ("Vary", "Origin"), ("Access-Control-Expose-Headers", "X-Kotomimi-Name, X-Kotomimi-Node")]
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
            return .error(404, "This device lends no text models yet.", allow)
        default:
            return .error(404, "Not here.", allow)
        }
    }

    private func modelsJson() -> String {
        let lent = hearing.ready.isEmpty ? "" : #"{"id":"\#(Lending.modelId)","object":"model","owned_by":"kotomimi-phone","holds_mb":0}"#
        let total = Int(ProcessInfo.processInfo.physicalMemory / 1_048_576)
        let free = Int(os_proc_available_memory() / 1_048_576)
        return #"{"object":"list","data":[\#(lent)],"text":[],"memory_mb":{"total":\#(total),"available":\#(free)}}"#
    }

    private func transcribe(_ request: Request, _ allow: [(String, String)]) async -> Response {
        guard !hearing.ready.isEmpty else {
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
