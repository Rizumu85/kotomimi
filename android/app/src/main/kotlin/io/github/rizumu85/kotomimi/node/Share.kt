package io.github.rizumu85.kotomimi.node

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Sharing: engines' servers on this phone alone (the loopback), and before them a small door on the network that a
 * computer finds and sends its sound and its sentences to. The recognition engine is the one the lent model is for:
 * audio.cpp's server, or llama.cpp's. Which of them reads, a computer cannot tell: the door says the same and
 * answers the same. The text models — translation, grammar feedback — each have a server of llama.cpp's of their
 * own, started when one is first asked for.
 *
 * The door answers what a Kotomimi on a computer asks of another device:
 *
 * - `GET /v1/models` — in `data`, the recognition model that is lent, under audio.cpp's name for it
 *   (`Model.lentAs`), with the phone's name in `X-Kotomimi-Name` as a sharing computer gives its own, and
 *   `X-Kotomimi-Node: engine`: what is here is the engine itself, not a computer's whole pipeline. The text models
 *   stand beside it in a list of their own, `text` (`modelsJson`).
 * - `POST /v1/audio/transcriptions` — one stretch of sound read whole. It is audio.cpp's own interface and OpenAI's
 *   shape, so the computer's "API model" place reads through it too. audio.cpp's server is asked the same thing
 *   in the door's own words (`readByAudioCpp`). llama.cpp's has no such door: it is asked as a chat (`readByChat`).
 *   Either way what goes back is `{"text": …}` and nothing more.
 * - `POST /v1/chat/completions` — one answer of a text model, whole or as it is written (`chat`).
 *
 * One thing is done at a time, in the order asked (`turn`): a reading, a translation, a line of feedback. Two
 * engines at work at once have more threads between them than the phone has cores, and llama.cpp's threads wait
 * for each other by spinning: with as many threads as cores one engine alone fell from 5 tokens a second to 0.2
 * (NOTES.md, 2026-10-12).
 *
 * Which engines are up at once goes by the phone's memory (`ensure`).
 *
 * As a computer's door does, it turns away a request a web page made (one carrying an `Origin` that is not the app's
 * own) and one whose `Host` is a public name: the phone is for the devices around it.
 */
class Share(private val context: Context, private val engine: Engine, private val llama: Llama, private val store: ModelStore) {
    enum class Phase { OFF, LOADING, WAITING, WORKING, FAILED }

    /**
     * `model` is the recognition model that is lent (none, where the phone lends text models alone) — or, while an
     * engine is being loaded, the model it is loaded with. `task` is what the phone is working at.
     */
    /**
     * How sharing stands. `peer`: the computer at work with the phone now (while WORKING). `seen`, `seenAt`: the last
     * computer that asked anything of it, and when — what the screen's "connect a device" widget says between requests.
     */
    class State(val phase: Phase, val model: Model? = null, val address: String? = null, val peer: String? = null, val message: String? = null, val task: Task? = null, val seen: String? = null, val seenAt: Long = 0L)

    @Volatile var onState: (State) -> Unit = {}
    @Volatile private var model: Model? = null
    @Volatile private var door: ServerSocket? = null
    @Volatile private var pool: ExecutorService? = null
    @Volatile private var stopping = false
    @Volatile private var lastUse = 0L
    @Volatile private var lastPeer: String? = null
    /** The sound of the reading under way, once its length is known: for what the screen says of recognition. */
    @Volatile private var soundMs = 0L
    @Volatile private var lastTask: Task? = null
    @Volatile private var startWith: Llama.Build? = null
    private val choices = Choices(context)
    private val device = Device(context)

    /**
     * An engine's server: the model it holds, where on this phone it listens, the key it asks of whoever asks it
     * (llama.cpp's; made anew at every start, and nobody but this door has it), when it was last asked, and the last
     * of what it wrote, for when it fails.
     */
    private class Up(val model: Model, val process: Process, val port: Int, val key: String) {
        @Volatile var usedAt = System.currentTimeMillis()
        val said = ArrayDeque<String>()
    }

    /** The engines that are up. Which are, changes only by who has the turn — and by `close`, which ends them all. */
    private val up = ArrayList<Up>()

    /** The engine that is being brought up, and its model: told on the screen, and ended with the rest. */
    @Volatile private var rising: Up? = null
    @Volatile private var loading: Model? = null

    /** One thing at a time by the phone's engines, in the order they were asked. */
    private val turn = Line()

    /**
     * Who waits for the phone's engines, in the order they came: the first has the turn. (A fair lock that is asked
     * for again and again, to look between askings whether anybody still waits, does not keep that order — whoever
     * asks at the right moment is let in ahead of one who has waited longer: four translations asked together were
     * answered first, second, fourth, third.)
     */
    private class Line {
        private val lock = ReentrantLock()
        private val moved = lock.newCondition()
        private val waiting = ArrayDeque<Any>()

        /** Stands in line until its turn comes; false where `gone` says, between looks, that nobody waits for it any more. */
        fun take(gone: () -> Boolean): Boolean {
            val mine = Any()
            lock.withLock { waiting.addLast(mine) }
            try {
                while (true) {
                    lock.withLock {
                        if (waiting.first() === mine) return true
                        moved.await(LOOK_EVERY_MS.toLong(), TimeUnit.MILLISECONDS)
                        if (waiting.first() === mine) return true
                    }
                    if (gone()) break
                }
            } catch (stopped: InterruptedException) {
                // Sharing was stopped under it: out of the line like one who has gone, so that nobody waits behind it.
            }
            lock.withLock { waiting.remove(mine); moved.signalAll() }
            return false
        }

        /** The turn, where nobody has it and nobody waits; false otherwise. */
        fun tryTake(): Boolean = lock.withLock { waiting.isEmpty().also { free -> if (free) waiting.addLast(Any()) } }

        fun give() = lock.withLock { waiting.removeFirstOrNull(); moved.signalAll() }
    }

    /** The text requests in the door, the one that is being answered among them. */
    private val asking = AtomicInteger(0)
    private val answers = AtomicInteger(0)

    /** The requests the door has in hand at once: each may hold a recording, and the app's own memory is small. */
    private val open = Semaphore(MOST_OPEN)

    val name: String = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /**
     * Brings the recognition engine up with `model`, where there is one to lend, and opens the door. Returns when
     * it is up, or has failed. `startWith` is for trying a build of llama.cpp's server the phone would not pick
     * itself. The text models' engines are not started here: each waits to be asked for (`ensure`).
     */
    fun start(model: Model?, startWith: Llama.Build? = null) {
        stopping = false
        Sharing.forget()
        this.model = model
        this.startWith = startWith
        tell(Phase.LOADING)
        // The engines before these may still be on their way out, where sharing was stopped and started again at
        // once: a phone has memory for few at a time, and a new one would be taken for up while the old one
        // still answers at its port.
        for (before in started.toList()) {
            if (before.isAlive) endOutright(before)
            if (before.isAlive && !before.waitFor(GONE_WITHIN_MS, TimeUnit.MILLISECONDS)) return fail("上一次的引擎还没退出，等几秒再开")
            started -= before
        }
        if (model != null) {
            if (!turn.take { stopping }) return
            val raised = try { raise(model) } finally { turn.give() }
            if (raised.up == null) {
                if (raised.why != null) fail(raised.why)
                return
            }
        }

        val socket = try {
            ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(PORT)) }
        } catch (error: Exception) {
            close()
            return fail("端口 $PORT 被占用")
        }
        door = socket
        val workers = Executors.newCachedThreadPool()
        pool = workers
        Thread({
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (error: Exception) { break }
                // More at once than the door takes: this one is not read at all.
                if (!open.tryAcquire()) { runCatching { client.close() }; continue }
                // Stopped between the two: the workers take no more, and say so by throwing.
                try {
                    workers.execute { try { runCatching { client.use(::answer) } } finally { open.release() } }
                } catch (error: Exception) {
                    open.release()
                    runCatching { client.close() }
                    break
                }
            }
        }, "door").apply { isDaemon = true }.start()
        // Whether it is working is told by whether anything was asked of it lately.
        Thread({
            runCatching {
                while (!stopping && door === socket) {
                    // An engine that is gone without having been ended here was ended by the system, as a rule for
                    // its memory. It is forgotten: the next request for its model starts it again, in whatever
                    // room there is then. (Before the text models, sharing ended with it. Now an engine going is
                    // part of how the phone is lent.)
                    for (gone in running().filter { !it.process.isAlive }) {
                        Log.w(TAG, "${gone.model.id} is gone: ${whyEnded(gone)}")
                        synchronized(up) { up -= gone }
                    }
                    // The system says memory is short: with more than one engine up, the one asked longest ago
                    // goes, before the system picks what goes itself.
                    if (running().size > 1 && device.memoryShort() && turn.tryTake()) {
                        try { running().minByOrNull { it.usedAt }?.let { end(it, "the system says memory is short") } } finally { turn.give() }
                    }
                    tell(if (loading != null) Phase.LOADING else if (System.currentTimeMillis() - lastUse < WORKING_FOR_MS) Phase.WORKING else Phase.WAITING)
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
        for (running in synchronized(up) { up.toList().also { up.clear() } }) endOutright(running.process)
        rising?.let { endOutright(it.process) }
        rising = null
    }

    private fun fail(message: String) {
        onState(State(Phase.FAILED, model, message = message))
    }

    private fun tell(phase: Phase) {
        val shown = if (phase == Phase.LOADING) loading ?: model else model
        onState(State(phase, shown, address = address(), peer = if (phase == Phase.WORKING) lastPeer else null, task = if (phase == Phase.WORKING) lastTask else null, seen = lastPeer, seenAt = lastUse))
    }

    private fun running(): List<Up> = synchronized(up) { up.toList() }

    /** The phone's address on the network it is on, with the door's port. */
    fun address(): String? = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        .filter { it.isUp && !it.isLoopback && !it.isVirtual }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        ?.let { "${it.hostAddress}:$PORT" }

    // ── The engines ─────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * An engine for a model, up — or why there is none: `why` in the screen's words, `told` in the words a computer
     * is given, and `short` where the reason is the phone's memory. Neither where sharing was stopped meanwhile.
     */
    private class Raised(val up: Up?, val why: String? = null, val told: String? = null, val short: Boolean = false)

    /**
     * The engine for `model`, up: the one that is, or one started now. Asked by whoever has the turn.
     *
     * Which engines are up together goes by the phone's memory. A phone of 4 GB cannot hold a recognizer and a
     * translator at once (1.9 GB and 2.3 GB at their most on the F22 Pro, of 2.1 GB to spare); one of 15 GB holds
     * all three kinds. So nothing is fixed beforehand. An engine is started when its model is asked for and stays
     * up; and before one is started, the memory the system says can be had (`Device.memory`) is held against what
     * that engine keeps for its own (`Model.holdsMb`):
     *
     * - Beside other engines it is started only if `RESERVE_MB` would still be over — for the files the engines
     *   map, and the rest of the phone. Else the engine asked longest ago is ended, and the next longest, until
     *   there is that much or no other is left.
     * - Alone it needs what it keeps and no more to spare: that it runs so is what was measured.
     * - A text model that would not fit even alone is refused, and before anything is ended for it: by what the
     *   others hold of their own, read from the system (`heldBy`), ending them all would not make the room. The
     *   computer is told the phone has not the memory (503), and may ask again.
     * - The recognition model is started whatever the figures say, once every other engine is ended: it is the
     *   one the phone's owner chose to lend, and it was started so before there were text models.
     *
     * So on a small phone the engines take turns, each loaded again when it is asked for (some ten seconds each
     * way on the F22 Pro), and on a large one they all stay. The system ending the app, or one of its engines, for
     * memory is what this is to keep from happening; where it ends an engine all the same, that engine is started
     * again at its next request (`start`'s watch).
     */
    private fun ensure(model: Model): Raised {
        running().firstOrNull { it.model === model }?.let { had ->
            if (had.process.isAlive) return Raised(had.also { it.usedAt = System.currentTimeMillis() })
            Log.w(TAG, "${model.id} is gone: ${whyEnded(had)}")
            synchronized(up) { up -= had }
        }
        val text = model.task != Task.HEAR
        fun others() = running().filter { it.process.isAlive }.sortedBy { it.usedAt }
        fun free() = device.memory().second
        fun tooLittle(free: Long) = Raised(
            null, short = true,
            told = "This phone has not the memory for ${model.name} now: it keeps ${gigabytes(model.holdsMb.toLong())} GB for itself, and ${gigabytes(free)} GB can be had.",
        )
        if (text) {
            val could = free() + others().sumOf { (heldBy(it.process)?.ownMb ?: it.model.holdsMb).toLong() }
            if (could < model.holdsMb) return tooLittle(could).also { Log.i(TAG, "${model.id} refused: ${model.holdsMb} MB needed, $could MB to be had with every engine ended") }
        }
        while (true) {
            val beside = others()
            val spare = free() - model.holdsMb
            if (spare >= (if (beside.isEmpty()) 0 else RESERVE_MB)) break
            end(beside.firstOrNull() ?: break, "room for ${model.id}: $spare MB would be over")
        }
        if (stopping) return Raised(null)
        if (text && free() < model.holdsMb) return tooLittle(free()).also { Log.i(TAG, "${model.id} refused: ${model.holdsMb} MB needed, ${free()} MB free") }
        return raise(model)
    }

    /** Ends an engine that is up, and waits until it is gone and its memory is the system's again. */
    private fun end(running: Up, why: String) {
        Log.i(TAG, "ending ${running.model.id}: $why")
        endOutright(running.process)
        runCatching { running.process.waitFor(GONE_WITHIN_MS, TimeUnit.MILLISECONDS) }
        synchronized(up) { up -= running }
        runCatching { Thread.sleep(SETTLE_MS) }
    }

    /**
     * Starts the engine for `model` and waits for it to answer, on the processor: audio.cpp's server for its
     * models, llama.cpp's for its own — a recognizer or a text model — with the newest build this processor runs: and where that build ends at once on an
     * instruction the processor does not have after all, with the next one down, as the self-check does with the
     * reader.
     */
    private fun raise(model: Model): Raised {
        loading = model
        tell(Phase.LOADING)
        val free = device.memory().second
        val began = System.currentTimeMillis()
        try {
            val way = choices.wayOf(model)
            val port = portOf(model)
            fun came(running: Up, lower: () -> Llama.Build? = { null }): Pair<Raised?, Llama.Build?> = when (awaited(running)) {
                Came.UP -> {
                    synchronized(up) { up += running }
                    Log.i(TAG, "${model.id} up in ${System.currentTimeMillis() - began} ms on ${way.threads} threads; $free MB could be had before, ${device.memory().second} MB now")
                    Raised(running) to null
                }
                Came.STOPPED -> Raised(null) to null
                Came.LATE -> Raised(null, "装入太久，停下了", "The engine took too long to load ${model.name}.") to null
                Came.ENDED -> {
                    val next = if (exitOf(running.process) == ILLEGAL_INSTRUCTION) lower() else null
                    if (next != null) null to next
                    else Raised(null, "引擎没起来：${whyEnded(running)}", "The engine did not start with ${model.name}: ${whyEnded(running, forComputer = true)}", short = exitOf(running.process) == KILLED) to null
                }
            }
            if (model.reader == Reader.AUDIO_CPP) {
                File(store.folder, CONFIG).writeText(configOf(model, way, port))
                return came(begun(model, engine.serve(listOf("--config", CONFIG, "--no-ui"), store.folder), port, "")).first!!
            }
            var build = startWith?.takeIf { it in llama.servers } ?: llama.serverFor(device.features)
                ?: return Raised(null, "安装包里没有这台处理器能用的 llama.cpp", "This phone's app has no llama.cpp for its processor.")
            while (true) {
                val key = UUID.randomUUID().toString().replace("-", "")
                val using = build
                val (raised, lower) = came(begun(model, llama.serve(model, store, using, way.threads, port, key), port, key)) { llama.serverBelow(using) }
                if (raised != null) return raised
                build = lower!!
            }
        } finally {
            rising = null
            loading = null
        }
    }

    /** An engine just started: remembered, so that it can be ended, and what it writes kept for when it fails. */
    private fun begun(model: Model, process: Process, port: Int, key: String): Up {
        val running = Up(model, process, port, key)
        rising = running
        started.removeAll { !it.isAlive }
        started += process
        // Sharing was stopped while this one was on its way: nobody else would end it.
        if (stopping) endOutright(process)
        // Ending the engine closes what this reads from under it, and Android then throws in the reading thread: an
        // error nobody caught there closed the whole app the moment sharing was stopped (a friend's phone, 2026-10-12).
        Thread({
            runCatching { process.inputStream.bufferedReader().forEachLine { line -> synchronized(running.said) { running.said += line; if (running.said.size > KEPT_LINES) running.said.removeFirst() } } }
        }, "engine-output").apply { isDaemon = true }.start()
        return running
    }

    private enum class Came { UP, ENDED, LATE, STOPPED }

    /** Waits for an engine to answer: both say they are well at `/health` once the model is in memory. */
    private fun awaited(running: Up): Came {
        val deadline = System.currentTimeMillis() + READY_WITHIN_MS
        while (!Chat.well(running.port)) {
            if (stopping) return Came.STOPPED
            if (!running.process.isAlive) return Came.ENDED
            if (System.currentTimeMillis() > deadline) { endOutright(running.process); return Came.LATE }
            Thread.sleep(400)
        }
        return Came.UP
    }

    private fun exitOf(process: Process): Int? = runCatching { process.exitValue() }.getOrNull()

    /** Why an engine is no longer there: that the system took it, or what it said last. */
    private fun whyEnded(running: Up, forComputer: Boolean = false): String =
        if (exitOf(running.process) == KILLED) (if (forComputer) "the system ended it, as a rule for the memory it took" else "被系统停掉了，多半是内存不够")
        else synchronized(running.said) { running.said.lastOrNull { it.isNotBlank() }?.replace(Llama.LOG_PREFIX, "")?.trim()?.take(160) } ?: if (forComputer) "it gave no reason" else "没有说原因"

    /**
     * What audio.cpp's server is started with (its `server.json`): the one model, and with it what every reading
     * of that model is to be told (`default_request_options` — the server puts them under whatever a request
     * says itself, and the door's requests say none of them).
     */
    private fun configOf(model: Model, way: Choices.Way, port: Int): String {
        val always = model.options.entries.joinToString(",") { "${JSONObject.quote(it.key)}:${JSONObject.quote(it.value)}" }
        val entry = """{"id":"${model.id}","family":"${model.family}","path":"${model.file.name}","task":"asr","mode":"offline","session_options":{},"default_request_options":{$always}}"""
        return """{"host":"$LOOPBACK","port":$port,"backend":"cpu","device":0,"threads":${way.threads},"lazy_load":false,"models":[$entry]}"""
    }

    private sealed class Turn {
        /** The turn is held, with the engine to ask: whoever is given this gives the turn back (`turn.give`). */
        class Mine(val up: Up) : Turn()
        class No(val status: Int, val message: String) : Turn()
    }

    /**
     * Waits for its turn at the phone's engines, and has the one for `model` brought up. Whoever asked may give up
     * before its turn comes (`gone`), and is then not served at all.
     */
    private fun turnFor(model: Model, gone: () -> Boolean): Turn {
        if (!turn.take { gone() || stopping }) return Turn.No(503, "Nobody waits for this any more.")
        val raised = try { ensure(model) } catch (error: Throwable) { turn.give(); throw error }
        raised.up?.let { return Turn.Mine(it) }
        turn.give()
        return Turn.No(if (raised.short || raised.told == null) 503 else 502, raised.told ?: "This phone is no longer lent.")
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

        // The owner's access key, where one is set (`DoorKey`): without it, nothing but the phone's name is answered.
        val key = DoorKey.of(context)
        if (key.isNotEmpty() && method != "OPTIONS" && headers["authorization"] != "Bearer $key") {
            val asks = "This phone asks for its access key."
            return if (method == "POST") refuseUnread(client, input, out, asks, allow, status = 401) else reply(out, 401, errorOf(asks), allow)
        }

        when {
            method == "OPTIONS" -> reply(out, 204, "", "${allow}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type\r\n")
            method == "GET" && (path == "/v1/models" || path == "/models") -> reply(out, 200, modelsJson(), allow)
            method == "POST" && (path == "/v1/audio/transcriptions" || path == "/audio/transcriptions") -> {
                val lent = model ?: return reply(out, 404, errorOf("This phone lends no speech recognition now: no model for it is downloaded there."), allow)
                val length = headers["content-length"]?.toIntOrNull()
                if (length == null || length < 0 || length > BODY_MOST) return refuseUnread(client, input, out, "The sound is too long, or its length was not said.", allow)
                val body = bodyOf(input, length) ?: return
                lastPeer = client.inetAddress.hostAddress
                // Whoever asked may give up before its turn comes, or while its stretch is read, and the engine
                // is not kept busy for a computer that has dropped the stretch. Nothing more is due from it
                // after the request, so the one thing its side of the line can say now is that it has gone.
                val gone = {
                    try { client.soTimeout = 1; input.read() < 0 } catch (waiting: SocketTimeoutException) { false } catch (broken: IOException) { true }
                }
                val onWork = { lastTask = Task.HEAR; lastUse = System.currentTimeMillis() }
                val type = headers["content-type"].orEmpty()
                val began = System.currentTimeMillis()
                soundMs = 0L
                val (status, json) = if (lent.reader == Reader.LLAMA_CPP) readByChat(lent, type, body, gone, onWork) else readByAudioCpp(lent, type, body, gone, onWork)
                lastUse = System.currentTimeMillis()
                // What it heard, for the screen: a reading of nothing is no work to show.
                if (status == 200 && soundMs > 0) {
                    val heard = runCatching { JSONObject(json).optString("text") }.getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
                    Sharing.work(Task.HEAR).done(lastUse - began, null, heard, soundMs = soundMs)
                }
                reply(out, status, json, allow)
            }
            method == "POST" && (path == "/v1/chat/completions" || path == "/chat/completions") -> chat(client, input, out, headers, allow)
            else -> reply(out, 404, errorOf("Not here."), allow)
        }
    }

    /**
     * Refuses a request whose body is not read — too long, or of no said length — and then lets what the computer
     * is still sending run out for a moment. Closed at once, with the rest of the upload unread, the line is broken
     * off under the refusal, and the computer may see a broken line where it should read why.
     */
    private fun refuseUnread(client: Socket, input: InputStream, out: OutputStream, message: String, more: String, status: Int = 413) {
        reply(out, status, errorOf(message), more)
        runCatching {
            client.shutdownOutput()
            client.soTimeout = UNREAD_FOR_MS
            val deadline = System.currentTimeMillis() + UNREAD_FOR_MS
            val buffer = ByteArray(1 shl 15)
            var passed = 0L
            while (passed < UNREAD_MOST && System.currentTimeMillis() < deadline) {
                val read = input.read(buffer)
                if (read < 0) break
                passed += read
            }
        }
    }

    /** A request's body, of the length it said; null where the line ended before it. */
    private fun bodyOf(input: InputStream, length: Int): ByteArray? {
        val body = ByteArray(length)
        var had = 0
        while (had < length) {
            val read = input.read(body, had, length - had)
            if (read < 0) return null
            had += read
        }
        return body
    }

    /**
     * One answer of a text model: a translation, or a line of grammar feedback. The request and the answer are
     * OpenAI's chat completions, as the desktop app asks its own engine (`completeText` in
     * src/providers/openai/textModel.ts): whole, or — with `"stream": true` — as it is written, in the same
     * `data:` lines llama.cpp's server writes.
     *
     * What goes to the engine is not the request but what `Chat.requestOf` makes of it. The model is one of the
     * text models this phone lends, by the desktop's name for it; the engine for it is brought up for the first
     * request and kept (`ensure`), and the first answer waits for that.
     *
     * A request waits its turn behind what the phone is doing, as a stretch of sound does: a talk has two sides,
     * and both may want a sentence translated at once. But no more than a few wait (`MOST_ASKING`): the next is
     * told the phone is busy (429) at once, where it would else wait out the computer's patience for nothing.
     */
    private fun chat(client: Socket, input: InputStream, out: OutputStream, headers: Map<String, String>, allow: String) {
        val length = headers["content-length"]?.toIntOrNull()
        if (length == null || length < 0 || length > CHAT_BODY_MOST) return refuseUnread(client, input, out, "The request is too long, or its length was not said.", allow)
        val body = bodyOf(input, length) ?: return
        val asked = when (val request = Chat.requestOf(body, choices.lendableText(store))) {
            is Chat.Refused -> return reply(out, request.status, errorOf(request.message), allow)
            is Chat.Asked -> request
        }
        if (asking.incrementAndGet() > MOST_ASKING) {
            asking.decrementAndGet()
            return reply(out, 429, errorOf("This phone is busy: $MOST_ASKING requests for its text models wait already."), "${allow}Retry-After: 2\r\n")
        }
        try {
            // The computer may give up while it waits or while the answer is written: its line then ends, or
            // what is written to it no longer goes.
            var left = false
            val gone = {
                left || stopping || try { client.soTimeout = 1; input.read() < 0 } catch (waiting: SocketTimeoutException) { false } catch (broken: IOException) { true }
            }
            val running = when (val mine = turnFor(asked.model, gone)) {
                is Turn.No -> return reply(out, mine.status, errorOf(mine.message), if (mine.status == 503) "${allow}Retry-After: 5\r\n" else allow)
                is Turn.Mine -> mine.up
            }
            try {
                lastPeer = client.inetAddress.hostAddress
                lastTask = asked.model.task
                lastUse = System.currentTimeMillis()
                val id = "chatcmpl-kotomimi-${answers.incrementAndGet()}"
                val created = System.currentTimeMillis() / 1000
                var begun = false
                fun event(json: String) {
                    out.write("data: $json\n\n".toByteArray())
                    out.flush()
                }
                /** The answer's head, and its first piece: who speaks. Written once it is known that there is an answer. */
                fun begin() {
                    begun = true
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: close\r\n${named()}$allow\r\n".toByteArray(Charsets.ISO_8859_1))
                    event(Chat.pieceOf(id, created, asked.model, JSONObject().put("role", "assistant").put("content", "")))
                }
                val written = Chat.ask(running.port, running.key, asked.body, TEXT_TIMEOUT_MS, gone) { piece ->
                    lastUse = System.currentTimeMillis()
                    if (asked.stream && !left) {
                        try {
                            if (!begun) begin()
                            event(Chat.pieceOf(id, created, asked.model, JSONObject().put("content", piece)))
                        } catch (broken: IOException) {
                            left = true
                        }
                    }
                }
                running.usedAt = System.currentTimeMillis()
                lastUse = running.usedAt
                if (left) return
                if (written == null) {
                    if (gone()) return
                    val why = if (running.process.isAlive) "The engine did not answer in time." else "The engine stopped: ${whyEnded(running, forComputer = true)}."
                    if (begun) event(errorOf(why)) else reply(out, 502, errorOf(why), allow)
                    return
                }
                val broke = written.error?.take(300)
                when {
                    // A request the model cannot take — as a rule one longer than its room — is the computer's to mend.
                    written.status == 400 -> reply(out, 400, errorOf("The model did not take the request: ${broke.orEmpty()}"), allow)
                    written.status != 200 -> reply(out, 502, errorOf("The engine answered HTTP ${written.status}: ${broke.orEmpty()}"), allow)
                    !asked.stream && broke != null -> reply(out, 502, errorOf("The engine broke off: $broke"), allow)
                    !asked.stream -> reply(out, 200, Chat.wholeOf(id, created, asked.model, written), allow).also { tell(asked, written) }
                    else -> {
                        if (!begun) begin()
                        if (broke != null) event(errorOf(broke))
                        event(Chat.pieceOf(id, created, asked.model, JSONObject(), written.finish ?: "stop", written.timings))
                        out.write("data: [DONE]\n\n".toByteArray())
                        out.flush()
                        if (broke == null) tell(asked, written)
                    }
                }
            } finally {
                turn.give()
            }
        } finally {
            asking.decrementAndGet()
        }
    }

    /** A text model's answer, for the screen: what it was asked, what it wrote, how long that took. */
    private fun tell(asked: Chat.Asked, written: Chat.Reply) {
        val answer = written.text.trim().takeIf { it.isNotEmpty() } ?: return
        Sharing.work(asked.model.task).done(written.tookMs, Chat.saidIn(asked.body), answer, into = Chat.intoIn(asked.body))
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
    private fun asked(port: Int, head: String, pieces: List<ByteArray>, gone: () -> Boolean): ByteArray? = runCatching {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(LOOPBACK, port), 2000)
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

    /**
     * What the phone lends. `data` is the recognition model, and nothing else is ever put there: a Kotomimi on a
     * computer takes every name in it for a recognizer — the published ones (0.43.114) take the first for the
     * model the phone lends (`readAnswer` in electron/lan-discover.js, `engineNode` in src/lib/native/remoteEngine.ts)
     * and offer all of them for the recognition model's field (`slot === 'asr'` in src/providers/openai/localai.ts).
     * A translation model listed there would be offered to hear with. It is empty where the phone has no
     * recognition model: such a phone is then not listed by those versions at all, which can do nothing with it.
     *
     * The text models stand in `text`, a field those versions do not read: each by the desktop's own name for it,
     * with what it is for (`kind`: `translate` or `coach`), its name in words, and whether its engine is up now
     * (`loaded`) — one that is not takes a while over its first answer.
     *
     * And so that a computer can tell beforehand what this phone holds at once: what each model's engine keeps for
     * its own (`holds_mb`, on the text models and on the recognizer), and in `memory_mb` all the phone has and what
     * can be had of it now. Engines that do not fit together take turns, and every turn is a loading (`ensure`).
     */
    private fun modelsJson(): String {
        fun entry(model: Model, more: String = "") = """{"id":"${model.lentAs}","object":"model","owned_by":"kotomimi-phone","holds_mb":${model.holdsMb}$more}"""
        val up = running().filter { it.process.isAlive }.map { it.model }
        val text = choices.lendableText(store).joinToString(",") {
            entry(it, ""","kind":"${if (it.task == Task.TRANSLATE) "translate" else "coach"}","name":${JSONObject.quote(it.name)},"loaded":${it in up}""")
        }
        val (all, free) = device.memory()
        return """{"object":"list","data":[${model?.let { entry(it) }.orEmpty()}],"text":[$text],"memory_mb":{"total":$all,"available":$free}}"""
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
    private fun readByChat(model: Model, type: String, body: ByteArray, gone: () -> Boolean, onWork: () -> Unit): Pair<Int, String> {
        val form = formOf(type, body) ?: return 400 to errorOf("The request is not a multipart form.")
        val sound = form.file ?: return 400 to errorOf("The form has no file in it.")
        val ms = wavMsOf(sound) ?: return 400 to errorOf("The file is not a WAV recording.")
        // Nothing to hear: llama.cpp would refuse it as a file it cannot read.
        if (ms < LEAST_MS) return 200 to TEXT_OF_NOTHING
        soundMs = ms.toLong()
        val seconds = ms / 1000.0
        if (seconds > MOST_SECONDS) return 413 to errorOf("The sound is too long: this phone reads at most $MOST_SECONDS seconds at once.")
        val begun = languageOf(form.fields["language"])?.let { "language $it${Llama.TEXT_MARK}" }

        // The request, written by hand around the sound: letters of base64 need nothing done to them, and a
        // minute of sound put through a JSON library would be copied several times over.
        val before = """{"temperature":0,"max_tokens":${tokensFor(seconds)},"cache_prompt":false,"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":""""
        val beginning = begun?.let { """,{"role":"assistant","content":${JSONObject.quote(it)}}""" }.orEmpty()
        val after = """","format":"wav"}}]}$beginning]}"""
        val pieces = listOf(before.toByteArray(), Base64.encode(sound, Base64.NO_WRAP), after.toByteArray())

        // Its turn: the phone does one thing at a time, and one who has gone meanwhile is not read at all.
        val running = when (val mine = turnFor(model, gone)) {
            is Turn.No -> return mine.status to errorOf(mine.message)
            is Turn.Mine -> mine.up
        }
        val answered: ByteArray?
        try {
            onWork()
            val head = "POST /v1/chat/completions HTTP/1.1\r\nHost: $LOOPBACK\r\nAuthorization: Bearer ${running.key}\r\nContent-Type: application/json\r\nContent-Length: ${pieces.sumOf { it.size }}\r\nConnection: close\r\n\r\n"
            answered = asked(running.port, head, pieces, gone)
            running.usedAt = System.currentTimeMillis()
        } finally {
            turn.give()
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
    private fun readByAudioCpp(model: Model, type: String, body: ByteArray, gone: () -> Boolean, onWork: () -> Unit): Pair<Int, String> {
        val form = formOf(type, body) ?: return 400 to errorOf("The request is not a multipart form.")
        val sound = form.file ?: return 400 to errorOf("The form has no file in it.")
        val ms = wavMsOf(sound) ?: return 400 to errorOf("The file is not a WAV recording.")
        // Nothing to hear: audio.cpp would refuse it as an incomplete file.
        if (ms < LEAST_MS) return 200 to TEXT_OF_NOTHING
        soundMs = ms.toLong()
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
        // Its turn, as llama.cpp's readings take theirs. (audio.cpp's server reads to the end whoever has gone
        // meanwhile: closing its line stops nothing there, so it is not looked whether the computer still waits.)
        val running = when (val mine = turnFor(model, gone)) {
            is Turn.No -> return mine.status to errorOf(mine.message)
            is Turn.Mine -> mine.up
        }
        val heard: ByteArray?
        try {
            onWork()
            heard = asked(running.port, head, pieces) { false }
            running.usedAt = System.currentTimeMillis()
        } finally {
            turn.give()
        }
        val answered = heard ?: return 502 to errorOf("The engine did not answer.")

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
        private const val TAG = "share"

        /** Where a model's engine listens, on this phone alone: the recognizer at one port, each text model at one of its own after it. */
        fun portOf(model: Model): Int = if (model.task == Task.HEAR) ENGINE_PORT else ENGINE_PORT + 1 + TEXT_MODELS.indexOf(model)

        /**
         * What is to be over, in megabytes, once an engine is started beside others (`ensure`): for the pages of
         * their files the engines read from, which the system gives and takes as it has room, and for whatever
         * else the phone is asked meanwhile. A setting more than a measurement. On the F22 Pro (2026-10-13) it lets
         * SenseVoice-Small stay beside Hunyuan MT 2 — the two were up together there with 0.9 GB still to be had,
         * and each answered as fast as alone — and has every other pair take turns: Qwen3-ASR 0.6B started beside
         * Hunyuan MT 2 (1.3 GB and 1.2 GB of their own) used up the phone's swap, the translator was put out of
         * memory whole, and a reading that takes 9 s took 42.
         */
        private const val RESERVE_MB = 400

        /** After an engine is ended, before the memory is asked after again. */
        private const val SETTLE_MS = 300L

        /** The requests in hand at once, of every kind; and of those, the ones for a text model, waiting or being answered. */
        private const val MOST_OPEN = 12
        private const val MOST_ASKING = 4

        /** A text request: the feedback model's, the longest the desktop sends, is under six kilobytes. */
        private const val CHAT_BODY_MOST = 256 * 1024

        /** How long, and how much, of an upload that was refused is let run out before the line is closed. */
        private const val UNREAD_FOR_MS = 1_500
        private const val UNREAD_MOST = 8L * 1024 * 1024

        /**
         * How long a text model may take over one answer. The desktop gives up after a minute
         * (`TEXT_TIMEOUT_MS` in src/providers/openai/textModel.ts), and the door then stops the engine; this is for
         * whoever else asks, and is patient.
         */
        private const val TEXT_TIMEOUT_MS = 180_000L

        private fun gigabytes(megabytes: Long) = "%.1f".format(megabytes / 1024.0)
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
            200 to "OK", 204 to "No Content", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found",
            413 to "Payload Too Large", 429 to "Too Many Requests", 502 to "Bad Gateway", 503 to "Service Unavailable",
        )

        /** How a program ends when the system kills it for an instruction the processor does not have, and when it kills it outright. */
        private const val ILLEGAL_INSTRUCTION = 132
        private const val KILLED = 137

        /** The engines started, by whichever sharing: all of them must be gone before another sharing starts its own. */
        private val started = CopyOnWriteArrayList<Process>()

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
