import Foundation

/// A `multipart/form-data` body: its fields by their names, and the file it carries. As the Android app reads it
/// (`formOf` in Share.kt): what is not a form, or has no boundary, is nil.
nonisolated struct Upload: Sendable {
    let fields: [String: String]
    let file: Data?

    private static let fieldMost = 4096

    init?(type: String, body: Data) {
        guard type.lowercased().hasPrefix("multipart/form-data"),
              let boundary = Upload.boundary(in: type), !boundary.isEmpty else { return nil }
        let mark = Data("--\(boundary)".utf8)
        let blank = Data("\r\n\r\n".utf8)
        var fields: [String: String] = [:]
        var file: Data?
        var at = body.range(of: mark)
        while let here = at {
            let start = here.upperBound
            // "--" after the mark: the last one.
            if body.count >= start + 2, body[start] == UInt8(ascii: "-"), body[start + 1] == UInt8(ascii: "-") { break }
            guard let next = body.range(of: mark, in: start..<body.endIndex) else { break }
            if let headEnd = body.range(of: blank, in: start..<next.lowerBound) {
                let head = String(decoding: body[start..<headEnd.lowerBound], as: UTF8.self)
                let from = headEnd.upperBound
                // A part ends with the line break before the next mark.
                let to = max(from, next.lowerBound - 2)
                if let name = Upload.partName(in: head) {
                    if name == "file" { file = Data(body[from..<to]) }
                    else if to - from <= Upload.fieldMost { fields[name] = String(decoding: body[from..<to], as: UTF8.self) }
                }
            }
            at = next
        }
        self.fields = fields
        self.file = file
    }

    private static func boundary(in type: String) -> String? {
        guard let range = type.range(of: "boundary=", options: .caseInsensitive) else { return nil }
        var value = type[range.upperBound...]
        if value.hasPrefix("\"") {
            value = value.dropFirst()
            return value.split(separator: "\"", maxSplits: 1).first.map(String.init)
        }
        return value.split(whereSeparator: { $0 == ";" || $0 == " " }).first.map(String.init)
    }

    private static func partName(in head: String) -> String? {
        for line in head.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-disposition:") {
            guard let range = line.range(of: " name=\"") ?? line.range(of: ";name=\"") else { continue }
            return line[range.upperBound...].split(separator: "\"", maxSplits: 1).first.map(String.init)
        }
        return nil
    }
}

/// A WAV recording's sound: 16-bit samples of one channel (the first, where there are more) and its rate. Nil for
/// anything else — another sample size, a compressed format, no `data` chunk. (A writer that did not know the
/// length when it wrote the header says more than there is: what is there counts.)
nonisolated struct Wav: Sendable {
    let samples: [Int16]
    let rate: Double

    var seconds: Double { Double(samples.count) / rate }

    init?(_ bytes: Data) {
        let b = [UInt8](bytes)
        func text(_ at: Int) -> String { String(decoding: b[at..<at + 4], as: UTF8.self) }
        func u16(_ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        guard b.count >= 12, text(0) == "RIFF", text(8) == "WAVE" else { return nil }
        var at = 12
        var channels = 0
        var rate = 0
        var bits = 0
        var format = 0
        while at + 8 <= b.count {
            let chunk = text(at)
            let size = u32(at + 4)
            if chunk == "fmt ", at + 24 <= b.count {
                format = u16(at + 8)
                channels = u16(at + 10)
                rate = u32(at + 12)
                bits = u16(at + 22)
            }
            if chunk == "data" {
                // PCM, or the extensible header that says PCM inside.
                guard format == 1 || format == 0xFFFE, bits == 16, channels >= 1, rate >= 8000 else { return nil }
                let there = b.count - at - 8
                let length = (0...there).contains(size) ? size : there
                let frame = 2 * channels
                let count = length / frame
                var samples = [Int16](repeating: 0, count: count)
                let base = at + 8
                for i in 0..<count {
                    let p = base + i * frame
                    samples[i] = Int16(bitPattern: UInt16(b[p]) | UInt16(b[p + 1]) << 8)
                }
                self.samples = samples
                self.rate = Double(rate)
                return
            }
            at += 8 + size + (size & 1)
        }
        return nil
    }
}
