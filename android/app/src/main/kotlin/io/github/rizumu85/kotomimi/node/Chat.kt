package io.github.rizumu85.kotomimi.node

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * The chat wire — `POST /v1/chat/completions`, OpenAI's shape — as the phone speaks it for its text models: what of
 * a computer's request goes on to an engine (`requestOf`), and how llama.cpp's server is asked and its answer read
 * while it is written (`ask`). The door answers a computer with these (`Share.chat`), and the self-check asks with
 * them too (`TextCheck`): what the check measures goes the way a computer's request goes.
 */
object Chat {
    sealed class Request

    /** A request an engine is given: for which model, whether the computer wants the answer as it is written, and the engine's request, written anew. */
    class Asked(val model: Model, val stream: Boolean, val body: String) : Request()

    /** A request no engine is given, and what the computer is told instead. */
    class Refused(val status: Int, val message: String) : Request()

    /**
     * What a computer asked, held to what a text model is asked here, and written anew from that.
     *
     * Nothing of the request goes to the engine as it came. The door is open to everything on the network, and
     * llama.cpp's server takes a good deal more than a chat: sound and pictures by their address, a grammar to
     * write by, a slot to write in, a prompt cache to save to a file. So the messages are the three plain kinds
     * with plain text in them and nothing else, the model is one this phone lends, and of the rest only what the
     * desktop app sends its own engine goes on (`translatorRequest`, `NATIVE_COACH_EXTRA`): the sampling a model's
     * makers name, an end to the answer, and whether it thinks first. How much may be written is cut to what a
     * translation or a line of feedback can be.
     *
     * The engine is always asked for the answer as it is written, whatever the computer asked: that is how the
     * door knows the engine is alive, and can stop it for a computer that has gone.
     */
    /**
     * The sentence a request asks about, for the screen: the last thing the person said, without the instructions
     * a translation prompt puts before it (`translatorRequest` in the desktop app: they end in a line break, the
     * sentence is the last line). Null where there is none.
     */
    fun saidIn(body: String): String? = runCatching {
        val messages = JSONObject(body).getJSONArray("messages")
        (messages.length() - 1 downTo 0).map { messages.getJSONObject(it) }.firstOrNull { it.optString("role") == "user" }
            ?.optString("content")?.trim()?.substringAfterLast('\n')?.trim()?.takeIf { it.isNotEmpty() }
    }.getOrNull()

    /** The language a translation is asked for, as its prompt names it (翻译为中文, into English); null where none is named. */
    fun intoIn(body: String): String? {
        val text = runCatching { JSONObject(body).getJSONArray("messages").toString() }.getOrNull() ?: return null
        return INTO.find(text)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }
    }

    private val INTO = Regex("翻译[为成]([\\p{IsHan}]{1,6}?)[，,：:\\\\]|into ([A-Z][a-z]+)")

    fun requestOf(body: ByteArray, lent: List<Model>): Request {
        val json = runCatching { JSONObject(String(body, Charsets.UTF_8)) }.getOrNull() ?: return Refused(400, "The request is not JSON.")
        val named = json.opt("model") as? String ?: return Refused(400, "The request names no model.")
        val model = lent.firstOrNull { it.lentAs == named } ?: return Refused(
            404,
            if (TEXT_MODELS.any { it.lentAs == named }) "This phone does not lend \"$named\": it is not downloaded there, or the phone has not the memory for it."
            else "This phone lends no text model called \"${named.take(NAME_SHOWN)}\".",
        )
        val said = json.optJSONArray("messages")?.takeIf { it.length() in 1..MOST_MESSAGES }
            ?: return Refused(400, "The request has no messages, or more than $MOST_MESSAGES.")
        val messages = JSONArray()
        var letters = 0
        for (index in 0 until said.length()) {
            val message = said.optJSONObject(index)
            val role = message?.opt("role") as? String
            val content = message?.opt("content") as? String
            if (role !in ROLES || content == null) return Refused(400, "Every message is said by \"system\", \"user\" or \"assistant\", in plain text.")
            letters += content.length
            messages.put(JSONObject().put("role", role).put("content", content))
        }
        if (letters > MOST_LETTERS) return Refused(413, "The messages are too long: at most $MOST_LETTERS letters in all.")

        val out = JSONObject().put("model", model.lentAs).put("messages", messages).put("stream", true)
        val most = ((json.opt("max_tokens") ?: json.opt("max_completion_tokens")) as? Number)?.toInt()?.takeIf { it > 0 }
        out.put("max_tokens", minOf(most ?: MOST_TOKENS, MOST_TOKENS))
        for ((name, range) in SAMPLING) (json.opt(name) as? Number)?.toDouble()?.takeIf { it.isFinite() }?.let { out.put(name, it.coerceIn(range)) }
        (json.opt("top_k") as? Number)?.toInt()?.let { out.put("top_k", it.coerceIn(0, 1000)) }
        (json.opt("seed") as? Number)?.toLong()?.let { out.put("seed", it) }
        val stop = when (val given = json.opt("stop")) {
            is String -> listOf(given)
            is JSONArray -> (0 until given.length()).mapNotNull { given.opt(it) as? String }
            else -> emptyList()
        }.filter { it.isNotEmpty() && it.length <= STOP_MOST }.take(STOPS_MOST)
        if (stop.isNotEmpty()) out.put("stop", JSONArray(stop))
        // Of what a request may tell the model's template, the one thing the desktop tells it.
        (json.optJSONObject("chat_template_kwargs")?.opt("enable_thinking") as? Boolean)?.let { out.put("chat_template_kwargs", JSONObject().put("enable_thinking", it)) }
        return Asked(model, json.opt("stream") == true, out.toString())
    }

    /** Whether the engine at `port` answers: both engines' servers say they are well at `/health` once the model is in memory. */
    fun well(port: Int): Boolean = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, port), 500)
            socket.soTimeout = 2000
            socket.getOutputStream().write("GET /health HTTP/1.1\r\nHost: $LOOPBACK\r\nConnection: close\r\n\r\n".toByteArray())
            String(socket.getInputStream().readBytes()).startsWith("HTTP/1.1 200")
        }
    }.getOrDefault(false)

    /**
     * What the engine reckoned of an answer: the tokens of the request it read and how long that took, the tokens it
     * wrote and how long those took, and the tokens it did not read because the request before began the same way.
     */
    class Timings(val read: Int, val readMs: Double, val written: Int, val writtenMs: Double, val kept: Int) {
        val readASecond: Double? get() = if (read > 0 && readMs > 0) read * 1000.0 / readMs else null
        val writtenASecond: Double? get() = if (written > 0 && writtenMs > 0) written * 1000.0 / writtenMs else null
    }

    /**
     * An engine's answer: its status, the text it wrote, why it stopped (`stop`; `length` where it was cut off),
     * its own reckoning, and by the clock here when the first of the text came and when the last. `error` is what
     * it said where it refused, or broke off.
     */
    class Reply(val status: Int, val text: String, val error: String?, val finish: String?, val timings: Timings?, val firstMs: Long?, val tookMs: Long)

    /**
     * Asks the engine at `port` and reads its answer as it is written, each piece of text handed to `onPiece` as it
     * comes. Null where the engine does not answer, or not within `limitMs`, or where `gone` says nobody waits any
     * more: the line is then closed, which is how llama.cpp's server is told to stop writing.
     */
    fun ask(port: Int, key: String, body: String, limitMs: Long, gone: () -> Boolean, onPiece: (String) -> Unit = {}): Reply? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, port), 2000)
            socket.soTimeout = LOOK_EVERY_MS
            val bytes = body.toByteArray()
            val out = socket.getOutputStream()
            out.write("POST /v1/chat/completions HTTP/1.1\r\nHost: $LOOPBACK\r\nAuthorization: Bearer $key\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            out.write(bytes)
            out.flush()

            val started = System.nanoTime()
            fun since() = (System.nanoTime() - started) / 1_000_000
            val text = StringBuilder()
            var first: Long? = null
            var error: String? = null
            var finish: String? = null
            var timings: Timings? = null
            var done = false

            /** One line of the stream: `data: {…}`, with a piece of the text in it, or the end of it. */
            fun line(line: String) {
                val data = line.trim().takeIf { it.startsWith("data:") }?.substring(5)?.trim() ?: return
                if (data == "[DONE]") { done = true; return }
                val event = runCatching { JSONObject(data) }.getOrNull() ?: return
                event.optJSONObject("error")?.let { error = it.optString("message").ifBlank { "no reason given" }; return }
                val choice = event.optJSONArray("choices")?.optJSONObject(0)
                (choice?.optJSONObject("delta")?.opt("content") as? String)?.takeIf { it.isNotEmpty() }?.let { piece ->
                    if (first == null) first = since()
                    text.append(piece)
                    onPiece(piece)
                }
                (choice?.opt("finish_reason") as? String)?.let { finish = it }
                event.optJSONObject("timings")?.let {
                    timings = Timings(it.optInt("prompt_n"), it.optDouble("prompt_ms", 0.0), it.optInt("predicted_n"), it.optDouble("predicted_ms", 0.0), it.optInt("cache_n"))
                }
            }

            // A refusal is one JSON body; an answer is lines, each whole before it is read (no line break lies
            // inside a letter of UTF-8).
            val refusal = ByteArrayOutputStream()
            val pending = ByteArrayOutputStream()
            val framed = Framed { status, piece, from, count ->
                if (status != 200) {
                    refusal.write(piece, from, minOf(count, (REFUSAL_MOST - refusal.size()).coerceAtLeast(0)))
                } else {
                    for (at in from until from + count) {
                        if (piece[at] == NEW_LINE) { line(pending.toString(Charsets.UTF_8.name())); pending.reset() } else pending.write(piece[at].toInt())
                    }
                }
            }

            val buffer = ByteArray(1 shl 13)
            val from = socket.getInputStream()
            val deadline = System.currentTimeMillis() + limitMs
            var looked = 0L
            while (!done && !framed.over) {
                val read = try { from.read(buffer) } catch (waiting: SocketTimeoutException) { 0 }
                if (read < 0) break
                if (read > 0) framed.take(buffer, read)
                val now = System.currentTimeMillis()
                if (now - looked >= LOOK_EVERY_MS) {
                    looked = now
                    if (gone() || now > deadline) return@runCatching null
                }
            }
            if (framed.status == 0) return@runCatching null
            if (framed.status == 200 && pending.size() > 0) line(pending.toString(Charsets.UTF_8.name()))
            if (framed.status != 200) {
                error = runCatching { JSONObject(refusal.toString(Charsets.UTF_8.name())).optJSONObject("error")?.optString("message") }.getOrNull()?.ifBlank { null } ?: "no reason given"
            }
            Reply(framed.status, text.toString(), error, finish, timings, first, since())
        }
    }.getOrNull()

    /**
     * An answer over HTTP taken in as it comes, whichever way its length is said: its status, then its body handed
     * on in pieces. llama.cpp's server sends an answer that is written as it goes in chunks, each with its length
     * before it, and a refusal by its length.
     */
    private class Framed(private val onBody: (Int, ByteArray, Int, Int) -> Unit) {
        var status = 0
            private set
        var over = false
            private set
        private val head = ByteArrayOutputStream()
        private var inHead = true
        private var chunked = false

        /** Bytes still to come: of the body by its length (-1 where it runs to the end of the line), or of the chunk in hand. */
        private var left = -1L
        private var inChunk = false
        private val size = StringBuilder()

        fun take(bytes: ByteArray, count: Int) {
            var at = 0
            while (at < count && !over) {
                if (inHead) {
                    head.write(bytes[at++].toInt())
                    val had = head.size()
                    if (had > HEAD_MOST) { over = true; return }
                    if (bytes[at - 1] == NEW_LINE && had >= 4 && head.toString(Charsets.ISO_8859_1.name()).endsWith("\r\n\r\n")) headRead()
                } else if (!chunked) {
                    val now = if (left >= 0) minOf(left, (count - at).toLong()).toInt() else count - at
                    onBody(status, bytes, at, now)
                    at += now
                    if (left >= 0) { left -= now; if (left == 0L) over = true }
                } else if (inChunk) {
                    val now = minOf(left, (count - at).toLong()).toInt()
                    onBody(status, bytes, at, now)
                    at += now
                    left -= now
                    if (left == 0L) inChunk = false
                } else {
                    // Between chunks: the line break that ends one, then the next one's length in hexadecimal on a line of its own.
                    val letter = bytes[at++].toInt().toChar()
                    if (letter != '\n') { size.append(letter); continue }
                    val said = size.toString().trim().substringBefore(';')
                    size.setLength(0)
                    if (said.isEmpty()) continue
                    left = said.toLongOrNull(16) ?: 0
                    if (left <= 0L) over = true else inChunk = true
                }
            }
        }

        private fun headRead() {
            val lines = head.toString(Charsets.ISO_8859_1.name()).split("\r\n")
            status = lines.first().split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            val headers = lines.drop(1).mapNotNull { line -> line.indexOf(':').takeIf { it > 0 }?.let { line.substring(0, it).trim().lowercase() to line.substring(it + 1).trim() } }.toMap()
            chunked = headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true
            left = if (chunked) 0 else headers["content-length"]?.toLongOrNull() ?: -1
            inHead = false
            if (status == 0 || (!chunked && left == 0L)) over = true
        }
    }

    // ── What a computer is answered ─────────────────────────────────────────────────────────────────────────────

    /**
     * One piece of an answer written as it goes (`chat.completion.chunk`): the door's own, with the model under the
     * name the computer asked it by — the engine's carries its build and the like, which is nobody's business on
     * the network. The last piece says why the answer ended, and carries the engine's reckoning as `timings`,
     * in llama.cpp's own names: a computer that does not know the field passes over it.
     */
    fun pieceOf(id: String, created: Long, model: Model, delta: JSONObject, finish: String? = null, timings: Timings? = null): String =
        JSONObject().put("id", id).put("object", "chat.completion.chunk").put("created", created).put("model", model.lentAs)
            .put("choices", JSONArray().put(JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finish ?: JSONObject.NULL)))
            .also { whole -> timings?.let { whole.put("timings", timingsOf(it)) } }.toString()

    /** An answer given whole (`chat.completion`). */
    fun wholeOf(id: String, created: Long, model: Model, reply: Reply): String =
        JSONObject().put("id", id).put("object", "chat.completion").put("created", created).put("model", model.lentAs)
            .put("choices", JSONArray().put(JSONObject().put("index", 0).put("message", JSONObject().put("role", "assistant").put("content", reply.text)).put("finish_reason", reply.finish ?: "stop")))
            .also { whole ->
                reply.timings?.let {
                    whole.put("usage", JSONObject().put("prompt_tokens", it.read + it.kept).put("completion_tokens", it.written).put("total_tokens", it.read + it.kept + it.written))
                    whole.put("timings", timingsOf(it))
                }
            }.toString()

    private fun timingsOf(timings: Timings) = JSONObject()
        .put("cache_n", timings.kept).put("prompt_n", timings.read).put("prompt_ms", timings.readMs).put("predicted_n", timings.written).put("predicted_ms", timings.writtenMs)

    private const val LOOPBACK = "127.0.0.1"
    private const val NEW_LINE = '\n'.code.toByte()
    private const val HEAD_MOST = 16 * 1024
    private const val REFUSAL_MOST = 64 * 1024

    /** How often, while an engine writes, it is looked whether the answer is still waited for. */
    private const val LOOK_EVERY_MS = 500

    private val ROLES = setOf("system", "user", "assistant")

    /** The feedback request is sixteen messages: the instructions, seven examples and their answers, the sentence. */
    private const val MOST_MESSAGES = 64

    /**
     * The most a request may say, in letters: no more than fits the engines' room (`Llama.TEXT_CONTEXT`) at about
     * a token a letter, which is what Chinese and Japanese come to. The feedback request is some 620.
     */
    private const val MOST_LETTERS = 8_000

    /**
     * The most an answer may run to, in tokens — what the desktop's own door gives a sharing computer's feedback
     * (`MOST_TOKENS` in src/lib/lan/coach.ts), and twice what it asks a translation to stop at. A model that has
     * lost its way is stopped there.
     */
    const val MOST_TOKENS = 1024

    /** The sampling a request may set, and the bounds llama.cpp gives each. */
    private val SAMPLING = mapOf("temperature" to 0.0..2.0, "top_p" to 0.0..1.0, "repeat_penalty" to 0.0..2.0)
    private const val STOPS_MOST = 4
    private const val STOP_MOST = 32
    private const val NAME_SHOWN = 60
}
