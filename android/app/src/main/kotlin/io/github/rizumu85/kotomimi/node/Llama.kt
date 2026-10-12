package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File

/**
 * llama.cpp's two programs, packed as audio.cpp's are (`scripts/build-llama.sh`): its reader of speech
 * (`llama-mtmd-cli`), which reads one recording and ends — the self-check times it against audio.cpp — and its
 * server (`llama-server`), which stays up and is asked over HTTP: what the phone is lent with when the model lent is
 * one of llama.cpp's. Both read the same Qwen3-ASR as audio.cpp, from files of their own.
 *
 * audio.cpp's engine loads the processor code that fits the phone; these are programs with their processor code
 * built in, so there is one of each for each kind of processor, and the app picks.
 */
class Llama(context: Context) {
    /** The programs for the processor, the one for the newest processors first. */
    enum class Build(val words: String) { V86("v86"), V82("v82"), V80("v80") }

    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val vulkan = File(home, "libllama_mtmd_vulkan.so")
    private val runner = Runner()

    private fun programOf(build: Build) = File(home, "libllama_mtmd_${build.words}.so")
    private fun serverOf(build: Build) = File(home, "libllama_server_${build.words}.so")

    /** The processor builds of the reader that came with the app. */
    val builds: List<Build> = Build.values().filter { programOf(it).canExecute() }

    /** And of the server. There is none for the graphics chip: on the phones tried it is slower than the processor, or ends the program. */
    val servers: List<Build> = Build.values().filter { serverOf(it).canExecute() }

    val present: Boolean get() = builds.isNotEmpty()

    /** Whether the build for the graphics chip came with it. Whether the phone's driver takes it is found by trying. */
    val hasGraphics: Boolean get() = vulkan.canExecute()

    /** The fastest of the builds here that a processor with these instruction sets runs; null when none of them is. */
    fun buildFor(features: Set<String>): Build? = bestFor(features).let { best -> builds.firstOrNull { it.ordinal >= best.ordinal } }

    /** The next build down, for a processor that turned out not to take `build`. */
    fun below(build: Build): Build? = builds.firstOrNull { it.ordinal > build.ordinal }

    /** The same two for the server. */
    fun serverFor(features: Set<String>): Build? = bestFor(features).let { best -> servers.firstOrNull { it.ordinal >= best.ordinal } }
    fun serverBelow(build: Build): Build? = servers.firstOrNull { it.ordinal > build.ordinal }

    /**
     * Reads `recording` with `model` to the end: on the processor with `build`, or on the graphics chip when `build`
     * is null. The prompt is the mark where the sound goes and nothing else: with an empty one the program waits
     * for somebody to type.
     */
    fun read(model: Model, store: ModelStore, recording: File, build: Build?, threads: Int, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome {
        val program = if (build == null) vulkan else programOf(build)
        val arguments = listOf(
            "-m", store.fileOf(model.file).path, "--mmproj", store.fileOf(model.projector!!).path,
            "--audio", recording.path, "-p", MEDIA_MARK, "-t", threads.toString(), "--temp", "0", "-n", "256", "-c", CONTEXT,
        )
        // Everything on the graphics chip, where there is one to put it on; and one step more of its log, which is
        // where it names the chip (`CHIP`): as it comes it says nothing of what it runs on.
        return runner.run(listOf(program.path) + arguments + if (build == null) listOf("-ngl", "99", "-lv", "4") else emptyList(), store.folder, limitMs = limitMs, onLine = onLine)
    }

    /**
     * Starts the server with `model` on this phone alone, at `port`; whoever starts it reads what it writes and ends
     * it. One reading at a time (`-np 1`) and nothing kept of a reading once it is answered (`--cache-ram 0`: left
     * to itself the server may keep up to 8 GB of what it has read, for conversations that come back — a stretch
     * of speech never does).
     *
     * It answers only who has `key`. Without one it answers every app on the phone, and any page open in the
     * phone's browser besides: its answers to another origin carry that origin's leave. (The desktop app starts
     * its own the same way: `LLAMA_RUNTIME` in electron/native-engine.js.)
     */
    fun serve(model: Model, store: ModelStore, build: Build, threads: Int, port: Int, key: String): Process {
        val arguments = listOf(
            "-m", store.fileOf(model.file).path, "--mmproj", store.fileOf(model.projector!!).path,
            "-c", SERVER_CONTEXT.toString(), "-t", threads.toString(), "-np", "1", "--cache-ram", "0",
            "--host", "127.0.0.1", "--port", port.toString(), "--no-webui", "--no-slots", "--api-key", key,
        )
        return ProcessBuilder(listOf(serverOf(build).path) + arguments).directory(store.folder).redirectErrorStream(true).start()
    }

    /** Ends the reading that is running, if one is. */
    fun stop() = runner.stop()

    companion object {
        private const val MEDIA_MARK = "<__media__>"

        /**
         * Room for this many tokens, said outright. Left unsaid, llama.cpp makes room for what the model was trained
         * with — 65,536 for Qwen3-ASR — and that room is over two gigabytes of memory filled before anything is read:
         * on a 4 GB phone the system killed every app in the background and then this one, to make way for it
         * (2026-10-12; loading took 27 s that way, 8 s this way). A quarter of a minute of speech is some two hundred
         * tokens, and what is written of it is cut at 256.
         */
        private const val CONTEXT = "1024"

        /**
         * The server's room, which every reading it is ever asked for has to fit in: the sound and what is written
         * of it. The sound takes 13 tokens a second, and what stands around it 16 to 26 more (measured on a
         * desktop with this version: 127 tokens for 8.6 s, 201 for 14.2 s; with the answer begun for the model,
         * 416 for 30 s and 806 for 60 s). Speech is written in 3 to 5 tokens a second, and the door lets a reading
         * run to 12 and a little (`Share.tokensFor`). So a minute of speech is 800 for the sound and up to 800 for
         * its text, and fits; a minute and a half still has room for 9 a second, and nothing longer is taken
         * (`Share.MOST_SECONDS`).
         *
         * What it costs is memory, held from the start whether used or not: 112 MB for every 1024 tokens, the same
         * for either size of the model (`llama_kv_cache: … KV buffer size = 112.00 MiB` at 1024, in its fuller
         * log). On the F22 Pro (4 GB) with the 0.6B model, the server's own memory after a reading and the most it
         * ever held: 1.18 and 1.76 GB at 1024, 1.30 and 1.91 GB at 2048, 1.53 and 2.13 GB at 4096 — the reading
         * no slower for it (2026-10-12). 2048 is still under what audio.cpp's server holds there (2.0 GB).
         */
        const val SERVER_CONTEXT = 2048

        /** The most a stretch of sound takes of that room: 13 tokens a second, and what stands around them. */
        fun tokensOfSound(seconds: Double): Int = (seconds * 13).toInt() + 40

        /** Written once the model is in memory, before the recording is touched. */
        const val LOADED_LINE = "main: loading model"

        /** What stands before the text in the line that carries it: `language English<asr_text>The English …`. */
        const val TEXT_MARK = "<asr_text>"

        /** What its log puts before every line: the time since it started, and a letter for how grave. */
        val LOG_PREFIX = Regex("""^\d+\.\d+\.\d+\.\d+ [A-Z] """)

        /**
         * Where it names the graphics chip it runs on, at the fourth step of its log and no lower:
         * `llama_prepare_model_devices: using device Vulkan0 (Mali-G1-Ultra MC12) (unknown id) - 14000 MiB free`.
         * The name may have brackets of its own ("Adreno (TM) 750"); what follows it has none.
         */
        val CHIP = Regex("""using device Vulkan\d+ \((.+)\) \([^()]*\) - \d+ MiB free""")

        /**
         * The newest build a processor runs, by the instruction sets the kernel names for it (`/proc/cpuinfo`):
         * dot product (`asimddp`) and half floats (`asimdhp`) for the armv8.2 build; the 8-bit matrix multiply
         * (`i8mm`) and `bf16` as well for the armv8.6 one, whose compiler was free to use either.
         */
        fun bestFor(features: Set<String>): Build {
            val v82 = "asimddp" in features && "asimdhp" in features
            return when {
                v82 && "i8mm" in features && "bf16" in features -> Build.V86
                v82 -> Build.V82
                else -> Build.V80
            }
        }
    }
}
