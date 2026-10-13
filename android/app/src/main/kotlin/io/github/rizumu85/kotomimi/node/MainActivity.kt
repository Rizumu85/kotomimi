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
import android.view.WindowInsets
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
    private lateinit var llama: Llama
    private lateinit var store: ModelStore
    private lateinit var choices: Choices

    private lateinit var title: TextView
    private lateinit var sub: TextView
    private lateinit var progress: ProgressBar
    private lateinit var key: TextView
    private lateinit var checkKey: TextView
    private lateinit var report: TextView
    private lateinit var share: TextView
    private lateinit var rule: TextView
    private val rows = HashMap<Model, Pair<TextView, TextView>>()

    /** What this screen's own worker is doing: nothing, a check, or the download of one model. */
    private var busy: Any? = null
    private var lastReport: String? = null
    private var lastVerdict: Pair<String, String>? = null

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        engine = Engine(this)
        llama = Llama(this)
        store = ModelStore(this)
        choices = Choices(this)
        setContentView(build())
        refresh()
        asked(intent)
    }

    /** The app is one screen kept: asked again while it is open, it is told here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        asked(intent)
    }

    /**
     * For a computer driving the phone: adb shell am start -n …/.MainActivity --ez selfcheck true (or --ez share true;
     * --ez share false stops it). With --es llama v86 (or v82, v80) the self-check, or sharing, begins with that build
     * of llama.cpp, not the one it would pick. With --es model llama-qwen3-asr-0.6b-q8 (a model's own name here, not
     * the one it is lent as) the phone is lent with that model this once: what the user chose stays as it was.
     * With --es force opencl,sme the self-check also makes the runs only another kind of phone is given.
     */
    private fun asked(intent: Intent) {
        if (intent.getBooleanExtra("selfcheck", false)) {
            check(Llama.Build.values().firstOrNull { it.words == intent.getStringExtra("llama") }, intent.getStringExtra("force")?.split(',')?.map { it.trim() }?.toSet().orEmpty())
        }
        if (intent.getBooleanExtra("share", false)) lend(MODELS.firstOrNull { it.id == intent.getStringExtra("model") }, intent.getStringExtra("llama"))
        else if (intent.hasExtra("share") && Sharing.on) ShareService.stop(this)
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
        llama.stop()
        worker.shutdownNow()
        super.onDestroy()
    }

    // ── The screen ──────────────────────────────────────────────────────────────────────────────────────────────

    private fun build(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(PAGE_SIDE), dp(PAGE_TOP), dp(PAGE_SIDE), dp(PAGE_FOOT))
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

        // The models, each with the engine it is for: the one that is lent is marked; a touch on another that is
        // here lends that one instead, by its own engine.
        val models = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(R.color.tile, 26)
            setPadding(dp(18), dp(8), dp(12), dp(8))
        }
        for (model in MODELS) {
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(64)
                setOnClickListener { if (model in choices.lendable(store) && busy == null && !Sharing.on) { choices.share(model); lastVerdict = null; refresh() } }
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
        // Under the rows, how the one that is lent comes to be it: nothing else on the screen says a row can be touched.
        rule = text("", 12.5f, R.color.ink_2)
        models.addView(rule, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4); bottomMargin = dp(8); rightMargin = dp(6) })
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

        // The page lies under the status bar and the navigation bar — Android 15 puts every app there, and here it is
        // asked for on the versions before, so that all of them are one case — and keeps its content clear of them:
        // on the first phone of that kind it was shown on, the name sat against the clock (2026-10-11).
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        return ScrollView(this).apply {
            isFillViewport = true
            addView(column)
            // The bars' room is the scrolling view's own, so what scrolls is cut off at the bars and never runs under
            // the clock; the page's colour shows there.
            setOnApplyWindowInsetsListener { view, insets ->
                val (left, top, right, bottom) = if (Build.VERSION.SDK_INT >= 30) {
                    insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()).let { listOf(it.left, it.top, it.right, it.bottom) }
                } else {
                    @Suppress("DEPRECATION")
                    listOf(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                view.setPadding(left, top, right, bottom)
                insets
            }
        }
    }

    /** The screen as things stand. A check or a download in hand writes its own lines over this as it goes. */
    private fun refresh() {
        val here = MODELS.filter { store.has(it) }
        val lendable = choices.lendable(store)
        val lent = choices.shared(store)
        val sharing = Sharing.state
        val shared = Sharing.on
        for ((model, views) in rows) {
            val (state, act) = views
            val begun = store.begun(model)
            if (busy !== model) {
                // Which engine a row is for, in every state: two rows carry the same model's name. A model with a
                // row to itself says there what it is good for, which the engine's name tells nobody.
                val whose = model.note ?: "${model.reader.words} 用"
                state.text = when {
                    store.has(model) -> if (model === lent && lendable.size > 1) "借出去的是这个 · $whose" else "已下载 · $whose · ${model.sizeInWords}"
                    begun > 0 -> "$whose · 下载到 ${percent(begun, model.bytes)}，可以接着下"
                    else -> "$whose · ${model.sizeInWords}"
                }
                act.text = if (begun > 0 && !store.has(model)) "继续" else "下载"
                act.alpha = if (busy == null) 1f else 0.4f
            }
            act.visibility = if (store.has(model)) View.GONE else View.VISIBLE
        }
        // The rule the lent model is picked by (`Choices.shared`), where there is more than one to pick from.
        rule.visibility = if (lendable.size > 1) View.VISIBLE else View.GONE
        rule.text = when {
            choices.chosen(store) != null -> "借的是你点的那一行。点别的行就换。"
            choices.checked(store) -> "点哪一行就借哪一行。没点过：按自检，借跟得上的里最准的，都跟不上就借最快的。"
            else -> "点哪一行就借哪一行。没点过、也没自检过：先借最小最快的。"
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
                // Only llama.cpp's files are here, in a package built without its server: enough to check with, not to lend.
                lent == null -> say("可以自检", "要借给电脑，还得下载 audio.cpp 用的模型")
                // Which engine it will be, in a word: the row below says which model.
                else -> say("没有开启", "按下面的键借给电脑 · ${lent.reader.words}")
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

    /** Lends the phone: the model that is chosen (or, asked from a computer, `named`), the way the self-check found fastest. */
    private fun lend(named: Model? = null, llamaBuild: String? = null) {
        val model = named?.takeIf { it in choices.lendable(store) } ?: choices.shared(store) ?: return
        if (!engine.present || busy != null || Sharing.on) return
        // The notification that says the phone is lent: asked for once, and lent whatever the answer.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        lastVerdict = null
        ShareService.start(this, model, llamaBuild)
    }

    private fun check(startWith: Llama.Build? = null, force: Set<String> = emptySet()) {
        if (busy != null || !engine.present || MODELS.none { store.has(it) } || Sharing.on) return
        begin("check")
        // Every run is waited for with the phone cooling: it takes a good while, and says at each step what it is at.
        say("正在检查", "手机放着别动，要等一阵子")
        progress.visibility = View.VISIBLE
        progress.progress = 0
        refresh()
        worker.execute {
            val result = runCatching {
                SelfCheck(this, engine, llama, store).run(
                    onStep = { done, of, words ->
                        main.post {
                            title.text = if (done < of) "正在检查 ${done + 1}/$of" else "正在检查"
                            sub.text = words
                            progress.progress = if (of == 0) 0 else done * 1000 / of
                        }
                    },
                    stopped = stop::get,
                    startWith = startWith,
                    force = force,
                )
            }
            main.post {
                busy = null
                result.onSuccess { done ->
                    if (done != null) {
                        lastReport = done.report
                        // What the screen says is about lending the phone: the model it is lent with, by its engine.
                        // (The model by its size alone: its whole name with the rest does not fit a small screen's line.
                        // The engine only where the model has a row for each: it is what tells the two apart.)
                        lastVerdict = done.verdict.words to (done.lending?.let { of ->
                            of.lent?.speed?.let { listOfNotNull(of.model.size, of.model.reader.words.takeIf { of.model.twin }, "${"%.1f".format(it)} 倍速").joinToString(" · ") }
                        } ?: "看下面的报告")
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
                    onProgress = { now ->
                        main.post {
                            // What comes in a second says the download is alive where the per cent stands still, and
                            // where it comes from says which address this phone ended up with. A model in several
                            // files says which it is at; the per cent is of the whole model.
                            val which = if (now.files > 1) "${now.file}/${now.files} · " else ""
                            state.text = if (now.from.isBlank()) "${which}找最快的下载地址…" else "$which${percent(now.had, model.bytes)} · ${speed(now.perSecond)} · ${now.from}"
                            act.alpha = 1f
                        }
                    },
                    onChecking = { main.post { state.text = "核对中…"; act.alpha = 0.4f } },
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
        llama.stop()
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

    private companion object {
        /** The page's own margins, in dp, inside whatever the system's bars take. */
        const val PAGE_SIDE = 18
        const val PAGE_TOP = 14
        const val PAGE_FOOT = 28
    }

    private fun percent(had: Long, of: Long) = "${had * 100 / of}%"

    private fun speed(perSecond: Long) = if (perSecond >= 1024 * 1024) "%.1f MB/秒".format(perSecond / (1024.0 * 1024.0)) else "${perSecond / 1024} KB/秒"
}
