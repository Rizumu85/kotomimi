package io.github.rizumu85.kotomimi.node

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The self-check of the text models: what the phone does with a translation and with a line of grammar feedback.
 *
 * Nobody has these numbers for the phones this is for, and they decide what is built next, so they are taken the way
 * the phone will be used. The server is llama.cpp's, started as sharing starts it (`Llama.serve`: the same program,
 * the same room, the same flags). The requests are the desktop app's own, word for word — what it sends its own
 * engine for a sentence of Japanese into Chinese (`translatorRequest` in src/providers/openai/nativeTranslators.ts)
 * and for a Chinese speaker's Japanese (`coachPrompt` in coachPrompt.ts, `NATIVE_COACH_EXTRA`), put together as
 * `completeText` puts them (textModel.ts) — and they go through what the door puts a computer's request through
 * (`Chat.requestOf`, `Chat.ask`). Only the door's own socket is not in the way.
 *
 * One run is one start of the server: its loading, the desktop's own first short request (`LLAMA_RUNTIME.warm`),
 * then the two requests that are measured. `SelfCheck` cools the phone before each run and writes them down.
 */
class TextCheck(private val llama: Llama, private val store: ModelStore) {
    /** A request of the check: what the report calls it, the sentence in it, and the request as the desktop writes it. */
    class Asking(val label: String, val sentence: String, val body: JSONObject)

    class Answer(val asking: Asking, val reply: Chat.Reply) {
        /** Answered, and with something written. */
        val good: Boolean get() = reply.status == 200 && reply.error == null && reply.text.isNotBlank()
    }

    /**
     * What one start of the server came to: how long the model took to load, the server's first answer (`warm`),
     * the answers that are measured, the most memory the server held and what of it was its own, in megabytes —
     * or why there is less than that (`failure`). `exit` is how the server ended, where it ended by itself.
     */
    class Outcome(val loadMs: Long?, val warm: Chat.Reply?, val answers: List<Answer>, val peakMb: Int, val ownMb: Int, val failure: String?, val exit: Int? = null)

    /** A run as the check made it: on so many threads, with how the phone stood before and after (`SelfCheck.Run` has the same). */
    class Run(
        val model: Model, val threads: Int,
        val waitedMs: Long, val warm: Boolean, val warmthBefore: Double?, val warmthAfter: Double?, val thermal: Int?, val headroom: Double?,
        val outcome: Outcome,
    ) {
        /**
         * What the run comes to, in seconds — the lower the better. For a translator, a sentence from the request to
         * its last word: the mean of the two. For the feedback model, the wait for the first word of an answer once
         * the instructions have been read — the second request: the instructions and their examples are the same
         * every time, and the server reads them once. Null where a request failed or came back empty.
         */
        val score: Double? = outcome.answers.takeIf { it.size == ASKED && it.all(Answer::good) }?.let { answers ->
            if (model.task == Task.COACH) answers.last().reply.firstMs?.let { it / 1000.0 } else answers.map { it.reply.tookMs / 1000.0 }.average()
        }
    }

    /** A model's runs and what they come to; or why it was not run at all. */
    class Of(val model: Model, val runs: List<Run>, val skipped: String? = null) {
        private val scores: Map<Int, Double> = runs.groupBy { it.threads }.mapNotNull { (threads, its) -> its.mapNotNull { it.score }.takeIf { it.isNotEmpty() }?.let { threads to it.average() } }.toMap()

        /** The thread count it answered fastest with, and how fast that was (`Run.score`). */
        val best: Int? = scores.minByOrNull { it.value }?.key
        val score: Double? = best?.let { scores[it] }
        val verdict: SelfCheck.Verdict? = score?.let { verdictOf(model.task, it) }
        fun scoreOf(threads: Int): Double? = scores[threads]

        /** For the top of the screen, where no recognizer was checked: "翻译跟不上" and "Hunyuan MT 2 1.8B · 一句 5.4 秒". */
        val words: Pair<String, String>? get() = verdict?.let { "${model.task.words}${it.words}" to "${model.name} · ${if (model.task == Task.COACH) "等" else "一句"} ${"%.1f".format(score)} 秒" }
    }

    /**
     * Starts the server with `model` on `threads` threads, asks it, and ends it. Null where the check was stopped.
     * The server is gone before this returns: a phone has memory for one at a time.
     */
    fun run(model: Model, build: Llama.Build, threads: Int, stopped: () -> Boolean): Outcome? {
        val key = UUID.randomUUID().toString().replace("-", "")
        val port = Share.portOf(model)
        val began = System.nanoTime()
        fun sinceStart() = (System.nanoTime() - began) / 1_000_000
        val process = llama.serve(model, store, build, threads, port, key)
        val said = ArrayDeque<String>()
        Thread({
            runCatching { process.inputStream.bufferedReader().forEachLine { line -> synchronized(said) { said += line; if (said.size > KEPT_LINES) said.removeFirst() } } }
        }, "text-check-output").apply { isDaemon = true }.start()
        // Beside it while it runs, the memory it holds as the kernel keeps it: the most of all, and the most of its own.
        val peak = AtomicInteger(0)
        val own = AtomicInteger(0)
        val watch = Thread({
            try {
                while (process.isAlive) {
                    heldBy(process)?.let { if (it.peakMb > peak.get()) peak.set(it.peakMb); if (it.ownMb > own.get()) own.set(it.ownMb) }
                    Thread.sleep(WATCH_EVERY_MS)
                }
            } catch (ended: InterruptedException) {
                // The run is over.
            }
        }, "text-check-watch").apply { isDaemon = true; start() }
        fun lastSaid() = synchronized(said) { said.lastOrNull { it.isNotBlank() }?.replace(Llama.LOG_PREFIX, "")?.trim()?.take(160) }
        fun outcome(loadMs: Long?, warm: Chat.Reply?, answers: List<Answer>, failure: String?, exit: Int? = null) = Outcome(loadMs, warm, answers, peak.get(), own.get(), failure, exit)

        try {
            while (!Chat.well(port)) {
                if (stopped()) return null
                if (!process.isAlive) {
                    val exit = runCatching { process.waitFor() }.getOrDefault(-1)
                    val why = when (exit) {
                        KILLED -> "被系统停掉了（$exit），多半是内存不够"
                        in CRASHES -> "引擎崩了（$exit）" + (lastSaid()?.let { "：$it" } ?: "")
                        else -> "引擎没起来" + (lastSaid()?.let { "：$it" } ?: "（$exit）")
                    }
                    return outcome(null, null, emptyList(), why, exit)
                }
                if (sinceStart() > LOAD_AT_MOST_MS) return outcome(null, null, emptyList(), "装入 ${LOAD_AT_MOST_MS / 60_000} 分钟还没好，停下了")
                Thread.sleep(200)
            }
            val loadMs = sinceStart()

            /** One request, the way the door would pass it on; a failure in the report's words where there is no answer. */
            fun ask(body: JSONObject): Pair<Chat.Reply?, String?> {
                val asked = Chat.requestOf(body.toString().toByteArray(), listOf(model)) as? Chat.Asked ?: return null to "自检的请求没过小门这一关"
                val reply = Chat.ask(port, key, asked.body, ANSWER_AT_MOST_MS, stopped)
                return when {
                    reply != null && reply.status == 200 && reply.error == null -> reply to null
                    reply != null -> reply to "引擎回答 HTTP ${reply.status}：${reply.error.orEmpty().take(160)}"
                    !process.isAlive -> null to if (runCatching { process.exitValue() }.getOrNull() == KILLED) "写到一半被系统停掉了，多半是内存不够" else "写到一半引擎停了" + (lastSaid()?.let { "：$it" } ?: "")
                    else -> null to "${ANSWER_AT_MOST_MS / 60_000} 分钟还没写完，停下了"
                }
            }

            val (warm, cold) = ask(warmUp(model))
            if (stopped()) return null
            if (cold != null) return outcome(loadMs, warm, emptyList(), cold)
            val answers = ArrayList<Answer>()
            for (asking in askingsOf(model)) {
                val (reply, failure) = ask(asking.body)
                if (stopped()) return null
                if (reply != null) answers += Answer(asking, reply)
                if (failure != null) return outcome(loadMs, warm, answers, failure)
            }
            return outcome(loadMs, warm, answers, answers.firstOrNull { !it.good }?.let { "${it.asking.label}没写出字" })
        } finally {
            endOutright(process)
            runCatching { process.waitFor(GONE_WITHIN_MS, TimeUnit.MILLISECONDS) }
            watch.interrupt()
        }
    }

    companion object {
        /** The requests of a run that are measured. */
        private const val ASKED = 2

        private const val KEPT_LINES = 40
        private const val WATCH_EVERY_MS = 250L
        private const val GONE_WITHIN_MS = 5_000L

        /** No start and no answer is waited on longer: the slowest phone tried loads in a quarter of a minute and answers in under ten seconds. */
        private const val LOAD_AT_MOST_MS = 5 * 60_000L
        private const val ANSWER_AT_MOST_MS = 5 * 60_000L

        private const val KILLED = 137
        private val CRASHES = setOf(132, 134, 135, 136, 139)

        /**
         * What keeping up means for each, in seconds (`Run.score`). Proposals, to be set right by what the first
         * phones measure and by how it feels on the desktop:
         *
         * - A translation: a sentence done in about a second reads as part of the talk. The desktop shows the answer
         *   as it is written, so a little over is still that; past a few seconds the talk has moved on.
         * - Feedback: it is read after the sentence, not during it. A few seconds to its first words is soon
         *   enough; much longer and the next sentence has been said.
         */
        const val TRANSLATION_FAST_S = 1.5
        const val TRANSLATION_TIGHT_S = 4.0
        const val FEEDBACK_FAST_S = 3.0
        const val FEEDBACK_TIGHT_S = 8.0

        fun verdictOf(task: Task, seconds: Double): SelfCheck.Verdict {
            val (fast, tight) = if (task == Task.COACH) FEEDBACK_FAST_S to FEEDBACK_TIGHT_S else TRANSLATION_FAST_S to TRANSLATION_TIGHT_S
            return if (seconds <= fast) SelfCheck.Verdict.FAST else if (seconds <= tight) SelfCheck.Verdict.TIGHT else SelfCheck.Verdict.SLOW
        }

        // ── The desktop's requests ──────────────────────────────────────────────────────────────────────────────

        /**
         * The two sentences the translators were measured with on this phone by hand (NOTES.md, 2026-10-12): a short
         * one and a long one, of a talk between friends. Japanese into Chinese is what the app is used for.
         */
        const val SHORT = "今日はいい天気ですね。散歩に行きませんか？"
        const val LONG = "昨日の夜、友達と新宿で映画を見たあと、遅くまで開いているラーメン屋に寄って帰りました。"

        /** A learner's two sentences, one wrong and one right, from the desktop's own trial of its prompt (coachPrompt.live.test.ts). */
        const val WRONG = "昨日はとても寒いです。"
        const val RIGHT = "すみません、駅はどこですか。"

        /** The body as `completeText` writes it: what the model's request carries besides, the model, the stream, the messages. */
        private fun body(model: Model, extra: JSONObject, messages: List<Pair<String, String>>): JSONObject =
            extra.put("model", model.lentAs).put("stream", true).put("messages", JSONArray(messages.map { (role, content) -> JSONObject().put("role", role).put("content", content) }))

        private fun unthinking() = JSONObject().put("enable_thinking", false)

        /** `LLAMA_RUNTIME.warm` in electron/native-engine.js: the one short answer the desktop asks of its engine before any other. */
        fun warmUp(model: Model): JSONObject =
            body(model, JSONObject().put("max_tokens", 4).put("temperature", 0).put("chat_template_kwargs", unthinking()), listOf("user" to "Hello"))

        /**
         * The requests that are measured, for each model as the desktop writes them (`translatorRequest`):
         *
         * - Index-Translate: its card's request in Chinese, greedy, thinking off; each sentence alone, always.
         * - Hunyuan MT: its card's request in Chinese with the sampling the card names; and for the second sentence
         *   its card's form with what was said before, which is what the desktop sends for a sentence said soon
         *   after another (`wrapAfter`).
         * - The feedback model: the instructions and the seven examples of a Chinese speaker practising Japanese,
         *   then the sentence; greedy, thinking off, and no end said to the answer (the door sets one).
         */
        fun askingsOf(model: Model): List<Asking> = when (model.family) {
            "index" -> listOf(SHORT, LONG).mapIndexed { index, sentence ->
                Asking(
                    if (index == 0) "短句" else "长句", sentence,
                    body(model, JSONObject().put("temperature", 0).put("max_tokens", 512).put("chat_template_kwargs", unthinking()), listOf("user" to "请将以下日语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n$sentence")),
                )
            }
            "hunyuan" -> listOf(
                Asking("短句", SHORT, body(model, hunyuanSampling(), listOf("user" to "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n$SHORT"))),
                Asking("长句", LONG, body(model, hunyuanSampling(), listOf("user" to "$SHORT\n参考上面的信息，把下面的文本翻译成中文，注意不需要翻译上文，也不要额外解释：\n$LONG"))),
            )
            else -> listOf("第一句" to WRONG, "第二句" to RIGHT).map { (label, sentence) ->
                val shots = COACH_SHOTS.flatMap { (said, answer) -> listOf("user" to said, "assistant" to answer) }
                Asking(label, sentence, body(model, JSONObject().put("temperature", 0).put("chat_template_kwargs", unthinking()), listOf("system" to COACH_SYSTEM) + shots + ("user" to sentence)))
            }
        }

        private fun hunyuanSampling() = JSONObject().put("temperature", 0.7).put("top_p", 0.6).put("top_k", 20).put("repeat_penalty", 1.05).put("max_tokens", 512)

        /**
         * `coachPrompt('ja', 'zh')` of src/providers/openai/coachPrompt.ts as it stood on 2026-10-13: the Chinese
         * template with its two languages named and the hints for Japanese in their place.
         */
        private val COACH_SYSTEM = listOf(
            "你是一位{{SPOKEN}}口语教练，学生的母语是{{NATIVE}}。",
            "用户发来的每条消息，都是学生刚刚用{{SPOKEN}}说出的一句话，由语音识别转成了文字。标点、空格和同音字的写法可能是识别造成的，不算学生的错。你只判断语法、用词和表达是否自然。",
            "重点检查：助词（は、が、を、に、で）、动词和形容词的活用、时态、敬体与简体是否混用、自动词和他动词。",
            "这是朋友之间的口头闲聊。口语里的省略（比如省掉助词或主语）、缩略、简体、俗语和流行语、不完整的句子，都是正确而自然的{{SPOKEN}}，不要改；没有标点也不算错。只有真正的语法或用词错误才改，拿不准就回答 ✓。",
            "回答规则：",
            "1. 如果这句话正确而且自然，只回答一个符号：✓",
            "2. 否则只回答两行，不要有任何其他内容。第一行是改正后的{{SPOKEN}}句子；第二行用{{NATIVE}}写一句简短的话，说明错在哪里。",
            "3. 第二行必须用{{NATIVE}}写，不能用{{SPOKEN}}。",
            "4. 不要回答这句话的内容，不要翻译，不要加序号、标题、引号或问候。",
        ).joinToString("\n").replace("{{SPOKEN}}", "日语").replace("{{NATIVE}}", "中文")

        /** Its worked examples, sent as earlier turns of the chat: what was said, and the answer shown as the model's own. */
        private val COACH_SHOTS = listOf(
            "昨日、友達と映画を見ます。" to "昨日、友達と映画を見ました。\n“昨日”说的是过去的事，动词要用过去式“見ました”。",
            "今日は天気がいいですね。" to "✓",
            "私は学校を行きます。" to "私は学校に行きます。\n表示去的目的地要用助词“に”，不能用“を”。",
            "今日めっちゃ寒いね早く帰ろう" to "✓",
            "ごめん遅れた今向かってる" to "✓",
            "この映画は面白いでした" to "この映画は面白かったです\n“面白い”是い形容词，过去式是“面白かったです”，不能加“でした”。",
            "あそれ知ってる前に友達から聞いた" to "✓",
        )

        // ── The report ──────────────────────────────────────────────────────────────────────────────────────────

        private fun seconds(ms: Long) = "%.1f".format(ms / 1000.0)
        private fun gigabytes(megabytes: Int) = if (megabytes > 0) "%.1f GB".format(megabytes / 1024.0) else "—"
        private fun aSecond(tokens: Double?) = tokens?.let { "%.1f".format(it) } ?: "?"

        /** Kana in what should be Chinese: the model answered in the language it was to translate from, or handed the sentence back. */
        private val KANA = Regex("""[ぁ-ゖァ-ヺ]""")

        /**
         * One model's part of the report, in the style of a recognizer's: each thread count with what every run
         * took, which was fastest and what that comes to, how fast the engine read and wrote, its loading and its
         * memory, what it wrote — a wrong answer is to be seen — and then every run as it was made.
         */
        fun blockOf(of: Of, threads: List<Int>): String = buildString {
            val model = of.model
            val coach = model.task == Task.COACH
            appendLine("【${model.task.words} · ${model.name}】")
            if (of.skipped != null) { appendLine("  没测：${of.skipped}"); return@buildString }
            val labels = askingsOf(model).map { it.label }
            fun tookOf(run: Run, label: String) = run.outcome.answers.firstOrNull { it.asking.label == label }?.takeIf { it.good }?.let { seconds(it.reply.tookMs) + if (run.warm) "*" else "" }
            for (count in threads) {
                val its = of.runs.filter { it.threads == count }
                if (its.isEmpty()) continue
                appendLine("  $count 线程：" + labels.joinToString("   ") { label -> "$label " + its.joinToString(" / ") { tookOf(it, label) ?: "没成" } + if (its.any { tookOf(it, label) != null }) " 秒" else "" })
            }
            of.runs.firstOrNull { it.outcome.failure != null }?.let { appendLine("  ${it.threads} 线程没测成：${it.outcome.failure}") }

            val best = of.best
            if (best != null) {
                val other = threads.firstOrNull { it != best }?.let { count -> of.scoreOf(count)?.let { count to it } }
                val against = other?.let { (count, score) -> "（$count 线程 ${"%.1f".format(score)} 秒）" }.orEmpty()
                val told = if (coach) "读过说明之后，等 ${"%.1f".format(of.score)} 秒出第一个字" else "一句平均 ${"%.1f".format(of.score)} 秒"
                appendLine("  最快：$best 线程，$told$against → ${of.verdict!!.words}")
                // The rest is of the runs at that count, each in its turn as the lines above have them: one run
                // alone may have been the lucky or the unlucky one, and on a warm phone they lie far apart.
                val its = of.runs.filter { it.threads == best && it.score != null }
                fun each(tell: (Run) -> String) = its.joinToString(" / ", transform = tell)
                // How the engine itself reckoned it: reading by the request it had most to read of, writing by the
                // answer it wrote most of.
                fun timed(run: Run) = run.outcome.answers.mapNotNull { it.reply.timings }
                val counts = timed(its.first()).let { all -> "读的那一句 ${all.maxOfOrNull { it.read } ?: "?"} 个词元，写的那一句 ${all.maxOfOrNull { it.written } ?: "?"} 个" }
                appendLine("  速度（$best 线程）：读 ${each { aSecond(timed(it).maxByOrNull { timings -> timings.read }?.readASecond) }} 词元/秒，写 ${each { aSecond(timed(it).maxByOrNull { timings -> timings.written }?.writtenASecond) }} 词元/秒（$counts）")
                // (What was kept of the request before, where that is more than the mark every request begins with.)
                appendLine("  第一个字：" + labels.joinToString("，") { label ->
                    fun answer(run: Run) = run.outcome.answers.firstOrNull { it.asking.label == label }
                    val kept = answer(its.first())?.reply?.timings?.kept?.takeIf { it >= KEPT_WORTH_SAYING }
                    "${label}等 ${each { answer(it)?.reply?.firstMs?.let(::seconds) ?: "?" }} 秒" + (kept?.let { "（有 $it 个词元是上一次读过的，不用再读）" } ?: "")
                })
                appendLine(
                    "  装入 ${each { it.outcome.loadMs?.let(::seconds) ?: "?" }} 秒，装完第一次回答 ${each { it.outcome.warm?.let { warm -> seconds(warm.tookMs) } ?: "?" }} 秒；" +
                        "内存最高 ${gigabytes(its.maxOf { it.outcome.peakMb })}，其中引擎自己占 ${gigabytes(its.maxOf { it.outcome.ownMb })}",
                )
            }
            // What it wrote, of the fastest setting's first run, or of whatever run wrote anything.
            val shown = (of.runs.firstOrNull { it.threads == best && it.score != null } ?: of.runs.firstOrNull { it.outcome.answers.isNotEmpty() })?.outcome?.answers.orEmpty()
            for (answer in shown) {
                val text = answer.reply.text.trim()
                val odd = when {
                    text.isEmpty() -> "（没写出字）"
                    answer.reply.finish == "length" -> "（写到上限被截断了）"
                    !coach && KANA.containsMatchIn(text) -> "（里面还有假名，看着没翻对）"
                    else -> ""
                }
                appendLine("  ${answer.asking.label}：${answer.asking.sentence}")
                appendLine("    → ${text.replace("\n", " ⏎ ").take(TEXT_SHOWN)}$odd")
            }

            val heated = of.runs.any { it.headroom != null }
            appendLine("  每一次（${labels.joinToString(" · ")} · 装入 · 内存 · 电池温度${if (heated) " · 发热，到 100% 系统会降速" else ""}）：")
            for ((index, run) in of.runs.withIndex()) {
                val took = if (run.outcome.loadMs == null) "没成" else labels.joinToString(" · ") { label -> tookOf(run, label)?.let { "$it 秒" } ?: "没成" } + " · ${seconds(run.outcome.loadMs)} 秒 · ${gigabytes(run.outcome.peakMb)}"
                val notes = (if (run.warm) "，等了 ${run.waitedMs / 1000} 秒没凉下来" else "") +
                    (run.thermal?.takeIf { it != Device.THERMAL_NONE }?.let { "，系统说手机热（${Device.thermalInWords(it)}）" } ?: "")
                appendLine("   ${index + 1} ${run.threads} 线程：$took · ${run.warmthBefore ?: "?"}→${run.warmthAfter ?: "?"}°C${run.headroom?.let { " · %.0f%%".format(it * 100) }.orEmpty()}$notes")
            }
        }

        private const val TEXT_SHOWN = 300
        private const val KEPT_WORTH_SAYING = 10

        /** What the report says of how to read the text models' numbers, where any were taken. */
        fun howToRead(tasks: Set<Task>): List<String> = listOfNotNull(
            "翻译：一句话从发出到写完，${TRANSLATION_FAST_S} 秒以内算跟得上，${TRANSLATION_TIGHT_S.toInt()} 秒以内勉强，再慢跟不上。".takeIf { Task.TRANSLATE in tasks },
            "语法反馈：说明读过一遍之后，一句话等 ${FEEDBACK_FAST_S.toInt()} 秒以内出第一个字算跟得上，${FEEDBACK_TIGHT_S.toInt()} 秒以内勉强。".takeIf { Task.COACH in tasks },
            "这几条线是暂定的。词元大约是一个汉字或假名。".takeIf { tasks.isNotEmpty() },
        )
    }
}
