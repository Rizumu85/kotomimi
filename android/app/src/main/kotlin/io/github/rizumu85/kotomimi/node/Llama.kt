package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File

/**
 * llama.cpp's reader of speech — its `llama-mtmd-cli`, packed as audio.cpp's programs are (`scripts/build-llama.sh`).
 * It reads the same Qwen3-ASR from files of its own. Only the self-check runs it, to say which engine is the faster
 * on this phone: the phone is lent with audio.cpp.
 *
 * audio.cpp's engine loads the processor code that fits the phone; this is one program with its processor code
 * built in, so there is a program for each kind of processor, and the app picks.
 */
class Llama(context: Context) {
    /** The programs for the processor, the one for the newest processors first. */
    enum class Build(val words: String) { V86("v86"), V82("v82"), V80("v80") }

    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val vulkan = File(home, "libllama_mtmd_vulkan.so")
    private val runner = Runner()

    private fun programOf(build: Build) = File(home, "libllama_mtmd_${build.words}.so")

    /** The processor builds that came with the app. */
    val builds: List<Build> = Build.values().filter { programOf(it).canExecute() }

    val present: Boolean get() = builds.isNotEmpty()

    /** Whether the build for the graphics chip came with it. Whether the phone's driver takes it is found by trying. */
    val hasGraphics: Boolean get() = vulkan.canExecute()

    /** The fastest of the builds here that a processor with these instruction sets runs; null when none of them is. */
    fun buildFor(features: Set<String>): Build? = bestFor(features).let { best -> builds.firstOrNull { it.ordinal >= best.ordinal } }

    /** The next build down, for a processor that turned out not to take `build`. */
    fun below(build: Build): Build? = builds.firstOrNull { it.ordinal > build.ordinal }

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
        // Everything on the graphics chip, where there is one to put it on.
        return runner.run(listOf(program.path) + arguments + if (build == null) listOf("-ngl", "99") else emptyList(), store.folder, limitMs = limitMs, onLine = onLine)
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
