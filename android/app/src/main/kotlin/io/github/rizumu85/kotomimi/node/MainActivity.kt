package io.github.rizumu85.kotomimi.node

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
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
import android.widget.Toast
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The phone side's one screen: fetch a model, lend the phone to a computer, and check what the phone can do — and,
 * when a newer version of the app is published, fetch and install that. The look of the mockup comes after it is
 * known to work on the phones it is for.
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

    private lateinit var updater: Updater
    private lateinit var lookKey: TextView
    private lateinit var updateRow: View
    private lateinit var updateTitle: TextView
    private lateinit var updateState: TextView
    private lateinit var updateAct: TextView

    /** What this screen's own worker is doing: nothing, a check, or the download of one model or of a newer version. */
    private var busy: Any? = null
    private var lastReport: String? = null
    private var lastVerdict: Pair<String, String>? = null

    /** The newer version there is, if any; and what its row says in place of how it stands: why something about it failed. */
    private var release: Release? = null
    private var updateWords: String? = null

    /** Asking whether there is a newer version: under way, whether the person asked, and what they are told of it for a moment. */
    private var looking = false
    private var lookAsked = false
    private var lookWords: String? = null

    /** A package is on its way to the system, which has not answered yet. */
    private var installing = false

    /** The person was taken to the system's screen where this app is let install apps, since this screen was made. */
    private var sentToAllow = false
    private var shown = false
    private var testing = false

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        engine = Engine(this)
        llama = Llama(this)
        store = ModelStore(this)
        choices = Choices(this)
        updater = Updater(this)
        // What was last heard of, at once: asking again waits on the network. And nothing kept of a version the
        // app has since become.
        release = updater.offered()
        updater.tidy(release)
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
     * With --ez update true it asks whether there is a newer version, as the small key does. (Where it asks is not
     * to be told this way: `Updater.testAddress`.)
     */
    private fun asked(intent: Intent) {
        if (intent.getBooleanExtra("update", false)) look(asked = true)
        if (intent.getBooleanExtra("selfcheck", false)) {
            check(Llama.Build.values().firstOrNull { it.words == intent.getStringExtra("llama") }, intent.getStringExtra("force")?.split(',')?.map { it.trim() }?.toSet().orEmpty())
        }
        if (intent.getBooleanExtra("share", false)) lend(MODELS.firstOrNull { it.id == intent.getStringExtra("model") }, intent.getStringExtra("llama"))
        else if (intent.hasExtra("share") && Sharing.on) ShareService.stop(this)
    }

    override fun onStart() {
        super.onStart()
        shown = true
        testing = updater.testAddress() != null
        Sharing.listener = { refresh() }
        Installing.listener = { answered() }
        refresh()
        // What the system said of an install while the screen was away.
        answered()
        // Never in the way of the screen: it is asked on a thread of its own, and says nothing unless there is one.
        if (updater.due()) look(asked = false)
    }

    override fun onResume() {
        super.onResume()
        // Back from the system's screen where the person lets this app install apps: if they did, on with the
        // install they asked for.
        if (updater.sentToAllow) {
            updater.sentToAllow = false
            release?.takeIf { updater.has(it) && updater.allowed() }?.let(::install)
        }
    }

    override fun onStop() {
        shown = false
        Sharing.listener = null
        Installing.listener = null
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

        // The name and the version, and beside them the one thing there is to ask about the app itself.
        val head = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        names.addView(text("KOTOMIMI", 17f, R.color.screen, bold = true).apply { letterSpacing = 0.14f })
        names.addView(text("手机端 ${BuildConfigLite.VERSION}", 13f, R.color.ink_2), spaced(top = 2))
        lookKey = text("", 13f, R.color.ink_2).apply {
            gravity = Gravity.CENTER
            background = shape(R.color.tile, 18)
            setPadding(dp(14), 0, dp(14), 0)
            setOnClickListener { look(asked = true) }
        }
        head.addView(names, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        head.addView(lookKey, LinearLayout.LayoutParams(WRAP_CONTENT, dp(36)))
        column.addView(head)

        // A newer version, when there is one: a row like a model's, above everything else, and not there otherwise.
        updateRow = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(64)
            background = shape(R.color.tile, 26)
            setPadding(dp(18), dp(8), dp(12), dp(8))
            val words = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            updateTitle = text("", 16f, R.color.ink, bold = true)
            updateState = text("", 13f, R.color.ink_2)
            words.addView(updateTitle)
            words.addView(updateState, spaced(top = 2))
            updateAct = text("", 14f, R.color.screen, bold = true).apply {
                gravity = Gravity.CENTER
                background = shape(R.color.body, 20)
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener { release?.let(::touched) }
            }
            addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = dp(10) })
            addView(updateAct, LinearLayout.LayoutParams(WRAP_CONTENT, dp(40)))
        }
        column.addView(updateRow, spaced(top = 14))

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
        showUpdate()
        if (busy == null) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** The small key that asks for a newer version, and the row of the one there is. Its download writes its own lines over this. */
    private fun showUpdate() {
        // A test's address is said on the key: it is not to be left behind unseen.
        lookKey.text = lookWords ?: if (testing) "检查更新 · 测试" else "检查更新"
        val offered = release
        updateRow.visibility = if (offered == null) View.GONE else View.VISIBLE
        if (offered == null) return
        updateTitle.text = "新版本 ${offered.version}"
        if (busy === offered) return
        val here = updater.has(offered)
        val begun = updater.begun(offered)
        updateState.text = updateWords ?: when {
            installing -> "正在交给系统…"
            sentToAllow && !updater.allowed() -> "要先允许本应用安装应用"
            // Installing ends the app, and what it is lent for with it.
            here && Sharing.on -> "已下好 · 安装会停止共享"
            here -> "已下好"
            begun > 0 -> "下载到 ${percent(begun, offered.bytes)}，可以接着下"
            else -> listOf(offered.notes, offered.sizeInWords).filter { it.isNotBlank() }.joinToString(" · ")
        }
        updateAct.text = if (here) "安装" else if (begun > 0) "继续" else "更新"
        updateAct.alpha = if (busy == null && !installing) 1f else 0.4f
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

    // ── The app's own update ────────────────────────────────────────────────────────────────────────────────────

    /**
     * Asks whether a newer version is published. By itself it says nothing unless there is one — not that there is
     * none, and not that nobody answered; asked by the person, it says how it went, for a moment.
     */
    private fun look(asked: Boolean) {
        // The version in hand is the one being fetched or installed: what else there is can wait for that.
        if (busy is Release || installing) return
        if (asked) { lookAsked = true; lookWords = "正在检查…"; refresh() }
        if (looking) return
        looking = true
        thread(name = "update-check", isDaemon = true) {
            val result = runCatching { updater.check() }
            main.post {
                looking = false
                result.onSuccess { found ->
                    if (found?.name != release?.name) updateWords = null
                    // A download begun in the meantime is of the version it was begun with.
                    if (busy !is Release && !installing) { release = found; updater.tidy(found) }
                }
                val tell = if (!lookAsked) null else if (result.isFailure) "没连上，稍后再试" else if (result.getOrNull() == null) "已是最新" else null
                lookAsked = false
                lookWords = tell
                if (tell != null) main.postDelayed({ if (lookWords === tell) { lookWords = null; refresh() } }, LOOK_WORDS_MS)
                refresh()
            }
        }
    }

    /** The key of the newer version's row: fetch it, stop fetching it, or install what was fetched. */
    private fun touched(offered: Release) {
        when {
            busy === offered -> halt()
            busy != null || installing -> Unit
            updater.has(offered) -> install(offered)
            else -> fetch(offered)
        }
    }

    /** Fetches the newer version's package as a model is fetched, and goes on to install it. */
    private fun fetch(offered: Release) {
        begin(offered)
        updateWords = null
        updateAct.text = "停止"
        refresh()
        updateAct.alpha = 1f
        worker.execute {
            val result = runCatching {
                updater.fetch(
                    offered,
                    onProgress = { had, perSecond, from ->
                        main.post {
                            updateState.text = if (from.isBlank()) "找最快的下载地址…" else "${percent(had, offered.bytes)} · ${speed(perSecond)} · $from"
                            updateAct.alpha = 1f
                        }
                    },
                    onChecking = { main.post { updateState.text = "核对中…"; updateAct.alpha = 0.4f } },
                    stopped = stop::get,
                )
            }
            main.post {
                busy = null
                result.onFailure { error -> updateWords = "没下成：${error.message ?: error.javaClass.simpleName}" }
                refresh()
                // Installing ends the app, and with it whatever the phone is lent for: while it is lent the package
                // waits for the person's own touch. So it does with the screen away, where the system's question
                // would have nobody to ask.
                if (updater.has(offered) && !Sharing.on && shown) install(offered)
            }
        }
    }

    /**
     * Hands the package to the system. The system asks the person itself before it installs anything; and before
     * that, once on a phone, the person has to let this app install apps at all, on a screen of the system's that
     * they are taken to.
     */
    private fun install(offered: Release) {
        if (busy != null || installing) return
        updateWords = null
        if (!updater.allowed()) {
            updater.sentToAllow = true
            // The row says what is missing to someone who comes back without having turned it on (`showUpdate`); over
            // the system's screen, a line says what to turn on.
            sentToAllow = true
            Toast.makeText(this, "打开这个开关，再返回", Toast.LENGTH_LONG).show()
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }.onFailure {
                // A system without that screen under this name: the person finds it by hand.
                updater.sentToAllow = false
                updateWords = "请在系统设置里允许本应用安装应用"
            }
            refresh()
            return
        }
        installing = true
        refresh()
        thread(name = "install") {
            val result = runCatching { updater.install(offered) }
            main.post {
                result.onFailure { error ->
                    installing = false
                    updateWords = "没装成：${error.message ?: error.javaClass.simpleName}"
                    refresh()
                }
            }
        }
    }

    /** What the system said of the install it was handed (`InstallReceiver`). */
    private fun answered() {
        val told = Installing.take() ?: return
        installing = false
        when (told.status) {
            // It wants the person's word, and gives the screen of its own that asks for it.
            PackageInstaller.STATUS_PENDING_USER_ACTION ->
                runCatching { startActivity(told.confirm!!) }.onFailure { error -> updateWords = "没装成：${error.message ?: error.javaClass.simpleName}" }
            // The person said no: the package stays, for when they say yes. (A yes is not heard here: the app is ended
            // to be replaced.) The same word comes when the phone's own guard said no in their place — Google Play
            // Protect did, the first time, on the emulator this was tried on (2026-10-13): that much is said.
            PackageInstaller.STATUS_FAILURE_ABORTED, PackageInstaller.STATUS_SUCCESS ->
                updateWords = if (told.message?.contains("VERIFICATION") == true) "没装成：被手机的安全检查拦下了" else null
            else -> {
                updateWords = "没装成：${Updater.reasonOf(told.status, told.message)}"
                // A package the system will not take over this app whenever it is asked — signed with another key,
                // or not for this phone — is not kept, nor offered again as it is. The row stays, to say so.
                if (told.status in NEVER_TAKEN) updater.drop()
            }
        }
        refresh()
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

        /** How long the small key says how asking for a newer version went, before it is the key again. */
        const val LOOK_WORDS_MS = 4_000L

        /** The system's refusals that asking again would not change. */
        val NEVER_TAKEN = setOf(PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_INVALID)
    }

    private fun percent(had: Long, of: Long) = "${had * 100 / of}%"

    private fun speed(perSecond: Long) = if (perSecond >= 1024 * 1024) "%.1f MB/秒".format(perSecond / (1024.0 * 1024.0)) else "${perSecond / 1024} KB/秒"
}
