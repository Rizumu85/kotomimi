package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The self-check: one fixed recording read with each model that is here, by the engine it is for — audio.cpp's files
 * by audio.cpp, llama.cpp's by llama.cpp — on the processor at two thread counts, each twice, then once on the
 * graphics chip. What every run took is written down, the two engines side by side. The numbers are the phone's own;
 * nothing is judged from the name of its processor.
 *
 * A phone that has just read is warm, and a warm phone reads slower: three checks in a row on one phone gave 1.3,
 * 1.2 and 1.1 times real time for the same setting (2026-10-12). Whichever engine came second would lose by that
 * alone. So the engines take turns within each setting, and before every run the phone is given time to cool back to
 * where it began; a run it could not wait long enough for says so.
 */
class SelfCheck(private val context: Context, private val engine: Engine, private val llama: Llama, private val store: ModelStore) {
    /** What a run that read the recording took. */
    class Reading(val speechMs: Double, val tookMs: Double, val loadMs: Double, val memoryMb: Int, val text: String) {
        /** Seconds of speech read in a second: above 1 it keeps up with a voice read once. */
        val speed: Double get() = if (tookMs > 0) speechMs / tookMs else 0.0
    }

    /**
     * One run: a model on the graphics chip, or on so many threads of the processor. With it, how the phone stood:
     * how long it was waited on to cool and whether it did (`warm` when not), the battery's temperature before and
     * after, and the system's thermal status before. Then the reading, or why there is none.
     */
    class Run(
        val model: Model, val graphics: Boolean, val threads: Int,
        val waitedMs: Long, val warm: Boolean, val warmthBefore: Double?, val warmthAfter: Double?, val thermal: Int?,
        val reading: Reading?, val failure: String?,
    ) {
        val how: String get() = if (graphics) "显卡" else "$threads 线程"
    }

    /** A model's runs one way, and what they come to: the mean of their speeds, so that one lucky run is not it. */
    class Setting(val graphics: Boolean, val threads: Int, val runs: List<Run>) {
        val speed: Double? = runs.mapNotNull { it.reading?.speed }.takeIf { it.isNotEmpty() }?.average()
        val how: String get() = if (graphics) "显卡" else "$threads 线程"
    }

    class OfModel(val model: Model, val runs: List<Run>) {
        val settings: List<Setting> = runs.groupBy { it.graphics to it.threads }.map { (way, its) -> Setting(way.first, way.second, its) }
        val best: Setting? = settings.filter { it.speed != null }.maxByOrNull { it.speed!! }
    }

    class Result(val report: String, val verdict: Verdict, val models: List<OfModel>)

    /** Whether the phone keeps up when it is lent — which is with audio.cpp, so by audio.cpp's runs alone. */
    enum class Verdict(val words: String) {
        FAST("跟得上"), TIGHT("勉强跟上"), SLOW("跟不上"), NONE("没测成"),

        /** None of audio.cpp's models was here to be read: the check compared what there was. */
        COMPARED("测完了"),
    }

    /**
     * `onStep(done, of, words)` as it goes. Returns null when it was stopped. `startWith` is for trying a build of
     * llama.cpp the phone would not pick itself (the fall to the next one down cannot be seen otherwise).
     */
    fun run(onStep: (Int, Int, String) -> Unit, stopped: () -> Boolean, startWith: Llama.Build? = null): Result? {
        val device = Device(context)
        val recording = File(context.cacheDir, RECORDING).also { file ->
            context.assets.open(RECORDING).use { input -> file.outputStream().use { input.copyTo(it) } }
        }
        val speechMs = speechMsOf(recording)
        // Each model that is here whole and has its engine in the app; the same model for the two engines together.
        val groups = MODELS.filter { store.has(it) && (it.reader == Reader.AUDIO_CPP || llama.present) }.groupBy { it.name }
        val threads = threadCounts(device.cores.size)
        fun onGraphics(reader: Reader) = if (reader == Reader.AUDIO_CPP) engine.hasGraphics else llama.hasGraphics
        val steps = groups.values.flatten().sumOf { threads.size * ROUNDS + if (onGraphics(it.reader)) 1 else 0 }

        val began = System.currentTimeMillis()
        val warmthAtStart = device.warmth()
        val (memory, free) = device.memory()
        val charge = device.charge()
        val charging = device.charging()
        val savingPower = device.savingPower()

        var done = 0
        var waitedMs = 0L
        var variant: String? = null
        var chip: String? = null
        var build = startWith?.takeIf { it in llama.builds } ?: llama.buildFor(device.features)
        val steppedDown = ArrayList<String>()

        /** One run, the phone cooled first. Null when the check was stopped. */
        fun measure(model: Model, graphics: Boolean, count: Int): Run? {
            while (true) {
                val (waited, cooled) = cool(device, warmthAtStart, atOnce = done == 0, stopped) { onStep(done, steps, it) } ?: return null
                waitedMs += waited
                onStep(done, steps, "${model.name} · ${model.reader.words} · ${if (graphics) "显卡" else "$count 线程"}")
                val warmthBefore = device.warmth()
                val thermal = device.thermal()
                val using = build
                val outcome = when {
                    model.reader == Reader.AUDIO_CPP -> engine.run(
                        listOf(
                            "--task", "asr", "--family", model.family, "--model", store.fileOf(model.file).path,
                            "--backend", if (graphics) "vulkan" else "cpu", "--threads", count.toString(),
                            "--audio", recording.path, "--language", "en", "--metrics",
                        ),
                        store.folder,
                        graphics,
                        RUN_AT_MOST_MS,
                    )
                    graphics || using != null -> llama.read(model, store, recording, if (graphics) null else using, count, RUN_AT_MOST_MS)
                    else -> return Run(model, graphics, count, waited, !cooled, warmthBefore, warmthBefore, thermal, null, "安装包里没有这台处理器能用的 llama.cpp")
                }
                if (stopped()) return null
                // A processor without what this build of llama.cpp was compiled for ends it at the first such
                // instruction. The next build down then, for the rest of the check, and this run again.
                if (model.reader == Reader.LLAMA_CPP && !graphics && outcome.exit == ILLEGAL_INSTRUCTION && using != null) {
                    val lower = llama.below(using)
                    if (lower != null) {
                        steppedDown += "${using.words} 这一档在这台手机上跑不了（非法指令），换成了 ${lower.words}"
                        build = lower
                        continue
                    }
                }
                // ggml says which of audio.cpp's CPU builds it took for this processor, and what the graphics chip is.
                if (model.reader == Reader.AUDIO_CPP) variant = variant ?: outcome.lines.firstOrNull { LOADED in it }?.substringAfter(VARIANT_PREFIX)?.removeSuffix(".so")
                if (graphics) chip = chip ?: outcome.lines.firstOrNull { CHIP_LINE in it }?.substringAfter(CHIP_LINE)?.substringBefore(" |")
                val reading = if (model.reader == Reader.AUDIO_CPP) audioCppReading(outcome, speechMs) else llamaCppReading(outcome, speechMs)
                return Run(model, graphics, count, waited, !cooled, warmthBefore, device.warmth(), thermal, reading, if (reading == null) whyNot(outcome, model.reader) else null)
            }
        }

        val checked = ArrayList<Pair<String, List<Run>>>()
        for ((name, models) in groups) {
            val runs = ArrayList<Run>()
            val broken = HashSet<Model>()
            // The engines in turn within each setting, and every setting once before any is read again: neither
            // engine has the cool phone to itself. The graphics chip last: a driver that cannot take it ends that
            // one run, and the rest is already had.
            val turns = (1..ROUNDS).flatMap { threads.flatMap { count -> models.map { Triple(it, false, count) } } } +
                models.filter { onGraphics(it.reader) }.map { Triple(it, true, GRAPHICS_THREADS) }
            for ((model, graphics, count) in turns) {
                // A model that could not be read on the processor is not asked again: on a phone it is too big for,
                // every try is a long wait for the same end.
                if (model !in broken) {
                    val run = measure(model, graphics, count) ?: return null
                    runs += run
                    if (run.reading == null && !graphics) broken += model
                }
                done += 1
            }
            checked += name to runs
        }
        onStep(steps, steps, "写报告")

        val results = checked.flatMap { (_, runs) -> runs.map { it.model }.distinct().map { model -> OfModel(model, runs.filter { it.model === model }) } }
        val lent = results.filter { it.model.reader == Reader.AUDIO_CPP }
        val verdict = when {
            lent.isEmpty() && results.isNotEmpty() -> Verdict.COMPARED
            else -> lent.mapNotNull { it.best?.speed }.maxOrNull()?.let(::verdictOf) ?: Verdict.NONE
        }
        val report = buildString {
            appendLine("Kotomimi 手机端自检 ${BuildConfigLite.VERSION}")
            appendLine(SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date()) + "，用了 ${minutes(System.currentTimeMillis() - began)}（其中等手机凉下来 ${minutes(waitedMs)}）")
            appendLine()
            appendLine("手机：${device.name}")
            appendLine("芯片：${device.chip}")
            appendLine("系统：${device.android}")
            appendLine("处理器：${device.coresInWords()}")
            appendLine("指令集：${device.featuresInWords()}")
            if (engine.hasGraphics || llama.hasGraphics) appendLine("显卡：${chip ?: "引擎没认出来"}")
            appendLine("内存：共 ${"%.1f".format(memory / 1024.0)} GB，开始时空闲 ${"%.1f".format(free / 1024.0)} GB")
            appendLine("电池：" + listOfNotNull(charge?.let { "$it%" }, charging?.let { if (it) "充着电" else "没充电" }, if (savingPower) "省电模式开着" else "省电模式关着").joinToString("，"))
            val handicaps = listOfNotNull(if (charging == true) "充着电手机更热" else null, if (savingPower) "省电模式会限速" else null)
            if (handicaps.isNotEmpty()) appendLine("  （${handicaps.joinToString("，")}：这次的数字可能偏慢）")
            val warmthAtEnd = device.warmth()
            if (warmthAtStart != null && warmthAtEnd != null) appendLine("电池温度：$warmthAtStart°C → $warmthAtEnd°C")
            val read = results.map { it.model.reader }.toSet()
            appendLine(
                "引擎：audio.cpp ${BuildConfigLite.ENGINE}，" +
                    if (Reader.AUDIO_CPP in read) "处理器用的是 ${variant ?: "没说"} 这一档（共 ${engine.variants.size} 档）" else "这次没有它的模型",
            )
            appendLine(
                "引擎：llama.cpp ${BuildConfigLite.LLAMA}，" + when {
                    !llama.present -> "这个安装包里没有带"
                    Reader.LLAMA_CPP !in read -> "这次没有它的模型"
                    build == null -> "没有这台处理器能用的那一档"
                    else -> "处理器用的是 ${build!!.words} 这一档（共 ${llama.builds.size} 档）"
                },
            )
            for (step in steppedDown) appendLine("  llama.cpp 的 $step")
            appendLine()
            if (checked.isEmpty()) appendLine("没有模型：先下载一个。")
            else appendLine("下面是倍速：${seconds(speechMs)} 秒的录音，处理器每种线程数读 $ROUNDS 遍，显卡读 1 遍，每遍之前先等手机凉下来。")
            appendLine()
            for ((name, runs) in checked) {
                append(blockOf(name, runs, results.filter { it.model.name == name }, threads))
                appendLine()
            }
            appendLine("怎么看：倍速是一秒钟能读几秒的话。边听边出字要把同一段话反复读，")
            appendLine("所以 4 倍以上算跟得上，2 到 4 倍勉强，2 倍以下跟不上。")
            appendLine("每次读之前都先等手机凉下来，两个引擎轮流读，免得排在后面的吃亏。")
            if (checked.any { (_, runs) -> runs.any { it.warm } }) appendLine("带 * 的是等了 ${COOL_AT_MOST_MS / 60_000} 分钟还没凉下来、热着测的。")
            appendLine("现在共享用的是 audio.cpp；llama.cpp 只是拿来比一比。")
        }
        File(context.getExternalFilesDir(null), "report.txt").writeText(report)
        // What sharing starts the engine with: the fastest way found here for audio.cpp, the engine it runs.
        for (result in lent) result.best?.let { Choices(context).remember(result.model, it.graphics, it.threads) }
        return Result(report, verdict, results)
    }

    /**
     * Waits for the phone to cool before a run: a few seconds at least, then until the battery is back within a
     * degree of where it was when the check began and the system no longer calls the phone hot — or until it has
     * stopped getting cooler. A phone that began the check cold never comes back to within a degree of that while
     * it is being checked: on the first phone tried, six runs in ten waited the full three minutes for a goal it
     * had settled 0.4 °C above. Settled is as fair a start as cooled — every run then begins from the same warmth,
     * whichever engine's turn it is — so it goes on from there. Only a phone still cooling when the longest wait is
     * over is run warm, and marked so.
     * Returns how long it waited and whether the phone cooled or settled; null when the check was stopped.
     *
     * The battery's is the one temperature every phone gives an app. It follows the processor's slowly, and some
     * phones report it only now and then: the least wait is for that, too.
     */
    private fun cool(device: Device, warmthAtStart: Double?, atOnce: Boolean, stopped: () -> Boolean, onWait: (String) -> Unit): Pair<Long, Boolean>? {
        val began = System.nanoTime()
        // Nothing has been read before the first run: there is nothing to cool from but what the system itself says.
        val atLeast = if (atOnce) 0L else COOL_AT_LEAST_MS
        // The coolest it has been in this wait, and when it got there.
        var coolest = Double.MAX_VALUE
        var coolestAt = 0L
        while (true) {
            if (stopped()) return null
            val waited = (System.nanoTime() - began) / 1_000_000
            val warmth = device.warmth()
            val thermal = device.thermal()
            val goal = warmthAtStart?.let { it + COOL_WITHIN }
            val cooled = goal == null || warmth == null || warmth <= goal
            val calm = thermal == null || thermal == Device.THERMAL_NONE
            if (warmth != null && warmth < coolest - COOL_STEP) { coolest = warmth; coolestAt = waited }
            val settled = waited - coolestAt >= COOL_SETTLED_MS
            if ((cooled || settled) && calm && waited >= atLeast) return waited to true
            if (waited >= COOL_AT_MOST_MS) return waited to false
            val left = (COOL_AT_MOST_MS - waited) / 1000
            onWait(
                when {
                    !cooled -> "等手机凉下来：现在 $warmth°C，到 ${"%.1f".format(goal)}°C 或不再降了就继续（最多再等 $left 秒）"
                    !calm -> "等手机凉下来：系统说它还热（最多再等 $left 秒）"
                    else -> "歇几秒再读下一遍…"
                },
            )
            Thread.sleep(COOL_LOOK_EVERY_MS)
        }
    }

    /** audio.cpp says what it took itself, in `name=value` lines. */
    private fun audioCppReading(outcome: Outcome, speechMs: Double): Reading? {
        if (outcome.exit != 0) return null
        val said = outcome.lines.associate { line -> line.substringBefore('=') to line.substringAfter('=', "") }
        val took = said["metrics.wall_ms"]?.toDoubleOrNull() ?: return null
        return Reading(
            speechMs = said["metrics.audio_duration_ms"]?.toDoubleOrNull() ?: speechMs,
            tookMs = took,
            // The rest of the run: starting, and reading the model in.
            loadMs = (outcome.tookMs - took).coerceAtLeast(0.0),
            memoryMb = said["metrics.memory.peak_rss_mb"]?.toDoubleOrNull()?.toInt() ?: outcome.peakMb,
            text = said["text_output"].orEmpty(),
        )
    }

    /**
     * llama.cpp says nothing of the kind, so it is timed from here: loading is from the start of the program to the
     * line it writes once the model is in memory, reading from that line to its end. That is the stretch audio.cpp's
     * `metrics.wall_ms` covers — the recording taken in, heard and written out, without the loading — so the two
     * speeds can be set side by side. (It is a little unkind to llama.cpp: the program's own ending is in it.)
     */
    private fun llamaCppReading(outcome: Outcome, speechMs: Double): Reading? {
        if (outcome.exit != 0) return null
        val loaded = outcome.saidAt(Llama.LOADED_LINE) ?: return null
        val text = outcome.lines.lastOrNull { Llama.TEXT_MARK in it }?.substringAfter(Llama.TEXT_MARK)?.trim() ?: return null
        return Reading(speechMs, (outcome.tookMs - loaded).toDouble(), loaded.toDouble(), outcome.peakMb, text)
    }

    /** Why a run gave no reading: that it was killed by a fault, or what it said last. */
    private fun whyNot(outcome: Outcome, reader: Reader): String {
        // audio.cpp ends with its `name=value` lines, which say nothing of a failure; llama.cpp's log has `=` all over.
        val last = outcome.lines.lastOrNull { it.isNotBlank() && (reader == Reader.LLAMA_CPP || '=' !in it) }?.replace(Llama.LOG_PREFIX, "")?.trim()?.take(160)
        return when {
            outcome.overtime -> "${RUN_AT_MOST_MS / 60_000} 分钟还没读完，停下了"
            // With what it said last, where it said anything: "it crashed (134)" on a friend's phone told nobody why
            // its graphics chip could not be used (2026-10-12).
            outcome.exit in CRASHES -> "引擎崩了（${outcome.exit}）" + (last?.let { "：$it" } ?: "")
            outcome.exit == KILLED -> "被系统停掉了（${outcome.exit}），多半是内存不够"
            outcome.exit == 0 -> "没读出字" + (last?.let { "：$it" } ?: "")
            else -> last ?: "引擎退出（${outcome.exit}）"
        }
    }

    /** One model's part of the report: the engines side by side, which was fastest, then every run as it was made. */
    private fun blockOf(name: String, runs: List<Run>, models: List<OfModel>, threads: List<Int>): String = buildString {
        appendLine("【$name】")
        for (count in threads) {
            appendLine("  $count 线程：" + models.joinToString("   ") { of -> "${of.model.reader.words} ${speedsOf(of.runs.filter { !it.graphics && it.threads == count })}" })
        }
        for (of in models) {
            val run = of.runs.firstOrNull { it.graphics } ?: continue
            appendLine("  显卡：${of.model.reader.words} " + (run.reading?.let { "${times(it.speed)}${if (run.warm) "*" else ""} 倍速" } ?: "用不了（${run.failure}）"))
        }
        for (of in models) of.runs.firstOrNull { !it.graphics && it.reading == null }?.let { appendLine("  ${of.model.reader.words} 没读成：${it.failure}") }

        val bests = models.mapNotNull { of -> of.best?.let { best -> Triple(of.model.reader, best, best.speed ?: 0.0) } }.sortedByDescending { it.third }
        bests.firstOrNull()?.let { (reader, best, speed) ->
            val fastest = "${reader.words} ${best.how}，${times(speed)} 倍速"
            val other = bests.getOrNull(1)
            if (other == null) {
                appendLine("  最快：$fastest" + if (reader == Reader.AUDIO_CPP) " → ${verdictOf(speed).words}" else "")
            } else {
                val ahead = ((speed / other.third - 1) * 100).roundToInt()
                val against = "${other.first.words} 最快的（${other.second.how}，${times(other.third)} 倍速）"
                appendLine(if (ahead >= NEAR_PER_CENT) "  最快：$fastest，比 ${against}快 $ahead%" else "  最快：$fastest，和 ${against}差不多（差 $ahead%）")
                // The phone is lent with audio.cpp, whichever was the faster here.
                bests.first { it.first == Reader.AUDIO_CPP }.let { (_, lent, its) -> appendLine("  共享用的是 audio.cpp：${lent.how}，${times(its)} 倍速 → ${verdictOf(its).words}") }
            }
        }
        val texts = models.mapNotNull { of -> of.best?.runs?.firstNotNullOfOrNull { it.reading }?.let { of.model.reader.words to it.text } }
        if (texts.size > 1 && texts.all { it.second == texts.first().second }) appendLine("  读出的字（两个引擎一样）：${texts.first().second}")
        else for ((reader, text) in texts) appendLine("  读出的字（$reader）：$text")

        appendLine("  每一次（读 · 装入 · 内存 · 电池温度）：")
        for ((index, run) in runs.withIndex()) {
            val took = run.reading?.let { "${seconds(it.tookMs)} 秒 · ${seconds(it.loadMs)} 秒 · ${if (it.memoryMb > 0) "%.1f GB".format(it.memoryMb / 1024.0) else "—"}" } ?: "没读成"
            val notes = (if (run.warm) "，等了 ${run.waitedMs / 1000} 秒没凉下来" else "") +
                (run.thermal?.takeIf { it != Device.THERMAL_NONE }?.let { "，系统说手机热（${Device.thermalInWords(it)}）" } ?: "")
            appendLine("   ${index + 1} ${run.model.reader.words} ${run.how}：$took · ${run.warmthBefore ?: "?"}→${run.warmthAfter ?: "?"}°C$notes")
        }
    }

    /** "0.52 / 0.51* 倍速": the runs of one setting in the order they were made, a warm one marked. */
    private fun speedsOf(runs: List<Run>): String {
        if (runs.isEmpty()) return "没测"
        return runs.joinToString(" / ") { run -> run.reading?.let { times(it.speed) + if (run.warm) "*" else "" } ?: "没读成" } + if (runs.any { it.reading != null }) " 倍速" else ""
    }

    private fun verdictOf(speed: Double) = when {
        speed >= FAST_FROM -> Verdict.FAST
        speed >= TIGHT_FROM -> Verdict.TIGHT
        else -> Verdict.SLOW
    }

    /** Two places: on a slow phone the whole difference between two engines is 0.52 against 0.58. */
    private fun times(speed: Double) = "%.2f".format(speed)

    private fun seconds(ms: Double) = "%.1f".format(ms / 1000.0)

    private fun minutes(ms: Long) = if (ms < 60_000) "${ms / 1000} 秒" else "${(ms / 60_000.0).roundToInt()} 分钟"

    /** How long a WAV recording is, by its own header: llama.cpp does not say, as audio.cpp does. */
    private fun speechMsOf(recording: File): Double {
        val bytes = recording.readBytes()
        val numbers = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var at = 12
        var bytesASecond = 0
        while (at + 8 <= bytes.size) {
            val chunk = String(bytes, at, 4, Charsets.US_ASCII)
            val size = numbers.getInt(at + 4)
            if (chunk == "fmt " && at + 20 <= bytes.size) bytesASecond = numbers.getInt(at + 16)
            if (chunk == "data") return if (bytesASecond > 0) minOf(size, bytes.size - at - 8) * 1000.0 / bytesASecond else 0.0
            if (size < 0) break
            at += 8 + size + (size and 1)
        }
        return 0.0
    }

    companion object {
        const val RECORDING = "selfcheck.wav"
        private const val LOADED = "loaded CPU backend from"
        private const val VARIANT_PREFIX = "libggml-cpu-"
        private const val CHIP_LINE = "ggml_vulkan: 0 = "
        private const val GRAPHICS_THREADS = 4

        /** Each setting of the processor is read this many times: one run alone may have been the lucky or the unlucky one. */
        private const val ROUNDS = 2

        /** How a program ends when the system kills it for a fault (128 + the signal): illegal instruction, abort, bus, arithmetic, bad address. */
        private const val ILLEGAL_INSTRUCTION = 132
        private val CRASHES = setOf(ILLEGAL_INSTRUCTION, 134, 135, 136, 139)

        /** And when it is killed outright — on a phone, as a rule, for the memory it took. */
        private const val KILLED = 137

        /** No run is waited on longer: a driver that hangs must not hold the check for ever. The slowest phone tried takes under a minute. */
        private const val RUN_AT_MOST_MS = 10 * 60_000L

        /** Before a run: cooled is within this of the battery's temperature at the start, in °C. */
        private const val COOL_WITHIN = 1.0
        private const val COOL_AT_LEAST_MS = 10_000L
        private const val COOL_AT_MOST_MS = 180_000L
        /** No cooler for this long is as cool as it gets; and a fall smaller than this is the sensor's own noise. */
        private const val COOL_SETTLED_MS = 40_000L
        private const val COOL_STEP = 0.05
        private const val COOL_LOOK_EVERY_MS = 1_000L

        /** Engines closer than this, in per cent, are called about as fast as each other: two runs of one setting differ by as much. */
        private const val NEAR_PER_CENT = 5

        /** Live captions read a growing stretch again and again: several times real time is what keeping up means. */
        const val FAST_FROM = 4.0
        const val TIGHT_FROM = 2.0

        /**
         * The thread counts tried, always fewer than the phone has cores: with as many threads as cores the engines
         * fall over each other. Four and six on the eight-core phones of today — on a fast one (1 + 3 + 4 cores) two
         * and eight were never the best (2026-10-12) — and what is left of that on a phone with fewer.
         */
        fun threadCounts(cores: Int): List<Int> = when {
            cores > 6 -> listOf(4, 6)
            cores > 4 -> listOf(2, 4)
            cores > 2 -> listOf(2)
            else -> listOf(1)
        }
    }
}

/** What the build knows of itself. */
object BuildConfigLite {
    const val VERSION = "0.3.0"
    const val ENGINE = "0.9.0"
    const val LLAMA = "b11401"
}
