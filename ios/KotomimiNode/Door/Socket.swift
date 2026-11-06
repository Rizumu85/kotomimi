import CryptoKit
import Foundation
import Network

/// What the door does with a request to switch to a WebSocket: answer it as an HTTP request would be (a refusal), or
/// take the connection over for as long as `run` keeps it.
nonisolated enum Upgrade: Sendable {
    case refuse(Response)
    case take(@Sendable (Socket) async -> Void)
}

/// One WebSocket the door has taken over (RFC 6455, the server's side): messages in, text out. A computer streams a
/// stretch of sound on one (`/v1/audio/stream`, `Lending.live`), and is written what is heard while it speaks.
///
/// Only what such a client sends is taken: whole or fragmented text and binary messages, pings, a close. A message
/// longer than `messageMost` ends the socket.
nonisolated final class Socket: @unchecked Sendable {
    enum Message: Sendable { case text(String), binary(Data) }

    /// A second of sound at 16 kHz is 32 KB; the computer sends a tenth of that at a time.
    static let messageMost = 1 << 20

    private let connection: NWConnection
    private var had: Data
    private var closed = false

    init(_ connection: NWConnection, leftover: Data) {
        self.connection = connection
        had = leftover
    }

    /// The answer that accepts a request to switch: its `Sec-WebSocket-Accept`, from the key the request carried.
    static func accepting(_ key: String) -> Data {
        let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
        let accept = Data(digest).base64EncodedString()
        return Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)
    }

    /// The next message: nil once the other side has closed, or broken the rules.
    func receive() async -> Message? {
        var parts = Data()
        var kind: UInt8 = 0
        while !closed {
            guard let (fin, opcode, payload) = await frame() else { closed = true; return nil }
            switch opcode {
            case 0x9:
                send(opcode: 0xA, payload)
                continue
            case 0xA:
                continue
            case 0x8:
                send(opcode: 0x8, Data())
                closed = true
                return nil
            case 0x1, 0x2:
                kind = opcode
                parts = payload
            case 0x0:
                guard kind != 0 else { closed = true; return nil }
                parts.append(payload)
            default:
                closed = true
                return nil
            }
            guard parts.count <= Socket.messageMost else { closed = true; return nil }
            guard fin else { continue }
            if kind == 0x1 { return .text(String(decoding: parts, as: UTF8.self)) }
            return .binary(parts)
        }
        return nil
    }

    /// A text message to the other side.
    func send(_ text: String) {
        send(opcode: 0x1, Data(text.utf8))
    }

    /// Says goodbye and lets the connection go.
    func close() {
        guard !closed else { connection.cancel(); return }
        closed = true
        connection.send(content: Data([0x88, 0x00]), completion: .contentProcessed { [connection] _ in connection.cancel() })
    }

    // ── Frames ──────────────────────────────────────────────────────────────────────────────────────────────

    private func send(opcode: UInt8, _ payload: Data) {
        var bytes = Data([0x80 | opcode])
        let n = payload.count
        if n < 126 {
            bytes.append(UInt8(n))
        } else if n <= 0xFFFF {
            bytes.append(126)
            bytes.append(contentsOf: [UInt8(n >> 8), UInt8(n & 0xFF)])
        } else {
            bytes.append(127)
            bytes.append(contentsOf: (0..<8).reversed().map { UInt8((UInt64(n) >> (UInt64($0) * 8)) & 0xFF) })
        }
        bytes.append(payload)
        connection.send(content: bytes, completion: .contentProcessed { _ in })
    }

    /// `count` bytes of the connection, from what was read already first.
    private func take(_ count: Int) async -> Data? {
        while had.count < count {
            guard let piece = await more() else { return nil }
            had.append(piece)
        }
        let out = Data(had.prefix(count))
        had = Data(had.dropFirst(count))
        return out
    }

    private func more() async -> Data? {
        await withCheckedContinuation { (done: CheckedContinuation<Data?, Never>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, complete, error in
                if let data, !data.isEmpty { done.resume(returning: data) }
                else if complete || error != nil { done.resume(returning: nil) }
                else { done.resume(returning: Data()) }
            }
        }
    }

    /// One frame: whether it ends its message, its opcode, its payload unmasked. Nil where the connection ended, or
    /// the frame is not one a client may send (every client frame is masked).
    private func frame() async -> (Bool, UInt8, Data)? {
        guard let head = await take(2) else { return nil }
        let first = head[head.startIndex], second = head[head.startIndex + 1]
        guard second & 0x80 != 0 else { return nil }
        var length = UInt64(second & 0x7F)
        if length == 126 {
            guard let more = await take(2) else { return nil }
            length = more.reduce(0) { $0 << 8 | UInt64($1) }
        } else if length == 127 {
            guard let more = await take(8) else { return nil }
            length = more.reduce(0) { $0 << 8 | UInt64($1) }
        }
        guard length <= UInt64(Socket.messageMost), let mask = await take(4), var payload = await take(Int(length)) else { return nil }
        let key = [UInt8](mask)
        payload.withUnsafeMutableBytes { bytes in
            for i in 0..<bytes.count { bytes[i] ^= key[i & 3] }
        }
        return (first & 0x80 != 0, first & 0x0F, payload)
    }
}
