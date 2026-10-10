package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File

/**
 * The recognition engine: audio.cpp's two programs, the same engine the desktop app runs. They are packed as native
 * libraries (`scripts/build-engine.sh`) because that is the one place an app may keep a program it starts.
 */
class Engine(context: Context) {
    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val reader = File(home, "libaudiocpp_cli.so")
    private val server = File(home, "libaudiocpp_server.so")
    private val vulkan = File(home, "libkotomimi-vulkan.so")

    @Volatile private var running: Process? = null

    val present: Boolean get() = reader.canExecute()

    /** Whether the build for the graphics chip came with it. Whether the phone's driver takes it is found by trying. */
    val hasGraphics: Boolean get() = vulkan.exists()

    /** The CPU builds packed with it; it loads the best one this processor has. */
    val variants: List<String>
        get() = home.list().orEmpty().filter { it.startsWith(VARIANT_PREFIX) }.map { it.removePrefix(VARIANT_PREFIX).removeSuffix(".so") }.sorted()

    class Outcome(val exit: Int, val lines: List<String>, val tookMs: Long)

    /** Reads one recording to the end in `folder`, every line it writes handed on as it comes. */
    fun run(arguments: List<String>, folder: File, graphics: Boolean = false, onLine: (String) -> Unit = {}): Outcome {
        val started = System.nanoTime()
        val process = start(reader, arguments, folder, graphics)
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

    /** Starts the server in `folder`; whoever starts it reads what it writes and ends it. */
    fun serve(arguments: List<String>, folder: File, graphics: Boolean): Process = start(server, arguments, folder, graphics)

    /** Ends the reading that is running, if one is. */
    fun stop() {
        running?.destroyForcibly()
    }

    private fun start(program: File, arguments: List<String>, folder: File, graphics: Boolean): Process {
        val builder = ProcessBuilder(listOf(program.path) + arguments).directory(folder).redirectErrorStream(true)
        // Its own libraries lie beside it.
        builder.environment()["LD_LIBRARY_PATH"] = home.path
        // The graphics backend is loaded only where it is asked for: a driver that cannot take it then costs that
        // one run, not the processor's as well.
        if (graphics) builder.environment()["GGML_BACKEND_PATH"] = vulkan.path
        return builder.start()
    }

    private companion object {
        const val VARIANT_PREFIX = "libggml-cpu-"
    }
}
