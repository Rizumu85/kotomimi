package io.github.rizumu85.kotomimi.node

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
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
 * The phone side's one screen: fetch a model, lend the phone to a computer, and check what the phone can do. The look
 * of the mockup comes after it is known to work on the phones it is for.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val stop = AtomicBoolean(false)

    private lateinit var engine: Engine
    private lateinit var store: ModelStore
    private lateinit var choices: Choices

    private lateinit var title: TextView
    private lateinit var sub: TextView
    private lateinit var progress: ProgressBar
    private lateinit var key: TextView
    private lateinit var checkKey: TextView
    private lateinit var report: TextView
    private lateinit var share: TextView
    private val rows = HashMap<Model, Pair<TextView, TextView>>()

    /** What this screen's own worker is doing: nothing, a check, or the download of one model. */
    private var busy: Any? = null
    private var lastReport: String? = null
    private var lastVerdict: Pair<String, String>? = null

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        engine = Engine(this)
        store = ModelStore(this)
        choices = Choices(this)
        setContentView(build())
        refresh()
        // For a computer driving the phone: adb shell am start -n …/.MainActivity --ez selfcheck true (or --ez share true)
        if (intent.getBooleanExtra("selfcheck", false)) check()
        if (intent.getBooleanExtra("share", false)) lend()
    }

    override fun onStart() {
        super.onStart()
        Sharing.listener = { refresh() }
        refresh()
    }

    override fun onStop() {
        Sharing.listener = null
        super.onStop()
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
        column.addView(text("手机端 ${BuildConfigLite.VERSION}", 13f, R.color.ink_2), spaced(top = 2))

        // The recorder: a body, a screen that says what is going on, and the key.
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
            setOnClickListener { if (Sharing.on) ShareService.stop(this@MainActivity) else if (busy == null) lend() }
        }
        body.addView(key, LinearLayout.LayoutParams(MATCH_PARENT, dp(56)).apply { topMargin = dp(12) })
        checkKey = text("", 15f, R.color.screen, bold = true).apply {
            gravity = Gravity.CENTER
            background = shape(R.color.body_deep, 22)
            setOnClickListener { if (busy == "check") halt() else if (busy == null && !Sharing.on) check() }
        }
        body.addView(checkKey, LinearLayout.LayoutParams(MATCH_PARENT, dp(46)).apply { topMargin = dp(10) })
        column.addView(body, spaced(top = 18))

        // The models: the one that is lent is marked; a touch on another that is here lends that one instead.
        val models = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.tile, 26)
            setPadding(dp(18), dp(8), dp(12), dp(8))
        }
        for (model in MODELS) {
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(64)
                setOnClickListener { if (store.has(model) && busy == null && !Sharing.on) { choices.share(model); refresh() } }
            }
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

    /** The screen as things stand. A check or a download in hand writes its own lines over this as it goes. */
    private fun refresh() {
        val here = MODELS.filter { store.has(it) }
        val lent = choices.shared(store)
        val sharing = Sharing.state
        val shared = Sharing.on
        for ((model, views) in rows) {
            val (state, act) = views
            val begun = store.begun(model)
            if (busy !== model) {
                state.text = when {
                    store.has(model) -> if (model === lent && here.size > 1) "借出去的是这个 · ${model.sizeInWords}" else "已下载 · ${model.sizeInWords}"
                    begun > 0 -> "下载到 ${percent(begun, model.bytes)}，可以接着下"
                    else -> model.sizeInWords
                }
                act.text = if (begun > 0 && !store.has(model)) "继续" else "下载"
                act.alpha = if (busy == null) 1f else 0.4f
            }
            act.visibility = if (store.has(model)) View.GONE else View.VISIBLE
        }

        key.text = if (shared) "停止共享" else "开始共享"
        key.alpha = if (shared || (busy == null && lent != null && engine.present)) 1f else 0.45f
        checkKey.text = if (busy == "check") "停下" else if (lastReport == null) "自检：看这台手机跟不跟得上" else "再自检一次"
        checkKey.alpha = if (busy == "check" || (busy == null && !shared && here.isNotEmpty() && engine.present)) 1f else 0.45f

        if (busy != "check") {
            progress.visibility = View.INVISIBLE
            when {
                !engine.present -> say("引擎不在", "这个安装包里没有带上识别引擎")
                shared || sharing.phase == Share.Phase.FAILED -> ShareService.wordsOf(sharing).let { say(it.first, it.second) }
                here.isEmpty() -> say("先下载模型", "下面选一个，建议连着 Wi-Fi")
                lastVerdict != null -> say(lastVerdict!!.first, lastVerdict!!.second)
                else -> say("没有开启", "按下面的键，把这台手机借给电脑")
            }
        }
        report.text = lastReport ?: "还没有自检报告。"
        share.visibility = if (lastReport == null) View.GONE else View.VISIBLE
        if (busy == null) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun say(big: String, small: String) {
        title.text = big
        sub.text = small
    }

    // ── What it does ────────────────────────────────────────────────────────────────────────────────────────────

    /** Lends the phone: the model that is chosen, the way the self-check found fastest. */
    private fun lend() {
        val model = choices.shared(store) ?: return
        if (!engine.present || busy != null) return
        // The notification that says the phone is lent: asked for once, and lent whatever the answer.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        lastVerdict = null
        ShareService.start(this, model)
    }

    private fun check() {
        if (!engine.present || MODELS.none { store.has(it) } || Sharing.on) return
        begin("check")
        say("正在检查", "别切走，一会儿就好")
        progress.visibility = View.VISIBLE
        progress.progress = 0
        refresh()
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
                        lastVerdict = done.verdict.words to done.models.mapNotNull { m -> m.best?.let { "${m.model.name} ${"%.1f".format(it.speed)} 倍速" } }.joinToString(" · ").ifBlank { "看下面的报告" }
                    }
                }.onFailure { error ->
                    lastVerdict = "没检查成" to (error.message ?: error.javaClass.simpleName)
                }
                refresh()
            }
        }
    }

    private fun fetch(model: Model) {
        begin(model)
        val (state, act) = rows.getValue(model)
        act.text = "停止"
        refresh()
        act.alpha = 1f
        worker.execute {
            val result = runCatching {
                store.fetch(
                    model,
                    onProgress = { had -> main.post { state.text = "下载中 ${percent(had, model.bytes)}" } },
                    onChecking = { main.post { state.text = "下完了，核对中…"; act.alpha = 0.4f } },
                    stopped = stop::get,
                )
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
