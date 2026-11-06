import Foundation
import Network

/// One request a computer sent to the door: its line, its headers (names in lower case), its body, and who sent it.
nonisolated struct Request: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
    let peer: String?
}

/// What the door answers: a status, a body, and any headers beyond the ones every answer carries.
nonisolated struct Response: Sendable {
    var status: Int
    var body: Data
    var headers: [(String, String)] = []
    var type = "application/json; charset=utf-8"

    static func json(_ status: Int, _ text: String, _ headers: [(String, String)] = []) -> Response {
        Response(status: status, body: Data(text.utf8), headers: headers)
    }

    static func error(_ status: Int, _ message: String, _ headers: [(String, String)] = []) -> Response {
        json(status, #"{"error":{"message":\#(jsonQuoted(message))}}"#, headers)
    }
}

/// A string as a JSON string literal, quotes included.
nonisolated func jsonQuoted(_ text: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [text], options: [.fragmentsAllowed])) ?? Data("[\"\"]".utf8)
    let array = String(decoding: data, as: UTF8.self)
    return String(array.dropFirst().dropLast())
}

/// The door on the network: a small HTTP/1.1 server on one port, one request to a connection, as the Android app's
/// (`Share.kt`). It reads a request whole — its head up to the blank line, then as many bytes of body as it says —
/// hands it to `handle`, writes the answer and closes. Nothing here knows what is asked: that is `Lending`'s.
///
/// The listener is told to the local network as a Bonjour service as well. Nothing on the computer looks for it
/// (the desktop probes port 8792 on every address it finds); it is there so that the system asks the owner for the
/// local network at once, when sharing is turned on, rather than refusing the first computer silently.
nonisolated final class Door: @unchecked Sendable {
    static let port: UInt16 = 8792

    /// The requests in hand at once: each may hold a recording.
    private static let mostOpen = 12
    private static let headMost = 16 * 1024
    /// Two minutes of sound at the 16 kHz the computer sends is under four megabytes.
    static let bodyMost = 32 * 1024 * 1024
    /// A request that is not whole within this is dropped.
    private static let requestWithin: Duration = .seconds(30)

    private let queue = DispatchQueue(label: "door")
    private var listener: NWListener?
    private var open = 0
    private let handle: @Sendable (Request) async -> Response
    private let named: @Sendable () -> [(String, String)]
    private let upgrade: @Sendable (Request) async -> Upgrade

    /// `named`: the headers every answer carries (who this device is). `handle`: the answer to a request. `upgrade`:
    /// what is done with a request to switch to a WebSocket (`Socket`); by default, it is refused.
    init(named: @escaping @Sendable () -> [(String, String)],
         upgrade: @escaping @Sendable (Request) async -> Upgrade = { _ in .refuse(.error(404, "Not here.")) },
         handle: @escaping @Sendable (Request) async -> Response) {
        self.named = named
        self.upgrade = upgrade
        self.handle = handle
    }

    /// Opens the door; `onState` hears whether it is listening (nil) or why it is not.
    func start(serviceName: String, onState: @escaping @Sendable (String?) -> Void) {
        queue.async { [self] in
            guard listener == nil else { return }
            do {
                let parameters = NWParameters.tcp
                parameters.allowLocalEndpointReuse = true
                parameters.includePeerToPeer = false
                let made = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: Door.port)!)
                made.service = NWListener.Service(name: serviceName, type: "_kotomimi._tcp")
                made.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                made.stateUpdateHandler = { state in
                    switch state {
                    case .ready: onState(nil)
                    case .failed(let error): onState(Door.why(error))
                    case .waiting(let error): onState(Door.why(error))
                    default: break
                    }
                }
                listener = made
                made.start(queue: queue)
            } catch {
                onState("端口 \(Door.port) 被占用")
            }
        }
    }

    func stop() {
        queue.async { [self] in
            listener?.cancel()
            listener = nil
        }
    }

    private static func why(_ error: NWError) -> String {
        if case .posix(let code) = error, code == .EADDRINUSE { return "端口 \(port) 被占用" }
        if case .dns = error { return "没有局域网访问权限，请在系统设置里允许" }
        return "局域网服务没有打开：\(error.localizedDescription)"
    }

    private func accept(_ connection: NWConnection) {
        // More at once than the door takes: this one is not read at all.
        guard open < Door.mostOpen else { connection.cancel(); return }
        open += 1
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.queue.async { self?.open -= 1 }
            default: break
            }
        }
        connection.start(queue: queue)
        let peer = Door.peerOf(connection)
        Task.detached { [self] in
            let deadline = Task.detached {
                try? await Task.sleep(for: Door.requestWithin)
                if !Task.isCancelled { connection.cancel() }
            }
            let response: Response
            if let request = await read(connection, peer: peer) {
                deadline.cancel()
                if Door.upgrades(request) {
                    switch await upgrade(request) {
                    case .refuse(let refusal):
                        write(refusal, to: connection)
                    case .take(let run):
                        // Held open for as long as `run` keeps it: the request's own deadline is over.
                        connection.send(content: Socket.accepting(request.headers["sec-websocket-key"] ?? ""), completion: .contentProcessed { _ in })
                        let socket = Socket(connection, leftover: request.body)
                        await run(socket)
                        socket.close()
                    }
                    return
                }
                response = await handle(request)
            } else {
                deadline.cancel()
                connection.cancel()
                return
            }
            write(response, to: connection)
        }
    }

    /// A request to switch to a WebSocket, with the key the answer is made from.
    static func upgrades(_ request: Request) -> Bool {
        request.method == "GET" && request.headers["upgrade"]?.lowercased() == "websocket"
            && request.headers["sec-websocket-version"] == "13" && !(request.headers["sec-websocket-key"] ?? "").isEmpty
    }

    private static func peerOf(_ connection: NWConnection) -> String? {
        guard case .hostPort(let host, _) = connection.endpoint else { return nil }
        switch host {
        case .ipv4(let address): return "\(address)".components(separatedBy: "%").first
        case .ipv6(let address): return "\(address)".components(separatedBy: "%").first
        case .name(let name, _): return name
        @unknown default: return nil
        }
    }

    /// Some more bytes of the connection: nil where it ended or broke first.
    private func more(_ connection: NWConnection) async -> Data? {
        await withCheckedContinuation { (done: CheckedContinuation<Data?, Never>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, complete, error in
                if let data, !data.isEmpty { done.resume(returning: data) }
                else if complete || error != nil { done.resume(returning: nil) }
                else { done.resume(returning: Data()) }
            }
        }
    }

    private func read(_ connection: NWConnection, peer: String?) async -> Request? {
        var had = Data()
        let blank = Data("\r\n\r\n".utf8)
        var headEnd: Range<Data.Index>?
        while headEnd == nil {
            guard had.count < Door.headMost, let piece = await more(connection) else { return nil }
            had.append(piece)
            headEnd = had.range(of: blank)
        }
        guard let headEnd else { return nil }
        let head = String(decoding: had[had.startIndex..<headEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(had[headEnd.upperBound...])
        let length = Int(headers["content-length"] ?? "") ?? 0
        // Too long, or of no length it said: answered without being read, from what came with the head.
        if length > Door.bodyMost || length < 0 {
            return Request(method: String(first[0]), path: String(first[1].split(separator: "?").first ?? ""), headers: headers, body: Data(), peer: peer)
        }
        while body.count < length {
            guard let piece = await more(connection) else { return nil }
            body.append(piece)
        }
        // What follows a request to switch is the WebSocket's first frames, not a body: kept for it.
        if body.count > length && headers["upgrade"]?.lowercased() != "websocket" { body = body.prefix(length) }
        return Request(method: String(first[0]), path: String(first[1].split(separator: "?").first ?? ""), headers: headers, body: body, peer: peer)
    }

    private func write(_ response: Response, to connection: NWConnection) {
        var head = "HTTP/1.1 \(response.status) \(Door.reason(response.status))\r\n"
        if response.type != "" { head += "Content-Type: \(response.type)\r\n" }
        head += "Content-Length: \(response.body.count)\r\nConnection: close\r\n"
        for (name, value) in named() + response.headers { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        var bytes = Data(head.utf8)
        bytes.append(response.body)
        connection.send(content: bytes, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 204: "No Content"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 403: "Forbidden"
        case 404: "Not Found"
        case 413: "Payload Too Large"
        case 429: "Too Many Requests"
        case 502: "Bad Gateway"
        case 503: "Service Unavailable"
        default: "OK"
        }
    }
}
