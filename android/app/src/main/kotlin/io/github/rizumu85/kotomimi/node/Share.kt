package io.github.rizumu85.kotomimi.node

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLEncoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Sharing: the engine's server on this phone alone (the loopback), and before it a small door on the network that a
 * computer finds and sends its sound to.
 *
 * The door answers what a Kotomimi on a computer asks of another device:
 *
 * - `GET /v1/models` — the model that is lent, with the phone's name in `X-Kotomimi-Name` as a sharing computer gives
 *   its own, and `X-Kotomimi-Node: engine`: what is here is the recognition engine itself, not a computer's whole
 *   pipeline.
 * - `POST /v1/audio/transcriptions` — one stretch of sound read whole, handed to the engine as it came. It is the
 *   engine's own interface and OpenAI's shape, so the computer's "API model" place reads through it too.
 *
 * As a computer's door does, it turns away a request a web page made (one carrying an `Origin` that is not the app's
 * own) and one whose `Host` is a public name: the phone is for the devices around it.
 */
class Share(private val context: Context, private val engine: Engine, private val store: ModelStore) {
    enum class Phase { OFF, LOADING, WAITING, WORKING, FAILED }

    class State(val phase: Phase, val model: Model? = null, val address: String? = null, val peer: String? = null, val message: String? = null)

    @Volatile var onState: (State) -> Unit = {}
    @Volatile private var model: Model? = null
    @Volatile private var server: Process? = null
    @Volatile private var door: ServerSocket? = null
    @Volatile private var pool: ExecutorService? = null
    @Volatile private var stopping = false
    @Volatile private var lastUse = 0L
    @Volatile private var lastPeer: String? = null
    private val said = ArrayDeque<String>()

    val name: String = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /** Brings the engine up with `model` and opens the door. Returns when it is up, or has failed. */
    fun start(model: Model, way: Choices.Way) {
        stopping = false
        this.model = model
        tell(Phase.LOADING)
        File(store.folder, CONFIG).writeText(configOf(model, way))
        val process = engine.serve(listOf("--config", CONFIG, "--no-ui"), store.folder, way.graphics)
        server = process
        Thread({ process.inputStream.bufferedReader().forEachLine { line -> synchronized(said) { said += line; if (said.size > KEPT_LINES) said.removeFirst() } } }, "engine-output").apply { isDaemon = true }.start()

        val deadline = System.currentTimeMillis() + READY_WITHIN_MS
        while (!ready()) {
            if (stopping) return
            if (!process.isAlive) return fail("引擎没起来：${lastSaid()}")
            if (System.currentTimeMillis() > deadline) { process.destroyForcibly(); return fail("装入太久，停下了") }
            Thread.sleep(400)
        }

        val socket = try {
            ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(PORT)) }
        } catch (error: Exception) {
            process.destroyForcibly()
            return fail("端口 $PORT 被占用")
        }
        door = socket
        val workers = Executors.newCachedThreadPool()
        pool = workers
        Thread({
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (error: Exception) { break }
                workers.execute { runCatching { client.use(::answer) } }
            }
        }, "door").apply { isDaemon = true }.start()
        // Whether it is working is told by whether anything was asked of it lately; and that the engine still lives.
        Thread({
            while (!stopping && door === socket) {
                if (!process.isAlive) { fail("引擎停了：${lastSaid()}"); close(); return@Thread }
                tell(if (System.currentTimeMillis() - lastUse < WORKING_FOR_MS) Phase.WORKING else Phase.WAITING)
                Thread.sleep(700)
            }
        }, "watch").apply { isDaemon = true }.start()
        tell(Phase.WAITING)
    }

    fun stop() {
        stopping = true
        close()
        tell(Phase.OFF)
    }

    private fun close() {
        runCatching { door?.close() }
        door = null
        pool?.shutdownNow()
        pool = null
        server?.destroyForcibly()
        server = null
    }

    private fun fail(message: String) {
        onState(State(Phase.FAILED, model, message = message))
    }

    private fun tell(phase: Phase) {
        onState(State(phase, model, address = address(), peer = if (phase == Phase.WORKING) lastPeer else null))
    }

    private fun lastSaid() = synchronized(said) { said.lastOrNull { it.isNotBlank() }?.take(160) ?: "没有说原因" }

    /** The phone's address on the network it is on, with the door's port. */
    fun address(): String? = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        .filter { it.isUp && !it.isLoopback && !it.isVirtual }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        ?.let { "${it.hostAddress}:$PORT" }

    private fun configOf(model: Model, way: Choices.Way): String {
        val entry = """{"id":"${model.id}","family":"${model.family}","path":"${model.file}","task":"asr","mode":"offline","session_options":{}}"""
        return """{"host":"$LOOPBACK","port":$ENGINE_PORT,"backend":"${if (way.graphics) "vulkan" else "cpu"}","device":0,"threads":${way.threads},"lazy_load":false,"models":[$entry]}"""
    }

    private fun ready(): Boolean = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, ENGINE_PORT), 500)
            socket.soTimeout = 2000
            socket.getOutputStream().write("GET /health HTTP/1.1\r\nHost: $LOOPBACK\r\nConnection: close\r\n\r\n".toByteArray())
            String(socket.getInputStream().readBytes()).startsWith("HTTP/1.1 200")
        }
    }.getOrDefault(false)

    // ── The door ────────────────────────────────────────────────────────────────────────────────────────────────

    private fun answer(client: Socket) {
        client.soTimeout = CLIENT_TIMEOUT_MS
        val input = BufferedInputStream(client.getInputStream())
        val out = client.getOutputStream()
        val head = headOf(input) ?: return
        val lines = head.split("\r\n")
        val request = lines.first().split(' ')
        if (request.size < 2) return
        val method = request[0]
        val path = request[1].substringBefore('?')
        val headers = lines.drop(1).mapNotNull { line -> line.indexOf(':').takeIf { it > 0 }?.let { line.substring(0, it).trim().lowercase() to line.substring(it + 1).trim() } }.toMap()

        val origin = headers["origin"]
        val own = origin == null || origin == "null" || origin.startsWith("file://")
        if (!own || !localName(headers["host"])) return reply(out, 403, """{"error":{"message":"This phone answers the devices around it only."}}""")

        // The app's own page, where it says where it comes from, is told it may read the answer.
        val allow = origin?.let { "Access-Control-Allow-Origin: $it\r\nVary: Origin\r\nAccess-Control-Expose-Headers: X-Kotomimi-Name, X-Kotomimi-Node\r\n" }.orEmpty()

        when {
            method == "OPTIONS" -> reply(out, 204, "", "${allow}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type\r\n")
            method == "GET" && (path == "/v1/models" || path == "/models") -> reply(out, 200, modelsJson(), allow)
            method == "POST" && (path == "/v1/audio/transcriptions" || path == "/audio/transcriptions") -> {
                val length = headers["content-length"]?.toIntOrNull()
                if (length == null || length < 0 || length > BODY_MOST) return reply(out, 413, """{"error":{"message":"The sound is too long, or its length was not said."}}""", allow)
                val body = ByteArray(length)
                var had = 0
                while (had < length) {
                    val read = input.read(body, had, length - had)
                    if (read < 0) return
                    had += read
                }
                lastPeer = client.inetAddress.hostAddress
                lastUse = System.currentTimeMillis()
                val answered = forward(headers["content-type"].orEmpty(), body)
                lastUse = System.currentTimeMillis()
                if (answered == null) reply(out, 502, """{"error":{"message":"The engine did not answer."}}""", allow) else relay(out, answered, allow)
            }
            else -> reply(out, 404, """{"error":{"message":"Not here."}}""", allow)
        }
    }

    /** The request's head, up to the empty line; null when it is not one. */
    private fun headOf(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        var matched = 0
        while (bytes.size() < HEAD_MOST) {
            val byte = input.read()
            if (byte < 0) return null
            bytes.write(byte)
            matched = if (byte == END[matched].code) matched + 1 else if (byte == '\r'.code) 1 else 0
            if (matched == END.length) return bytes.toString(Charsets.ISO_8859_1.name()).dropLast(END.length)
        }
        return null
    }

    /** Hands the upload to the engine as it came; what the engine answered, head and all, or null. */
    private fun forward(type: String, body: ByteArray): ByteArray? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, ENGINE_PORT), 2000)
            socket.soTimeout = ENGINE_TIMEOUT_MS
            val out = socket.getOutputStream()
            out.write("POST /v1/audio/transcriptions HTTP/1.1\r\nHost: $LOOPBACK\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            out.write(body)
            out.flush()
            socket.getInputStream().readBytes()
        }
    }.getOrNull()

    /** The engine's answer, with the phone's name put into its head. */
    private fun relay(out: OutputStream, answered: ByteArray, more: String) {
        val text = String(answered, Charsets.ISO_8859_1)
        val firstLine = text.indexOf("\r\n")
        if (firstLine < 0) return reply(out, 502, """{"error":{"message":"The engine's answer could not be read."}}""")
        out.write(answered, 0, firstLine + 2)
        out.write((named() + more).toByteArray(Charsets.ISO_8859_1))
        out.write(answered, firstLine + 2, answered.size - firstLine - 2)
        out.flush()
    }

    private fun reply(out: OutputStream, status: Int, body: String, more: String = "") {
        val bytes = body.toByteArray()
        val reason = mapOf(200 to "OK", 204 to "No Content", 403 to "Forbidden", 404 to "Not Found", 413 to "Payload Too Large", 502 to "Bad Gateway")[status] ?: "OK"
        out.write("HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n${named()}$more\r\n".toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
    }

    private fun named() = "X-Kotomimi-Name: ${URLEncoder.encode(name, "UTF-8").replace("+", "%20")}\r\nX-Kotomimi-Node: engine\r\n"

    private fun modelsJson(): String {
        val model = model ?: return """{"object":"list","data":[]}"""
        return """{"object":"list","data":[{"id":"${model.id}","object":"model","owned_by":"kotomimi-phone"}]}"""
    }

    /** An address, `localhost`, a bare name, or a name that exists on a local network only — not a public name pointed here. */
    private fun localName(host: String?): Boolean {
        val name = host?.substringBeforeLast(':')?.lowercase() ?: return true
        return IPV4.matches(name) || name.startsWith("[") || '.' !in name || name.endsWith(".local") || name.endsWith(".lan") || name.endsWith(".home")
    }

    companion object {
        /**
         * Not the port a sharing computer listens on (8790): the Kotomimi that is published searches that port, and
         * would list the phone as a device with a whole pipeline, which it is not — choosing it there would fail.
         */
        const val PORT = 8792
        private const val ENGINE_PORT = 8793
        private const val LOOPBACK = "127.0.0.1"
        private const val CONFIG = "server.json"
        private const val END = "\r\n\r\n"
        private const val HEAD_MOST = 16 * 1024
        /** Two minutes of sound at the 16 kHz the computer sends is under four megabytes. */
        private const val BODY_MOST = 32 * 1024 * 1024
        private const val KEPT_LINES = 40
        private const val READY_WITHIN_MS = 180_000L
        private const val CLIENT_TIMEOUT_MS = 30_000
        private const val ENGINE_TIMEOUT_MS = 120_000
        private const val WORKING_FOR_MS = 4_000L
        private val IPV4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
    }
}
