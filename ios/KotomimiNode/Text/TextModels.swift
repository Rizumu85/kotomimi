import CryptoKit
import Foundation
import os

/// The text models: the desktop app's own translation and feedback models — the same files, by the same checksums,
/// under the desktop's own names for them (`id`), which is what a computer asks for them by (`TEXT_MODELS` in the
/// Android app's Models.kt, `TRANSLATORS` and `COACHES` in electron/native-engine.js).
nonisolated struct TextModel: Identifiable, Sendable, Equatable {
    enum Kind: String, Sendable { case translate, coach }
    let id: String
    let name: String
    let kind: Kind
    let file: String
    let bytes: Int64
    let sha256: String
    /// Hugging Face repository and revision, and the same file's repository on ModelScope where it has one.
    let repository: String
    let revision: String
    let modelScope: String?
    /// What its engine keeps for itself once loaded, in megabytes, roughly: what is held against the memory free.
    let holdsMb: Int

    /// Where it can be had, best first for where this device is: in mainland China (by its time zone) ModelScope
    /// and the mirror before Hugging Face, which is not reached there without a proxy; elsewhere Hugging Face first.
    var sources: [URL] {
        let huggingFace = URL(string: "https://huggingface.co/\(repository)/resolve/\(revision)/\(file)")!
        let mirror = URL(string: "https://hf-mirror.com/\(repository)/resolve/\(revision)/\(file)")!
        let scope = modelScope.map { URL(string: "https://modelscope.cn/models/\($0)/resolve/master/\(file)")! }
        let china = ["Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar"].contains(TimeZone.current.identifier)
        return china ? [scope, mirror, huggingFace].compactMap { $0 } : [huggingFace, scope, mirror].compactMap { $0 }
    }

    static let all: [TextModel] = [
        TextModel(id: "hy-mt2-1.8b", name: "Hunyuan MT 2 1.8B", kind: .translate, file: "Hy-MT2-1.8B-Q4_K_M.gguf", bytes: 1_133_080_448,
                  sha256: "dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699",
                  repository: "tencent/Hy-MT2-1.8B-GGUF", revision: "a0c709d9fac510f2c807aa3af52872340dc37a4a", modelScope: "Tencent-Hunyuan/Hy-MT2-1.8B-GGUF", holdsMb: 1400),
        TextModel(id: "index-translate-2b", name: "Index-Translate 2B", kind: .translate, file: "Index-Translate-2B.Q4_K_M.gguf", bytes: 1_312_164_352,
                  sha256: "044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a",
                  repository: "IndexTeam/Index-Translate-2B-GGUF", revision: "449c9e6457b3632d328c6cbb78ae8e8e0c8059a5", modelScope: "IndexTeam/Index-Translate-2B-GGUF", holdsMb: 1600),
        TextModel(id: "gemma-4-e2b", name: "Gemma 4 E2B", kind: .coach, file: "gemma-4-E2B-it-Q4_K_M.gguf", bytes: 3_106_738_272,
                  sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
                  repository: "unsloth/gemma-4-E2B-it-GGUF", revision: "0314792d7f1f7e229411f620751375812bb9faf2", modelScope: "unsloth/gemma-4-E2B-it-GGUF", holdsMb: 3400),
    ]
}

/// Where the text models are kept, which of them are here, and their downloads.
///
/// A download is the system's (`Downloader`, a background session): a model is a gigabyte or three, which takes
/// minutes, and an app's own download stops when the screen locks or the app leaves the front — on the first iPad,
/// every source of the first model timed out that way (the user, 2026-11-04). The system's goes on meanwhile, and
/// the app hears how it went when it is back.
@Observable
final class TextStore {
    enum State: Equatable { case missing, fetching(Double, String), checking, ready, failed(String) }

    private(set) var states: [String: State] = [:]
    let folder: URL
    private let downloader = Downloader.shared
    /// Per model, why each source it was asked of did not give it, for when none does.
    private var why: [String: [String]] = [:]
    /// What a source that broke off had given, to go on from: per model, the source and the system's resume data.
    private var resume: [String: (source: Int, data: Data)] = [:]
    /// Downloads the person stopped: their end is not a failure.
    private var stopped: Set<String> = []

    var downloading: Bool { states.values.contains { if case .fetching = $0 { true } else { $0 == .checking } } }

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        folder = support.appending(path: "models", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Kept off backups: they are downloads, and large.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var marked = folder
        try? marked.setResourceValues(values)
        for model in TextModel.all {
            states[model.id] = FileManager.default.fileExists(atPath: path(model).path) ? .ready : .missing
            // What the app's own downloads left before the system's took over.
            try? FileManager.default.removeItem(at: path(model).appendingPathExtension("part"))
        }
        downloader.folder = folder
        downloader.onEvent = { [weak self] event in Task { @MainActor in self?.heard(event) } }
        // Downloads the system went on with while the app was not running.
        downloader.running { [weak self] going in
            Task { @MainActor in
                guard let self else { return }
                for (id, source) in going {
                    guard let model = TextModel.all.first(where: { $0.id == id }), self.states[id] != .ready else { continue }
                    self.states[id] = .fetching(0, model.sources[safe: source]?.host() ?? "")
                }
            }
        }
    }

    #if DEBUG
    func pretend() { states["hy-mt2-1.8b"] = .ready; states["gemma-4-e2b"] = .fetching(0.42, "modelscope.cn") }
    #endif

    func path(_ model: TextModel) -> URL { folder.appending(path: model.file) }
    func state(_ model: TextModel) -> State { states[model.id] ?? .missing }
    var ready: [TextModel] { TextModel.all.filter { states[$0.id] == .ready } }

    func delete(_ model: TextModel) {
        cancel(model)
        try? FileManager.default.removeItem(at: path(model))
        states[model.id] = .missing
    }

    func cancel(_ model: TextModel) {
        stopped.insert(model.id)
        resume[model.id] = nil
        downloader.cancel(model.id)
        states[model.id] = .missing
    }

    /// Fetches a model: from its first source, then the next where one does not give it, going on from what a
    /// source that broke off had given, and kept only if its SHA-256 is the one expected.
    func fetch(_ model: TextModel) {
        if case .fetching = state(model) { return }
        stopped.remove(model.id)
        why[model.id] = []
        let from = resume[model.id]
        start(model, source: from?.source ?? 0, resume: from?.data)
    }

    private func start(_ model: TextModel, source: Int, resume data: Data?) {
        guard let url = model.sources[safe: source] else { return }
        states[model.id] = .fetching(0, url.host() ?? "")
        downloader.start(id: model.id, source: source, url: url, resume: data)
    }

    private func heard(_ event: Downloader.Event) {
        guard let model = TextModel.all.first(where: { $0.id == event.id }) else { return }
        let host = model.sources[safe: event.source]?.host() ?? ""
        switch event.kind {
        case .progress(let written, let total):
            guard !stopped.contains(model.id) else { return }
            states[model.id] = .fetching(Double(written) / Double(total > 0 ? total : model.bytes), host)
        case .finished(let file):
            resume[model.id] = nil
            states[model.id] = .checking
            Task {
                let sum = try? await Fetch.sha256(of: file)
                if sum == model.sha256 {
                    try? FileManager.default.removeItem(at: path(model))
                    do {
                        try FileManager.default.moveItem(at: file, to: path(model))
                        states[model.id] = .ready
                    } catch {
                        states[model.id] = .failed("存不下：\(error.localizedDescription)")
                    }
                } else {
                    try? FileManager.default.removeItem(at: file)
                    tryNext(model, after: event.source, because: "\(host)：下载的文件不对，已删除")
                }
            }
        case .failed(let reason, let data):
            if stopped.contains(model.id) { return }
            if let data { resume[model.id] = (event.source, data) }
            tryNext(model, after: event.source, because: "\(host)：\(reason)")
        }
    }

    private func tryNext(_ model: TextModel, after source: Int, because reason: String) {
        why[model.id, default: []].append(reason)
        if source + 1 < model.sources.count {
            start(model, source: source + 1, resume: nil)
        } else {
            states[model.id] = .failed((why[model.id] ?? [reason]).joined(separator: "\n"))
        }
    }
}

/// The system's downloads, in a background session: they go on while the app is suspended, the screen locked, or
/// the app not running at all. A finished file is moved out of the system's hands at once, beside the models.
nonisolated final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = Downloader()

    struct Event: Sendable {
        enum Kind: Sendable { case progress(Int64, Int64), finished(URL), failed(String, Data?) }
        let id: String
        let source: Int
        let kind: Kind
    }

    /// Set once, before the first download.
    var onEvent: @Sendable (Event) -> Void = { _ in }
    var folder: URL?
    private var told: [Int: Date] = [:]
    private let lock = NSLock()

    private var session: URLSession!

    private override init() {
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: "io.github.rizumu85.kotomimi.node.models")
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.timeoutIntervalForRequest = 60
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func start(id: String, source: Int, url: URL, resume: Data?) {
        cancel(id)
        let task = resume.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: url)
        task.taskDescription = "\(id)|\(source)"
        task.resume()
    }

    func cancel(_ id: String) {
        session.getAllTasks { tasks in
            for task in tasks where task.taskDescription?.hasPrefix("\(id)|") == true { task.cancel() }
        }
    }

    /// The downloads under way: each model's id and source.
    func running(_ then: @escaping @Sendable ([(String, Int)]) -> Void) {
        session.getAllTasks { tasks in
            then(tasks.filter { $0.state == .running }.compactMap { Downloader.named($0) })
        }
    }

    private static func named(_ task: URLSessionTask) -> (String, Int)? {
        guard let parts = task.taskDescription?.split(separator: "|"), parts.count == 2, let source = Int(parts[1]) else { return nil }
        return (String(parts[0]), source)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let (id, source) = Downloader.named(downloadTask) else { return }
        // A few times a second is all the screen needs.
        let now = Date()
        let due = lock.withLock { () -> Bool in
            if let last = told[downloadTask.taskIdentifier], now.timeIntervalSince(last) < 0.3 { return false }
            told[downloadTask.taskIdentifier] = now
            return true
        }
        if due { onEvent(Event(id: id, source: source, kind: .progress(totalBytesWritten, totalBytesExpectedToWrite))) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let (id, source) = Downloader.named(downloadTask), let folder else { return }
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            onEvent(Event(id: id, source: source, kind: .failed("HTTP \(http.statusCode)", nil)))
            return
        }
        // The system deletes the file once this returns: it is moved now.
        let kept = folder.appending(path: "\(id).downloaded")
        try? FileManager.default.removeItem(at: kept)
        do {
            try FileManager.default.moveItem(at: location, to: kept)
            onEvent(Event(id: id, source: source, kind: .finished(kept)))
        } catch {
            onEvent(Event(id: id, source: source, kind: .failed(error.localizedDescription, nil)))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.withLock { _ = told.removeValue(forKey: task.taskIdentifier) }
        guard let error, let (id, source) = Downloader.named(task) else { return }
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled && ns.userInfo[NSURLSessionDownloadTaskResumeData] == nil { return }
        onEvent(Event(id: id, source: source, kind: .failed(error.localizedDescription, ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data)))
    }
}

nonisolated extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

nonisolated enum Fetch {
    @concurrent static func sha256(of file: URL) async throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// The text models' engine: llama.cpp in this process (TextShim). A model is loaded when it is first asked for and
/// stays, unless the memory free is too little for the next one, when the one asked longest ago goes first. One
/// answer at a time, on a thread of its own: an answer holds its thread for a second or more, which neither the main
/// actor nor the shared pool should give.
nonisolated final class TextEngine: @unchecked Sendable {
    /// The room a model is given: the longest request the desktop sends (the feedback model's instructions, under
    /// six kilobytes) and its answer.
    static let context: Int32 = 4096
    /// What is to be over once a model is loaded beside others, for the recognizer and the rest of the app.
    static let reserveMb = 800

    private let queue = DispatchQueue(label: "text-engine", qos: .userInitiated)
    /// Only touched on `queue`.
    private var loaded: [String: (model: OpaquePointer, usedAt: Date)] = [:]
    private let cancel = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private let names = OSAllocatedUnfairLock(initialState: Set<String>())

    /// Whether llama.cpp's backends are up: brought up with the first model, since bringing up Metal compiles its
    /// kernels, which nothing should wait for before a text model is asked for. Only touched on `queue`.
    private var started = false

    init() { cancel.initialize(to: 0) }

    /// The models that are loaded now.
    var up: Set<String> { names.withLock { $0 } }

    struct Answer: Sendable {
        let text: String
        let finish: String
        let read: Int
        let written: Int
        let tookMs: Double
    }

    struct Asked: Sendable {
        var messages: [(role: String, content: String)]
        var temperature: Float = 0.8
        var topP: Float = 0.95
        var topK: Int32 = 40
        var repeatPenalty: Float = 1
        var seed: UInt32 = 0xFFFF_FFFF
        var maxTokens: Int32 = 512
        var thinking: Int32 = -1
        var stops: [String] = []
    }

    func answer(_ model: TextModel, at path: URL, _ asked: Asked) async throws -> Answer {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Answer, Error>) in
            queue.async { [self] in
                do { done.resume(returning: try answerHere(model, at: path, asked)) } catch { done.resume(throwing: error) }
            }
        }
    }

    /// Lets every model go: when the system says memory is short.
    func release() {
        queue.async { [self] in
            for (_, entry) in loaded { kt_model_free(entry.model) }
            loaded.removeAll()
            names.withLock { $0.removeAll() }
        }
    }

    private func answerHere(_ model: TextModel, at path: URL, _ asked: Asked) throws -> Answer {
        let engine = try loadedHere(model, at: path)
        let began = Date()
        cancel.pointee = 0
        var error = [CChar](repeating: 0, count: 512)
        var outcome = kt_outcome()
        let roles = asked.messages.map { strdup($0.role) }
        let contents = asked.messages.map { strdup($0.content) }
        let stops = asked.stops.map { UnsafePointer(strdup($0)) }
        defer { roles.forEach { free($0) }; contents.forEach { free($0) }; stops.forEach { free(UnsafeMutablePointer(mutating: $0)) } }
        var messages = zip(roles, contents).map { kt_message(role: $0.0, content: $0.1) }
        let text: UnsafeMutablePointer<CChar>? = stops.withUnsafeBufferPointer { stopList in
            let settings = kt_settings(temperature: asked.temperature, top_p: asked.topP, top_k: asked.topK, repeat_penalty: asked.repeatPenalty,
                                       seed: asked.seed, max_tokens: asked.maxTokens, enable_thinking: asked.thinking,
                                       stops: stopList.baseAddress.map { UnsafePointer($0) }, stop_count: Int32(stopList.count))
            return messages.withUnsafeMutableBufferPointer { list in
                kt_answer(engine, list.baseAddress, Int32(list.count), settings, &outcome, cancel, &error, Int32(error.count))
            }
        }
        guard let text else { throw Refusal(String(cString: error)) }
        defer { kt_free(text) }
        return Answer(text: String(cString: text), finish: outcome.finish == 1 ? "length" : "stop",
                      read: Int(outcome.read_tokens), written: Int(outcome.written_tokens), tookMs: Date().timeIntervalSince(began) * 1000)
    }

    private func loadedHere(_ model: TextModel, at path: URL) throws -> OpaquePointer {
        if !started { kt_backend_init(); started = true }
        if let had = loaded[model.id] {
            loaded[model.id]?.usedAt = Date()
            return had.model
        }
        // Room: the model asked longest ago goes while what is free would not hold this one and a reserve.
        while !loaded.isEmpty, Int(os_proc_available_memory() / 1_048_576) - model.holdsMb < TextEngine.reserveMb,
              let oldest = loaded.min(by: { $0.value.usedAt < $1.value.usedAt }) {
            kt_model_free(oldest.value.model)
            let gone = oldest.key
            loaded[gone] = nil
            names.withLock { _ = $0.remove(gone) }
        }
        let free = Int(os_proc_available_memory() / 1_048_576)
        guard free >= model.holdsMb else {
            throw Refusal("This device has not the memory for \(model.name) now: it needs about \(model.holdsMb) MB, and \(free) MB can be had.")
        }
        var error = [CChar](repeating: 0, count: 512)
        guard let made = kt_model_load(path.path, TextEngine.context, &error, Int32(error.count)) else {
            throw Refusal("The engine did not start with \(model.name): \(String(cString: error)).")
        }
        loaded[model.id] = (made, Date())
        let id = model.id
        names.withLock { _ = $0.insert(id) }
        return made
    }
}
