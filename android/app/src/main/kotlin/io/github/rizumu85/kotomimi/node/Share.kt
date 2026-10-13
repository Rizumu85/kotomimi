package io.github.rizumu85.kotomimi.node

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * Sharing: an engine's server on this phone alone (the loopback), and before it a small door on the network that a
 * computer finds and sends its sound to. The engine is the one the lent model is for: audio.cpp's server, or
 * llama.cpp's. Which of them reads, a computer cannot tell: the door says the same and answers the same.
 *
 * The door answers what a Kotomimi on a computer asks of another device:
 *
 * - `GET /v1/models` — the model that is lent, under audio.cpp's name for it (`Model.lentAs`), with the phone's name
 *   in `X-Kotomimi-Name` as a sharing computer gives its own, and `X-Kotomimi-Node: engine`: what is here is the
 *   recognition engine itself, not a computer's whole pipeline.
 * - `POST /v1/audio/transcriptions` — one stretch of sound read whole. It is audio.cpp's own interface and OpenAI's
 *   shape, so the computer's "API model" place reads through it too. audio.cpp's server is asked the same thing
 *   in the door's own words (`readByAudioCpp`). llama.cpp's has no such door: it is asked as a chat (`readByChat`).
 *   Either way what goes back is `{"text": …}` and nothing more.
 *
 * As a computer's door does, it turns away a request a web page made (one carrying an `Origin` that is not the app's
 * own) and one whose `Host` is a public name: the phone is for the devices around it.
 */
class Share(private val context: Context, private val engine: Engine, private val llama: Llama, private val store: ModelStore) {
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

    /** What llama.cpp's server asks of whoever asks it, made anew at every start; nobody but this door has it. */
    @Volatile private var key = ""

    /** One reading at a time by llama.cpp's server, in the order they came. */
    private val turn = ReentrantLock(true)

    val name: String = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /**
     * Brings the engine up with `model` and opens the door. Returns when it is up, or has failed. `startWith` is for
     * trying a build of llama.cpp's server the phone would not pick itself.
     */
    fun start(model: Model, way: Choices.Way, startWith: Llama.Build? = null) {
        stopping = false
        this.model = model
        tell(Phase.LOADING)
        // The engine before this one may still be on its way out, where sharing was stopped and started again at
        // once: a phone has memory for one at a time, and the new one would be taken for up while the old one
        // still answers at its port.
        last?.let { before ->
            if (before.isAlive && !before.waitFor(GONE_WITHIN_MS, TimeUnit.MILLISECONDS)) return fail("上一次的引擎还没退出，等几秒再开")
        }
        val process = (if (model.reader == Reader.LLAMA_CPP) llamaUp(model, way, startWith) else audioUp(model, way)) ?: return

        val socket = try {
            ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(PORT)) }
        } catch (error: Exception) {
            endOutright(process)
            return fail("端口 $PORT 被占用")
        }
        door = socket
        val workers = Executors.newCachedThreadPool()
        pool = workers
        Thread({
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (error: Exception) { break }
                // Stopped between the two: the workers take no more, and say so by throwing.
                try { workers.execute { runCatching { client.use(::answer) } } } catch (error: Exception) { runCatching { client.close() }; break }
            }
        }, "door").apply { isDaemon = true }.start()
        // Whether it is working is told by whether anything was asked of it lately; and that the engine still lives.
        Thread({
            runCatching {
                while (!stopping && door === socket) {
                    if (!process.isAlive) { if (!stopping) fail("引擎停了：${whyEnded(process)}"); close(); return@runCatching }
                    tell(if (System.currentTimeMillis() - lastUse < WORKING_FOR_MS) Phase.WORKING else Phase.WAITING)
                    Thread.sleep(700)
                }
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
        server?.let(::endOutright)
        server = null
    }

    private fun fail(message: String) {
        onState(State(Phase.FAILED, model, message = message))
    }

    private fun tell(phase: Phase) {
        onState(State(phase, model, address = address(), peer = if (phase == Phase.WORKING) lastPeer else null))
    }

    /** The phone's address on the network it is on, with the door's port. */
    fun address(): String? = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        .filter { it.isUp && !it.isLoopback && !it.isVirtual }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        ?.let { "${it.hostAddress}:$PORT" }

    // ── The engines ─────────────────────────────────────────────────────────────────────────────────────────────

    /** audio.cpp's server with `model`, up and answering; null where it is not, the reason already told. */
    private fun audioUp(model: Model, way: Choices.Way): Process? {
        File(store.folder, CONFIG).writeText(configOf(model, way))
        val process = begun(engine.serve(listOf("--config", CONFIG, "--no-ui"), store.folder, way.graphics))
        return when (awaited(process)) {
            Came.UP -> process
            Came.STOPPED -> null
            Came.LATE -> null.also { fail("装入太久，停下了") }
            Came.ENDED -> null.also { fail("引擎没起来：${whyEnded(process)}") }
        }
    }

    /**
     * llama.cpp's server with `model`, the same. On the processor alone, with the newest build this processor runs:
     * and where that build ends at once on an instruction the processor does not have after all, with the next one
     * down, as the self-check does with the reader.
     */
    private fun llamaUp(model: Model, way: Choices.Way, startWith: Llama.Build?): Process? {
        var build = startWith?.takeIf { it in llama.servers } ?: llama.serverFor(Device(context).features)
            ?: return null.also { fail("安装包里没有这台处理器能用的 llama.cpp") }
        key = UUID.randomUUID().toString().replace("-", "")
        while (true) {
            val process = begun(llama.serve(model, store, build, way.threads, ENGINE_PORT, key))
            when (awaited(process)) {
                Came.UP -> return process
                Came.STOPPED -> return null
                Came.LATE -> return null.also { fail("装入太久，停下了") }
                Came.ENDED -> {
                    val lower = if (exitOf(process) == ILLEGAL_INSTRUCTION) llama.serverBelow(build) else null
                    if (lower == null) return null.also { fail("引擎没起来：${whyEnded(process)}") }
                    build = lower
                }
            }
        }
    }

    /** An engine just started: remembered, so that it can be ended, and what it writes kept for when it fails. */
    private fun begun(process: Process): Process {
        server = process
        last = process
        synchronized(said) { said.clear() }
        // Ending the engine closes what this reads from under it, and Android then throws in the reading thread: an
        // error nobody caught there closed the whole app the moment sharing was stopped (a friend's phone, 2026-10-12).
        Thread({
            runCatching { process.inputStream.bufferedReader().forEachLine { line -> synchronized(said) { said += line; if (said.size > KEPT_LINES) said.removeFirst() } } }
        }, "engine-output").apply { isDaemon = true }.start()
        return process
    }

    private enum class Came { UP, ENDED, LATE, STOPPED }

    /** Waits for an engine to answer: both say they are well at `/health` once the model is in memory. */
    private fun awaited(process: Process): Came {
        val deadline = System.currentTimeMillis() + READY_WITHIN_MS
        while (!ready()) {
            if (stopping) return Came.STOPPED
            if (!process.isAlive) return Came.ENDED
            if (System.currentTimeMillis() > deadline) { endOutright(process); return Came.LATE }
            Thread.sleep(400)
        }
        return Came.UP
    }

    private fun ready(): Boolean = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, ENGINE_PORT), 500)
            socket.soTimeout = 2000
            socket.getOutputStream().write("GET /health HTTP/1.1\r\nHost: $LOOPBACK\r\nConnection: close\r\n\r\n".toByteArray())
            String(socket.getInputStream().readBytes()).startsWith("HTTP/1.1 200")
        }
    }.getOrDefault(false)

    private fun exitOf(process: Process): Int? = runCatching { process.exitValue() }.getOrNull()

    /** Why an engine is no longer there: that the system took it, or what it said last. */
    private fun whyEnded(process: Process): String =
        if (exitOf(process) == KILLED) "被系统停掉了，多半是内存不够"
        else synchronized(said) { said.lastOrNull { it.isNotBlank() }?.replace(Llama.LOG_PREFIX, "")?.trim()?.take(160) ?: "没有说原因" }

    /**
     * What audio.cpp's server is started with (its `server.json`): the one model, and with it what every reading
     * of that model is to be told (`default_request_options` — the server puts them under whatever a request
     * says itself, and the door's requests say none of them).
     */
    private fun configOf(model: Model, way: Choices.Way): String {
        val always = model.options.entries.joinToString(",") { "${JSONObject.quote(it.key)}:${JSONObject.quote(it.value)}" }
        val entry = """{"id":"${model.id}","family":"${model.family}","path":"${model.file.name}","task":"asr","mode":"offline","session_options":{},"default_request_options":{$always}}"""
        return """{"host":"$LOOPBACK","port":$ENGINE_PORT,"backend":"${if (way.graphics) "vulkan" else "cpu"}","device":0,"threads":${way.threads},"lazy_load":false,"models":[$entry]}"""
    }

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
        if (!own || !localName(headers["host"])) return reply(out, 403, errorOf("This phone answers the devices around it only."))

        // The app's own page, where it says where it comes from, is told it may read the answer.
        val allow = origin?.let { "Access-Control-Allow-Origin: $it\r\nVary: Origin\r\nAccess-Control-Expose-Headers: X-Kotomimi-Name, X-Kotomimi-Node\r\n" }.orEmpty()

        when {
            method == "OPTIONS" -> reply(out, 204, "", "${allow}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type\r\n")
            method == "GET" && (path == "/v1/models" || path == "/models") -> reply(out, 200, modelsJson(), allow)
            method == "POST" && (path == "/v1/audio/transcriptions" || path == "/audio/transcriptions") -> {
                val length = headers["content-length"]?.toIntOrNull()
                if (length == null || length < 0 || length > BODY_MOST) return reply(out, 413, errorOf("The sound is too long, or its length was not said."), allow)
                val body = ByteArray(length)
                var had = 0
                while (had < length) {
                    val read = input.read(body, had, length - had)
                    if (read < 0) return
                    had += read
                }
                lastPeer = client.inetAddress.hostAddress
                lastUse = System.currentTimeMillis()
                if (model?.reader == Reader.LLAMA_CPP) {
                    // Whoever asked may give up before its turn comes, or while its stretch is read, and the engine
                    // is not kept busy for a computer that has dropped the stretch. Nothing more is due from it
                    // after the request, so the one thing its side of the line can say now is that it has gone.
                    val gone = {
                        try { client.soTimeout = 1; input.read() < 0 } catch (waiting: SocketTimeoutException) { false } catch (broken: IOException) { true }
                    }
                    val (status, json) = readByChat(headers["content-type"].orEmpty(), body, gone) { lastUse = System.currentTimeMillis() }
                    lastUse = System.currentTimeMillis()
                    reply(out, status, json, allow)
                } else {
                    val (status, json) = readByAudioCpp(headers["content-type"].orEmpty(), body)
                    lastUse = System.currentTimeMillis()
                    reply(out, status, json, allow)
                }
            }
            else -> reply(out, 404, errorOf("Not here."), allow)
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

    /**
     * What the engine answers to a request — its `head`, then its body in `pieces` — whole, head and all. Null
     * where it does not answer, or not in time, or where `gone` says nobody waits for the answer any more: the line
     * to the engine is then closed, which is how llama.cpp's server is told to stop reading. (It stops at the next
     * step it comes to, not at once: a reading dropped after 3 s of its 16 held it for 8 more on the F22 Pro.)
     */
    private fun asked(head: String, pieces: List<ByteArray>, gone: () -> Boolean): ByteArray? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, ENGINE_PORT), 2000)
            socket.soTimeout = LOOK_EVERY_MS
            val out = socket.getOutputStream()
            out.write(head.toByteArray(Charsets.ISO_8859_1))
            for (piece in pieces) out.write(piece)
            out.flush()
            val deadline = System.currentTimeMillis() + ENGINE_TIMEOUT_MS
            val answered = ByteArrayOutputStream()
            val buffer = ByteArray(1 shl 14)
            val from = socket.getInputStream()
            while (true) {
                val read = try { from.read(buffer) } catch (waiting: SocketTimeoutException) { 0 }
                if (read < 0) break
                answered.write(buffer, 0, read)
                if (read == 0 && (gone() || stopping || System.currentTimeMillis() > deadline)) return@runCatching null
            }
            answered.toByteArray()
        }
    }.getOrNull()

    private fun reply(out: OutputStream, status: Int, body: String, more: String = "") {
        val bytes = body.toByteArray()
        val reason = REASONS[status] ?: "OK"
        out.write("HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n${named()}$more\r\n".toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
    }

    private fun named() = "X-Kotomimi-Name: ${URLEncoder.encode(name, "UTF-8").replace("+", "%20")}\r\nX-Kotomimi-Node: engine\r\n"

    private fun modelsJson(): String {
        val model = model ?: return """{"object":"list","data":[]}"""
        return """{"object":"list","data":[{"id":"${model.lentAs}","object":"model","owned_by":"kotomimi-phone"}]}"""
    }

    private fun errorOf(message: String) = """{"error":{"message":${JSONObject.quote(message)}}}"""

    /** An address, `localhost`, a bare name, or a name that exists on a local network only — not a public name pointed here. */
    private fun localName(host: String?): Boolean {
        val name = host?.substringBeforeLast(':')?.lowercase() ?: return true
        return IPV4.matches(name) || name.startsWith("[") || '.' !in name || name.endsWith(".local") || name.endsWith(".lan") || name.endsWith(".home")
    }

    // ── llama.cpp's server, asked as a chat ─────────────────────────────────────────────────────────────────────

    /**
     * One stretch of sound read by llama.cpp's server: the status and the body to answer the computer with.
     *
     * The computer sent a form: the sound as a WAV file, and perhaps the language. The server is asked as a chat
     * with the sound as the one thing said, and the model answers `language Japanese<asr_text>…the text…`. The
     * text alone goes back, as `{"text": …}` — what audio.cpp's server answers, and all a computer reads of it.
     *
     * Where the computer named the language, the answer is begun for the model — `language Japanese<asr_text>` —
     * and it goes on from there: this is how the model is told a language (audio.cpp does the same, inside). It
     * matters for short stretches, and a voice is read from its first second: left to tell the language itself,
     * the model called one second of Japanese conversation another language one time in three, and wrote it in
     * Chinese or English; two seconds, one time in six; a quarter of a minute, never (8 minutes of conversation,
     * 2026-10-12). `onWork` is called when its turn has come.
     */
    private fun readByChat(type: String, body: ByteArray, gone: () -> Boolean, onWork: () -> Unit): Pair<Int, String> {
        val form = formOf(type, body) ?: return 400 to errorOf("The request is not a multipart form.")
        val sound = form.file ?: return 400 to errorOf("The form has no file in it.")
        val ms = wavMsOf(sound) ?: return 400 to errorOf("The file is not a WAV recording.")
        // Nothing to hear: llama.cpp would refuse it as a file it cannot read.
        if (ms < LEAST_MS) return 200 to TEXT_OF_NOTHING
        val seconds = ms / 1000.0
        if (seconds > MOST_SECONDS) return 413 to errorOf("The sound is too long: this phone reads at most $MOST_SECONDS seconds at once.")
        val begun = languageOf(form.fields["language"])?.let { "language $it${Llama.TEXT_MARK}" }

        // The request, written by hand around the sound: letters of base64 need nothing done to them, and a
        // minute of sound put through a JSON library would be copied several times over.
        val before = """{"temperature":0,"max_tokens":${tokensFor(seconds)},"cache_prompt":false,"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":""""
        val beginning = begun?.let { """,{"role":"assistant","content":${JSONObject.quote(it)}}""" }.orEmpty()
        val after = """","format":"wav"}}]}$beginning]}"""
        val pieces = listOf(before.toByteArray(), Base64.encode(sound, Base64.NO_WRAP), after.toByteArray())
        val head = "POST /v1/chat/completions HTTP/1.1\r\nHost: $LOOPBACK\r\nAuthorization: Bearer $key\r\nContent-Type: application/json\r\nContent-Length: ${pieces.sumOf { it.size }}\r\nConnection: close\r\n\r\n"

        // Its turn: the server reads one at a time, and one who has gone meanwhile is not read at all.
        while (!turn.tryLock(LOOK_EVERY_MS.toLong(), TimeUnit.MILLISECONDS)) {
            if (gone() || stopping) return 503 to errorOf("Nobody waits for this reading any more.")
        }
        val answered: ByteArray?
        try {
            onWork()
            answered = asked(head, pieces, gone)
        } finally {
            turn.unlock()
        }
        if (answered == null) return 502 to errorOf("The engine did not answer.")

        val whole = String(answered, Charsets.UTF_8)
        val status = whole.substringBefore("\r\n").split(' ').getOrNull(1)?.toIntOrNull()
        val json = runCatching { JSONObject(whole.substringAfter(END, "")) }.getOrNull()
        if (status == null || json == null) return 502 to errorOf("The engine's answer could not be read.")
        if (status != 200) {
            val why = json.optJSONObject("error")?.optString("message").orEmpty().ifBlank { "no reason given" }
            return 502 to errorOf("The engine answered HTTP $status: ${why.take(200)}")
        }
        val written = json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.takeIf { it.has("content") && !it.isNull("content") }?.optString("content")
            ?: return 502 to errorOf("The engine's answer has no text in it.")
        return 200 to """{"text":${JSONObject.quote(textOf(written, begun != null))}}"""
    }

    /**
     * One stretch of sound read by audio.cpp's server: the status and the body to answer the computer with.
     *
     * The interface is audio.cpp's own, but the upload is not handed on as it came. What goes to the engine is
     * held to what llama.cpp is given — a form with a recording in it, no longer than this phone reads at once —
     * and is written anew from that: a body that was no form could name a file on the phone for the engine to
     * open, and one long recording took memory until the system killed this app and others to make room (both
     * found 2026-10-12; anything on the network could have sent either). Written anew, the request also names the
     * model by the name the engine was started with, whatever the computer called it (the engine refuses a name it
     * does not have: `unknown model id`), carries the recording as the `.wav` the engine asks an upload to be
     * called, and nothing else a form might hold (`stream`, which the engine answers in another shape).
     *
     * The language goes on as the computer said it, to a model of many languages. A model of a few (`Model.hears`)
     * is told one of its own by its code, or none; and a language it does not read is refused here, in so many
     * words. audio.cpp would not refuse it: SenseVoice told `fr` reads as though told nothing, and writes French
     * speech down as one of its five languages — an answer that looks like a reading and is none.
     */
    private fun readByAudioCpp(type: String, body: ByteArray): Pair<Int, String> {
        val model = model ?: return 502 to errorOf("The engine did not answer.")
        val form = formOf(type, body) ?: return 400 to errorOf("The request is not a multipart form.")
        val sound = form.file ?: return 400 to errorOf("The form has no file in it.")
        val ms = wavMsOf(sound) ?: return 400 to errorOf("The file is not a WAV recording.")
        // Nothing to hear: audio.cpp would refuse it as an incomplete file.
        if (ms < LEAST_MS) return 200 to TEXT_OF_NOTHING
        if (ms / 1000.0 > MOST_SECONDS_AUDIO_CPP) return 413 to errorOf("The sound is too long: this phone reads at most $MOST_SECONDS_AUDIO_CPP seconds at once.")
        val said = form.fields["language"]?.trim().orEmpty()
        val language = when {
            said.isEmpty() -> null
            model.hears == null -> said
            said.equals("auto", ignoreCase = true) -> null
            else -> heardAs(said, model.hears)
                ?: return 400 to errorOf("${model.name} reads ${inWords(model.hears.values)} only, not \"${said.take(LANGUAGE_SHOWN)}\". Lend another model from the phone for this language.")
        }

        val boundary = "----kotomimi${UUID.randomUUID().toString().replace("-", "")}"
        fun field(name: String, value: String) = "--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n"
        val before = field("model", model.id) + language?.let { field("language", it) }.orEmpty() +
            "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"stretch.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        val pieces = listOf(before.toByteArray(), sound, "\r\n--$boundary--\r\n".toByteArray())
        val head = "POST /v1/audio/transcriptions HTTP/1.1\r\nHost: $LOOPBACK\r\nContent-Type: multipart/form-data; boundary=$boundary\r\nContent-Length: ${pieces.sumOf { it.size }}\r\nConnection: close\r\n\r\n"
        val answered = asked(head, pieces) { false } ?: return 502 to errorOf("The engine did not answer.")

        val whole = String(answered, Charsets.UTF_8)
        val status = whole.substringBefore("\r\n").split(' ').getOrNull(1)?.toIntOrNull()
        val json = runCatching { JSONObject(whole.substringAfter(END, "")) }.getOrNull()
        if (status == null || json == null) return 502 to errorOf("The engine's answer could not be read.")
        if (status != 200) {
            val why = json.optJSONObject("error")?.optString("message").orEmpty().ifBlank { "no reason given" }
            return 502 to errorOf("The engine answered HTTP $status: ${why.take(200)}")
        }
        val written = json.takeIf { it.has("text") && !it.isNull("text") }?.optString("text") ?: return 502 to errorOf("The engine's answer has no text in it.")
        return 200 to """{"text":${JSONObject.quote(if (model.unspaced) unspaced(written) else written)}}"""
    }

    /** A form's fields by their names, and the file it carries. */
    private class Form(val fields: Map<String, String>, val file: ByteArray?)

    /** The parts of a `multipart/form-data` body; null where it is not one. */
    private fun formOf(type: String, body: ByteArray): Form? {
        if (!type.lowercase().startsWith("multipart/form-data")) return null
        val boundary = BOUNDARY.find(type)?.let { it.groupValues[1].ifEmpty { it.groupValues[2] } }?.takeIf { it.isNotEmpty() } ?: return null
        val mark = "--$boundary".toByteArray(Charsets.ISO_8859_1)
        val blank = END.toByteArray(Charsets.ISO_8859_1)
        val fields = HashMap<String, String>()
        var file: ByteArray? = null
        var at = indexOf(body, mark, 0)
        while (at >= 0) {
            val start = at + mark.size
            // "--" after the mark: the last one.
            if (start + 1 < body.size && body[start] == '-'.code.toByte() && body[start + 1] == '-'.code.toByte()) break
            val next = indexOf(body, mark, start)
            if (next < 0) break
            val headEnd = indexOf(body, blank, start)
            if (headEnd in 0 until next) {
                val head = String(body, start, headEnd - start, Charsets.UTF_8)
                val name = PART_NAME.find(head)?.groupValues?.get(1)
                // A part ends with the line break before the next mark.
                val from = headEnd + blank.size
                val to = (next - 2).coerceAtLeast(from)
                if (name == "file") file = body.copyOfRange(from, to)
                else if (name != null && to - from <= FIELD_MOST) fields[name] = String(body, from, to - from, Charsets.UTF_8)
            }
            at = next
        }
        return Form(fields, file)
    }

    private fun indexOf(bytes: ByteArray, what: ByteArray, from: Int): Int {
        var at = from
        while (at <= bytes.size - what.size) {
            var same = 0
            while (same < what.size && bytes[at + same] == what[same]) same += 1
            if (same == what.size) return at
            at += 1
        }
        return -1
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
        private const val FIELD_MOST = 4096
        private const val KEPT_LINES = 40
        private const val READY_WITHIN_MS = 180_000L
        private const val CLIENT_TIMEOUT_MS = 30_000
        private const val ENGINE_TIMEOUT_MS = 120_000
        /** How often, while an engine reads, it is looked whether the answer is still waited for. */
        private const val LOOK_EVERY_MS = 500
        private const val WORKING_FOR_MS = 4_000L
        private const val GONE_WITHIN_MS = 5_000L
        private val IPV4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
        private val BOUNDARY = Regex("""boundary=(?:"([^"]*)"|([^;\s]*))""", RegexOption.IGNORE_CASE)
        private val PART_NAME = Regex("""(?i)content-disposition:[^\r\n]*?[;\s]name="([^"]*)"""")
        private val REASONS = mapOf(
            200 to "OK", 204 to "No Content", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found",
            413 to "Payload Too Large", 502 to "Bad Gateway", 503 to "Service Unavailable",
        )

        /** How a program ends when the system kills it for an instruction the processor does not have, and when it kills it outright. */
        private const val ILLEGAL_INSTRUCTION = 132
        private const val KILLED = 137

        /** The engine started last, by whichever sharing: the one that must be gone before another is started. */
        @Volatile private var last: Process? = null

        private const val TEXT_OF_NOTHING = """{"text":""}"""

        /** Sound shorter than this is no sound: a click of a twentieth of a second has no word in it. */
        private const val LEAST_MS = 50.0

        /**
         * The longest stretch llama.cpp's server is asked to read at once: what its room holds with the text
         * (`Llama.SERVER_CONTEXT`). A computer sends a quarter of a minute at most while a voice is heard.
         */
        const val MOST_SECONDS = 90

        /**
         * audio.cpp's server is given less at once: what it holds grows with the length of the sound, where
         * llama.cpp's stays as it was at loading. A minute of silence — under the limit above — took memory on a
         * 4 GB phone until the system killed this app (2026-10-12). A computer reading live sends a quarter of a
         * minute at most.
         */
        const val MOST_SECONDS_AUDIO_CPP = 30

        /**
         * How many tokens a reading may run to before it is cut off. A model now and then loses its way and writes
         * the same few letters until it is stopped; the computer cuts such a reading back itself (`unloop` in
         * electron/native-engine.js), by its eight repeats and more of up to twenty letters — so the reading is
         * let run far enough to show them (the 96), and no further than that past what speech can be: it is written
         * in 3 to 5 tokens a second over a quarter of a minute, 8 over four seconds, 12 over one (measured on 8
         * minutes of Japanese conversation, 2026-10-12). And never past the room the server has.
         */
        fun tokensFor(seconds: Double): Int =
            minOf(96 + (seconds * 12).toInt(), Llama.SERVER_CONTEXT - Llama.tokensOfSound(seconds)).coerceAtLeast(96)

        /**
         * The languages Qwen3-ASR hears, as it names them itself, by the codes a computer tells them with (the
         * desktop app sends `ja`; `Japanese` is taken too). Any other is left to the model to tell.
         */
        private val LANGUAGES = mapOf(
            "zh" to "Chinese", "en" to "English", "yue" to "Cantonese", "ar" to "Arabic", "de" to "German", "fr" to "French",
            "es" to "Spanish", "pt" to "Portuguese", "id" to "Indonesian", "it" to "Italian", "ko" to "Korean", "ru" to "Russian",
            "th" to "Thai", "vi" to "Vietnamese", "ja" to "Japanese", "tr" to "Turkish", "hi" to "Hindi", "ms" to "Malay",
            "nl" to "Dutch", "sv" to "Swedish", "da" to "Danish", "fi" to "Finnish", "pl" to "Polish", "cs" to "Czech",
            "fil" to "Filipino", "fa" to "Persian", "el" to "Greek", "hu" to "Hungarian", "mk" to "Macedonian", "ro" to "Romanian",
        )

        fun languageOf(said: String?): String? {
            val word = said?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            return LANGUAGES[word.substringBefore('-').substringBefore('_')] ?: LANGUAGES.values.firstOrNull { it.lowercase() == word }
        }

        /**
         * The code a model of few languages (`Model.hears`: its codes, and their names) is told for what a computer
         * said: the code itself, with or without a region after it (`zh-CN`), or the language's English name. Null
         * for a language that is not one of the model's.
         */
        fun heardAs(said: String, hears: Map<String, String>): String? {
            val word = said.trim().lowercase()
            val code = word.substringBefore('-').substringBefore('_')
            return hears.keys.firstOrNull { it == code } ?: hears.entries.firstOrNull { it.value.lowercase() == word }?.key
        }

        /** "Chinese, Cantonese, English, Japanese and Korean". */
        fun inWords(names: Collection<String>): String = if (names.size < 2) names.joinToString() else names.toList().let { it.dropLast(1).joinToString(", ") + " and " + it.last() }

        /** A language nobody reads is shown in a refusal to this length: it is whatever the request said. */
        private const val LANGUAGE_SHOWN = 20

        /**
         * A text without the spaces a model put where the writing has none: between two characters of Japanese or
         * Chinese, and between such a character and a figure (「あと 15 秒」). SenseVoice writes them now and then —
         * in 27 of 59 stretches of real Japanese conversation, and a second or two cut out of a sentence comes back
         * a word at a time (「元 は 金持ち の 息子 でし たが。」) — and a computer shows what it is given. Korean keeps
         * its spaces (Hangul is not among these characters), and so do Latin words, also inside Japanese.
         */
        fun unspaced(text: String): String = text.replace(SPACE_INSIDE, "")

        /**
         * Kana, Chinese characters, and the marks and full-width forms written with them: left for the regular
         * expression to read as numbers, since the first of them is a space, which nobody would see standing here.
         */
        private const val UNSPACED = """\u3000-\u30ff\u3400-\u9fff\uff00-\uffef"""
        private val SPACE_INSIDE = Regex("""(?<=[$UNSPACED])\s+(?=[$UNSPACED\d])|(?<=\d)\s+(?=[$UNSPACED])""")

        /**
         * The text in what the model wrote: what follows its mark. The server gives the answer whole, the beginning
         * that was written for the model included. With no mark there is no text where the model was left to say
         * the language (it said the language, or `language None`, and stopped), and where the beginning was given
         * what stands there is the text.
         */
        fun textOf(written: String, begun: Boolean): String {
            val at = written.indexOf(Llama.TEXT_MARK)
            return when {
                at >= 0 -> written.substring(at + Llama.TEXT_MARK.length)
                begun || !written.trimStart().startsWith("language ") -> written
                else -> ""
            }.trim()
        }
    }
}

/**
 * How long a WAV recording is, in milliseconds, by its own header; null where it is not a WAV recording. (A writer
 * that did not know the length when it wrote the header says more than there is: what is there counts.)
 */
fun wavMsOf(bytes: ByteArray): Double? {
    if (bytes.size < 12 || String(bytes, 0, 4, Charsets.US_ASCII) != "RIFF" || String(bytes, 8, 4, Charsets.US_ASCII) != "WAVE") return null
    val numbers = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    var at = 12
    var bytesASecond = 0
    while (at + 8 <= bytes.size) {
        val chunk = String(bytes, at, 4, Charsets.US_ASCII)
        val size = numbers.getInt(at + 4)
        if (chunk == "fmt " && at + 20 <= bytes.size) bytesASecond = numbers.getInt(at + 16)
        if (chunk == "data") {
            val there = bytes.size - at - 8
            return if (bytesASecond > 0) (if (size in 0..there) size else there) * 1000.0 / bytesASecond else null
        }
        if (size < 0) break
        at += 8 + size + (size and 1)
    }
    return null
}
