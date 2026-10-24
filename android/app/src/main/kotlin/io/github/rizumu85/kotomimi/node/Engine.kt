package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * How one run of an engine's program ended: its exit, every line it wrote, how long the whole of it took, the most
 * memory it held (megabytes; 0 where that could not be seen), and whether it was ended for taking too long.
 */
class Outcome(val exit: Int, val lines: List<String>, private val at: List<Long>, val tookMs: Long, val peakMb: Int, val overtime: Boolean) {
    /** When the first line holding `mark` came, in milliseconds from the start of the run. */
    fun saidAt(mark: String): Long? = lines.indexOfFirst { mark in it }.takeIf { it >= 0 }?.let { at[it] }
}

private val PID = Regex("""pid=(\d+)""")

/** Android's `Process` names its number only in what it prints of itself. */
fun pidOf(process: Process): Int? = PID.find(process.toString())?.groupValues?.get(1)?.toIntOrNull()

/**
 * Ends a program outright, whatever it is doing. `destroyForcibly` alone does not on Android: it asks (SIGTERM), and
 * a program that answers the asking ends when it sees fit — llama.cpp's server, asked in the middle of a reading,
 * went on reading for seven seconds with its two gigabytes (F22 Pro, 2026-10-12). The system's own way of ending a
 * process is not to be answered, and is allowed on a process of the app's own.
 */
fun endOutright(process: Process) {
    process.destroyForcibly()
    if (process.isAlive) pidOf(process)?.let(android.os.Process::killProcess)
}

/**
 * What a program of the app's holds, in megabytes, as the kernel keeps it (`/proc/<pid>/status`): the most it has
 * ever held (`VmHWM`), and what it holds now that is its own and no file's (`RssAnon`) — the part the system cannot
 * take back from it. Null once the program is gone.
 */
class Held(val peakMb: Int, val ownMb: Int)

fun heldBy(process: Process): Held? = runCatching {
    val lines = File("/proc/${pidOf(process)!!}/status").readLines()
    fun megabytes(name: String) = lines.firstOrNull { it.startsWith(name) }?.substringAfter(':')?.trim()?.substringBefore(' ')?.toLongOrNull()?.let { (it / 1024).toInt() }
    Held(megabytes("VmHWM:")!!, megabytes("RssAnon:") ?: 0)
}.getOrNull()

/**
 * Runs an engine's program to its end, every line it writes handed on as it comes. The program is gone before this
 * returns: a phone has memory for one at a time.
 */
class Runner {
    @Volatile private var running: Process? = null

    fun run(command: List<String>, folder: File, environment: Map<String, String> = emptyMap(), limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome {
        val started = System.nanoTime()
        fun sinceStart() = (System.nanoTime() - started) / 1_000_000
        val builder = ProcessBuilder(command).directory(folder).redirectErrorStream(true)
        builder.environment().putAll(environment)
        val process = builder.start()
        running = process

        // Beside it while it runs: the most memory it has held, as the kernel keeps it (not every engine says), and
        // an end to a run that does not end — a graphics driver that hangs would hold the whole check for ever.
        val peak = AtomicInteger(0)
        val overtime = AtomicBoolean(false)
        val watch = Thread({
            val status = pidOf(process)?.let { File("/proc/$it/status") }
            try {
                while (process.isAlive) {
                    status?.let(::peakOf)?.let { if (it > peak.get()) peak.set(it) }
                    if (sinceStart() > limitMs) { overtime.set(true); process.destroyForcibly() }
                    Thread.sleep(WATCH_EVERY_MS)
                }
            } catch (ended: InterruptedException) {
                // The run is over.
            }
        }, "engine-watch").apply { isDaemon = true; start() }

        val lines = ArrayList<String>()
        val at = ArrayList<Long>()
        try {
            // Ending the program closes what this reads from under it, and Android then throws here: that is the end
            // of what it wrote, and how it ended is told by its exit.
            runCatching {
                process.inputStream.bufferedReader().forEachLine { line ->
                    lines += line
                    at += sinceStart()
                    onLine(line)
                }
            }
            return Outcome(process.waitFor(), lines, at, sinceStart(), peak.get(), overtime.get())
        } finally {
            running = null
            // Only where the reading above was broken off is there still something to end, and to see gone.
            if (process.isAlive) {
                process.destroyForcibly()
                runCatching { process.waitFor() }
            }
            watch.interrupt()
        }
    }

    /** Ends the program that is running, if one is. */
    fun stop() {
        running?.destroyForcibly()
    }

    private companion object {
        const val WATCH_EVERY_MS = 250L

        /** The high-water mark of the memory it holds (`VmHWM`, in kB), in megabytes. */
        fun peakOf(status: File): Int? = runCatching {
            status.readLines().firstOrNull { it.startsWith("VmHWM:") }?.substringAfter(':')?.trim()?.substringBefore(' ')?.toLongOrNull()?.let { (it / 1024).toInt() }
        }.getOrNull()
    }
}

/**
 * The recognition engine: audio.cpp's two programs, the same engine the desktop app runs. They are packed as native
 * libraries (`scripts/build-engine.sh`) because that is the one place an app may keep a program it starts.
 */
class Engine(context: Context) {
    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val reader = File(home, "libaudiocpp_cli.so")
    private val server = File(home, "libaudiocpp_server.so")
    private val vulkan = File(home, "libkotomimi-vulkan.so")
    private val runner = Runner()

    val present: Boolean get() = reader.canExecute()

    /** Whether the build for the graphics chip came with it. Whether the phone's driver takes it is found by trying. */
    val hasGraphics: Boolean get() = vulkan.exists()

    /** The CPU builds packed with it; it loads the best one this processor has. */
    val variants: List<String>
        get() = home.list().orEmpty().filter { it.startsWith(VARIANT_PREFIX) }.map { it.removePrefix(VARIANT_PREFIX).removeSuffix(".so") }.sorted()

    /** Reads one recording to the end in `folder`, every line it writes handed on as it comes. */
    fun run(arguments: List<String>, folder: File, graphics: Boolean = false, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome =
        runner.run(listOf(reader.path) + arguments, folder, environment(graphics), limitMs, onLine)

    /** Starts the server in `folder`; whoever starts it reads what it writes and ends it. */
    fun serve(arguments: List<String>, folder: File, graphics: Boolean): Process {
        val builder = ProcessBuilder(listOf(server.path) + arguments).directory(folder).redirectErrorStream(true)
        builder.environment().putAll(environment(graphics))
        return builder.start()
    }

    /** Ends the reading that is running, if one is. */
    fun stop() = runner.stop()

    private fun environment(graphics: Boolean): Map<String, String> {
        // Its own libraries lie beside it.
        val all = HashMap<String, String>()
        all["LD_LIBRARY_PATH"] = home.path
        // The graphics backend is loaded only where it is asked for: a driver that cannot take it then costs that
        // one run, not the processor's as well.
        if (graphics) all["GGML_BACKEND_PATH"] = vulkan.path
        return all
    }

    private companion object {
        const val VARIANT_PREFIX = "libggml-cpu-"
    }
}
