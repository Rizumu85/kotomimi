// Fork: the Mac's own speech recognition, for Kotomimi.
//
// macOS 26 and later carry a recognizer (SpeechAnalyzer with a
// SpeechTranscriber) that runs on the device and, measured on Japanese
// conversation, hears better than any model the app can download. This
// helper is the app's way to it: started by the app (`electron/apple-speech.js`)
// once for each stretch of speech, given the sound on its standard input and
// writing the text on its standard output, a JSON object to a line both ways.
//
//   speech-helper inventory          what the system offers, and what is installed
//   speech-helper install LOCALE     fetch a language's assets, with progress
//   speech-helper release LOCALE     let a language's assets go
//   speech-helper stream LOCALE      recognize what is given on standard input
//
// A stream takes  {"type":"audio","pcm":"<base64 of 16-bit little-endian mono at 16 kHz>"}
// and at the end  {"type":"end"};  it writes  {"type":"ready"},  then
// {"type":"partial","text":…}  — everything heard so far, as it stands now —
// {"type":"delta","text":…}  for text that will not change any more, and
// {"type":"final","text":…}  with the whole.
//
// Two recognizers listen to the same sound. The system's recognizer writes
// its considered text only every ten seconds or so, or when the sound ends;
// asked for fast results it writes within a second, but less well, and what
// it finally settles on is worse too (measured: 「お正月のイメージ」 became
// 「お正のイメージ」). So the fast one is used for what shows while someone is
// speaking, and the considered one for the text that is kept. One analyzer
// cannot hold both — given both, the fast one stops being fast — so each has
// its own.
//
// It must be run from inside its bundle: the system gives the recognizer only
// to a program with a bundle identifier.

import AVFoundation
import Darwin
import Foundation
import Speech

private struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private struct AudioMessage: Decodable {
    let type: String
    let pcm: String?
}

/// One recognizer listening: its analyzer, and the way sound is handed to it.
@MainActor
private final class Listener {
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    let format: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let input: AsyncStream<AnalyzerInput>

    init(locale: Locale, fast: Bool) async throws {
        transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: fast ? [.volatileResults, .fastResults] : [],
            attributeOptions: fast ? [] : [.audioTimeRange]
        )
        // The recognizer takes 16-bit samples as they are; it traps on floating point rather than converting it.
        let formats = await transcriber.availableCompatibleAudioFormats
        guard let format = formats.first(where: {
            $0.commonFormat == .pcmFormatInt16 && $0.sampleRate == 16000 && $0.channelCount == 1
        }) else { throw HelperError("This language does not take mono 16 kHz 16-bit sound") }
        self.format = format
        analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
        try await analyzer.prepareToAnalyze(in: format)
        (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    }

    func start() async throws { try await analyzer.start(inputSequence: input) }

    func hear(_ samples: Data) throws {
        let count = samples.count / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.int16ChannelData?[0] else { throw HelperError("Cannot allocate a sound buffer") }
        buffer.frameLength = AVAudioFrameCount(count)
        samples.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: count * 2))
        continuation.yield(AnalyzerInput(buffer: buffer))
    }

    func finish() { continuation.finish() }
}

@main
@MainActor
struct SpeechHelper {
    /// The longest one stream may run: the app closes a stretch of speech long before.
    static let maxSamples = 120 * 16000

    static func emit(_ fields: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }

    static func locale(_ identifier: String) async throws -> Locale {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
            throw HelperError("The system's speech recognition has no \(identifier)")
        }
        return locale
    }

    static func inventory() async throws {
        let installed = Set(await SpeechTranscriber.installedLocales.map(\.identifier))
        let supported = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted()
        try emit(["type": "inventory", "available": SpeechTranscriber.isAvailable,
                  "locales": supported.map { ["locale": $0, "installed": installed.contains($0)] },
                  "reserved": await AssetInventory.reservedLocales.map(\.identifier),
                  "maximumReserved": AssetInventory.maximumReservedLocales])
    }

    /// Kotomimi: the system lets an app keep only so many languages reserved (`maximumReservedLocales`, 5 on macOS
    /// 27), and refuses one more. Where they are all taken, one is let go first: one not downloaded, else the one used
    /// longest ago (`order`, oldest first, as the app saw them used), never one in `keep` (heard by a recognition now).
    /// Let go is not deleted: the system keeps a language's assets until it wants the room.
    static func makeRoom(for locale: Locale, keep: Set<String>, order: [String]) async {
        let reserved = await AssetInventory.reservedLocales.map(\.identifier)
        guard !reserved.contains(locale.identifier), reserved.count >= AssetInventory.maximumReservedLocales else { return }
        let installed = Set(await SpeechTranscriber.installedLocales.map(\.identifier))
        let free = reserved.filter { !keep.contains($0) && $0 != locale.identifier }
        guard let gone = free.first(where: { !installed.contains($0) }) ?? order.first(where: { free.contains($0) }) ?? free.first else { return }
        await AssetInventory.release(reservedLocale: Locale(identifier: gone))
        try? emit(["type": "released", "locale": gone])
    }

    static func install(_ identifier: String, keep: Set<String> = [], order: [String] = []) async throws {
        let locale = try await locale(identifier)
        await makeRoom(for: locale, keep: keep, order: order)
        try await AssetInventory.reserve(locale: locale)
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            let progress = Task {
                while !Task.isCancelled {
                    try? emit(["type": "progress", "fraction": request.progress.fractionCompleted])
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            defer { progress.cancel() }
            try await request.downloadAndInstall()
        }
        try emit(["type": "installed", "locale": locale.identifier])
    }

    static func release(_ identifier: String) async throws {
        let locale = try await locale(identifier)
        await AssetInventory.release(reservedLocale: locale)
        try emit(["type": "released", "locale": locale.identifier])
    }

    static func stream(_ identifier: String, keep: Set<String> = [], order: [String] = []) async throws {
        let locale = try await locale(identifier)
        guard await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == locale.identifier }) else {
            throw HelperError("The speech assets for \(locale.identifier) are not installed")
        }
        await makeRoom(for: locale, keep: keep, order: order)
        try await AssetInventory.reserve(locale: locale)
        let considered = try await Listener(locale: locale, fast: false)
        let quick = try await Listener(locale: locale, fast: true)

        // What is kept: the considered recognizer's text, in the order it was spoken.
        let kept = Task {
            var text = ""
            var lastEnd = CMTime.zero
            for try await result in considered.transcriber.results {
                guard result.isFinal else { continue }
                guard CMTimeCompare(result.range.start, lastEnd) >= 0 else { throw HelperError("Overlapping stretches of settled speech") }
                lastEnd = CMTimeRangeGetEnd(result.range)
                let delta = String(result.text.characters)
                text += delta
                if !delta.isEmpty { try emit(["type": "delta", "text": delta]) }
            }
            return text
        }
        // What shows meanwhile: the quick recognizer's text so far, settled and not.
        let shown = Task {
            var settled = ""
            for try await result in quick.transcriber.results {
                let piece = String(result.text.characters)
                if result.isFinal { settled += piece } else { try? emit(["type": "partial", "text": settled + piece]) }
            }
        }
        defer { considered.finish(); quick.finish(); kept.cancel(); shown.cancel() }
        do {
            try await considered.start()
            try await quick.start()
            try emit(["type": "ready"])
            var sampleCount = 0
            var ended = false
            for try await line in FileHandle.standardInput.bytes.lines {
                guard line.utf8.count <= 512 * 1024 else { throw HelperError("A sound message is too large") }
                let message = try JSONDecoder().decode(AudioMessage.self, from: Data(line.utf8))
                if message.type == "end" { ended = true; break }
                guard message.type == "audio", let encoded = message.pcm, let data = Data(base64Encoded: encoded),
                      data.count % 2 == 0, !data.isEmpty else { throw HelperError("Not a 16-bit sound message") }
                sampleCount += data.count / 2
                guard sampleCount <= maxSamples else { throw HelperError("The sound is longer than one stream takes") }
                try considered.hear(data)
                try quick.hear(data)
            }
            guard ended else { throw HelperError("The sound ended without its last message") }
            considered.finish()
            quick.finish()
            if sampleCount == 0 {
                await considered.analyzer.cancelAndFinishNow()
                await quick.analyzer.cancelAndFinishNow()
                try emit(["type": "final", "text": ""])
                return
            }
            // The quick one has done its part: only the considered text is waited for.
            await quick.analyzer.cancelAndFinishNow()
            try await considered.analyzer.finalizeAndFinishThroughEndOfInput()
            try emit(["type": "final", "text": try await kept.value])
        } catch {
            await considered.analyzer.cancelAndFinishNow()
            await quick.analyzer.cancelAndFinishNow()
            throw error
        }
    }

    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        // The app that started it is gone: so is this.
        let parent = getppid()
        let watcher = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                if parent > 1 && getppid() != parent { exit(1) }
            }
        }
        defer { watcher.cancel() }
        do {
            guard SpeechTranscriber.isAvailable, Bundle.main.bundleIdentifier != nil else {
                throw HelperError("The system's speech recognition is not available to this program")
            }
            let arguments = Array(CommandLine.arguments.dropFirst())
            // Kotomimi: `--keep A,B` and `--order A,B` after the locale, for `makeRoom`.
            var options: [String: [String]] = [:]
            var at = 2
            while at + 1 < arguments.count, arguments[at].hasPrefix("--") {
                options[String(arguments[at].dropFirst(2))] = arguments[at + 1].split(separator: ",").map(String.init)
                at += 2
            }
            let plain = at >= arguments.count
            let keep = Set(options["keep"] ?? [])
            let order = options["order"] ?? []
            switch (arguments.first, min(arguments.count, 2), plain) {
            case ("inventory", 1, _): try await inventory()
            case ("install", 2, true): try await install(arguments[1], keep: keep, order: order)
            case ("release", 2, true): try await release(arguments[1])
            case ("stream", 2, true): try await stream(arguments[1], keep: keep, order: order)
            default: throw HelperError("Usage: speech-helper inventory | install LOCALE [--keep L,...] [--order L,...] | release LOCALE | stream LOCALE [--keep L,...] [--order L,...]")
            }
        } catch {
            try? emit(["type": "error", "message": String(describing: error)])
            exit(1)
        }
    }
}
