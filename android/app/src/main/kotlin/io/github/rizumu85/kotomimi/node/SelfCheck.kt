package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The self-check: one fixed recording read with each model that is here, by the engine it is for — audio.cpp's files
 * by audio.cpp, llama.cpp's by llama.cpp — on the processor at two thread counts, each twice. What every run took is
 * written down, the two engines side by side, and with it which of them the phone is lent with from now on and how
 * that will be. The numbers are the phone's own; nothing is judged from the name of its processor. (A model one
 * engine alone reads — SenseVoice-Small, audio.cpp's — has a block with that one engine in it.)
 *
 * A phone that has just read is warm, and a warm phone reads slower: three checks in a row on one phone gave 1.3,
 * 1.2 and 1.1 times real time for the same setting (2026-10-12). Whichever engine came second would lose by that
 * alone. So the engines take turns within each setting, and before every run the phone is given time to cool back to
 * where it began; a run it could not wait long enough for says so.
 *
 * Up to 0.9.3 it also read on the graphics chip, and llama.cpp built with Arm's KleidiAI kernels and through OpenCL,
 * measured and never lent. Three phones answered that (2026-10-12 to 10-28; `Llama`): none of the three was a way to
 * lend, and they were seven of the seventeen runs of a model, each with its wait to cool.
 *
 * After the recognizers come the text models that are here — translation, grammar feedback — each asked on
 * llama.cpp's server the way a computer will ask it (`TextCheck`), on the same thread counts, the phone cooled the
 * same way before each start. A check finds what there is: recognizers alone, text models alone, or both.
 */
class SelfCheck(private val context: Context, private val engine: Engine, private val llama: Llama, private val store: ModelStore) {
    /** What a run that read the recording took. */
    class Reading(val speechMs: Double, val tookMs: Double, val loadMs: Double, val memoryMb: Int, val text: String, private val expected: String = EXPECTED) {
        /** Seconds of speech read in a second: above 1 it keeps up with a voice read once. */
        val speed: Double get() = if (tookMs > 0) speechMs / tookMs else 0.0

        /**
         * How many letters of it are not the recording's (`EXPECTED`): fast is worth nothing where the text is
         * wrong. Marks, spaces and capitals are not counted — the two sizes of the model already differ by two commas.
         */
        val wrong: Int = lettersApart(lettersOf(text), lettersOf(expected))

        /** Read right: within a few letters of what the recording says. A text that ran on, or is another's, is not. */
        val right: Boolean get() = wrong <= lettersOf(expected).length * WRONG_AT_MOST
    }

    /**
     * One run: a model on so many threads of the processor. With it, how the phone stood:
     * how long it was waited on to cool and whether it did (`warm` when not), the battery's temperature before and
     * after, and the system's thermal status before. Then the reading, or why there is none.
     */
    class Run(
        val model: Model, val threads: Int,
        val waitedMs: Long, val warm: Boolean, val warmthBefore: Double?, val warmthAfter: Double?, val thermal: Int?,
        val reading: Reading?, val failure: String?,
        /** The recording read: the English one the speeds are measured on, unless it says otherwise. */
        val clip: Clip = ENGLISH,
        /** How near the phone was to being held back for heat when the run was over (`Device.headroom`). */
        val headroom: Double? = null,
    ) {
        val how: String get() = "$threads 线程"
    }

    /**
     * A recording the check reads, the language audio.cpp is told it is in (llama.cpp tells that itself), and what
     * it says. The English one is what every speed is measured on. The Japanese one is read once by each engine: the
     * app is used for Japanese, and a build of an engine that reads English right on a phone has not thereby read
     * Japanese right on it. (LibriVox's public-domain reading of Akutagawa's 杜子春, 8.6 s of its first minute.)
     */
    class Clip(val asset: String, val language: String, val expected: String)

    /** A model's runs one way, and what they come to: the mean of their speeds, so that one lucky run is not it. */
    class Setting(val threads: Int, val runs: List<Run>) {
        /** Of the runs that read it right: a run that was quick and wrong has no speed to speak of. */
        val speed: Double? = runs.mapNotNull { run -> run.reading?.takeIf { it.right }?.speed }.takeIf { it.isNotEmpty() }?.average()
        val how: String get() = "$threads 线程"
    }

    class OfModel(val model: Model, val runs: List<Run>) {
        /** The speeds are of the English recording alone: the Japanese one is another length, read once. */
        val settings: List<Setting> = runs.filter { it.clip === ENGLISH }.groupBy { it.threads }.map { (threads, its) -> Setting(threads, its) }
        val japanese: Run? = runs.firstOrNull { it.clip === JAPANESE }
        val best: Setting? = settings.filter { it.speed != null }.maxByOrNull { it.speed!! }

        /** The way the phone is lent with it: the fastest found. */
        val lent: Setting? get() = best
    }

    /** `models` are the recognizers read, `lending` the one the phone is lent with from now on where it was among them, `texts` the text models. */
    class Result(val report: String, val verdict: Verdict, val models: List<OfModel>, val lending: OfModel?, val texts: List<TextCheck.Of> = emptyList())

    /** Whether the phone keeps up when it is lent: by the runs of the model it is lent with, the way it is lent. */
    enum class Verdict(val words: String) {
        FAST("跟得上"), TIGHT("勉强跟上"), SLOW("跟不上"), NONE("没测成"),

        /** Nothing that was checked can be lent (a package without llama.cpp's server): the check compared what there was. */
        COMPARED("测完了"),
    }

    /**
     * `onStep(done, of, words)` as it goes. Returns null when it was stopped. `startWith` is for trying a build of
     * llama.cpp the phone would not pick itself (the fall to the next one down cannot be seen otherwise): nothing a
     * user can ask.
     */
    fun run(onStep: (Int, Int, String) -> Unit, stopped: () -> Boolean, startWith: Llama.Build? = null): Result? {
        val device = Device(context)
        fun unpacked(asset: String): File? = runCatching {
            File(context.cacheDir, asset).also { file -> context.assets.open(asset).use { input -> file.outputStream().use { input.copyTo(it) } } }
        }.getOrNull()
        val recording = unpacked(RECORDING) ?: File(context.cacheDir, RECORDING)
        val speechMs = speechMsOf(recording)
        // A package built without it checks the English one alone.
        val japanese = unpacked(JAPANESE.asset)
        // Each model that is here whole and has its engine in the app; the same model for the two engines together.
        val groups = MODELS.filter { store.has(it) && (it.reader == Reader.AUDIO_CPP || llama.present) }.groupBy { it.name }
        val threads = threadCounts(device.cores.size)

        val began = System.currentTimeMillis()
        val warmthAtStart = device.warmth()
        val (memory, free) = device.memory()

        // The text models that are here whole: each is asked on a server of llama.cpp's (`TextCheck`), after the
        // recognizers. One this phone has no server for, or could not hold at all, is not started: its block says why.
        var server = startWith?.takeIf { it in llama.servers } ?: llama.serverFor(device.features)
        val texts = TEXT_MODELS.filter { store.has(it) }
        val unasked = texts.mapNotNull { model ->
            when {
                server == null -> model to "安装包里没有这台处理器能用的 llama.cpp"
                !Choices.fitsIn(model, memory) -> model to "这台手机内存不够：它的引擎自己要占 ${"%.1f".format(model.holdsMb / 1024.0)} GB，手机一共 ${"%.1f".format(memory / 1024.0)} GB"
                else -> null
            }
        }.toMap()

        val steps = groups.values.flatten().sumOf { threads.size * ROUNDS + if (japanese != null) 1 else 0 } +
            texts.count { it !in unasked } * threads.size * ROUNDS
        val charge = device.charge()
        val charging = device.charging()
        val savingPower = device.savingPower()

        var done = 0
        var waitedMs = 0L
        var variant: String? = null
        var build = startWith?.takeIf { it in llama.builds } ?: llama.buildFor(device.features)
        val steppedDown = ArrayList<String>()

        /** One run, the phone cooled first. Null when the check was stopped. */
        fun measure(model: Model, count: Int, clip: Clip = ENGLISH): Run? {
            val sound = if (clip === JAPANESE) japanese!! else recording
            val soundMs = if (clip === JAPANESE) speechMsOf(sound) else speechMs
            while (true) {
                val (waited, cooled) = cool(device, warmthAtStart, atOnce = done == 0, stopped) { onStep(done, steps, it) } ?: return null
                waitedMs += waited
                // (The engine where the model has a row for each: a model with the one row is named by its name alone,
                // which with the engine's beside it runs over the line of a small screen.)
                onStep(done, steps, listOfNotNull(model.name, model.reader.words.takeIf { model.twin }, "$count 线程", "日语".takeIf { clip === JAPANESE }).joinToString(" · "))
                val warmthBefore = device.warmth()
                val thermal = device.thermal()
                val using = build
                val outcome = when {
                    model.reader == Reader.AUDIO_CPP -> engine.run(
                        listOf(
                            "--task", "asr", "--family", model.family, "--model", store.fileOf(model.file).path,
                            "--backend", "cpu", "--threads", count.toString(),
                            "--audio", sound.path, "--language", clip.language, "--metrics",
                        ) + model.options.flatMap { listOf("--request-option", "${it.key}=${it.value}") },
                        store.folder,
                        RUN_AT_MOST_MS,
                    )
                    using != null -> llama.read(model, store, sound, using, count, RUN_AT_MOST_MS)
                    else -> return Run(model, count, waited, !cooled, warmthBefore, warmthBefore, thermal, null, "安装包里没有这台处理器能用的 llama.cpp", clip)
                }
                if (stopped()) return null
                // A processor without what this build of llama.cpp was compiled for ends it at the first such
                // instruction. The next build down then, for the rest of the check, and this run again.
                if (model.reader == Reader.LLAMA_CPP && outcome.exit == ILLEGAL_INSTRUCTION && using != null) {
                    val lower = llama.below(using)
                    if (lower != null) {
                        steppedDown += "llama.cpp 的 ${using.words} 这一档在这台手机上跑不了（非法指令），换成了 ${lower.words}"
                        build = lower
                        continue
                    }
                }
                // ggml says which of audio.cpp's CPU builds it took for this processor.
                if (model.reader == Reader.AUDIO_CPP) variant = variant ?: outcome.lines.firstOrNull { LOADED in it }?.substringAfter(VARIANT_PREFIX)?.removeSuffix(".so")
                val reading = if (model.reader == Reader.AUDIO_CPP) audioCppReading(outcome, soundMs, clip.expected, model.unspaced) else llamaCppReading(outcome, soundMs, clip.expected)
                return Run(model, count, waited, !cooled, warmthBefore, device.warmth(), thermal, reading, if (reading == null) whyNot(outcome, model.reader) else null, clip, device.headroom())
            }
        }

        val checked = ArrayList<Pair<String, List<Run>>>()
        for ((name, models) in groups) {
            val runs = ArrayList<Run>()
            // A model an engine could not read is not asked again.
            val broken = HashSet<Model>()
            fun of(model: Model) = OfModel(model, runs.filter { it.model === model })
            // The engines in turn within each setting, and every setting once before any is read again: neither
            // engine has the cool phone to itself.
            val rounds = (1..ROUNDS).flatMap { threads.flatMap { count -> models.map { model -> model to count } } }
            for ((model, count) in rounds) {
                // A model that could not be read is not asked again: on a phone it is too big for, every try is a
                // long wait for the same end.
                if (model !in broken) {
                    val run = measure(model, count) ?: return null
                    runs += run
                    if (run.reading == null) broken += model
                }
                done += 1
            }
            // The Japanese recording, once by each engine, the way that engine was fastest just now.
            if (japanese != null) {
                for (model in models) {
                    if (model !in broken) {
                        val fastest = of(model).best?.threads ?: threads.first()
                        runs += measure(model, fastest, JAPANESE) ?: return null
                    }
                    done += 1
                }
            }
            checked += name to runs
        }

        /**
         * One run of a text model's server, the phone cooled first as before a recognizer's. Null when the check was
         * stopped. Where the memory that can be had now is less than the engine keeps for its own, it is not started:
         * the system would end it, or this app, to find the room.
         */
        fun ask(model: Model, count: Int): TextCheck.Run? {
            val check = TextCheck(llama, store)
            while (true) {
                val (waited, cooled) = cool(device, warmthAtStart, atOnce = done == 0, stopped) { onStep(done, steps, it) } ?: return null
                waitedMs += waited
                onStep(done, steps, "${model.name} · $count 线程")
                val warmthBefore = device.warmth()
                val thermal = device.thermal()
                val using = server!!
                val room = device.memory().second
                val outcome = if (room < model.holdsMb) {
                    TextCheck.Outcome(null, null, emptyList(), 0, 0, "内存不够：现在能用的是 ${"%.1f".format(room / 1024.0)} GB，它的引擎自己要占 ${"%.1f".format(model.holdsMb / 1024.0)} GB")
                } else {
                    check.run(model, using, count, stopped) ?: return null
                }
                // The server on a processor without what this build was compiled for: the next build down, as the reader's.
                if (outcome.exit == ILLEGAL_INSTRUCTION) {
                    val lower = llama.serverBelow(using)
                    if (lower != null) {
                        steppedDown += "llama.cpp 的服务 ${using.words} 这一档在这台手机上跑不了（非法指令），换成了 ${lower.words}"
                        server = lower
                        continue
                    }
                }
                return TextCheck.Run(model, count, waited, !cooled, warmthBefore, device.warmth(), thermal, device.headroom(), outcome)
            }
        }

        val asked = ArrayList<TextCheck.Of>()
        for (model in texts) {
            unasked[model]?.let { asked += TextCheck.Of(model, emptyList(), it) }
            if (model in unasked) continue
            val runs = ArrayList<TextCheck.Run>()
            // Every thread count once before any is asked again, as the recognizers are read. A model that could not
            // be asked is not started again: every try is the same wait for the same end.
            for (round in 1..ROUNDS) for (count in threads) {
                if (runs.none { it.outcome.failure != null }) runs += ask(model, count) ?: return null
                done += 1
            }
            asked += TextCheck.Of(model, runs)
        }
        onStep(steps, steps, "写报告")

        val results = checked.flatMap { (_, runs) -> runs.map { it.model }.distinct().map { model -> OfModel(model, runs.filter { it.model === model }) } }
        // What sharing goes by from now on: for each model the fastest way found here to lend it, and how fast that
        // was. So the model lent, where the user chose none, is picked among those that read the recording right:
        // the most accurate that keeps up, or the fastest where none does (`Choices.preferred`).
        val choices = Choices(context)
        for (result in results) result.lent?.let { choices.remember(result.model, it.threads, it.speed!!) } ?: choices.forget(result.model)
        // And a text model is served from now on with the thread count it answered fastest with.
        for (of in asked) of.best?.let { choices.rememberText(of.model, it) }
        val lendable = choices.lendable(store)
        val shared = choices.shared(store)
        val lending = results.firstOrNull { it.model === shared }
        val verdict = when {
            shared == null && results.isNotEmpty() -> Verdict.COMPARED
            // No recognizer here at all: the check was of the text models, and the first of them speaks for it.
            results.isEmpty() -> asked.firstNotNullOfOrNull { it.verdict } ?: Verdict.NONE
            else -> lending?.lent?.speed?.let(::verdictOf) ?: Verdict.NONE
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
                    // (Its server may all the same have run the text models: those have a line of their own below.)
                    Reader.LLAMA_CPP !in read -> "这次没有它的识别模型"
                    build == null -> "没有这台处理器能用的那一档"
                    else -> "处理器用的是 ${build!!.words} 这一档（共 ${llama.builds.size} 档）"
                },
            )
            for (step in steppedDown) appendLine("  $step")
            if (asked.any { it.skipped == null }) appendLine("文字模型（翻译、语法反馈）：llama.cpp 的服务，${server?.words} 这一档，只用处理器")
            appendLine()
            if (checked.isEmpty() && asked.isEmpty()) appendLine("没有模型：先下载一个。")
            if (checked.isNotEmpty()) {
                appendLine("下面是倍速：${seconds(speechMs)} 秒的录音，每种线程数读 $ROUNDS 遍，每遍之前先等手机凉下来。" + if (japanese != null) "另有一段日语录音，每个引擎读 1 遍，看读得对不对。" else "")
                appendLine()
            }
            for ((name, runs) in checked) {
                append(blockOf(name, runs, results.filter { it.model.name == name }, threads))
                appendLine()
            }
            if (asked.isNotEmpty()) {
                appendLine("下面是翻译和语法反馈：问法和电脑版问它自己的引擎一样（日语译成中文；中文母语的人说的日语）。每种线程数起 $ROUNDS 次服务，每次先等手机凉下来，装入、先问一句短的，再问下面两句。数字是秒，越小越好。")
                appendLine()
            }
            for (of in asked) {
                append(TextCheck.blockOf(of, threads))
                appendLine()
            }
            if (checked.isNotEmpty()) {
                appendLine("怎么看：倍速是一秒钟能读几秒的话。边听边出字要把同一段话反复读，")
                appendLine("所以 4 倍以上算跟得上，2 到 4 倍勉强，2 倍以下跟不上。")
                appendLine("每次读之前都先等手机凉下来，两个引擎轮流读，免得排在后面的吃亏。")
            }
            for (line in TextCheck.howToRead(asked.filter { it.skipped == null }.map { it.model.task }.toSet())) appendLine(line)
            if (checked.any { (_, runs) -> runs.any { it.warm } } || asked.any { of -> of.runs.any { it.warm } }) appendLine("带 * 的是等了 ${COOL_AT_MOST_MS / 60_000} 分钟还没凉下来、热着测的。")
            // Which model the phone is lent with now, by which engine, and how that will be.
            if (shared != null) {
                val way = lending?.lent
                appendLine()
                appendLine("共享用的是：${shared.name} · ${shared.reader.words}" + (way?.let { "，${it.how}，${times(it.speed!!)} 倍速 → ${verdictOf(it.speed).words}" } ?: "（这次没读成）"))
                for (line in whyLent(shared, choices.chosen(store) != null, choices.preferred(store), lendable, choices::speedOf)) appendLine("  $line")
            }
            // The text models that are lent beside it, whatever the check made of them: nobody chooses among those.
            val lentText = choices.lendableText(store)
            if (lentText.isNotEmpty()) {
                appendLine()
                appendLine("共享时也借出：${lentText.joinToString("、") { it.name }}。电脑要用哪个，哪个才装入；内存不够几个一起放时，轮流装。")
            }
        }
        File(context.getExternalFilesDir(null), "report.txt").writeText(report)
        return Result(report, verdict, results, lending, asked)
    }

    /**
     * Waits for the phone to cool before a run: a few seconds at least, then until the battery is back within a few
     * degrees of where it was when the check began and the system no longer calls the phone hot — or until it has
     * stopped getting cooler. A phone that began the check cold never comes back to quite that while it is being
     * checked: on the first phone tried, six runs in ten waited the full three minutes for a goal it had settled
     * 0.4 °C above. Settled is as fair a start as cooled — every run then begins from the same warmth,
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

    /**
     * audio.cpp says what it took itself, in `name=value` lines. The text is shown as a computer is given it: without
     * the spaces the door takes out of it for a model that is `unspaced` (they count for nothing in the comparison).
     */
    private fun audioCppReading(outcome: Outcome, speechMs: Double, expected: String, unspaced: Boolean): Reading? {
        if (outcome.exit != 0) return null
        val said = outcome.lines.associate { line -> line.substringBefore('=') to line.substringAfter('=', "") }
        val took = said["metrics.wall_ms"]?.toDoubleOrNull() ?: return null
        return Reading(
            speechMs = said["metrics.audio_duration_ms"]?.toDoubleOrNull() ?: speechMs,
            tookMs = took,
            // The rest of the run: starting, and reading the model in.
            loadMs = (outcome.tookMs - took).coerceAtLeast(0.0),
            memoryMb = said["metrics.memory.peak_rss_mb"]?.toDoubleOrNull()?.toInt() ?: outcome.peakMb,
            text = said["text_output"].orEmpty().let { if (unspaced) Share.unspaced(it) else it },
            expected = expected,
        )
    }

    /**
     * llama.cpp says nothing of the kind, so it is timed from here: loading is from the start of the program to the
     * line it writes once the model is in memory, reading from that line to its end. That is the stretch audio.cpp's
     * `metrics.wall_ms` covers — the recording taken in, heard and written out, without the loading — so the two
     * speeds can be set side by side. (It is a little unkind to llama.cpp: the program's own ending is in it.)
     */
    private fun llamaCppReading(outcome: Outcome, speechMs: Double, expected: String): Reading? {
        if (outcome.exit != 0) return null
        val loaded = outcome.saidAt(Llama.LOADED_LINE) ?: return null
        val text = outcome.lines.lastOrNull { Llama.TEXT_MARK in it }?.substringAfter(Llama.TEXT_MARK)?.trim() ?: return null
        return Reading(speechMs, (outcome.tookMs - loaded).toDouble(), loaded.toDouble(), outcome.peakMb, text, expected)
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
            appendLine("  $count 线程：" + models.joinToString("   ") { of -> "${of.model.reader.words} ${speedsOf(of.runs.filter { it.threads == count && it.clip === ENGLISH })}" })
        }
        for (of in models) of.runs.firstOrNull { it.reading == null && it.clip === ENGLISH }?.let { appendLine("  ${of.model.reader.words} 没读成：${it.failure}") }

        // The fastest of the engines, and by how much.
        val bests = models.mapNotNull { of -> of.best?.let { best -> Triple(of.model.reader.words, best, best.speed ?: 0.0) } }.sortedByDescending { it.third }
        bests.firstOrNull()?.let { (label, best, speed) ->
            val fastest = "$label ${best.how}，${times(speed)} 倍速"
            val other = bests.getOrNull(1)
            if (other == null) {
                appendLine("  最快：$fastest")
            } else {
                val ahead = ((speed / other.third - 1) * 100).roundToInt()
                val against = "${other.first} 最快的（${other.second.how}，${times(other.third)} 倍速）"
                appendLine(if (ahead >= NEAR_PER_CENT) "  最快：$fastest，比 ${against}快 $ahead%" else "  最快：$fastest，和 ${against}差不多（差 $ahead%）")
            }
        }
        // How it would be to lend the phone with this model: the fastest way either engine's server runs it.
        models.filter { it.lent != null }.maxByOrNull { it.lent!!.speed!! }?.let { of ->
            val way = of.lent!!
            appendLine("  借给电脑时：${of.model.reader.words} ${way.how}，${times(way.speed!!)} 倍速 → ${verdictOf(way.speed).words}")
        }
        // Whether what was read is what the recording says: every run of each engine, the worst of them told.
        val heard = models.mapNotNull { of -> of.runs.filter { it.clip === ENGLISH }.mapNotNull { it.reading }.takeIf { it.isNotEmpty() }?.let { of.model.reader.words to it } }
        if (heard.isNotEmpty()) {
            appendLine("  英文录音读得对不对（和原文比，共 ${lettersOf(EXPECTED).length} 个字母）：" + heard.joinToString("，") { (reader, readings) ->
                val worst = readings.maxOf { it.wrong }
                "$reader " + if (worst == 0) "一字不差" else "最多错 $worst 个字母" + if (readings.any { !it.right }) "（读错的那几遍不算成绩）" else ""
            })
        }
        fun textOf(of: OfModel) = (of.best?.runs ?: of.runs.filter { it.clip === ENGLISH }).firstNotNullOfOrNull { it.reading }?.text
        val texts = models.mapNotNull { of -> textOf(of)?.let { of.model.reader.words to it } }
        if (texts.size > 1 && texts.all { it.second == texts.first().second }) appendLine("  读出的字（两个引擎一样）：${texts.first().second}")
        else for ((reader, text) in texts) appendLine("  读出的字（$reader）：${text.take(TEXT_SHOWN)}")

        // The Japanese recording: whether each engine read it right, and how fast; the text where they differ from it.
        val inJapanese = models.mapNotNull { of -> of.japanese?.let { of.model.reader.words to it } }
        if (inJapanese.isNotEmpty()) {
            appendLine("  日语录音（各读 1 遍）：" + inJapanese.joinToString("   ") { (reader, run) ->
                "$reader " + (run.reading?.let { "${times(it.speed)} 倍速，" + if (it.wrong == 0) "一字不差" else if (it.right) "错 ${it.wrong} 个字" else "读错了（错 ${it.wrong} 个字）" } ?: "没读成（${run.failure}）")
            })
            val said = inJapanese.mapNotNull { (reader, run) -> run.reading?.let { reader to it.text } }
            if (said.size > 1 && said.all { it.second == said.first().second }) appendLine("  日语读出的字（两个引擎一样）：${said.first().second}")
            else for ((reader, words) in said) appendLine("  日语读出的字（$reader）：${words.take(TEXT_SHOWN)}")
        }

        // (发热: how near the system says the phone is to holding itself back, where it says.)
        val heated = runs.any { it.headroom != null }
        appendLine("  每一次（读 · 装入 · 内存 · 电池温度${if (heated) " · 发热，到 100% 系统会降速" else ""}）：")
        for ((index, run) in runs.withIndex()) {
            val took = run.reading?.let { "${seconds(it.tookMs)} 秒 · ${seconds(it.loadMs)} 秒 · ${if (it.memoryMb > 0) "%.1f GB".format(it.memoryMb / 1024.0) else "—"}" } ?: "没读成"
            val notes = (if (run.warm) "，等了 ${run.waitedMs / 1000} 秒没凉下来" else "") +
                (run.thermal?.takeIf { it != Device.THERMAL_NONE }?.let { "，系统说手机热（${Device.thermalInWords(it)}）" } ?: "")
            appendLine("   ${index + 1} ${run.model.reader.words} ${run.how}${if (run.clip === JAPANESE) "（日语）" else ""}：$took · ${run.warmthBefore ?: "?"}→${run.warmthAfter ?: "?"}°C${run.headroom?.let { " · %.0f%%".format(it * 100) }.orEmpty()}$notes")
        }
    }

    /** "0.52 / 0.51* 倍速": the runs of one setting in the order they were made, a warm one marked. */
    private fun speedsOf(runs: List<Run>): String {
        if (runs.isEmpty()) return "没测"
        return runs.joinToString(" / ") { run -> run.reading?.let { if (it.right) times(it.speed) + (if (run.warm) "*" else "") else "读错了" } ?: "没读成" } + if (runs.any { it.reading?.right == true }) " 倍速" else ""
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
    private fun speechMsOf(recording: File): Double = runCatching { wavMsOf(recording.readBytes()) }.getOrNull() ?: 0.0

    companion object {
        const val RECORDING = "selfcheck.wav"

        /**
         * What the recording says: the words both engines, and both sizes of the model, write of it on a desktop's
         * graphics card (they differ there by two commas, which are not counted).
         */
        const val EXPECTED = "The English forwarded to the French baskets of flowers, of which they had made a plentiful provision " +
            "to greet the arrival of the young princess. The French, in return, invited the English to a supper, which was to be given the next day."

        /** What the Japanese recording says: what both engines and both sizes of the model write of it on a desktop. */
        const val EXPECTED_JA = "元は金持ちの息子でしたが、今は財産を使い尽くして、その日の暮らしにも困るくらい哀れな身分になっているのです。"

        val ENGLISH = Clip(RECORDING, "en", EXPECTED)
        val JAPANESE = Clip("selfcheck-ja.wav", "ja", EXPECTED_JA)

        /** A run is read right with no more of its letters wrong than this share of the recording's. */
        private const val WRONG_AT_MOST = 0.05

        /** A text that is not the recording's is shown to this length: one that ran on is thousands of letters. */
        private const val TEXT_SHOWN = 300

        /**
         * What the report says under the model the phone is lent with: why that one, and how to have another.
         *
         * A row the user touched is theirs and stays; where the phone would pick another by itself
         * (`Choices.preferred`), that one is named. Left to the phone, it says which of its two reasons it was —
         * the most accurate of those that keep up, or the fastest where none does — and where a model that reads
         * better was passed over for its speed, that it was, how fast it is, and how to lend it all the same: on a
         * phone that nearly keeps up with it, somebody may rather wait for the better text.
         *
         * `lendable` are the models that can be lent, `speedOf` how fast the check found each (null: not read right).
         */
        fun whyLent(shared: Model, chosen: Boolean, preferred: Model?, lendable: List<Model>, speedOf: (Model) -> Double?): List<String> {
            fun named(model: Model) = "${model.name} · ${model.reader.words}"
            fun speed(model: Model) = speedOf(model)?.let { "%.2f".format(it) }
            val others = "想借出别的，在模型列表里点那一行。".takeIf { lendable.size > 1 }
            if (chosen) {
                val instead = preferred?.takeIf { it !== shared }
                    ?: return listOfNotNull("这是你点的那一行。" + others.orEmpty())
                return listOf("这是你点的那一行。没点的话借的是 ${named(instead)}${speed(instead)?.let { "（$it 倍速）" }.orEmpty()}：点它那一行就换。")
            }
            val read = lendable.filter { speedOf(it) != null }
            val mine = speedOf(shared)
            val why = when {
                mine == null || read.size < 2 -> null
                mine >= FAST_FROM -> "读得对、又跟得上的里面它最准。"
                else -> "没有一个到 ${FAST_FROM.toInt()} 倍速（跟得上），借的是最快的。"
            }
            // Of the models that read better, the best; and of that model the faster engine.
            val passed = read.filter { it.accuracy < shared.accuracy }.minWithOrNull(compareBy<Model> { it.accuracy }.thenByDescending { speedOf(it)!! })
            val how = passed?.let { "更准的 ${named(it)} 只有 ${speed(it)} 倍速，太慢，没借它；要借它，在模型列表里点它那一行。" } ?: others
            return listOfNotNull(why, how)
        }

        /** A text's letters and digits alone, small: what is compared. */
        fun lettersOf(text: String): String = text.filter { it.isLetterOrDigit() }.lowercase()

        /** How many letters must be changed, added or taken away to make one text the other; looked at no further than twice the second's length. */
        fun lettersApart(said: String, expected: String): Int {
            val a = said.take(expected.length * 2)
            var previous = IntArray(expected.length + 1) { it }
            for (i in 1..a.length) {
                val current = IntArray(expected.length + 1)
                current[0] = i
                for (j in 1..expected.length) {
                    current[j] = minOf(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + if (a[i - 1] == expected[j - 1]) 0 else 1)
                }
                previous = current
            }
            return previous[expected.length]
        }
        private const val LOADED = "loaded CPU backend from"
        private const val VARIANT_PREFIX = "libggml-cpu-"

        /** Each setting of the processor is read this many times: one run alone may have been the lucky or the unlucky one. */
        private const val ROUNDS = 2

        /** How a program ends when the system kills it for a fault (128 + the signal): illegal instruction, abort, bus, arithmetic, bad address. */
        private const val ILLEGAL_INSTRUCTION = 132
        private val CRASHES = setOf(ILLEGAL_INSTRUCTION, 134, 135, 136, 139)

        /** And when it is killed outright — on a phone, as a rule, for the memory it took. */
        private const val KILLED = 137

        /** No run is waited on longer: a driver that hangs must not hold the check for ever. The slowest phone tried takes under a minute. */
        private const val RUN_AT_MOST_MS = 10 * 60_000L

        /**
         * Before a run: cooled is within this of the battery's temperature at the start, in °C. It was 1: a phone
         * that idles at 29 to 30 °C then waited forty seconds before each of its last four runs for having reached
         * 30.2 °C ("30 有点太低了", OPPO PLG110, 2026-10-13) — while its second round, at the very temperature of the
         * first, was a sixth slower. A degree of the battery says nothing of how the processor stands.
         */
        private const val COOL_WITHIN = 3.0
        private const val COOL_AT_LEAST_MS = 10_000L
        private const val COOL_AT_MOST_MS = 180_000L
        /**
         * No cooler for this long is as cool as it gets; and a fall smaller than this is the sensor's own noise. It was
         * 40 s: on a Snapdragon 8 Elite whose battery went from 24 to 31 °C over the check, 29 of its 36 minutes were
         * waiting (2026-10-28), most runs past the 3 °C and so waiting out this. The engines take turns either way.
         */
        private const val COOL_SETTLED_MS = 20_000L
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
    const val VERSION = "0.9.3"
    const val ENGINE = "0.9.0"
    const val LLAMA = "b11401"
}
