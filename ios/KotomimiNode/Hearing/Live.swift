import AVFoundation
import Foundation
import Speech

/// One stretch of speech heard while it is spoken, as the Mac's own recognition hears it: the same recognizer, driven
/// the same way (`stream` in native/apple-speech/SpeechHelper.swift, which this follows step for step), so that a
/// computer lent this device reads it as it reads its Mac. Reading a stretch whole and again as it grew
/// (`Hearing.read`) heard less well: the recognizer works best on a voice as it comes.
///
/// Two recognizers listen to the same sound. The considered one writes the text that is kept; the fast one, what shows
/// while someone speaks (asked for fast results, the considered one writes worse). Given a second language
/// (`also`), each language has its two, and the sentence is given to the language it was in
/// (`SpeechPairSelection`, the Mac's own file).
///
/// What it writes goes to `emit`: `partial` — everything heard so far, as it stands now — and `delta`, text that will
/// not change any more (one language only: with two, which one is known only at the end).
final class LiveHearing {
    /// The longest one stretch may run: a computer closes one long before (`native/apple-speech`'s `maxSamples`).
    static let mostSamples = 120 * 16000

    /// One recognizer listening: its analyzer, and the way sound is handed to it.
    private final class Listener {
        let transcriber: SpeechTranscriber
        let analyzer: SpeechAnalyzer
        let format: AVAudioFormat
        private let continuation: AsyncStream<AnalyzerInput>.Continuation
        private let input: AsyncStream<AnalyzerInput>

        init(locale: Locale, fast: Bool, confidence: Bool) async throws {
            transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: fast ? [.volatileResults, .fastResults] : [],
                attributeOptions: (fast ? [] : [.audioTimeRange] as Set<SpeechTranscriber.ResultAttributeOption>).union(confidence ? [.transcriptionConfidence] : [])
            )
            // The recognizer takes 16-bit samples as they are; it traps on floating point rather than converting it.
            let formats = await transcriber.availableCompatibleAudioFormats
            guard let format = formats.first(where: { $0.commonFormat == .pcmFormatInt16 && $0.sampleRate == 16000 && $0.channelCount == 1 }) else {
                throw Refusal("This language does not take mono 16 kHz 16-bit sound.")
            }
            self.format = format
            analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
            try await analyzer.prepareToAnalyze(in: format)
            (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        }

        func start() async throws { try await analyzer.start(inputSequence: input) }

        func hear(_ samples: Data) throws {
            let count = samples.count / 2
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                  let channel = buffer.int16ChannelData?[0] else { throw Refusal("Cannot hold the sound.") }
            buffer.frameLength = AVAudioFrameCount(count)
            samples.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: count * 2))
            continuation.yield(AnalyzerInput(buffer: buffer))
        }

        func finish() { continuation.finish() }
    }

    /// The text a recognizer settled on, and how sure it was of it (its characters' mean confidence; -1 for none).
    struct Settled {
        var text = ""
        var weighted = 0.0
        var chars = 0
        var confidence: Double { chars > 0 ? weighted / Double(chars) : -1 }
        mutating func add(_ text: AttributedString) {
            for run in text.runs {
                let n = String(text[run.range].characters).trimmingCharacters(in: .whitespaces).count
                if let c = run.transcriptionConfidence { weighted += c * Double(n); chars += n }
            }
        }
    }

    /// What shows while someone speaks: the quick text of the preferred language, unless the other's is surer of
    /// itself by more than a tie, so that it does not go back and forth between the two.
    private final class Shown {
        private var now: [Settled?]
        private let preferred: Int
        init(count: Int, preferred: Int) { now = Array(repeating: nil, count: count); self.preferred = preferred }
        func update(_ at: Int, _ settled: Settled) -> String? {
            let before = shown()
            now[at] = settled
            let after = shown()
            return after == before ? nil : after
        }
        private func shown() -> String? {
            guard now.count > 1, let first = now[preferred] else { return now.compactMap { $0 }.first?.text }
            guard let second = now[1 - preferred] else { return first.text }
            return second.confidence > first.confidence + SpeechPairSelection.tie ? second.text : first.text
        }
    }

    private let codes: [String]
    private let locales: [Locale]
    private let preferred: Int
    private let considered: [Listener]
    private let quick: [Listener]
    private var kept: [Task<Settled, Error>] = []
    private var shown: [Task<Void, Never>] = []
    private var samples = 0
    private var over = false

    private init(codes: [String], locales: [Locale], preferred: Int, considered: [Listener], quick: [Listener]) {
        self.codes = codes
        self.locales = locales
        self.preferred = preferred
        self.considered = considered
        self.quick = quick
    }

    /// A stretch begun, in the language `code` (the app's), or — given `also` — in either; `prefer` breaks a tie.
    static func open(_ code: String, also: String?, prefer: String?, in hearing: Hearing, emit: @escaping ([String: Any]) -> Void) async throws -> LiveHearing {
        var codes = [code]
        if let also, also != code { codes.append(also) }
        var locales: [Locale] = []
        for code in codes {
            guard let language = hearing.languages.first(where: { $0.id == code }) else { throw Refusal("No such language: \(code).") }
            let locale = try await Hearing.locale(language.locale)
            guard await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == locale.identifier }) else {
                throw Refusal("\(language.name) is not downloaded on this device: download it there first.")
            }
            locales.append(locale)
        }
        let both = locales.count > 1
        let preferred = codes.firstIndex { $0 == prefer } ?? 0
        var considered: [Listener] = []
        var quick: [Listener] = []
        for locale in locales {
            considered.append(try await Listener(locale: locale, fast: false, confidence: both))
            quick.append(try await Listener(locale: locale, fast: true, confidence: both))
        }
        let live = LiveHearing(codes: codes, locales: locales, preferred: preferred, considered: considered, quick: quick)
        // What is kept: each considered recognizer's text, in the order it was spoken.
        live.kept = considered.map { listener in
            Task { () -> Settled in
                var settled = Settled()
                var lastEnd = CMTime.zero
                for try await result in listener.transcriber.results {
                    guard result.isFinal else { continue }
                    guard CMTimeCompare(result.range.start, lastEnd) >= 0 else { throw Refusal("Overlapping stretches of settled speech.") }
                    lastEnd = CMTimeRangeGetEnd(result.range)
                    let delta = String(result.text.characters)
                    settled.text += delta
                    settled.add(result.text)
                    if !both, !delta.isEmpty { emit(["type": "delta", "text": delta]) }
                }
                return settled
            }
        }
        // What shows meanwhile: the quick recognizer's text so far, settled and not, of the language surer so far.
        let shownNow = Shown(count: locales.count, preferred: preferred)
        live.shown = quick.enumerated().map { at, listener in
            Task {
                var settled = Settled()
                do {
                    for try await result in listener.transcriber.results {
                        var now = settled
                        now.text += String(result.text.characters)
                        now.add(result.text)
                        if result.isFinal { settled = now }
                        if !result.isFinal || both, let text = shownNow.update(at, now) { emit(["type": "partial", "text": text]) }
                    }
                } catch {}
            }
        }
        do {
            for listener in considered + quick { try await listener.start() }
        } catch {
            await live.cancel()
            throw error
        }
        return live
    }

    /// Some more of the stretch: 16-bit little-endian mono samples at 16 kHz.
    func hear(_ data: Data) throws {
        guard !over else { return }
        guard data.count % 2 == 0 else { throw Refusal("Not 16-bit sound.") }
        guard !data.isEmpty else { return }
        samples += data.count / 2
        guard samples <= LiveHearing.mostSamples else { throw Refusal("The sound is longer than one stretch takes.") }
        for listener in considered + quick { try listener.hear(data) }
    }

    /// The stretch is over: the text kept, and the language (the app's code) it was heard in.
    func finish() async throws -> (text: String, code: String) {
        over = true
        let listeners = considered + quick
        for listener in listeners { listener.finish() }
        if samples == 0 {
            for listener in listeners { await listener.analyzer.cancelAndFinishNow() }
            end()
            return ("", codes[0])
        }
        do {
            // The quick ones have done their part: only the considered text is waited for, every language's at once.
            for listener in quick { await listener.analyzer.cancelAndFinishNow() }
            let analyzers = considered.map(\.analyzer)
            try await withThrowingTaskGroup(of: Void.self) { group in
                for analyzer in analyzers { group.addTask { try await analyzer.finalizeAndFinishThroughEndOfInput() } }
                try await group.waitForAll()
            }
            var heard: [Settled] = []
            for task in kept { heard.append(try await task.value) }
            let chosen = SpeechPairSelection.choose(heard.enumerated().map { at, candidate in
                SpeechCandidate(text: candidate.text, confidence: candidate.confidence, locale: locales[at])
            }, preferred: preferred)
            end()
            return (heard[chosen].text.trimmingCharacters(in: .whitespacesAndNewlines), codes[chosen])
        } catch {
            await cancel()
            throw error
        }
    }

    /// The stretch dropped: nothing more is written.
    func cancel() async {
        over = true
        for listener in considered + quick {
            listener.finish()
            await listener.analyzer.cancelAndFinishNow()
        }
        end()
    }

    private func end() {
        for task in kept { task.cancel() }
        for task in shown { task.cancel() }
    }
}
