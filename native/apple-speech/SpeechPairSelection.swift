import Foundation
import NaturalLanguage

/// A recognizer's locale is a request, not proof of the language it transcribed.
struct SpeechCandidate {
    let text: String
    let confidence: Double
    let locale: Locale
}

enum SpeechPairSelection {
    static let tie = 0.05

    static func choose(_ candidates: [SpeechCandidate], preferred: Int) -> Int {
        guard candidates.count == 2 else { return 0 }
        // Some locale-specific Apple models also transcribe other languages. Comparing their
        // speech confidence alone can label identical English text as Chinese. Override only
        // when both sufficiently long transcripts independently agree with high confidence.
        // Unconstrained detection avoids forcing unrelated text into one of the requested languages.
        if let language = clearLanguage(candidates[0].text),
           clearLanguage(candidates[1].text) == language {
            let matches = candidates.indices.filter { candidates[$0].locale.language.languageCode?.identifier == language }
            if matches.count == 1 { return matches[0] }
        }
        let other = 1 - preferred
        return candidates[other].confidence > candidates[preferred].confidence + tie ? other : preferred
    }

    private static func clearLanguage(_ text: String) -> String? {
        guard text.unicodeScalars.filter({ CharacterSet.letters.contains($0) }).count >= 12 else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let ranked = recognizer.languageHypotheses(withMaximum: 2).sorted { $0.value > $1.value }
        guard let first = ranked.first, first.value >= 0.8,
              first.value - (ranked.dropFirst().first?.value ?? 0) >= 0.2 else { return nil }
        return Locale(identifier: first.key.rawValue).language.languageCode?.identifier
    }
}
