import Foundation

/// The self-check: how far ahead of speech this device reads. The Android app's Japanese recording (LibriVox,
/// 杜子春, public domain; `android/app/src/main/assets/selfcheck-ja.wav`) is read a few times, and the best of the
/// runs after the first is the speed — the first also loads the recognizer. A computer reads a voice by reading the
/// same stretch again and again as it grows, so four times as fast as speech keeps up, two to four just, below two not.
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

    enum Phase: Equatable { case idle, running(Double), failed(String) }

    private(set) var phase: Phase = .idle
    private(set) var result: Result? = SelfCheck.kept

    static let runs = 4
    /// What the recording says, as the desktop's models write it.
    static let expected = "元は金持ちの息子でしたが、今は財産を使い尽くして、その日の暮らしにも困るくらい哀れな身分になっているのです。"
    /// The device's recognizer writes some words in kana where the models write kanji, and the other way round:
    /// a reading is taken as right with up to this share of its letters different.
    static let wrongAtMost = 0.3

    private var task: Task<Void, Never>?

    private static var kept: Result? {
        guard let data = UserDefaults.standard.data(forKey: "selfcheck.result") else { return nil }
        return try? JSONDecoder().decode(Result.self, from: data)
    }

    var running: Bool { if case .running = phase { true } else { false } }

    func start(_ hearing: Hearing) {
        guard !running else { return }
        guard let url = Bundle.main.url(forResource: "selfcheck-ja", withExtension: "wav"),
              let data = try? Data(contentsOf: url), let wav = Wav(data) else {
            phase = .failed("安装包里没有检测录音")
            return
        }
        guard hearing.ready.contains(where: { $0.id == "ja" }) else {
            phase = .failed("检测用的是一段日语录音，请先下载日语")
            return
        }
        phase = .running(0)
        task = Task {
            var took: [Double] = []
            var text = ""
            do {
                for run in 0..<SelfCheck.runs {
                    if Task.isCancelled { phase = .idle; return }
                    let began = Date()
                    text = try await hearing.read(wav, in: "ja")
                    took.append(Date().timeIntervalSince(began))
                    phase = .running(Double(run + 1) / Double(SelfCheck.runs))
                }
            } catch {
                phase = .failed("\(error)")
                return
            }
            let best = took.dropFirst().min() ?? took[0]
            let made = Result(speed: wav.seconds / best, firstSeconds: took[0], text: text,
                              right: SelfCheck.distance(SelfCheck.letters(text), SelfCheck.letters(SelfCheck.expected)) <= Int(Double(SelfCheck.letters(SelfCheck.expected).count) * SelfCheck.wrongAtMost),
                              at: Date())
            result = made
            if let data = try? JSONEncoder().encode(made) { UserDefaults.standard.set(data, forKey: "selfcheck.result") }
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
