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
 *
 * Besides those the phone is lent with, the reader comes in two kinds that are only measured by the self-check, on
 * phones nobody building this has: with Arm's KleidiAI kernels, and for Qualcomm's graphics chips through OpenCL.
 * There is no server of either kind: nothing is lent with them.
 */
class Llama(context: Context) {
    /** The programs for the processor, the one for the newest processors first. */
    enum class Build(val words: String) { V86("v86"), V82("v82"), V80("v80") }

    private val home = File(context.applicationInfo.nativeLibraryDir)
    private val vulkan = File(home, "libllama_mtmd_vulkan.so")
    private val openCl = File(home, "libllama_mtmd_opencl.so")
    private val runner = Runner()

    private fun programOf(build: Build) = File(home, "libllama_mtmd_${build.words}.so")
    private fun serverOf(build: Build) = File(home, "libllama_server_${build.words}.so")
    private fun kleidiaiOf(build: Build) = File(home, "libllama_mtmd_kleidiai_${build.words}.so")

    /**
     * What the OpenCL build is started with: where the chip maker's libOpenCL.so and what it loads in turn may be
     * found (`openClFolders`), and its store of compiled kernels turned off — it would be kept in the temporary
     * folder, which a phone gives a program none of, and a check that is run once gains nothing by it.
     */
    private val openClEnvironment: Map<String, String> by lazy { mapOf("LD_LIBRARY_PATH" to openClFolders().joinToString(":"), "GGML_OPENCL_KERNEL_CACHE_DIR" to "0") }

    /** The processor builds of the reader that came with the app. */
    val builds: List<Build> = Build.values().filter { programOf(it).canExecute() }

    /** And of the server. There is none for the graphics chip: on the phones tried it is slower than the processor, or ends the program. */
    val servers: List<Build> = Build.values().filter { serverOf(it).canExecute() }

    /**
     * The builds of the reader with KleidiAI that came with the app: the same code as the plain build of that name,
     * with Arm's kernels beside ggml's own for the language model's quantized matrix products. Which of its kernels
     * it uses it settles itself when it starts, by what the processor has (dot product, i8mm, SME, SME2).
     */
    val kleidiai: List<Build> = Build.values().filter { kleidiaiOf(it).canExecute() }

    val present: Boolean get() = builds.isNotEmpty()

    /** Whether the build for the graphics chip came with it. Whether the phone's driver takes it is found by trying. */
    val hasGraphics: Boolean get() = vulkan.canExecute()

    /** Whether the build for Qualcomm's graphics chips came with it. Whether the phone has such a chip, it says itself (`openClChip`). */
    val hasOpenCl: Boolean get() = openCl.canExecute()

    /** The fastest of the builds here that a processor with these instruction sets runs; null when none of them is. */
    fun buildFor(features: Set<String>): Build? = bestFor(features).let { best -> builds.firstOrNull { it.ordinal >= best.ordinal } }

    /** The next build down, for a processor that turned out not to take `build`. */
    fun below(build: Build): Build? = builds.firstOrNull { it.ordinal > build.ordinal }

    /** The same two for the server. */
    fun serverFor(features: Set<String>): Build? = bestFor(features).let { best -> servers.firstOrNull { it.ordinal >= best.ordinal } }
    fun serverBelow(build: Build): Build? = servers.firstOrNull { it.ordinal > build.ordinal }

    /**
     * And for the reader with KleidiAI: the build at the level the plain reader is picked at, so that the two are the
     * same program but for KleidiAI. Null for a processor KleidiAI has nothing for (`takesKleidiai`), though the
     * program would start on it.
     */
    fun kleidiaiFor(features: Set<String>): Build? = if (!takesKleidiai(features)) null else bestFor(features).let { best -> kleidiai.firstOrNull { it.ordinal >= best.ordinal } }
    fun kleidiaiBelow(build: Build): Build? = kleidiai.firstOrNull { it.ordinal > build.ordinal }

    /**
     * Reads `recording` with `model` to the end: on the processor with `build`, or on the graphics chip when `build`
     * is null. The prompt is the mark where the sound goes and nothing else: with an empty one the program waits
     * for somebody to type.
     */
    fun read(model: Model, store: ModelStore, recording: File, build: Build?, threads: Int, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome {
        val program = if (build == null) vulkan else programOf(build)
        return runner.run(listOf(program.path) + reading(model, store, recording, threads) + if (build == null) ON_GRAPHICS else emptyList(), store.folder, limitMs = limitMs, onLine = onLine)
    }

    /** What every kind of the reader is told: the model, the recording, and how much room and how many threads. */
    private fun reading(model: Model, store: ModelStore, recording: File, threads: Int) = listOf(
        "-m", store.fileOf(model.file).path, "--mmproj", store.fileOf(model.projector!!).path,
        "--audio", recording.path, "-p", MEDIA_MARK, "-t", threads.toString(), "--temp", "0", "-n", "256", "-c", CONTEXT,
    )

    /**
     * The same reading by the build with KleidiAI. It is asked for its fuller log, and not to fit itself to the
     * phone's memory first: KleidiAI says which of its kernels it took once only, the first time a model is opened,
     * and the fitting opens the model with the log shut (so with it nothing is ever said: tried, 2026-10-12). Both
     * are before the model is in memory — outside the stretch that is timed — and with the room said outright the
     * fitting changes nothing for a reader on the processor. `sme = false` has it leave its SME kernels alone,
     * which is how what SME itself brings is told from what Arm's other kernels bring.
     */
    fun readWithKleidiai(model: Model, store: ModelStore, recording: File, build: Build, threads: Int, sme: Boolean = true, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome =
        runner.run(
            listOf(kleidiaiOf(build).path) + reading(model, store, recording, threads) + listOf("-lv", "4", "-fit", "off"),
            store.folder, if (sme) emptyMap() else mapOf(KLEIDIAI_SME to "0"), limitMs, onLine,
        )

    /**
     * And by the build for Qualcomm's graphics chips, everything on the chip; with `hearingOnChip = false` the part
     * that hears stays on the processor, for a chip that reads wrong or not at all with it (nobody has reported
     * this model on one).
     */
    fun readOnOpenCl(model: Model, store: ModelStore, recording: File, threads: Int, hearingOnChip: Boolean = true, limitMs: Long = Long.MAX_VALUE, onLine: (String) -> Unit = {}): Outcome =
        runner.run(
            listOf(openCl.path) + reading(model, store, recording, threads) + ON_GRAPHICS + if (hearingOnChip) emptyList() else listOf("--no-mmproj-offload"),
            store.folder, openClEnvironment, limitMs, onLine,
        )

    /**
     * Asks the OpenCL build which graphics chips it would use, which starts it and ends it without a model: under a
     * second. The answer is the backend's own — it takes Qualcomm's Adreno chips (and Intel's) and no other — so
     * nothing here guesses a chip from its name. Where the program cannot start at all, because the phone has no
     * libOpenCL.so or not one it may load, the system's linker says so in the same breath.
     */
    fun openClChip(limitMs: Long = PROBE_AT_MOST_MS): OpenCl {
        if (!hasOpenCl) return OpenCl(null, null, absent = true)
        val outcome = runner.run(listOf(openCl.path, "--list-devices"), home, openClEnvironment, limitMs)
        // (The linker names the program by its whole path, which is a line and a half of the app's folder.)
        return openClIn(outcome.lines.map { it.replace(home.path + "/", "") }, outcome.exit, outcome.overtime)
    }

    /**
     * What the OpenCL build said of the phone: the chip it would use, or in `words` why there is none — what it or
     * the linker said itself, to be passed on as it is. `absent` when the build is not in the package.
     */
    class OpenCl(val chip: String?, val words: String?, val absent: Boolean = false, val exit: Int = 0, val overtime: Boolean = false)

    /**
     * What KleidiAI says of itself, in the fuller log: the kernels it took for the models' kind of weights
     * (`kleidiai: primary q8 kernel feature SME2` — or `I8MM`, `DOTPROD`), on how many threads at most it runs the
     * SME ones (`kleidiai: SME enabled (runtime-detected SME thread cap=2)`; `kleidiai: SME disabled` where none),
     * and, once the model's weights are in its keeping, `load_tensors: CPU_KLEIDIAI model buffer size = …`.
     */
    class Kleidiai(val kernel: String?, val smeThreads: Int?, val holdsWeights: Boolean)

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
         * Everything on the graphics chip, where there is one to put it on; and one step more of its log, which is
         * where it names the chip (`CHIP`): as it comes it says nothing of what it runs on.
         */
        private val ON_GRAPHICS = listOf("-ngl", "99", "-lv", "4")

        /**
         * The same line from the OpenCL build: `… using device GPUOpenCL (QUALCOMM Adreno(TM) 830) (unknown id) -
         * 6893 MiB free`. A reading by that build without this line was not read on the chip: with no chip it
         * takes, llama.cpp reads on the processor and says nothing of it.
         */
        val OPENCL_CHIP = Regex("""using device GPUOpenCL\d* \((.+)\) \([^()]*\) - \d+ MiB free""")

        /** A chip as `--list-devices` names it: `  GPUOpenCL: QUALCOMM Adreno(TM) 830 (7655 MiB, 6631 MiB free)`. */
        private val OPENCL_LISTED = Regex("""^\s*GPUOpenCL\d*: (.+) \(\d+ MiB, \d+ MiB free\)\s*$""")

        /** Long enough for a driver to answer what chips there are; one that hangs must not hold the check. */
        private const val PROBE_AT_MOST_MS = 20_000L

        /**
         * Where the OpenCL build is told to look for libraries (`LD_LIBRARY_PATH`), given what each of `roots` has
         * for folders inside it.
         *
         * Android has no OpenCL of its own: the library is the chip maker's, in the phone's vendor folder
         * (`/vendor/lib64/libOpenCL.so` on Qualcomm's and on MediaTek's), and the program asks for it by name. A
         * program started from anywhere under `/data` — an app's own folder too — is given the rules of the
         * system's own programs (`dir.system = /data` in `/linkerconfig/ld.config.txt`): it may load from
         * `/system/lib64` and from nowhere in the vendor's folders. Left at that, the program does not start
         * (`library "libOpenCL.so" not found`: F22 Pro, Android 14, 2026-10-12). The folders named here it may load
         * from besides, and they are looked in first. That is how the same build is run from Termux, whose
         * programs lie under `/data` as well, on the Qualcomm phones it is reported on.
         *
         * The folders inside are named too, because the rule is by the folder a file really lies in, and a
         * vendor's library may be a link into one: with `/vendor/lib64` alone, MediaTek's OpenCL found its Mali
         * driver and could not load it for one library kept in `/vendor/lib64/mt6768` — and said only that the
         * phone had no OpenCL. Where a folder may not be listed, the two every phone has.
         */
        fun openClFolders(roots: List<String> = VENDOR_FOLDERS, inside: (String) -> List<String>? = ::foldersIn): List<String> =
            roots.flatMap { root -> listOf(root) + (inside(root)?.takeIf { it.isNotEmpty() } ?: listOf("egl", "hw")).sorted().map { "$root/$it" } }.distinct()

        /** `/system/vendor` is the same folder on every phone since Android 8; before, it was the only one. */
        private val VENDOR_FOLDERS = listOf("/vendor/lib64", "/odm/lib64", "/system/vendor/lib64")

        private fun foldersIn(folder: String): List<String>? = runCatching { File(folder).listFiles()?.filter { it.isDirectory }?.map { it.name } }.getOrNull()

        /**
         * What the OpenCL build answered when asked for its chips (`openClChip`). Where it names none, why: its own
         * word on the chip it would not take (`ggml_opencl: unsupported GPU 'Mali-G52 MC2 r1p0'.`), else whatever
         * was said last — the linker's, where the program never started.
         */
        fun openClIn(lines: List<String>, exit: Int, overtime: Boolean = false): OpenCl {
            val listed = lines.firstNotNullOfOrNull { OPENCL_LISTED.find(it)?.groupValues?.get(1) }
            if (exit == 0 && listed != null) return OpenCl(listed, null)
            val said = lines.map { it.replace(LOG_PREFIX, "").trim() }.filter { it.isNotBlank() && !it.startsWith("Available devices") && it != "(none)" }
            return OpenCl(null, (said.firstOrNull { "ggml_opencl:" in it } ?: said.lastOrNull())?.take(WORDS_SHOWN), exit = exit, overtime = overtime)
        }
        private const val WORDS_SHOWN = 200

        /** The variable KleidiAI reads to leave its SME kernels alone (`0`), or to be held to so many threads of them. */
        private const val KLEIDIAI_SME = "GGML_KLEIDIAI_SME"

        fun kleidiaiIn(lines: List<String>) = Kleidiai(
            lines.firstNotNullOfOrNull { KLEIDIAI_KERNEL.find(it)?.groupValues?.get(1) },
            lines.firstNotNullOfOrNull { KLEIDIAI_SME_CAP.find(it)?.groupValues?.get(1)?.toIntOrNull() },
            lines.any { KLEIDIAI_HOLDS in it },
        )
        private val KLEIDIAI_KERNEL = Regex("""kleidiai: primary q8 kernel feature (\w+)""")
        private val KLEIDIAI_SME_CAP = Regex("""kleidiai: SME enabled \(.*cap=(\d+)\)""")
        private const val KLEIDIAI_HOLDS = "CPU_KLEIDIAI model buffer size"

        /**
         * Whether KleidiAI has anything for a processor: every kernel it has for these models' weights (Q8_0) needs
         * the dot product at least, and the builds with it are the armv8.2 one and up. On an older processor it
         * would turn every product down and the build would be the plain one under another name.
         */
        fun takesKleidiai(features: Set<String>): Boolean = bestFor(features) != Build.V80

        /** The OpenCL build is the armv8.2 one beneath: what the chip does not take is the processor's to do. */
        fun takesOpenCl(features: Set<String>): Boolean = bestFor(features) != Build.V80

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
