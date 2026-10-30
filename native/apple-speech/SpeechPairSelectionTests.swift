import Foundation

@main
struct SpeechPairSelectionTests {
    static func main() {
        func candidate(_ text: String, _ confidence: Double, _ locale: String) -> SpeechCandidate {
            SpeechCandidate(text: text, confidence: confidence, locale: Locale(identifier: locale))
        }
        func check(_ name: String, _ candidates: [SpeechCandidate], preferred: Int, expected: Int) {
            let actual = SpeechPairSelection.choose(candidates, preferred: preferred)
            guard actual == expected else { fatalError("\(name): expected \(expected), got \(actual)") }
            print("PASS: \(name)")
        }
        // Measured on macOS: both locale-specific recognizers transcribe this English audio in English.
        let english = [
            candidate("Yesterday I go to the park with my friends. We play games and had a very good time.", 0.9203, "zh_CN"),
            candidate("Yesterday, I go to the park with my friends. We played games and had a very good time.", 0.9489, "en_US"),
        ]
        check("English is not Chinese just because Chinese was preferred", english, preferred: 0, expected: 1)
        check("English remains English with the opposite preference", english, preferred: 1, expected: 1)
        check("Same-script French consensus", [
            candidate("Je voudrais apprendre une nouvelle langue avec mes amis.", 0.94, "en_US"),
            candidate("Je voudrais apprendre une nouvelle langue avec mes amis.", 0.92, "fr_FR"),
        ], preferred: 0, expected: 1)
        check("Chinese consensus", [
            candidate("今天天气很好，我准备和朋友一起去公园散步。", 0.94, "en_US"),
            candidate("今天天气很好，我准备和朋友一起去公园散步。", 0.92, "zh_CN"),
        ], preferred: 0, expected: 1)
        check("Ambiguous short words retain preference", [candidate("OK", 0.93, "en_US"), candidate("OK", 0.94, "fr_FR")], preferred: 0, expected: 0)
        check("Disagreement still uses speech confidence", [
            candidate("I would like to learn a new language.", 0.80, "en_US"),
            candidate("Je voudrais apprendre une nouvelle langue.", 0.95, "fr_FR"),
        ], preferred: 0, expected: 1)
        check("An empty candidate cannot establish consensus", [candidate("", -1, "zh_CN"), english[1]], preferred: 0, expected: 1)
        check("An unrelated text language cannot escape the pair", [
            candidate("Je voudrais apprendre une nouvelle langue avec mes amis.", 0.94, "en_US"),
            candidate("Je voudrais apprendre une nouvelle langue avec mes amis.", 0.92, "zh_CN"),
        ], preferred: 0, expected: 0)
    }
}
