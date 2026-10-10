package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File

/**
 * The recognition engine: audio.cpp's command-line program, the same engine the desktop app runs. It is packed as a
 * native library (`scripts/build-engine.sh`) because that is the one place an app may keep a program it starts.
 */
class Engine(context: Context) {
    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val program = File(home, "libaudiocpp_cli.so")

    @Volatile private var running: Process? = null

    val present: Boolean get() = program.canExecute()

    /** The CPU builds packed with it; it loads the best one this processor has. */
    val variants: List<String>
        get() = home.list().orEmpty().filter { it.startsWith(VARIANT_PREFIX) }.map { it.removePrefix(VARIANT_PREFIX).removeSuffix(".so") }.sorted()

    class Outcome(val exit: Int, val lines: List<String>, val tookMs: Long)

    /** Runs it to its end in `folder`, every line it writes handed on as it comes. */
    fun run(arguments: List<String>, folder: File, onLine: (String) -> Unit = {}): Outcome {
        val started = System.nanoTime()
        val builder = ProcessBuilder(listOf(program.path) + arguments).directory(folder).redirectErrorStream(true)
        // Its own libraries lie beside it.
        builder.environment()["LD_LIBRARY_PATH"] = home.path
        val process = builder.start()
        running = process
        val lines = ArrayList<String>()
        try {
            process.inputStream.bufferedReader().forEachLine { line ->
                lines += line
                onLine(line)
            }
            return Outcome(process.waitFor(), lines, (System.nanoTime() - started) / 1_000_000)
        } finally {
            running = null
            process.destroy()
        }
    }

    /** Ends what is running, if anything is. */
    fun stop() {
        running?.destroyForcibly()
    }

    private companion object {
        const val VARIANT_PREFIX = "libggml-cpu-"
    }
}
