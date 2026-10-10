package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The self-check: the engine reads one fixed recording with each model that is here, at several thread counts, and
 * what it took is written down. The numbers are the phone's own; nothing is judged from the name of its processor.
 */
class SelfCheck(private val context: Context, private val engine: Engine, private val store: ModelStore) {
    /** One reading of the recording. */
    class Reading(val threads: Int, val speechMs: Double, val tookMs: Double, val loadMs: Double, val memoryMb: Int, val text: String) {
        /** Seconds of speech read in a second: above 1 it keeps up with a voice read once. */
        val speed: Double get() = if (tookMs > 0) speechMs / tookMs else 0.0
    }

    class OfModel(val model: Model, val readings: List<Reading>, val failure: String?) {
        val best: Reading? get() = readings.maxByOrNull { it.speed }
    }

    class Result(val report: String, val verdict: Verdict, val models: List<OfModel>)

    enum class Verdict(val words: String) {
        FAST("跟得上"), TIGHT("勉强跟上"), SLOW("跟不上"), NONE("没测成")
    }

    /** `onStep(done, of, words)` as it goes. Returns null when it was stopped. */
    fun run(onStep: (Int, Int, String) -> Unit, stopped: () -> Boolean): Result? {
        val device = Device(context)
        val recording = File(context.cacheDir, RECORDING).also { file ->
            context.assets.open(RECORDING).use { input -> file.outputStream().use { input.copyTo(it) } }
        }
        val models = MODELS.filter { store.has(it) }
        val threads = threadCounts(device.cores.size)
        val steps = models.size * threads.size
        val warmBefore = device.warmth()
        val (memory, free) = device.memory()

        var done = 0
        var variant: String? = null
        val results = models.map { model ->
            val readings = ArrayList<Reading>()
            var failure: String? = null
            for (count in threads) {
                if (stopped()) return null
                onStep(done, steps, "${model.name} · $count 线程")
                val outcome = engine.run(
                    listOf(
                        "--task", "asr", "--family", model.family, "--model", store.fileOf(model).path, "--backend", "cpu",
                        "--threads", count.toString(), "--audio", recording.path, "--language", "en", "--metrics",
                    ),
                    store.folder,
                )
                if (stopped()) return null
                done += 1
                // ggml says which of its CPU builds it took for this processor.
                variant = variant ?: outcome.lines.firstOrNull { LOADED in it }?.substringAfter(VARIANT_PREFIX)?.removeSuffix(".so")
                val reading = readingOf(count, outcome)
                if (reading == null) {
                    // What it said last is the reason, when it gave one.
                    failure = outcome.lines.lastOrNull { it.isNotBlank() }?.take(200) ?: "引擎退出（${outcome.exit}）"
                    break
                }
                readings += reading
            }
            OfModel(model, readings, failure)
        }
        onStep(steps, steps, "写报告")

        val verdict = verdictOf(results)
        val report = buildString {
            appendLine("Kotomimi 手机端自检 ${BuildConfigLite.VERSION}")
            appendLine(SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date()))
            appendLine()
            appendLine("手机：${device.name}")
            appendLine("芯片：${device.chip}")
            appendLine("系统：${device.android}")
            appendLine("处理器：${device.coresInWords()}")
            appendLine("指令集：${device.featuresInWords()}")
            appendLine("内存：共 ${"%.1f".format(memory / 1024.0)} GB，开始时空闲 ${"%.1f".format(free / 1024.0)} GB")
            val warmAfter = device.warmth()
            if (warmBefore != null && warmAfter != null) appendLine("电池温度：$warmBefore°C → $warmAfter°C")
            appendLine("引擎：audio.cpp ${BuildConfigLite.ENGINE}，只用处理器，用的是 ${variant ?: "没说"} 这一档（共 ${engine.variants.size} 档）")
            appendLine()
            if (results.isEmpty()) appendLine("没有模型：先下载一个。")
            for (result in results) {
                appendLine("【${result.model.name}】")
                for (reading in result.readings) {
                    appendLine(
                        "  ${reading.threads} 线程：${seconds(reading.speechMs)} 秒的话读了 ${seconds(reading.tookMs)} 秒" +
                            "（${"%.1f".format(reading.speed)} 倍速），装入 ${seconds(reading.loadMs)} 秒，内存 ${"%.1f".format(reading.memoryMb / 1024.0)} GB",
                    )
                }
                result.failure?.let { appendLine("  没读成：$it") }
                result.best?.let { best ->
                    appendLine("  最快：${best.threads} 线程，${"%.1f".format(best.speed)} 倍速 → ${verdictOf(best.speed).words}")
                    appendLine("  读出的字：${best.text}")
                }
                appendLine()
            }
            appendLine("怎么看：倍速是一秒钟能读几秒的话。边听边出字要把同一段话反复读，")
            appendLine("所以 4 倍以上算跟得上，2 到 4 倍勉强，2 倍以下跟不上。")
            appendLine("连着读手机会发热降速，排在后面的几次偏慢是正常的。")
        }
        File(context.getExternalFilesDir(null), "report.txt").writeText(report)
        return Result(report, verdict, results)
    }

    private fun readingOf(threads: Int, outcome: Engine.Outcome): Reading? {
        if (outcome.exit != 0) return null
        val said = outcome.lines.associate { line -> line.substringBefore('=') to line.substringAfter('=', "") }
        val took = said["metrics.wall_ms"]?.toDoubleOrNull() ?: return null
        val speech = said["metrics.audio_duration_ms"]?.toDoubleOrNull() ?: return null
        return Reading(
            threads = threads,
            speechMs = speech,
            tookMs = took,
            // The rest of the run: starting, and reading the model in.
            loadMs = (outcome.tookMs - took).coerceAtLeast(0.0),
            memoryMb = said["metrics.memory.peak_rss_mb"]?.toDoubleOrNull()?.toInt() ?: 0,
            text = said["text_output"].orEmpty(),
        )
    }

    private fun verdictOf(results: List<OfModel>): Verdict {
        val best = results.mapNotNull { it.best?.speed }.maxOrNull() ?: return Verdict.NONE
        return verdictOf(best)
    }

    private fun verdictOf(speed: Double) = when {
        speed >= FAST_FROM -> Verdict.FAST
        speed >= TIGHT_FROM -> Verdict.TIGHT
        else -> Verdict.SLOW
    }

    private fun seconds(ms: Double) = "%.1f".format(ms / 1000.0)

    companion object {
        const val RECORDING = "selfcheck.wav"
        private const val LOADED = "loaded CPU backend from"
        private const val VARIANT_PREFIX = "libggml-cpu-"

        /** Live captions read a growing stretch again and again: several times real time is what keeping up means. */
        const val FAST_FROM = 4.0
        const val TIGHT_FROM = 2.0

        /** Two, four, six and all of them, as far as the phone has them: which is fastest differs from chip to chip. */
        fun threadCounts(cores: Int): List<Int> = (listOf(2, 4, 6).filter { it < cores } + cores).distinct()
    }
}

/** What the build knows of itself. */
object BuildConfigLite {
    const val VERSION = "0.1.0"
    const val ENGINE = "0.9.0"
}
