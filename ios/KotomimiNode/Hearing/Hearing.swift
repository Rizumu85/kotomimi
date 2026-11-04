import AVFoundation
import Foundation
import Speech

/// The device's own speech recognition (SpeechAnalyzer with a SpeechTranscriber, iOS 26), as this app lends it: one
/// stretch of sound read whole, the way the Android app's engines read one. It is the recognizer the Mac's helper
/// drives (native/apple-speech/SpeechHelper.swift), and the one measured best on Japanese conversation — on the Mac
/// about 12.5 % of the characters wrong, where the best downloaded model is at 16-17 %.
///
/// Its "models" are the system's languages, each fetched by the system on its own when asked
/// (`AssetInventory`). The languages offered are the desktop's for the same recognizer (`LOCALES` in
/// electron/apple-speech.js).
@Observable
final class Hearing {
    enum State: Equatable { case unknown, offered, fetching(Double), ready, unsupported }

    struct Language: Identifiable, Equatable {
        /// The app's code for it, as the computer sends it (`ja`).
        let id: String
        /// The system's locale for it.
        let locale: String
        let name: String
        var state: State = .unknown
    }

    private(set) var languages: [Language] = Hearing.offered.map { Language(id: $0.0, locale: $0.1, name: $0.2) }
    private(set) var available = SpeechTranscriber.isAvailable

    /// The language a stretch is read in where the computer says none.
    var preferred: String = UserDefaults.standard.string(forKey: "hearing.preferred") ?? Hearing.systemDefault {
        didSet { UserDefaults.standard.set(preferred, forKey: "hearing.preferred") }
    }

    var ready: [Language] { languages.filter { $0.state == .ready } }

    static let offered: [(String, String, String)] = [
        ("ja", "ja_JP", "日语"), ("en", "en_US", "英语"), ("zh", "zh_CN", "普通话"), ("yue", "yue_CN", "粤语"), ("ko", "ko_KR", "韩语"),
        ("es", "es_ES", "西班牙语"), ("fr", "fr_FR", "法语"), ("de", "de_DE", "德语"), ("it", "it_IT", "意大利语"), ("pt", "pt_BR", "葡萄牙语"), ("hi", "hi_IN", "印地语"),
    ]

    private static var systemDefault: String {
        let code = Locale.current.language.languageCode?.identifier ?? "ja"
        return offered.contains { $0.0 == code } ? code : "ja"
    }

    /// The app's code for what a computer said: `ja`, `ja-JP`, `ja_JP` or `Japanese`. Nil for a language not offered.
    static func code(for said: String) -> String? {
        let word = said.trimmingCharacters(in: .whitespaces).lowercased()
        let base = String(word.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "")
        if offered.contains(where: { $0.0 == base }) { return base }
        let english = ["japanese": "ja", "english": "en", "chinese": "zh", "mandarin": "zh", "cantonese": "yue", "korean": "ko",
                       "spanish": "es", "french": "fr", "german": "de", "italian": "it", "portuguese": "pt", "hindi": "hi"]
        return english[word]
    }

    func name(of code: String) -> String { languages.first { $0.id == code }?.name ?? code }

    /// What the system offers and has installed now.
    func refresh() async {
        available = SpeechTranscriber.isAvailable
        let supported = Set(await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) })
        let installed = Set(await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) })
        for index in languages.indices {
            if case .fetching = languages[index].state { continue }
            let tag = Locale(identifier: languages[index].locale).identifier(.bcp47)
            languages[index].state = installed.contains(tag) ? .ready : supported.contains(tag) ? .offered : .unsupported
        }
        if !ready.contains(where: { $0.id == preferred }), let first = ready.first { preferred = first.id }
    }

    /// Has the system fetch a language, with its progress on the language's row. Throws what the system said.
    func install(_ code: String) async throws {
        guard let index = languages.firstIndex(where: { $0.id == code }) else { return }
        languages[index].state = .fetching(0)
        defer { Task { await refresh() } }
        let locale = try await Hearing.locale(languages[index].locale)
        try await makeRoom(for: locale)
        try await AssetInventory.reserve(locale: locale)
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            let watching = Task { [weak self] in
                while !Task.isCancelled {
                    if let self, let at = languages.firstIndex(where: { $0.id == code }) {
                        languages[at].state = .fetching(request.progress.fractionCompleted)
                    }
                    try? await Task.sleep(for: .milliseconds(400))
                }
            }
            defer { watching.cancel() }
            try await request.downloadAndInstall()
        }
        if ready.isEmpty { preferred = code }
    }

    /// Lets a language go: the system keeps its assets until it wants the room.
    func release(_ code: String) async {
        guard let language = languages.first(where: { $0.id == code }),
              let locale = try? await Hearing.locale(language.locale) else { return }
        await AssetInventory.release(reservedLocale: locale)
        await refresh()
    }

    /// The system lets an app keep only so many languages reserved, and refuses one more: one not installed is let
    /// go first, else one that is not the preferred one. (As the Mac's helper does, `makeRoom`.)
    private func makeRoom(for locale: Locale) async throws {
        let reserved = await AssetInventory.reservedLocales
        guard !reserved.contains(where: { $0.identifier == locale.identifier }),
              reserved.count >= AssetInventory.maximumReservedLocales else { return }
        let installed = Set(await SpeechTranscriber.installedLocales.map(\.identifier))
        let keep = languages.first { $0.id == preferred }.map { Locale(identifier: $0.locale).identifier }
        let free = reserved.filter { $0.identifier != keep }
        if let gone = free.first(where: { !installed.contains($0.identifier) }) ?? free.first {
            await AssetInventory.release(reservedLocale: gone)
        }
    }

    static func locale(_ identifier: String) async throws -> Locale {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
            throw Refusal("This device's speech recognition has no \(identifier).")
        }
        return locale
    }

    // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────

    /// One reading at a time, in the order asked: two analyzers at once share the same Neural Engine.
    private let turn = Turn()

    /// One stretch of sound, read whole, in the language `code`: the text it settled on.
    ///
    /// The recognizer is asked for its considered text only (no volatile or fast results). On the Mac the fast
    /// results were worse, and what this device answers is read again and again by the computer as the stretch
    /// grows (`openWindow` in electron/native-engine.js), which gives it what shows meanwhile.
    func read(_ wav: Wav, in code: String) async throws -> String {
        guard let language = languages.first(where: { $0.id == code }) else { throw Refusal("No such language: \(code).") }
        await turn.take()
        defer { Task { await turn.give() } }
        let locale = try await Hearing.locale(language.locale)
        guard await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == locale.identifier }) else {
            throw Refusal("\(language.name) is not downloaded on this device: download it there first.")
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        // The recognizer takes 16-bit samples of the rate it names; it traps on floating point rather than converting.
        let formats = await transcriber.availableCompatibleAudioFormats
        guard let format = formats.first(where: { $0.commonFormat == .pcmFormatInt16 && $0.channelCount == 1 })
                ?? formats.first(where: { $0.commonFormat == .pcmFormatInt16 }) else {
            throw Refusal("This language does not take 16-bit sound.")
        }
        let buffer = try Hearing.buffer(of: wav, in: format)
        let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        try await analyzer.prepareToAnalyze(in: format)
        let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
        let kept = Task { () -> String in
            var text = ""
            for try await result in transcriber.results where result.isFinal {
                text += String(result.text.characters)
            }
            return text
        }
        do {
            try await analyzer.start(inputSequence: input)
            feed.yield(AnalyzerInput(buffer: buffer))
            feed.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            feed.finish()
            await analyzer.cancelAndFinishNow()
            kept.cancel()
            throw error
        }
        return try await kept.value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The recording as one buffer of `format`: as it is where the rates agree, else converted.
    private static func buffer(of wav: Wav, in format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let count = AVAudioFrameCount(wav.samples.count)
        guard let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: wav.rate, channels: 1, interleaved: true),
              let given = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: max(count, 1)) else { throw Refusal("Cannot hold the sound.") }
        given.frameLength = count
        wav.samples.withUnsafeBufferPointer { samples in
            if let base = samples.baseAddress { given.int16ChannelData![0].update(from: base, count: samples.count) }
        }
        if source.sampleRate == format.sampleRate && format.channelCount == 1 && format.isInterleaved == source.isInterleaved { return given }
        guard let converter = AVAudioConverter(from: source, to: format) else { throw Refusal("Cannot convert the sound.") }
        let capacity = AVAudioFrameCount((Double(count) * format.sampleRate / source.sampleRate).rounded(.up)) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw Refusal("Cannot hold the sound.") }
        nonisolated(unsafe) var handed = false
        var failure: NSError?
        let status = converter.convert(to: out, error: &failure) { _, said in
            if handed { said.pointee = .endOfStream; return nil }
            handed = true
            said.pointee = .haveData
            return given
        }
        if status == .error { throw Refusal("Cannot convert the sound: \(failure?.localizedDescription ?? "no reason given").") }
        return out
    }
}

/// A reason a request is not met, in words for the computer.
nonisolated struct Refusal: Error, CustomStringConvertible, Sendable {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Who waits for the recognizer, in the order they came: the first has the turn.
actor Turn {
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func take() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiting.append($0) }
    }

    func give() {
        if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
    }
}
