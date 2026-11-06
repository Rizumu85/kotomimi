import Foundation

/// The self-check: how far ahead of speech this device reads, with each recognizer it has — its own and every
/// downloaded model. The Android app's Japanese recording (LibriVox, 杜子春, public domain;
/// `android/app/src/main/assets/selfcheck-ja.wav`) is read a few times by each, and the best of the runs after the
/// first is the speed — the first also loads the recognizer. A computer reads a voice by reading the same stretch
/// again and again as it grows, so four times as fast as speech keeps up, two to four just, below two not.
@Observable
final class SelfCheck {
    nonisolated struct Result: Codable, Equatable, Sendable {
        /// Seconds of speech read in one second.
        let speed: Double
        /// The first reading, the recognizer's loading included.
        let firstSeconds: Double
        let text: String
        let right: Bool
        let at: Date
    }

    /// `running`: how far, and the recognizer being read with.
    enum Phase: Equatable { case idle, running(Double, String), failed(String) }

    private(set) var phase: Phase = .idle
    /// Per recognizer, by the id it is lent by (`apple-speech`, or a model's).
    private(set) var results: [String: Result] = SelfCheck.kept

    static let runs = 4
    /// What the recording says, as the desktop's models write it.
    static let expected = "元は金持ちの息子でしたが、今は財産を使い尽くして、その日の暮らしにも困るくらい哀れな身分になっているのです。"
    /// The device's recognizer writes some words in kana where the models write kanji, and the other way round:
    /// a reading is taken as right with up to this share of its letters different.
    static let wrongAtMost = 0.3

    private var task: Task<Void, Never>?

    private static var kept: [String: Result] {
        guard let data = UserDefaults.standard.data(forKey: "selfcheck.results") else {
            // What a version before this kept: the device's own recognition's alone.
            guard let one = UserDefaults.standard.data(forKey: "selfcheck.result"), let result = try? JSONDecoder().decode(Result.self, from: one) else { return [:] }
            return [Lending.modelId: result]
        }
        return (try? JSONDecoder().decode([String: Result].self, from: data)) ?? [:]
    }

    var running: Bool { if case .running = phase { true } else { false } }

    /// The result of the recognizer lent now.
    func result(_ lending: Lending) -> Result? { results[lending.lentModel?.id ?? Lending.modelId] }

    func start(_ hearing: Hearing, _ lending: Lending, _ text: TextStore) {
        guard !running else { return }
        guard let url = Bundle.main.url(forResource: "selfcheck-ja", withExtension: "wav"),
              let data = try? Data(contentsOf: url), let wav = Wav(data) else {
            phase = .failed("安装包里没有检测录音")
            return
        }
        // Every recognizer that hears the recording's Japanese.
        let own = hearing.ready.contains { $0.id == "ja" }
        let models = text.ready.filter { $0.kind == .hear && $0.languages.contains("ja") }
        guard own || !models.isEmpty else {
            phase = .failed("检测用的是一段日语录音，请先下载日语或一个识别模型")
            return
        }
        let samples = wav.samples.map { Float($0) / 32768 }
        let order: [(id: String, name: String)] = (own ? [(Lending.modelId, "系统语音识别")] : []) + models.map { ($0.id, $0.name) }
        let total = Double(order.count * SelfCheck.runs)
        phase = .running(0, order[0].name)
        task = Task {
            var done = 0.0
            for (id, name) in order {
                var took: [Double] = []
                var said = ""
                do {
                    for _ in 0..<SelfCheck.runs {
                        if Task.isCancelled { phase = .idle; await lending.freeIdleRecognizer(); return }
                        phase = .running(done / total, name)
                        let began = Date()
                        if let model = models.first(where: { $0.id == id }) {
                            said = try await lending.hearEngine.read(model, at: text.path(model), samples: samples, rate: Int(wav.rate), language: "ja")
                        } else {
                            said = try await hearing.read(wav, in: "ja")
                        }
                        took.append(Date().timeIntervalSince(began))
                        done += 1
                    }
                } catch {
                    phase = .failed("\(name)：\(error)")
                    await lending.freeIdleRecognizer()
                    return
                }
                let best = took.dropFirst().min() ?? took[0]
                let wrong = SelfCheck.distance(SelfCheck.letters(said), SelfCheck.letters(SelfCheck.expected))
                results[id] = Result(speed: wav.seconds / best, firstSeconds: took[0], text: said,
                                     right: wrong <= Int(Double(SelfCheck.letters(SelfCheck.expected).count) * SelfCheck.wrongAtMost), at: Date())
                if let data = try? JSONEncoder().encode(results) { UserDefaults.standard.set(data, forKey: "selfcheck.results") }
            }
            // The models read and not lent go: they hold gigabytes the text models need.
            await lending.freeIdleRecognizer()
            phase = .idle
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        phase = .idle
    }

    private static func letters(_ text: String) -> [Character] { text.filter { $0.isLetter || $0.isNumber }.map { $0 } }

    /// How many letters must change to make one text the other.
    private static func distance(_ a: [Character], _ b: [Character]) -> Int {
        if a.isEmpty { return b.count }
        var row = Array(0...b.count)
        for i in 1...a.count {
            var previous = row[0]
            row[0] = i
            for j in stride(from: 1, through: b.count, by: 1) {
                let here = row[j]
                row[j] = min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] == b[j - 1] ? 0 : 1))
                previous = here
            }
        }
        return row[b.count]
    }
}
