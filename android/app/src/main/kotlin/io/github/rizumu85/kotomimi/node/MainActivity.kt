package io.github.rizumu85.kotomimi.node

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The first build of the phone side: one screen that fetches a model and runs the self-check, so that a phone nobody
 * here can hold tells what it can do. The look of the mockup comes after the numbers.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val stop = AtomicBoolean(false)

    private lateinit var engine: Engine
    private lateinit var store: ModelStore

    private lateinit var title: TextView
    private lateinit var sub: TextView
    private lateinit var progress: ProgressBar
    private lateinit var key: TextView
    private lateinit var report: TextView
    private lateinit var share: TextView
    private val rows = HashMap<Model, Pair<TextView, TextView>>()

    /** What the worker is doing: nothing, a check, or the download of one model. */
    private var busy: Any? = null
    private var lastReport: String? = null

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        engine = Engine(this)
        store = ModelStore(this)
        setContentView(build())
        refresh()
        // For a check started from a computer: adb shell am start -n …/.MainActivity --ez selfcheck true
        if (intent.getBooleanExtra("selfcheck", false)) check()
    }

    override fun onDestroy() {
        stop.set(true)
        engine.stop()
        worker.shutdownNow()
        super.onDestroy()
    }

    // ── The screen ──────────────────────────────────────────────────────────────────────────────────────────────

    private fun build(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(22), dp(18), dp(28))
        }

        column.addView(text("KOTOMIMI", 17f, R.color.screen, bold = true).apply { letterSpacing = 0.14f })
        column.addView(text("手机端 · 自检版", 13f, R.color.ink_2), spaced(top = 2))

        // The recorder: a body, and a screen that says what is going on.
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.body, 34)
            setPadding(dp(12), dp(12), dp(12), dp(14))
        }
        val screen = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.screen, 24)
            setPadding(dp(20), dp(20), dp(20), dp(20))
        }
        title = text("", 27f, R.color.screen_ink, bold = true)
        sub = text("", 14f, R.color.screen_ink_2)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progressTintList = getColorStateList(R.color.glow)
            progressBackgroundTintList = getColorStateList(R.color.screen_ink_2)
        }
        screen.addView(title)
        screen.addView(sub, spaced(top = 6))
        screen.addView(progress, spaced(top = 18))
        body.addView(screen)
        key = text("", 17f, android.R.color.white, bold = true).apply {
            gravity = Gravity.CENTER
            background = shape(R.color.key, 28)
            setOnClickListener { if (busy == null) check() else halt() }
        }
        body.addView(key, LinearLayout.LayoutParams(MATCH_PARENT, dp(56)).apply { topMargin = dp(12) })
        column.addView(body, spaced(top = 18))

        // The models.
        val models = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.tile, 26)
            setPadding(dp(18), dp(8), dp(12), dp(8))
        }
        for (model in MODELS) {
            val row = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(64) }
            val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            val state = text("", 13f, R.color.ink_2)
            words.addView(text(model.name, 16f, R.color.ink, bold = true))
            words.addView(state, spaced(top = 2))
            val act = text("", 14f, R.color.screen, bold = true).apply {
                gravity = Gravity.CENTER
                background = shape(R.color.body, 20)
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener { if (busy == null) fetch(model) else if (busy === model) halt() }
            }
            row.addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            row.addView(act, LinearLayout.LayoutParams(WRAP_CONTENT, dp(40)))
            models.addView(row)
            rows[model] = state to act
        }
        column.addView(models, spaced(top = 14))

        // The report.
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.tile, 26)
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        report = text("", 12.5f, R.color.ink).apply {
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setLineSpacing(0f, 1.25f)
        }
        share = text("分享报告", 15f, R.color.screen, bold = true).apply {
            gravity = Gravity.CENTER
            background = shape(R.color.body, 22)
            setOnClickListener { lastReport?.let(::send) }
        }
        sheet.addView(report)
        sheet.addView(share, LinearLayout.LayoutParams(MATCH_PARENT, dp(46)).apply { topMargin = dp(14) })
        column.addView(sheet, spaced(top = 14))

        return ScrollView(this).apply {
            isFillViewport = true
            addView(column)
        }
    }

    /** The screen as things stand, while nothing is running. */
    private fun refresh() {
        val here = MODELS.filter { store.has(it) }
        for ((model, views) in rows) {
            val (state, act) = views
            val begun = store.begun(model)
            state.text = when {
                store.has(model) -> "已下载 · ${model.sizeInWords}"
                begun > 0 -> "下载到 ${percent(begun, model.bytes)}，可以接着下"
                else -> model.sizeInWords
            }
            act.text = if (begun > 0 && !store.has(model)) "继续" else "下载"
            act.visibility = if (store.has(model)) View.GONE else View.VISIBLE
            act.alpha = 1f
        }
        progress.visibility = View.INVISIBLE
        key.text = if (lastReport == null) "开始自检" else "再检查一次"
        key.alpha = if (here.isEmpty() || !engine.present) 0.45f else 1f
        when {
            !engine.present -> say("引擎不在", "这个安装包里没有带上识别引擎")
            here.isEmpty() -> say("先下载模型", "下面选一个，建议连着 Wi-Fi")
            lastReport == null -> say("可以自检了", "读一段固定的录音，看这台手机跟不跟得上")
        }
        report.text = lastReport ?: "还没有报告。"
        share.visibility = if (lastReport == null) View.GONE else View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun say(big: String, small: String) {
        title.text = big
        sub.text = small
    }

    // ── What it does ────────────────────────────────────────────────────────────────────────────────────────────

    private fun check() {
        if (!engine.present || MODELS.none { store.has(it) }) return
        begin("check")
        key.text = "停下"
        say("正在检查", "别切走，一会儿就好")
        progress.progress = 0
        worker.execute {
            val result = runCatching {
                SelfCheck(this, engine, store).run(
                    onStep = { done, of, words ->
                        main.post {
                            sub.text = words
                            progress.progress = if (of == 0) 0 else done * 1000 / of
                        }
                    },
                    stopped = stop::get,
                )
            }
            main.post {
                busy = null
                result.onSuccess { done ->
                    if (done != null) {
                        lastReport = done.report
                        say(done.verdict.words, done.models.mapNotNull { m -> m.best?.let { "${m.model.name} ${"%.1f".format(it.speed)} 倍速" } }.joinToString(" · ").ifBlank { "看下面的报告" })
                    }
                }.onFailure { error ->
                    say("没检查成", error.message ?: error.javaClass.simpleName)
                }
                refresh()
            }
        }
    }

    private fun fetch(model: Model) {
        begin(model)
        val (state, act) = rows.getValue(model)
        act.text = "停止"
        for ((other, views) in rows) if (other !== model) views.second.alpha = 0.4f
        key.alpha = 0.45f
        worker.execute {
            val result = runCatching {
                store.fetch(model, onProgress = { had -> main.post { state.text = "下载中 ${percent(had, model.bytes)}" } }, stopped = stop::get)
            }
            main.post {
                busy = null
                refresh()
                result.onFailure { error -> state.text = "没下成：${error.message ?: error.javaClass.simpleName}" }
            }
        }
    }

    private fun begin(what: Any) {
        busy = what
        stop.set(false)
        progress.visibility = if (what == "check") View.VISIBLE else View.INVISIBLE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun halt() {
        stop.set(true)
        engine.stop()
    }

    private fun send(words: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, words), "分享报告"))
    }

    // ── Small things ────────────────────────────────────────────────────────────────────────────────────────────

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun text(words: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = words
        textSize = size
        setTextColor(getColor(color))
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun shape(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(getColor(color))
        cornerRadius = dp(radius).toFloat()
    }

    private fun spaced(top: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(top) }

    private fun percent(had: Long, of: Long) = "${had * 100 / of}%"
}
