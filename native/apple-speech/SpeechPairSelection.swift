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
        guard !candidates.isEmpty else { return 0 }
        // Confidence may be absent even on final words. Empty or punctuation-only
        // candidates must not win a tie against usable final text.
        let usable = candidates.indices.filter { index in
            candidates[index].text.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
        }
        if usable.count == 1 { return usable[0] }
        // A language with a script of its own is not what a transcript in Latin letters alone is in: a Chinese
        // model writes the English it hears in English, and a short one gets no text consensus below
        // ("Are you weird?" came out Chinese). Such a candidate gives way to one whose language is written so.
        let latinAlone = usable.filter { inLatinAlone(candidates[$0].text) }
        let ruledOut = latinAlone.filter { hasOwnScript(candidates[$0].locale) }
        let kept = ruledOut.count < latinAlone.count ? usable.filter { !ruledOut.contains($0) } : usable
        return choose(among: kept, candidates, preferred: preferred)
    }

    private static func choose(among usable: [Int], _ candidates: [SpeechCandidate], preferred: Int) -> Int {
        if usable.count == 1 { return usable[0] }
        // Some locale-specific Apple models also transcribe other languages. Comparing their
        // speech confidence alone can label identical English text as Chinese. Override only
        // when both sufficiently long transcripts independently agree with high confidence.
        // Unconstrained detection avoids forcing unrelated text into one of the requested languages.
        if let language = usable.compactMap({ clearLanguage(candidates[$0].text) }).first,
           usable.allSatisfy({ clearLanguage(candidates[$0].text) == language }) {
            let matches = candidates.indices.filter { candidates[$0].locale.language.languageCode?.identifier == language }
            if matches.count == 1 { return matches[0] }
        }
        let fallback = usable.max { candidates[$0].confidence < candidates[$1].confidence } ?? preferred
        guard usable.contains(preferred) else { return fallback }
        let others = usable.filter { $0 != preferred }
        guard let surestOther = others.max(by: { candidates[$0].confidence < candidates[$1].confidence }) else { return preferred }
        return candidates[surestOther].confidence > candidates[preferred].confidence + tie ? surestOther : preferred
    }

    /// Whether a locale's language is written in a script other than Latin letters (Han, kana, hangul, Cyrillic…).
    private static func hasOwnScript(_ locale: Locale) -> Bool {
        let script = Locale.Language(identifier: locale.language.maximalIdentifier).script?.identifier
        return script != nil && script != "Latn"
    }

    /// Whether a text has letters, at least two, and every one of them Latin.
    private static func inLatinAlone(_ text: String) -> Bool {
        let letters = text.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        // Basic Latin to Latin Extended-B, and Latin Extended Additional (Vietnamese).
        return letters.count >= 2 && letters.allSatisfy { $0.value < 0x250 || (0x1E00...0x1EFF).contains($0.value) }
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
