import AVFoundation
import Foundation
import Speech

/// The recognizers the app has running at once. iOS gives an app two: a third is refused ("Maximum number of
/// recognizers reached", SFSpeechErrorDomain 16; measured on an iPad M2, iPadOS 26, 2026-11-05) — where the Mac's
/// helper, a process for each stretch, runs four for two languages. So they are shared out here: what is kept takes
/// a place first, and a fast recognizer that only shows what is being said (`LiveHearing`) gives its place up to it.
final class Recognizers {
    static let shared = Recognizers()
    static let most = 2

    private(set) var used = 0
    /// Fast recognizers that may be stopped for a place: each frees its places and says how many.
    private var yielding: [(owner: ObjectIdentifier, free: () async -> Int)] = []

    /// `count` places, freeing fast ones where there are too few (`yield`): false where there are not enough even so.
    func take(_ count: Int, yield: Bool = true) async -> Bool {
        while Recognizers.most - used < count, yield, let last = yielding.popLast() { used -= await last.free() }
        guard Recognizers.most - used >= count else { return false }
        used += count
        return true
    }

    func give(_ count: Int) { used = max(0, used - count) }

    func mayYield(_ owner: AnyObject, free: @escaping () async -> Int) { yielding.append((ObjectIdentifier(owner), free)) }

    func keep(_ owner: AnyObject) { yielding.removeAll { $0.owner == ObjectIdentifier(owner) } }
}

/// One stretch of speech heard while it is spoken, as the Mac's own recognition hears it: the same recognizer, driven
/// the same way (`stream` in native/apple-speech/SpeechHelper.swift, which this follows step for step), so that a
/// computer lent this device reads it as it reads its Mac. Reading a stretch whole and again as it grew
/// (`Hearing.read`) heard less well: the recognizer works best on a voice as it comes.
///
/// In one language, a considered recognizer writes the text that is kept and a fast one what shows while someone
/// speaks (asked for fast results, the considered one writes worse), as on the Mac. Given a second language (`also`),
/// the app's two places hold one recognizer for each, asked for fast results, kept and shown alike: the Mac's four do
/// not fit (`Recognizers`), and a considered one shows nothing for ten seconds at a time. The sentence is given to the
/// language it was in (`SpeechPairSelection`, the Mac's own file). Where another stretch has taken the fast one's
/// place, the considered one also says what it has so far, less often.
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

        /// `fast`: asked for fast results; `volatile`: also says what it has so far.
        init(locale: Locale, fast: Bool, volatile: Bool, confidence: Bool) async throws {
            transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: fast ? [.volatileResults, .fastResults] : volatile ? [.volatileResults] : [],
                attributeOptions: confidence ? [.audioTimeRange, .transcriptionConfidence] : [.audioTimeRange]
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

    /// What shows while someone speaks: the text so far of the preferred language, unless the other's is surer of
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
    private var quick: Listener?
    private var kept: [Task<Settled, Error>] = []
    private var shown: [Task<Void, Never>] = []
    private var samples = 0
    private var over = false
    /// The places this stretch holds (`Recognizers`).
    private var holds: Int

    private init(codes: [String], locales: [Locale], preferred: Int, considered: [Listener], quick: Listener?, holds: Int) {
        self.codes = codes
        self.locales = locales
        self.preferred = preferred
        self.considered = considered
        self.quick = quick
        self.holds = holds
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
        let places = Recognizers.shared
        guard await places.take(locales.count) else {
            throw Refusal("This device is hearing as much as it can at once: it runs \(Recognizers.most) recognitions at a time.")
        }
        // One language: a considered recognizer, and a fast one for what shows where there is a place left for it,
        // taken from no one. Two fill the app's places: each language's one recognizer is asked for fast results,
        // which show at once and are kept — a considered one says what it has so far only every ten seconds or so,
        // and the speaker would see nothing while speaking.
        let fast = !both ? await places.take(1, yield: false) : false
        var considered: [Listener] = []
        var quick: Listener?
        do {
            for locale in locales { considered.append(try await Listener(locale: locale, fast: both, volatile: !fast, confidence: both)) }
            if fast { quick = try await Listener(locale: locales[0], fast: true, volatile: true, confidence: false) }
        } catch {
            places.give(locales.count + (fast ? 1 : 0))
            throw error
        }
        let live = LiveHearing(codes: codes, locales: locales, preferred: preferred, considered: considered, quick: quick, holds: locales.count + (fast ? 1 : 0))
        let shownNow = Shown(count: locales.count, preferred: preferred)
        // What is kept: each considered recognizer's text, in the order it was spoken — and what shows, where no fast
        // one runs.
        live.kept = considered.enumerated().map { at, listener in
            Task { () -> Settled in
                var settled = Settled()
                var lastEnd = CMTime.zero
                for try await result in listener.transcriber.results {
                    if result.isFinal {
                        guard CMTimeCompare(result.range.start, lastEnd) >= 0 else { throw Refusal("Overlapping stretches of settled speech.") }
                        lastEnd = CMTimeRangeGetEnd(result.range)
                        let delta = String(result.text.characters)
                        settled.text += delta
                        settled.add(result.text)
                        if !both, !delta.isEmpty { emit(["type": "delta", "text": delta]) }
                    }
                    if !fast {
                        var now = settled
                        if !result.isFinal { now.text += String(result.text.characters); now.add(result.text) }
                        if !result.isFinal || both, let text = shownNow.update(at, now) { emit(["type": "partial", "text": text]) }
                    }
                }
                return settled
            }
        }
        // What shows meanwhile: the fast recognizer's text so far, settled and not, of the language surer so far.
        live.shown = (quick.map { [$0] } ?? []).enumerated().map { at, listener in
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
            for listener in considered { try await listener.start() }
            try await quick?.start()
        } catch {
            await live.cancel()
            throw error
        }
        // Another stretch that needs a place takes a fast one's: this one then shows nothing more until it ends.
        if fast { places.mayYield(live) { [weak live] in await live?.stopFast() ?? 0 } }
        return live
    }

    /// The fast recognizers stopped, for another stretch to have their places: how many there were.
    private func stopFast() async -> Int {
        guard let stopped = quick else { return 0 }
        quick = nil
        stopped.finish()
        await stopped.analyzer.cancelAndFinishNow()
        for task in shown { task.cancel() }
        holds -= 1
        return 1
    }

    /// Some more of the stretch: 16-bit little-endian mono samples at 16 kHz.
    func hear(_ data: Data) throws {
        guard !over else { return }
        guard data.count % 2 == 0 else { throw Refusal("Not 16-bit sound.") }
        guard !data.isEmpty else { return }
        samples += data.count / 2
        guard samples <= LiveHearing.mostSamples else { throw Refusal("The sound is longer than one stretch takes.") }
        for listener in considered { try listener.hear(data) }
        try quick?.hear(data)
    }

    /// The stretch is over: the text kept, and the language (the app's code) it was heard in.
    func finish() async throws -> (text: String, code: String) {
        over = true
        Recognizers.shared.keep(self)
        for listener in considered { listener.finish() }
        quick?.finish()
        if samples == 0 {
            for listener in considered { await listener.analyzer.cancelAndFinishNow() }
            await quick?.analyzer.cancelAndFinishNow()
            end()
            return ("", codes[0])
        }
        do {
            // The fast one has done its part: only the kept text is waited for, every language's at once.
            await quick?.analyzer.cancelAndFinishNow()
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
        Recognizers.shared.keep(self)
        for listener in considered {
            listener.finish()
            await listener.analyzer.cancelAndFinishNow()
        }
        quick?.finish()
        await quick?.analyzer.cancelAndFinishNow()
        end()
    }

    /// The tasks stopped and the places given back, once.
    private func end() {
        for task in kept { task.cancel() }
        for task in shown { task.cancel() }
        Recognizers.shared.give(holds)
        holds = 0
    }
}
