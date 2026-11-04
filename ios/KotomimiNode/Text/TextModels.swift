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

    var sources: [URL] {
        var all = [URL(string: "https://huggingface.co/\(repository)/resolve/\(revision)/\(file)")!,
                   URL(string: "https://hf-mirror.com/\(repository)/resolve/\(revision)/\(file)")!]
        if let modelScope { all.insert(URL(string: "https://modelscope.cn/models/\(modelScope)/resolve/master/\(file)")!, at: 1) }
        return all
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
@Observable
final class TextStore {
    enum State: Equatable { case missing, fetching(Double, String), checking, ready, failed(String) }

    private(set) var states: [String: State] = [:]
    let folder: URL
    private var downloads: [String: Task<Void, Never>] = [:]

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        folder = support.appending(path: "models", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Kept off backups: they are downloads, and large.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var marked = folder
        try? marked.setResourceValues(values)
        for model in TextModel.all { states[model.id] = FileManager.default.fileExists(atPath: path(model).path) ? .ready : .missing }
    }

    #if DEBUG
    func pretend() { states["hy-mt2-1.8b"] = .ready; states["gemma-4-e2b"] = .fetching(0.42, "modelscope.cn") }
    #endif

    func path(_ model: TextModel) -> URL { folder.appending(path: model.file) }
    func state(_ model: TextModel) -> State { states[model.id] ?? .missing }
    var ready: [TextModel] { TextModel.all.filter { states[$0.id] == .ready } }

    func delete(_ model: TextModel) {
        downloads[model.id]?.cancel()
        try? FileManager.default.removeItem(at: path(model))
        try? FileManager.default.removeItem(at: path(model).appendingPathExtension("part"))
        states[model.id] = .missing
    }

    func cancel(_ model: TextModel) {
        downloads[model.id]?.cancel()
        downloads[model.id] = nil
        states[model.id] = .missing
    }

    /// Fetches a model: from the first of its addresses that answers, with what was had before kept (a `.part` file,
    /// continued by a range request), checked against its SHA-256 at the end and kept only if it matches.
    func fetch(_ model: TextModel) {
        guard downloads[model.id] == nil else { return }
        states[model.id] = .fetching(0, "")
        downloads[model.id] = Task {
            defer { downloads[model.id] = nil }
            let part = path(model).appendingPathExtension("part")
            var why = "没有一个来源能连上"
            for source in model.sources {
                if Task.isCancelled { return }
                do {
                    try await Fetch.file(from: source, to: part, bytes: model.bytes) { [weak self] had in
                        self?.states[model.id] = .fetching(Double(had) / Double(model.bytes), source.host() ?? "")
                    }
                    states[model.id] = .checking
                    let sum = try await Fetch.sha256(of: part)
                    guard sum == model.sha256 else {
                        try? FileManager.default.removeItem(at: part)
                        why = "下载的文件不完整，已删除，请重试"
                        continue
                    }
                    try FileManager.default.moveItem(at: part, to: path(model))
                    states[model.id] = .ready
                    return
                } catch is CancellationError {
                    return
                } catch {
                    why = "\(source.host() ?? "")：\(error.localizedDescription)"
                }
            }
            states[model.id] = .failed(why)
        }
    }
}

/// A download that goes on from what is had.
nonisolated enum Fetch {
    static func file(from url: URL, to part: URL, bytes: Int64, progress: @escaping @MainActor (Int64) -> Void) async throws {
        let had = (try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? Int64) ?? 0
        if had >= bytes { return }
        var request = URLRequest(url: url, timeoutInterval: 30)
        if had > 0 { request.setValue("bytes=\(had)-", forHTTPHeaderField: "Range") }
        let (stream, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 206 else {
            throw Refusal("HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        // A server that does not take the range sends the whole file again.
        let resumed = http.statusCode == 206
        if !resumed { try? FileManager.default.removeItem(at: part) }
        if !FileManager.default.fileExists(atPath: part.path) { FileManager.default.createFile(atPath: part.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: part)
        defer { try? handle.close() }
        try handle.seekToEnd()
        var written = resumed ? had : 0
        var buffer = Data()
        buffer.reserveCapacity(1 << 20)
        var told = Date.distantPast
        for try await byte in stream {
            buffer.append(byte)
            if buffer.count >= 1 << 20 {
                try handle.write(contentsOf: buffer)
                written += Int64(buffer.count)
                buffer.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                if Date().timeIntervalSince(told) > 0.3 { told = Date(); let now = written; await progress(now) }
            }
        }
        try handle.write(contentsOf: buffer)
        written += Int64(buffer.count)
        await progress(written)
        guard written >= bytes else { throw Refusal("连接中断了") }
    }

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
