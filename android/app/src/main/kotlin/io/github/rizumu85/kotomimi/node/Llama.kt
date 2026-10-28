package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File

/**
 * llama.cpp's two programs, packed as audio.cpp's are (`scripts/build-llama.sh`): its reader of speech
 * (`llama-mtmd-cli`), which reads one recording and ends — the self-check times it against audio.cpp — and its
 * server (`llama-server`), which stays up and is asked over HTTP: what the phone is lent with when the model lent is
 * one of llama.cpp's. Both read the same Qwen3-ASR as audio.cpp, from files of their own. The server also runs the
 * text models — translation, grammar feedback (`TEXT_MODELS`) — which are the desktop app's own and need nothing
 * but it.
 *
 * audio.cpp's engine loads the processor code that fits the phone; these are programs with their processor code
 * built in, so there is one of each for each kind of processor, and the app picks.
 *
 * There is none for the graphics chip, nor any with Arm's KleidiAI kernels: the self-check measured both on three
 * phones (2026-10-12 to 10-28) and neither was a way to lend. Vulkan ended the program or read slower than the
 * processor, OpenCL on an Adreno 830 read at half its speed, and KleidiAI was 25 % slower on a Dimensity 9500 and
 * at most 17 % faster elsewhere. `scripts/build-llama.sh` still builds them, to measure again by hand.
 */
class Llama(context: Context) {
    /** The programs for the processor, the one for the newest processors first. */
    enum class Build(val words: String) { V86("v86"), V82("v82"), V80("v80") }

    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val runner = Runner()

    private fun programOf(build: Build) = File(home, "libllama_mtmd_${build.words}.so")
    private fun serverOf(build: Build) = File(home, "libllama_server_${build.words}.so")

    /** The processor builds of the reader that came with the app. */
    val builds: List<Build> = Build.values().filter { programOf(it).canExecute() }

    /** And of the server. */
    val servers: List<Build> = Build.values().filter { serverOf(it).canExecute() }

    val present: Boolean get() = builds.isNotEmpty()

    /** The fastest of the builds here that a processor with these instruction sets runs; null when none of them is. */
    fun buildFor(features: Set<String>): Build? = bestFor(features).let { best -> builds.firstOrNull { it.ordinal >= best.ordinal } }

    /** The next build down, for a processor that turned out not to take `build`. */
    fun below(build: Build): Build? = builds.firstOrNull { it.ordinal > build.ordinal }

    /** The same two for the server. */
    fun serverFor(features: Set<String>): Build? = bestFor(features).let { best -> servers.firstOrNull { it.ordinal >= best.ordinal } }
    fun serverBelow(build: Build): Build? = servers.firstOrNull { it.ordinal > build.ordinal }

    /**
     * Reads `recording` with `model` to the end, on the processor with `build`: the model, the recording, and how
     * much room and how many threads. The prompt is the mark where the sound goes and nothing else: with an empty
     * one the program waits for somebody to type.
     */
    fun read(model: Model, store: ModelStore, recording: File, build: Build, threads: Int, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome =
        runner.run(
            listOf(
                programOf(build).path, "-m", store.fileOf(model.file).path, "--mmproj", store.fileOf(model.projector!!).path,
                "--audio", recording.path, "-p", MEDIA_MARK, "-t", threads.toString(), "--temp", "0", "-n", "256", "-c", CONTEXT,
            ),
            store.folder, limitMs = limitMs, onLine = onLine,
        )

    /**
     * Starts the server with `model` on this phone alone, at `port`; whoever starts it reads what it writes and ends
     * it. One reading at a time (`-np 1`) and nothing kept of a reading once it is answered (`--cache-ram 0`: left
     * to itself the server may keep up to 8 GB of what it has read, for conversations that come back — a stretch
     * of speech never does).
     *
     * It answers only who has `key`. Without one it answers every app on the phone, and any page open in the
     * phone's browser besides: its answers to another origin carry that origin's leave. (The desktop app starts
     * its own the same way: `LLAMA_RUNTIME` in electron/native-engine.js.)
     *
     * A text model is served as the desktop serves it (`LLAMA_RUNTIME.launch`: the model, the room, no page, no
     * slots, the key; thinking is turned off by each request, not here, and the model's own template is used), but
     * for what a phone needs said: the threads, and no graphics chip (`-ngl` is left out: these builds have none).
     * With one slot, what the server read last stays in that slot and the next request reads only what is new of
     * it — the feedback model's instructions and examples are the same every time — which `--cache-ram 0` does not
     * touch: that is the server's other store, of slots put aside.
     */
    fun serve(model: Model, store: ModelStore, build: Build, threads: Int, port: Int, key: String): Process {
        val arguments = listOf("-m", store.fileOf(model.file).path) +
            (model.projector?.let { listOf("--mmproj", store.fileOf(it).path) } ?: emptyList()) +
            listOf(
                "-c", (if (model.task == Task.HEAR) SERVER_CONTEXT else TEXT_CONTEXT).toString(), "-t", threads.toString(), "-np", "1", "--cache-ram", "0",
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

        /**
         * A text model's room: the desktop's own (`model.context ?? 4096` in electron/native-engine.js), so that
         * whatever a computer may ask its own engine fits here too. The feedback model's instructions with their
         * seven examples are some six hundred letters of it, a sentence to translate a few dozen tokens. The memory
         * figures of `Model.holdsMb` were taken with it.
         */
        const val TEXT_CONTEXT = 4096

        /** The most a stretch of sound takes of that room: 13 tokens a second, and what stands around them. */
        fun tokensOfSound(seconds: Double): Int = (seconds * 13).toInt() + 40

        /** Written once the model is in memory, before the recording is touched. */
        const val LOADED_LINE = "main: loading model"

        /** What stands before the text in the line that carries it: `language English<asr_text>The English …`. */
        const val TEXT_MARK = "<asr_text>"

        /** What its log puts before every line: the time since it started, and a letter for how grave. */
        val LOG_PREFIX = Regex("""^\d+\.\d+\.\d+\.\d+ [A-Z] """)

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
