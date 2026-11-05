import Foundation
import audiocpp
import os

/// The desktop's recognition engine, audio.cpp v0.9.0, in this process (its C library, audiocpp.framework, built by
/// scripts/build-audiocpp.sh): the desktop's recognition models, read here a stretch at a time on Metal, as the
/// desktop reads them (`readWhole` in electron/native-engine.js).
///
/// One model is held at a time — each is two or three gigabytes — and stays loaded until another is asked for or the
/// system says memory is short. One reading at a time, on a thread of its own: a reading holds it for a second or so.
nonisolated final class HearingEngine: @unchecked Sendable {
    struct Refusal: Error, CustomStringConvertible { let description: String }

    private let queue = DispatchQueue(label: "hearing-engine", qos: .userInitiated)
    /// Only touched on `queue`.
    private var registry: OpaquePointer?
    private var loaded: (id: String, model: OpaquePointer, session: OpaquePointer)?
    private let up = OSAllocatedUnfairLock<String?>(initialState: nil)

    /// The model loaded now, if any: read from any thread.
    var loadedId: String? { up.withLock { $0 } }

    /// What a stretch says. `language`: the app's code (`ja`), or nil for one the model is to tell itself. `context`:
    /// the words to expect, for a model that takes them (Qwen3-ASR), as the computer words them.
    func read(_ model: TextModel, at path: URL, samples: [Float], rate: Int, language: String?, context: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<String, Error>) in
            queue.async { [self] in
                do { done.resume(returning: try readHere(model, at: path, samples: samples, rate: rate, language: language, context: context)) } catch { done.resume(throwing: error) }
            }
        }
    }

    /// Lets the model go: when the system says memory is short, or the text models need the room.
    func release() {
        queue.async { [self] in freeHere() }
    }

    /// The same, done once this returns.
    func releaseNow() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                freeHere()
                done.resume()
            }
        }
    }

    private func freeHere() {
        if let held = loaded {
            audiocpp_session_free(held.session)
            audiocpp_model_free(held.model)
        }
        loaded = nil
        up.withLock { $0 = nil }
    }

    private static func failure(_ what: String, _ status: audiocpp_status) -> Refusal {
        let detail = String(cString: audiocpp_last_error())
        return Refusal(description: "\(what): \(detail.isEmpty ? String(cString: audiocpp_status_string(status)) : detail)")
    }

    private func sessionHere(_ model: TextModel, at path: URL) throws -> OpaquePointer {
        if let held = loaded, held.id == model.id { return held.session }
        freeHere()
        if registry == nil {
            var made: OpaquePointer?
            let status = audiocpp_registry_create(nil, &made)
            guard status == AUDIOCPP_OK, let made else { throw HearingEngine.failure("The engine did not start", status) }
            registry = made
        }
        // Nothing is known of it in the simulator, which says 0.
        let free = Int(os_proc_available_memory() / 1_048_576)
        guard free == 0 || free >= model.holdsMb else {
            throw Refusal(description: "This device has not the memory for \(model.name) now: it needs about \(model.holdsMb) MB, and \(free) MB can be had.")
        }
        var made: OpaquePointer?
        let status: audiocpp_status = model.family!.withCString { family in
            var config = audiocpp_model_config(family_hint: family, config_id: nil, weight_id: nil, model_spec_override: nil)
            return audiocpp_model_load(registry, path.path, &config, nil, &made)
        }
        guard status == AUDIOCPP_OK, let made else { throw HearingEngine.failure("\(model.name) could not be loaded", status) }
        var session: OpaquePointer?
        // The simulator's Metal cannot hold a model's weights (it traps making a buffer of them): there, the processor.
        #if targetEnvironment(simulator)
        let backendName = "cpu"
        #else
        let backendName = "metal"
        #endif
        let opened: audiocpp_status = backendName.withCString { backend in
            var config = audiocpp_backend_config(backend: backend, device: 0, threads: 4)
            return audiocpp_session_create(made, "asr", "offline", &config, nil, &session)
        }
        guard opened == AUDIOCPP_OK, let session else {
            audiocpp_model_free(made)
            throw HearingEngine.failure("\(model.name) could not be started", opened)
        }
        loaded = (model.id, made, session)
        up.withLock { $0 = model.id }
        return session
    }

    private func readHere(_ model: TextModel, at path: URL, samples: [Float], rate: Int, language: String?, context: String?) throws -> String {
        let session = try sessionHere(model, at: path)
        guard let request = audiocpp_request_create() else { throw Refusal(description: "The engine has no memory for the request.") }
        defer { audiocpp_request_free(request) }
        let status = samples.withUnsafeBufferPointer { audiocpp_request_set_audio(request, $0.baseAddress, $0.count, Int32(rate), 1) }
        guard status == AUDIOCPP_OK else { throw HearingEngine.failure("The sound could not be handed over", status) }
        // Told as the desktop tells it: Qwen3-ASR by the code, R2T2 by the English name.
        if let language {
            let said = model.languageAs == .name ? TextModel.languageNames[language] : language
            if let said { _ = audiocpp_request_set_option(request, "language", said) }
        }
        // The words to expect go as the request's text, as the desktop's server passes its form's `text`; only
        // Qwen3-ASR reads it.
        if let context, !context.isEmpty, model.family == "qwen3_asr" { _ = audiocpp_request_set_text(request, context, nil) }
        var result: OpaquePointer?
        let ran = audiocpp_session_run(session, request, &result)
        guard ran == AUDIOCPP_OK, let result else { throw HearingEngine.failure("\(model.name) could not read the sound", ran) }
        defer { audiocpp_result_free(result) }
        var text: UnsafePointer<CChar>?
        let got = audiocpp_result_text(result, &text, nil)
        if got == AUDIOCPP_ERR_NOT_AVAILABLE { return "" }
        guard got == AUDIOCPP_OK, let text else { throw HearingEngine.failure("\(model.name) gave no text", got) }
        return String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
