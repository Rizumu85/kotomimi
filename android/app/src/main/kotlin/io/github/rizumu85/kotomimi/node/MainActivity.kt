package io.github.rizumu85.kotomimi.node

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.style.RelativeSizeSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.AccelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The phone side's one screen, after the OriginOS 1.0 desktop the user pointed to (`Look.kt`): a living wallpaper
 * and, on it, a status word with a large number, the share tile with its switch, a large tile for the work the phone
 * is doing — hearing, translating or giving grammar feedback, each its own object — small tiles for the other two,
 * and tiles for the computer's side, the performance check and the models. Those three open as a panel over the page.
 *
 * The models stand in three groups, by what each is lent for: to recognize speech, to translate, to give grammar
 * feedback. One recognizer is lent, the one whose row is marked; the text models that are here are all lent.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val stop = AtomicBoolean(false)

    private lateinit var engine: Engine
    private lateinit var llama: Llama
    private lateinit var store: ModelStore
    private lateinit var choices: Choices
    private lateinit var device: Device

    // The page.
    private lateinit var wall: Wall
    private lateinit var page: FrameLayout
    private lateinit var scroll: ScrollView
    private lateinit var updatePill: TextView
    private lateinit var word: TextView
    private lateinit var bigNumber: TextView
    private lateinit var bigUnit: TextView
    private lateinit var from: TextView
    private lateinit var shareTitle: TextView
    private lateinit var shareSub: TextView
    private lateinit var switch: Switch

    // The large tile: one of three, for the work in hand.
    private lateinit var stage: FrameLayout
    private lateinit var hearTile: View
    private lateinit var water: Water
    private lateinit var hearNumber: TextView
    private lateinit var hearSub: TextView
    private lateinit var hearModel: TextView
    private lateinit var heardLast: TextView
    private lateinit var glassTile: View
    private lateinit var glassNumber: TextView
    private lateinit var glassSub: TextView
    private lateinit var glassState: TextView
    private lateinit var paneBack: TextView
    private lateinit var paneFront: TextView
    private lateinit var paperTile: View
    private lateinit var paperNumber: TextView
    private lateinit var paperSub: TextView
    private lateinit var paperState: TextView
    private lateinit var paperSaid: TextView
    private lateinit var paperFix: TextView
    private lateinit var paperWhy: TextView
    private lateinit var sheet: View

    // The small tiles.
    private class Small(val view: View, val state: TextView, val name: TextView, val sub: TextView, val thing: Thing)
    private lateinit var works: Map<Task, Small>
    private lateinit var workRow: LinearLayout
    private lateinit var lens: Small
    private lateinit var dial: Small
    private lateinit var modelsSub: TextView

    // The panels, made once and laid over the page when opened.
    private lateinit var modelsBox: View
    private lateinit var toolsBox: View
    private lateinit var devicesBox: View
    private var opened: View? = null
    private var scrim: View? = null
    /** The back key or gesture, while a panel is open: it closes the panel (Android 13 on; before, `onBackPressed`). */
    private val backCloses: Any? = if (Build.VERSION.SDK_INT >= 33) OnBackInvokedCallback { close() } else null

    // In the models panel.
    private lateinit var rule: TextView
    private val rows = HashMap<Model, Row>()
    /** The lent row's mark: made once, since the screen is redrawn every time sharing says how it stands. */
    private val lentMark by lazy { flat(R.color.field_mint, 16) }

    // In the performance panel.
    private lateinit var checkKey: TextView
    private lateinit var checkState: TextView
    private lateinit var checkBar: Bar
    private lateinit var report: TextView
    private lateinit var reportKey: TextView
    private lateinit var share: TextView
    private lateinit var lookKey: TextView
    private lateinit var updateRow: View
    private lateinit var updateTitle: TextView
    private lateinit var updateState: TextView
    private lateinit var updateAct: TextView
    private var reportOpen = false

    // In the devices panel.
    private lateinit var address: TextView
    private lateinit var lastComputer: TextView
    private lateinit var stay: TextView

    private lateinit var updater: Updater

    /** A model's row in the models panel: the whole row (to mark the one lent, and to hide), what it says, and its key. */
    private class Row(val view: View, val state: TextView, val act: TextView)

    /** What this screen's own worker is doing: nothing, a check, or the download of one model or of a newer version. */
    private var busy: Any? = null
    private var lastReport: String? = null
    private var lastVerdict: Pair<String, String>? = null
    /** How far the self-check under way has come, of one; and the speed the last one found for the model lent. */
    private var checked = 0f
    private var checkedSpeed: Double? = null
    /** How many of each work the screen has shown: one more is answered by the wallpaper. */
    private val seen = HashMap<Task, Int>()

    /** The newer version there is, if any; and what its row says in place of how it stands: why something about it failed. */
    private var release: Release? = null
    private var updateWords: String? = null

    /** Asking whether there is a newer version: under way, whether the person asked, and what they are told of it for a moment. */
    private var looking = false
    private var lookAsked = false
    private var lookWords: String? = null

    /**
     * A package is with the system: on its way there, or there and being asked about or installed. Asking the
     * system again meanwhile would give up the install under way — on a slow phone the system takes ten seconds
     * over it after the person said yes, with this screen back in front (Duoqin F22 Pro, 2026-10-13: three
     * installs handed over within twenty seconds, each giving up the one before it).
     */
    private var installing = false

    /** The system's own question about the install was opened; and this screen gave way to it. */
    private var confirming = false
    private var confirmShown = false

    /** Which handing-over is the current one: a wait that was set for an earlier one ends nothing. */
    private var handed = 0

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
        device = Device(this)
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
     * With --ez update true it asks whether there is a newer version, as the panel's key does. (Where it asks is not
     * to be told this way: `Updater.testAddress`.) With --es open models (or tools, devices) that panel is opened, and
     * with --es open none whatever is open is closed: for screenshots. With --es demo coach (or translate) a made-up
     * piece of that work is shown, as if a computer had asked it — for a screenshot of a kind of work this phone
     * cannot run itself; nothing is lent or asked for it.
     */
    private fun asked(intent: Intent) {
        if (intent.getBooleanExtra("update", false)) look(asked = true)
        if (intent.getBooleanExtra("selfcheck", false)) {
            check(Llama.Build.values().firstOrNull { it.words == intent.getStringExtra("llama") }, intent.getStringExtra("force")?.split(',')?.map { it.trim() }?.toSet().orEmpty())
        }
        if (intent.getBooleanExtra("share", false)) lend(MODELS.firstOrNull { it.id == intent.getStringExtra("model") }, intent.getStringExtra("llama"))
        else if (intent.hasExtra("share") && Sharing.on) ShareService.stop(this)
        when (intent.getStringExtra("demo")) {
            "coach" -> Sharing.work(Task.COACH).done(620, "昨日、映画を見ます。", "昨日、映画を見ました。\n动词时态应与“昨日”一致，使用过去式。")
            "translate" -> Sharing.work(Task.TRANSLATE).done(1400, "飛べないおじさんはただのおじさんだ。", "不会飞的叔叔只是个普通叔叔而已。", into = "中文")
        }
        if (intent.hasExtra("demo")) refresh()
        when (intent.getStringExtra("open")) {
            "models" -> open(modelsBox)
            "tools" -> open(toolsBox)
            "devices" -> open(devicesBox)
            "none" -> close()
        }
    }

    override fun onStart() {
        super.onStart()
        shown = true
        testing = updater.testAddress() != null
        Sharing.listener = { refresh() }
        Installing.listener = { answered() }
        wall.running = true
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
        // Back from the system's question. A no is told (`answered`); a yes ends the app within the time the system
        // takes to install; a question put away with the home key is told by nobody — so after that time the row is
        // the person's again.
        if (confirmShown) {
            confirming = false
            confirmShown = false
            val turn = handed
            main.postDelayed({ if (installing && handed == turn) { installing = false; refresh() } }, SYSTEM_INSTALLS_MS)
        }
    }

    override fun onPause() {
        if (confirming) confirmShown = true
        super.onPause()
    }

    override fun onStop() {
        shown = false
        // Nothing moves on a screen nobody sees: `onStart` sets it going again.
        wall.running = false
        water.running = false
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

    /** The back key closes an open panel first. */
    @Deprecated("The platform's own, kept for the versions before predictive back.")
    override fun onBackPressed() {
        if (opened != null) close() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ── The page ────────────────────────────────────────────────────────────────────────────────────────────────

    @SuppressLint("ClickableViewAccessibility")
    private fun build(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(PAGE_SIDE), px(PAGE_TOP), px(PAGE_SIDE), px(PAGE_FOOT))
        }

        // The status: a word, letter-spaced, and a large thin number with its unit — and, when there is one, the
        // newer version beside the word.
        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        word = text("", 12.5f, R.color.ink_red, bold = true).apply { letterSpacing = 0.5f }
        top.addView(word, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        updatePill = text("", 12.5f, R.color.tile, bold = true).apply {
            gravity = Gravity.CENTER
            background = flat(R.color.key, 15)
            setPadding(px(12), 0, px(12), 0)
            setOnClickListener { open(toolsBox) }
        }
        top.addView(updatePill, LinearLayout.LayoutParams(WRAP_CONTENT, px(30)))
        column.addView(top, spaced(top = 12))
        val big = LinearLayout(this).apply { gravity = Gravity.BOTTOM }
        bigNumber = text("", 60f, R.color.ink).apply { typeface = Typeface.create("sans-serif-thin", Typeface.NORMAL); includeFontPadding = false }
        bigUnit = text("", 16f, R.color.ink_2, bold = true)
        big.addView(bigNumber)
        big.addView(bigUnit, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = px(6); bottomMargin = px(8) })
        column.addView(big, spaced(top = 6))
        from = text("", 12.5f, R.color.ink_2).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
        column.addView(from, spaced(top = 6))

        // The share tile: what sharing is, and its switch. The whole tile is the switch.
        val shareTile = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = flat(R.color.tile, 30, alpha = 215)
            setPadding(px(20), px(14), px(16), px(14))
            minimumHeight = px(76)
            setOnClickListener { if (Sharing.on) ShareService.stop(this@MainActivity) else if (busy == null) lend() }
        }
        val shareWords = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        shareTitle = text("", 15f, R.color.ink, bold = true)
        shareSub = text("", 11.5f, R.color.ink_2).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        shareWords.addView(shareTitle)
        shareWords.addView(shareSub, spaced(top = 2))
        shareTile.addView(shareWords, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = px(10) })
        switch = Switch(this)
        shareTile.addView(switch, LinearLayout.LayoutParams(px(60), px(36)))
        column.addView(shareTile, spaced(top = 18))

        // The large tile.
        stage = FrameLayout(this)
        hearTile = hearing()
        glassTile = translating()
        paperTile = reviewing()
        for (tile in listOf(hearTile, glassTile, paperTile)) stage.addView(tile, FrameLayout.LayoutParams(MATCH_PARENT, px(STAGE_HEIGHT)))
        column.addView(stage, spaced(top = 12))

        // The other two kinds of work, small.
        workRow = LinearLayout(this)
        works = mapOf(
            Task.HEAR to small(Thing(this, Thing.Kind.WATER), "语音识别") { open(modelsBox) },
            Task.TRANSLATE to small(Thing(this, Thing.Kind.PANES), "文本翻译") { open(modelsBox) },
            Task.COACH to small(Thing(this, Thing.Kind.NOTE), "语法反馈") { open(modelsBox) },
        )
        column.addView(workRow, spaced(top = 12))

        // The computer's side and the check, and the models.
        val tools = LinearLayout(this)
        lens = small(Thing(this, Thing.Kind.LENS), "设备连接") { open(devicesBox) }
        dial = small(Thing(this, Thing.Kind.DIAL), "性能检测") { open(toolsBox) }
        tools.addView(lens.view, LinearLayout.LayoutParams(0, px(SMALL_HEIGHT), 1f))
        tools.addView(dial.view, LinearLayout.LayoutParams(0, px(SMALL_HEIGHT), 1f).apply { leftMargin = px(12) })
        column.addView(tools, spaced(top = 12))
        column.addView(modelsTile(), spaced(top = 12))

        modelsBox = box("模型管理", "选择借给电脑的识别模型，下载翻译与语法反馈模型", modelsContent())
        toolsBox = box("性能检测", "检测这台手机能否跟上说话的速度", toolsContent())
        devicesBox = box("设备连接", "让电脑使用这台手机上的模型", devicesContent())

        // The page lies under the status bar and the navigation bar — Android 15 puts every app there, and here it is
        // asked for on the versions before, so that all of them are one case — and keeps its content clear of them:
        // on the first phone of that kind it was shown on, the name sat against the clock (2026-10-11). The
        // wallpaper runs under the bars.
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(column)
            setOnScrollChangeListener { _, _, y, _, _ -> wall.scrolled = y.toFloat() }
        }
        // A touch on the wallpaper — between the tiles — rings out from the finger.
        column.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) wall.touched(event.x + scroll.paddingLeft, event.y - scroll.scrollY + scroll.paddingTop)
            false
        }
        wall = Wall(this)
        page = FrameLayout(this).apply {
            addView(wall, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(scroll, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            setOnApplyWindowInsetsListener { _, insets ->
                val (left, top, right, bottom) = if (Build.VERSION.SDK_INT >= 30) {
                    insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()).let { listOf(it.left, it.top, it.right, it.bottom) }
                } else {
                    @Suppress("DEPRECATION")
                    listOf(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                scroll.setPadding(left, top, right, bottom)
                bars = Bars(top, bottom)
                insets
            }
        }
        return page
    }

    /** The system bars' room, for a panel that opens over the page. */
    private class Bars(val top: Int, val bottom: Int)
    private var bars = Bars(0, 0)

    /** The large tile of hearing: the glass of water, its speed above, and what it heard last. */
    private fun hearing(): View = FrameLayout(this).apply {
        water = Water(this@MainActivity)
        addView(water, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        val (number, sub) = numberOf(this, R.color.water_number, R.color.water_sub)
        hearNumber = number
        hearSub = sub
        hearModel = corner(this, "语音识别", R.color.tile, R.color.water_sub)
        heardLast = text("", 12.5f, R.color.water_tile).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.START; setLineSpacing(0f, 1.15f) }
        addView(heardLast, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = px(18); rightMargin = px(18); bottomMargin = px(16) })
    }

    /** The large tile of translation: two panes of frosted glass, the sentence on the back one, its translation in front. */
    private fun translating(): View = FrameLayout(this).apply {
        background = flat(R.color.glass_tile, 30)
        val (number, sub) = numberOf(this, R.color.glass_number, R.color.glass_sub)
        glassNumber = number
        glassSub = sub
        glassState = corner(this, "文本翻译", R.color.glass_number, R.color.glass_sub)
        paneBack = text("", 12f, R.color.glass_sub).apply {
            background = flat(R.color.tile, 16, alpha = 120, edge = R.color.tile)
            setPadding(px(12), px(10), px(12), px(10)); maxLines = 3; ellipsize = TextUtils.TruncateAt.END; setLineSpacing(0f, 1.15f)
        }
        addView(paneBack, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(84); leftMargin = px(16); rightMargin = px(64) })
        paneFront = text("", 12.5f, R.color.ink, bold = true).apply {
            background = flat(R.color.tile, 16, alpha = 240)
            elevation = px(6f)
            setPadding(px(12), px(10), px(12), px(10)); maxLines = 3; ellipsize = TextUtils.TruncateAt.END; setLineSpacing(0f, 1.15f)
        }
        addView(paneFront, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = px(56); rightMargin = px(16); bottomMargin = px(18) })
    }

    /** The large tile of feedback: a sheet of paper with the sentence on it, struck through and written over in red. */
    private fun reviewing(): View = FrameLayout(this).apply {
        background = flat(R.color.paper_tile, 30)
        val (number, sub) = numberOf(this, R.color.paper_number, R.color.paper_sub)
        paperNumber = number
        paperSub = sub
        paperState = corner(this, "语法反馈", R.color.paper_number, R.color.paper_sub)
        val page = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            background = lined()
            elevation = px(4f)
            rotation = -1.2f
            setPadding(px(14), px(9), px(14), px(10))
        }
        paperSaid = text("", 12.5f, R.color.paper_sub).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        paperFix = text("", 13.5f, R.color.ink_red, bold = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        paperWhy = text("", 11.5f, R.color.paper_sub).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
        page.addView(paperSaid)
        page.addView(paperFix, spaced(top = 4))
        page.addView(paperWhy, spaced(top = 4))
        sheet = page
        addView(page, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = px(18); rightMargin = px(22); bottomMargin = px(20) })
        addView(View(this@MainActivity).apply { background = flat(R.color.ink_red, 5) }, FrameLayout.LayoutParams(px(9), px(9), Gravity.END or Gravity.BOTTOM).apply { rightMargin = px(30); bottomMargin = px(118) })
    }

    /** A large tile's number, thin, and the line under it. */
    private fun numberOf(tile: FrameLayout, numberColor: Int, subColor: Int): Pair<TextView, TextView> {
        val number = text("", 34f, numberColor).apply { typeface = Typeface.create("sans-serif-light", Typeface.NORMAL); includeFontPadding = false }
        val sub = text("", 11.5f, subColor).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        tile.addView(number, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = px(18); topMargin = px(18) })
        tile.addView(sub, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = px(18); topMargin = px(60) })
        return number to sub
    }

    /** A large tile's name, top right, and how it stands under it. */
    private fun corner(tile: FrameLayout, name: String, nameColor: Int, subColor: Int): TextView {
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.END }
        words.addView(text(name, 14f, nameColor, bold = true).apply { gravity = Gravity.END })
        val sub = text("", 11.5f, subColor).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.END }
        words.addView(sub, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(1) })
        tile.addView(words, FrameLayout.LayoutParams(px(150), WRAP_CONTENT, Gravity.END).apply { rightMargin = px(18); topMargin = px(18) })
        return sub
    }

    /** A small tile: its object, how it stands at the top right, and what it is under them. */
    private fun small(thing: Thing, name: String, onTouch: () -> Unit): Small {
        val tile = FrameLayout(this).apply {
            background = flat(R.color.tile, 30, alpha = 215)
            setOnClickListener { onTouch() }
        }
        tile.addView(thing, FrameLayout.LayoutParams(px(44), px(44)).apply { leftMargin = px(16); topMargin = px(16) })
        val state = text("", 11f, R.color.ink_3).apply { maxLines = 1 }
        tile.addView(state, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.END).apply { rightMargin = px(16); topMargin = px(16) })
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = text(name, 14f, R.color.ink, bold = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        val sub = text("", 11.5f, R.color.ink_2).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        words.addView(title)
        words.addView(sub, spaced(top = 1))
        tile.addView(words, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = px(16); rightMargin = px(12); bottomMargin = px(14) })
        return Small(tile, state, title, sub, thing)
    }

    /** The models tile: its three objects, and how many models are here. */
    private fun modelsTile(): View = FrameLayout(this).apply {
        background = flat(R.color.tile, 30, alpha = 215)
        setOnClickListener { open(modelsBox) }
        addView(text("模型管理", 14f, R.color.ink, bold = true), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = px(18); topMargin = px(16) })
        val things = LinearLayout(this@MainActivity)
        for (kind in listOf(Thing.Kind.WATER, Thing.Kind.PANES, Thing.Kind.NOTE)) things.addView(Thing(this@MainActivity, kind), LinearLayout.LayoutParams(px(34), px(34)).apply { rightMargin = px(10) })
        addView(things, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = px(18); topMargin = px(46) })
        modelsSub = text("", 11.5f, R.color.ink_2)
        addView(modelsSub, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = px(18); bottomMargin = px(14) })
        minimumHeight = px(SMALL_HEIGHT)
    }

    // ── The panels ──────────────────────────────────────────────────────────────────────────────────────────────

    /** A panel: a large rounded sheet with a grip, what it is, and its contents. Opened, it comes up from the foot. */
    private fun box(name: String, about: String, contents: View): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            isClickable = true
            background = flat(R.color.tile, 32)
            elevation = px(12f)
            setPadding(0, px(10), 0, 0)
        }
        box.addView(View(this).apply { background = flat(R.color.switch_off, 2) }, LinearLayout.LayoutParams(px(36), px(4)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        val head = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(22), px(14), px(22), px(4)) }
        head.addView(text(name, 19f, R.color.ink, bold = true))
        head.addView(text(about, 12.5f, R.color.ink_2), spaced(top = 3))
        box.addView(head)
        val inside = ScrollView(this).apply { isVerticalScrollBarEnabled = false; addView(contents) }
        box.addView(inside, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        return box
    }

    private fun open(which: View) {
        if (opened === which) return
        close(at = false)
        // Still on its way out, from a close a moment ago: taken off the page now, as it was before it opened.
        which.animate().cancel()
        (which.parent as? ViewGroup)?.removeView(which)
        which.translationY = 0f
        val inside = (which as ViewGroup).getChildAt(2)
        inside.layoutParams = (inside.layoutParams as LinearLayout.LayoutParams).apply { height = WRAP_CONTENT }
        val shade = View(this).apply {
            setBackgroundColor(getColor(R.color.scrim))
            setOnClickListener { close() }
            alpha = 0f
        }
        page.addView(shade, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        val room = page.height - bars.top - bars.bottom
        page.addView(which, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply {
            leftMargin = px(8); rightMargin = px(8); bottomMargin = bars.bottom + px(8)
        })
        // A panel no higher than the room: its contents scroll inside.
        inside.post {
            // Not laid out yet (a panel asked for before the first layout): as high as it is.
            if (room <= 0) return@post
            val most = maxOf(px(160), (room * 0.86f).toInt() - (which.height - inside.height))
            if (inside.height > most) inside.layoutParams = (inside.layoutParams as LinearLayout.LayoutParams).apply { height = most }
        }
        opened = which
        scrim = shade
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCloses as OnBackInvokedCallback)
        shade.animate().alpha(1f).setDuration(220).start()
        which.translationY = page.height.toFloat()
        which.animate().translationY(0f).setDuration(420).setInterpolator(OvershootInterpolator(0.8f)).start()
        refresh()
    }

    /** Closes the panel that is open: at once where another opens in its place. */
    private fun close(at: Boolean = true) {
        val which = opened ?: return
        val shade = scrim
        opened = null
        scrim = null
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.unregisterOnBackInvokedCallback(backCloses as OnBackInvokedCallback)
        if (!at) { page.removeView(which); page.removeView(shade); return }
        shade?.animate()?.alpha(0f)?.setDuration(200)?.withEndAction { page.removeView(shade) }?.start()
        which.animate().translationY(page.height.toFloat()).setDuration(240).setInterpolator(AccelerateInterpolator()).withEndAction {
            page.removeView(which)
            which.translationY = 0f
        }.start()
    }

    /** A key of a panel: the main one, in the coral of the switch, or a quiet one. */
    private fun key(words: String, main: Boolean, onTouch: () -> Unit) = text(words, 14.5f, if (main) R.color.tile else R.color.ink, bold = true).apply {
        gravity = Gravity.CENTER
        background = if (main) flat(R.color.key, 18) else flat(R.color.dial, 18, edge = R.color.dial_edge)
        setPadding(px(16), 0, px(16), 0)
        setOnClickListener { onTouch() }
    }

    /**
     * The models, in three short groups by what they are lent for, each under a small heading. The recognizer that is
     * lent is marked; a touch on another that is here lends that one instead. The text models are all lent, so a
     * touch on one does nothing.
     */
    private fun modelsContent(): View {
        val models = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(14), px(4), px(14), px(18))
        }
        rule = text("", 11.5f, R.color.ink_2)
        for (task in Task.values()) {
            models.addView(
                text(TASK_NAMES.getValue(task), 12f, R.color.ink_3, bold = true).apply { letterSpacing = 0.06f },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(if (task == Task.HEAR) 10 else 18); leftMargin = px(10) },
            )
            for (model in ALL_MODELS.filter { it.task == task }) {
                val row = LinearLayout(this).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    minimumHeight = px(58)
                    setPadding(px(10), px(6), px(4), px(6))
                    setOnClickListener { if (model in choices.lendable(store) && busy == null && !Sharing.on) { choices.share(model); lastVerdict = null; refresh() } }
                }
                val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                val state = text("", 12f, R.color.ink_2)
                words.addView(text(model.name, 15f, R.color.ink, bold = true))
                words.addView(state, spaced(top = 2))
                val act = key("下载", main = false) { if (busy == null) fetch(model) else if (busy === model) halt() }
                row.addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = px(8) })
                row.addView(act, LinearLayout.LayoutParams(WRAP_CONTENT, px(36)))
                models.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(2) })
                rows[model] = Row(row, state, act)
            }
            // Under the recognizers, how the one that is lent comes to be it.
            if (task == Task.HEAR) models.addView(rule, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(4); leftMargin = px(10); rightMargin = px(6) })
        }
        return models
    }

    /** The performance panel: the check and its report; a newer version of the app, and the key that asks for one. */
    private fun toolsContent(): View {
        val tools = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(22), px(12), px(22), px(20))
        }
        // A newer version, when there is one: first in the panel, and not there otherwise.
        updateRow = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = flat(R.color.field_apricot, 18)
            setPadding(px(14), px(10), px(10), px(10))
            val words = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            updateTitle = text("", 15f, R.color.ink, bold = true)
            updateState = text("", 12f, R.color.ink_2)
            words.addView(updateTitle)
            words.addView(updateState, spaced(top = 2))
            updateAct = key("更新", main = true) { release?.let(::touched) }
            addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = px(10) })
            addView(updateAct, LinearLayout.LayoutParams(WRAP_CONTENT, px(36)))
        }
        tools.addView(updateRow, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = px(14) })

        checkState = text("", 13.5f, R.color.ink).apply { setLineSpacing(0f, 1.15f) }
        tools.addView(checkState)
        checkBar = Bar(this)
        tools.addView(checkBar, spaced(top = 12))
        checkKey = key("", main = true) { if (busy == "check") halt() else if (busy == null && !Sharing.on) check() }
        tools.addView(checkKey, LinearLayout.LayoutParams(MATCH_PARENT, px(48)).apply { topMargin = px(14) })

        // The report: kept shut, it is long and only wanted when asked for, or to send.
        val keys = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        reportKey = key("", main = false) { reportOpen = !reportOpen; refresh() }
        share = key("分享报告", main = false) { lastReport?.let(::send) }
        keys.addView(reportKey, LinearLayout.LayoutParams(0, px(40), 1f))
        keys.addView(share, LinearLayout.LayoutParams(0, px(40), 1f).apply { leftMargin = px(10) })
        tools.addView(keys, spaced(top = 10))
        report = text("", 11.5f, R.color.ink).apply {
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setLineSpacing(0f, 1.2f)
        }
        tools.addView(report, spaced(top = 10))

        // The app's own version, and the key that asks for a newer one.
        val version = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        version.addView(text("Kotomimi 手机端 ${BuildConfigLite.VERSION}", 12.5f, R.color.ink_2), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        lookKey = key("", main = false) { look(asked = true) }
        version.addView(lookKey, LinearLayout.LayoutParams(WRAP_CONTENT, px(34)))
        tools.addView(version, spaced(top = 18))
        return tools
    }

    /** The computer's side: where this phone is, how a computer finds it, which one used it last, and staying awake. */
    private fun devicesContent(): View {
        val devices = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(22), px(12), px(22), px(20))
        }
        address = text("", 20f, R.color.ink, bold = true)
        devices.addView(address)
        devices.addView(text("在电脑端 Kotomimi 的「另一台设备」中点击搜索，即可找到这台手机。两台设备需连接同一个 Wi-Fi。", 13f, R.color.ink_2).apply { setLineSpacing(0f, 1.2f) }, spaced(top = 8))
        lastComputer = text("", 13f, R.color.ink)
        devices.addView(lastComputer, spaced(top = 14))
        // Where the phone may still be stopped in the background: the one place to let it run.
        stay = key("", main = false) { letRun() }
        devices.addView(stay, LinearLayout.LayoutParams(MATCH_PARENT, px(44)).apply { topMargin = px(16) })
        return devices
    }

    // ── How things stand ────────────────────────────────────────────────────────────────────────────────────────

    /** The screen as things stand. A check or a download in hand writes its own lines over this as it goes. */
    private fun refresh() {
        val here = ALL_MODELS.filter { store.has(it) }
        val lendable = choices.lendable(store)
        val lent = choices.shared(store)
        val lentText = choices.lendableText(store)
        val sharing = Sharing.state
        val shared = Sharing.on
        val phase = sharing.phase
        val (_, free) = device.memory()
        val recently = sharing.seen != null && System.currentTimeMillis() - sharing.seenAt < RECENT_MS

        // What the large tile is for: the work in hand, else the last done, else what is lent first.
        val done = Task.values().map { it to Sharing.work(it) }
        val focus = when {
            phase == Share.Phase.WORKING && sharing.task != null -> sharing.task
            done.any { it.second.count > 0 } -> done.maxBy { it.second.at }.first
            lent != null -> Task.HEAR
            lentText.any { it.task == Task.TRANSLATE } -> Task.TRANSLATE
            lentText.isNotEmpty() -> Task.COACH
            else -> Task.HEAR
        }
        val work = Sharing.work(focus)
        val atWork = phase == Share.Phase.WORKING && sharing.task == focus

        // The wallpaper: its colour, its pace, and an answer to each piece of work done since it was last drawn.
        wall.moodFor(if (!shared) Mood.IDLE else when (focus) { Task.HEAR -> Mood.HEAR; Task.TRANSLATE -> Mood.TRANSLATE; Task.COACH -> Mood.COACH })
        wall.pace = when (phase) { Share.Phase.WORKING -> 1f; Share.Phase.WAITING, Share.Phase.LOADING -> 0.6f; else -> 0.3f }
        for ((task, w) in done) {
            val before = seen[task] ?: w.count
            if (w.count > before && shown) {
                val at = IntArray(2).also { stage.getLocationInWindow(it) }
                wall.pulse(task, at[0] + stage.width / 2f, at[1] + stage.height / 2f)
                if (task == focus) arrive()
            }
            seen[task] = w.count
        }

        // The status.
        word.text = when (phase) {
            Share.Phase.OFF -> "READY"
            Share.Phase.LOADING -> "LOADING"
            Share.Phase.WAITING -> "STANDBY"
            Share.Phase.FAILED -> "ERROR"
            Share.Phase.WORKING -> when (sharing.task) { Task.TRANSLATE -> "TRANSLATING"; Task.COACH -> "REVIEWING"; else -> "LISTENING" }
        }
        val speed = speedOf(Sharing.work(Task.HEAR))
        when {
            !engine.present -> big("不可用")
            phase == Share.Phase.OFF -> big("未启用")
            phase == Share.Phase.LOADING -> big("启动中")
            phase == Share.Phase.FAILED -> big("未能启用")
            // Hearing has its speed in its tile: above it, how long the phone has been lent, as a desktop says screen time.
            focus == Task.HEAR && speed != null -> lentFor()
            focus == Task.TRANSLATE && work.count > 0 -> big("${work.count}", "句")
            focus == Task.COACH && work.count > 0 -> big("${work.count}", "句已批改")
            else -> big("待命")
        }
        from.text = when {
            !engine.present -> "这个安装包缺少运行引擎。"
            here.isEmpty() -> "尚未下载模型。请先在「模型管理」中下载。"
            phase == Share.Phase.OFF -> "启用共享后，电脑即可在局域网中找到这台手机。"
            phase == Share.Phase.LOADING -> "正在加载 ${sharing.model?.name.orEmpty()}"
            phase == Share.Phase.FAILED -> sharing.message.orEmpty()
            phase == Share.Phase.WORKING -> when (sharing.task) {
                Task.TRANSLATE -> listOfNotNull(work.into?.let { "译为$it" } ?: "正在翻译", sharing.peer?.let { "来自 $it" }).joinToString(" · ")
                Task.COACH -> listOfNotNull("正在批改", sharing.peer?.let { "来自 $it" }).joinToString(" · ")
                else -> listOfNotNull("正在识别", sharing.peer?.let { "来自 $it" }).joinToString(" · ")
            }
            recently -> "待命 · 最近连接 ${sharing.seen}"
            else -> "等待电脑连接" + sharing.address?.let { " · 本机 $it" }.orEmpty()
        }

        // The share tile.
        switch.on = shared
        shareTitle.text = when (phase) { Share.Phase.LOADING -> "正在启动"; Share.Phase.OFF, Share.Phase.FAILED -> "启用共享"; else -> "共享中" }
        shareSub.text = when {
            shared && sharing.address != null -> "本机 ${sharing.address}"
            shared -> "这台手机未连接 Wi-Fi"
            lent == null && lentText.isEmpty() -> "请先下载一个模型"
            else -> "将这台手机上的模型提供给电脑使用"
        }

        // The large tile, while lent.
        stage.visibility = if (shared) View.VISIBLE else View.GONE
        hearTile.visibility = if (focus == Task.HEAR) View.VISIBLE else View.GONE
        glassTile.visibility = if (focus == Task.TRANSLATE) View.VISIBLE else View.GONE
        paperTile.visibility = if (focus == Task.COACH) View.VISIBLE else View.GONE
        water.running = shown && shared && focus == Task.HEAR
        water.moving = atWork
        val modelOf = { task: Task -> if (task == Task.HEAR) lent else lentText.firstOrNull { it.task == task } }
        val stateOf = { task: Task -> if (phase == Share.Phase.WORKING && sharing.task == task) "工作中" else "待命" }
        when (focus) {
            Task.HEAR -> {
                hearNumber.text = speed?.let { unit("%.1f".format(it), " 倍速") } ?: "—"
                hearSub.text = when { speed == null -> "等待第一段语音"; speed >= 1.0 -> "快于说话速度，可实时识别"; else -> "慢于说话速度，会有延迟" }
                hearModel.text = listOfNotNull(stateOf(Task.HEAR), modelOf(Task.HEAR)?.name).joinToString(" · ")
                heardLast.text = work.answer.orEmpty()
                water.level = ((speed ?: 0.6) / 2.0).coerceIn(0.25, 1.0).toFloat() * 0.5f
            }
            Task.TRANSLATE -> {
                glassNumber.text = if (work.count > 0) unit("%.1f".format(work.lastMs / 1000.0), " 秒 · 上一句") else "—"
                glassSub.text = modelOf(Task.TRANSLATE)?.name.orEmpty()
                glassState.text = stateOf(Task.TRANSLATE)
                paneBack.text = work.said ?: "原文将显示在这里"
                paneFront.text = work.answer ?: "译文将显示在这里"
            }
            Task.COACH -> {
                paperNumber.text = if (work.count > 0) unit("%.1f".format(work.lastMs / 1000.0), " 秒 · 上一句") else "—"
                paperSub.text = modelOf(Task.COACH)?.name.orEmpty()
                paperState.text = stateOf(Task.COACH)
                val lines = work.answer?.lines()?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
                val fine = lines.firstOrNull() == "✓"
                paperSaid.text = work.said ?: "等待第一句"
                paperSaid.paintFlags = if (!fine && lines.isNotEmpty()) paperSaid.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG else paperSaid.paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
                paperFix.text = if (fine) "没有问题" else lines.firstOrNull().orEmpty()
                paperWhy.text = lines.drop(1).joinToString(" ")
            }
        }

        // The other two kinds of work, while lent.
        workRow.removeAllViews()
        workRow.visibility = if (shared) View.VISIBLE else View.GONE
        if (shared) {
            Task.values().filter { it != focus }.forEachIndexed { i, task ->
                val tile = works.getValue(task)
                workRow.addView(tile.view, LinearLayout.LayoutParams(0, px(SMALL_HEIGHT), 1f).apply { if (i > 0) leftMargin = px(12) })
                val model = modelOf(task)
                val downloaded = ALL_MODELS.any { it.task == task && store.has(it) }
                tile.sub.text = model?.name ?: if (downloaded) "内存不足" else "未下载"
                tile.state.text = if (model == null) "不可用" else stateOf(task)
                tile.state.setTextColor(getColor(if (model != null && stateOf(task) == "工作中") R.color.good else R.color.ink_3))
            }
        }

        // The computer's side, the check, the models.
        lens.thing.lit = shared && recently
        lens.state.text = if (shared && recently) "在用" else ""
        lens.state.setTextColor(getColor(R.color.good))
        lens.sub.text = when { !shared -> "未启用"; recently -> sharing.seen.orEmpty(); else -> "尚无电脑连接" }
        val found = checkedSpeed ?: lent?.let(choices::speedOf)
        dial.thing.amount = ((found ?: 0.0) / 3.0).toFloat()
        dial.state.text = found?.let { "%.1f×".format(it) }.orEmpty()
        dial.state.setTextColor(getColor(if ((found ?: 0.0) >= 1.0) R.color.good else R.color.ink_red))
        dial.sub.text = when {
            busy == "check" -> "检测中 ${(checked * 100).toInt()}%"
            found == null -> "尚未检测"
            found >= 1.0 -> "可流畅使用"
            else -> "可能跟不上说话"
        }
        modelsSub.text = if (here.isEmpty()) "尚未下载模型" else "已下载 ${here.size} 个模型"

        // The models panel.
        for ((model, row) in rows) {
            val begun = store.begun(model)
            val isText = model.task != Task.HEAR
            // A text model this phone could not hold says so in its row, and is not offered for download: it is
            // three gigabytes that would lie there for nothing. One it holds, but not now, beside what is open.
            val tooLarge = isText && !choices.fits(model)
            val tight = isText && !tooLarge && store.has(model) && !shared && model.holdsMb > free
            // The second engine's row of a model that has two is offered only once it is here: to the person they
            // are one model, and the check, not they, decides between the two.
            row.view.visibility = if (model.twin && model.reader == Reader.LLAMA_CPP && !store.has(model) && busy !== model) View.GONE else View.VISIBLE
            row.view.background = if (model === lent && lendable.size > 1) lentMark else null
            if (busy !== model) {
                // What a row is good for, where that is known; for a model in two rows, which of the two it is.
                val whose = model.note ?: twinWords(model)
                row.state.text = when {
                    tooLarge -> listOfNotNull("已下载".takeIf { store.has(model) }, model.sizeInWords, "这台手机内存不足")
                    tight -> listOfNotNull("已下载", model.sizeInWords, "当前可用内存不足，请关闭其他应用")
                    store.has(model) -> if (model === lent && lendable.size > 1) listOfNotNull("正在使用", whose) else listOfNotNull("已下载", whose, model.sizeInWords)
                    begun > 0 -> listOfNotNull(whose, "已下载 ${percent(begun, model.bytes)}，可继续")
                    else -> listOfNotNull(whose, model.sizeInWords)
                }.joinToString(" · ")
                row.act.text = if (begun > 0 && !store.has(model)) "继续" else "下载"
                row.act.alpha = if (busy == null) 1f else 0.4f
            }
            row.act.visibility = if (store.has(model) || (tooLarge && busy !== model)) View.GONE else View.VISIBLE
        }
        rule.visibility = if (lendable.size > 1) View.VISIBLE else View.GONE
        rule.text = if (choices.chosen(store) != null) "正在使用你选择的识别模型。点击其他模型即可切换。" else "未手动选择时，按性能检测的结果选用跟得上说话的模型中最准确的一个。"

        // The performance panel.
        checkKey.text = if (busy == "check") "停止检测" else if (lastReport == null) "开始检测" else "重新检测"
        checkKey.alpha = if (busy == "check" || (busy == null && !shared && here.isNotEmpty() && engine.present)) 1f else 0.45f
        if (busy != "check") {
            checkState.text = when {
                shared -> "共享期间无法检测，请先停止共享。"
                lastVerdict != null -> "${lastVerdict!!.first} · ${lastVerdict!!.second}"
                here.isEmpty() -> "请先下载至少一个模型。"
                else -> "用一段固定录音测试识别速度，检测期间请勿操作手机，约需数分钟。"
            }
        }
        checkBar.visibility = if (busy == "check") View.VISIBLE else View.GONE
        checkBar.done = checked
        reportKey.visibility = if (lastReport == null) View.GONE else View.VISIBLE
        share.visibility = reportKey.visibility
        reportKey.text = if (reportOpen) "收起报告" else "查看报告"
        report.text = lastReport.orEmpty()
        report.visibility = if (lastReport != null && reportOpen) View.VISIBLE else View.GONE

        // The devices panel.
        address.text = if (shared) sharing.address?.let { "本机 $it" } ?: "这台手机未连接 Wi-Fi" else "共享未启用"
        lastComputer.text = sharing.seen?.let { "最近连接的电脑：$it · ${ago(sharing.seenAt)}" } ?: if (shared) "尚无电脑连接。" else "启用共享后，电脑才能找到这台手机。"
        val runs = mayRun()
        stay.visibility = if (!runs || FREEZING_MAKERS.any { Build.MANUFACTURER.lowercase().contains(it) }) View.VISIBLE else View.GONE
        stay.text = if (!runs) "允许在后台运行，避免锁屏后断开" else "前往系统设置，允许在后台运行"

        showUpdate()
        if (busy == null) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** How long the phone has been lent: minutes, or hours with the minutes after them. */
    private fun lentFor() {
        val minutes = ((System.currentTimeMillis() - Sharing.since) / 60_000).coerceAtLeast(0)
        if (minutes < 60) big("$minutes", "分钟") else big("${minutes / 60}", "小时 ${minutes % 60} 分钟")
    }

    /** The large number and its unit; a word on its own is set smaller, as Chinese at the number's size is heavy. */
    private fun big(number: String, unit: String = "") {
        bigNumber.text = number
        bigNumber.textSize = if (number.any { it.isDigit() }) 60f else 42f
        bigUnit.text = unit
    }

    /** A number with its unit after it, small, as a large tile writes it. */
    private fun unit(number: String, unit: String): CharSequence =
        SpannableString(number + unit).apply { setSpan(RelativeSizeSpan(0.36f), number.length, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }

    /** A new piece of work in the large tile: its front pane or its sheet comes in from a little below. */
    private fun arrive() {
        for (view in listOf(paneFront, sheet, heardLast)) {
            view.translationY = px(10f)
            view.alpha = 0.3f
            view.animate().translationY(0f).alpha(1f).setDuration(380).setInterpolator(OvershootInterpolator(1.4f)).start()
        }
    }

    /** How far ahead of speech recognition keeps, from what it has read: null before anything was read. */
    private fun speedOf(work: Work): Double? = if (work.spentMs <= 0 || work.soundMs <= 0) null else work.soundMs.toDouble() / work.spentMs

    /** For a model in two rows — the same model for each engine —, which of the two this is; null for any other. */
    private fun twinWords(model: Model): String? = if (!model.twin) null else if (model.reader == Reader.AUDIO_CPP) "GPU 版" else "CPU 版"

    private fun ago(at: Long): String {
        val seconds = (System.currentTimeMillis() - at) / 1000
        return when {
            seconds < 60 -> "刚刚"
            seconds < 3600 -> "${seconds / 60} 分钟前"
            else -> "${seconds / 3600} 小时前"
        }
    }

    /** The newer version's pill on the page and its row in the panel. Its download writes its own lines over this. */
    private fun showUpdate() {
        // A test's address is said on the key: it is not to be left behind unseen.
        lookKey.text = lookWords ?: if (testing) "检查更新 · 测试" else "检查更新"
        val offered = release
        updateRow.visibility = if (offered == null) View.GONE else View.VISIBLE
        updatePill.visibility = updateRow.visibility
        if (offered == null) return
        updateTitle.text = "新版本 ${offered.version}"
        updatePill.text = "新版本 ${offered.version}"
        if (busy === offered) return
        val here = updater.has(offered)
        val begun = updater.begun(offered)
        updateState.text = updateWords ?: when {
            installing -> "已交给系统安装，请稍候"
            sentToAllow && !updater.allowed() -> "需要先允许本应用安装应用"
            // Installing ends the app, and what it is lent for with it.
            here && Sharing.on -> "已下载 · 安装将停止共享"
            here -> "已下载"
            begun > 0 -> "已下载 ${percent(begun, offered.bytes)}，可继续"
            else -> listOf(offered.notes, offered.sizeInWords).filter { it.isNotBlank() }.joinToString(" · ")
        }
        updateAct.text = if (here) "安装" else if (begun > 0) "继续" else "更新"
        updateAct.alpha = if (busy == null && !installing) 1f else 0.4f
    }

    // ── What it does ────────────────────────────────────────────────────────────────────────────────────────────

    /** Lends the phone: the model that is chosen (or, asked from a computer, `named`), the way the self-check found fastest. */
    private fun lend(named: Model? = null, llamaBuild: String? = null) {
        // No recognizer to lend: the phone is lent with its text models alone, where it has any.
        val model = named?.takeIf { it in choices.lendable(store) } ?: choices.shared(store)
        if (model == null && choices.lendableText(store).isEmpty()) { open(modelsBox); return }
        if (!engine.present || busy != null || Sharing.on) return
        // The notification that says the phone is lent: asked for once, and lent whatever the answer.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        lastVerdict = null
        ShareService.start(this, model, llamaBuild)
        // Asked once, the first time the phone is lent: a phone the system may put to sleep stops answering when it
        // has lain locked a while (2026-10-20). The answer, either way, is the system's to keep.
        val asked = getSharedPreferences("stay", MODE_PRIVATE)
        if (!mayRun() && !asked.getBoolean("asked", false)) {
            asked.edit().putBoolean("asked", true).apply()
            letRun()
        }
    }

    /** Whether the system lets the app run on with the screen locked: not held back to save the battery. */
    private fun mayRun(): Boolean = (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    /**
     * Where the phone is let run in the background: the system's question for this app, or — asked already, or a
     * maker whose own power saving stops apps all the same (ColorOS, MIUI, …) — the app's own page in the settings,
     * where those makers keep the switch.
     */
    private fun letRun() {
        val ask = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        val page = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        runCatching { startActivity(if (mayRun()) page else ask) }.recoverCatching { startActivity(page) }
    }

    private fun check(startWith: Llama.Build? = null, force: Set<String> = emptySet()) {
        if (busy != null || !engine.present || ALL_MODELS.none { store.has(it) } || Sharing.on) return
        begin("check")
        // Every run is waited for with the phone cooling: it takes a good while, and says at each step what it is at.
        checked = 0f
        checkState.text = "正在检测，请勿操作手机，约需数分钟。"
        refresh()
        worker.execute {
            val result = runCatching {
                SelfCheck(this, engine, llama, store).run(
                    onStep = { done, of, words ->
                        main.post {
                            checkState.text = "正在检测 ${minOf(done + 1, of)}/$of：$words"
                            checked = if (of == 0) 0f else done.toFloat() / of
                            checkBar.done = checked
                            dial.sub.text = "检测中 ${(checked * 100).toInt()}%"
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
                        checkedSpeed = done.lending?.lent?.speed
                        // What is said is about lending the phone: the model it is lent with, by its size, and which
                        // of its two rows where it has two. Where no recognizer was checked, the first text model
                        // speaks: what it is for, and how long it takes.
                        lastVerdict = done.texts.takeIf { done.models.isEmpty() }?.firstNotNullOfOrNull { it.words } ?: (done.verdict.words to (done.lending?.let { of ->
                            of.lent?.speed?.let { listOfNotNull(of.model.size, twinWords(of.model), "${"%.1f".format(it)} 倍速").joinToString(" · ") }
                        } ?: "详见检测报告"))
                    }
                }.onFailure { error ->
                    lastVerdict = "检测未完成" to (error.message ?: error.javaClass.simpleName)
                }
                refresh()
            }
        }
    }

    private fun fetch(model: Model) {
        begin(model)
        val row = rows.getValue(model)
        row.act.text = "停止"
        refresh()
        row.act.alpha = 1f
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
                            row.state.text = if (now.from.isBlank()) "${which}正在选择最快的下载地址" else "$which${percent(now.had, model.bytes)} · ${speed(now.perSecond)} · ${now.from}"
                            row.act.alpha = 1f
                        }
                    },
                    onChecking = { main.post { row.state.text = "正在校验"; row.act.alpha = 0.4f } },
                    stopped = stop::get,
                )
            }
            main.post {
                busy = null
                refresh()
                result.onFailure { error -> row.state.text = "下载失败：${error.message ?: error.javaClass.simpleName}" }
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
        if (asked) { lookAsked = true; lookWords = "正在检查"; refresh() }
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
                val tell = if (!lookAsked) null else if (result.isFailure) "连接失败，请稍后再试" else if (result.getOrNull() == null) "已是最新版本" else null
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
                            updateState.text = if (from.isBlank()) "正在选择最快的下载地址" else "${percent(had, offered.bytes)} · ${speed(perSecond)} · $from"
                            updateAct.alpha = 1f
                        }
                    },
                    onChecking = { main.post { updateState.text = "正在校验"; updateAct.alpha = 0.4f } },
                    stopped = stop::get,
                )
            }
            main.post {
                busy = null
                result.onFailure { error -> updateWords = "下载失败：${error.message ?: error.javaClass.simpleName}" }
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
            Toast.makeText(this, "请打开此开关，然后返回", Toast.LENGTH_LONG).show()
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }.onFailure {
                // A system without that screen under this name: the person finds it by hand.
                updater.sentToAllow = false
                updateWords = "请在系统设置中允许本应用安装应用"
            }
            refresh()
            return
        }
        installing = true
        handed++
        refresh()
        thread(name = "install") {
            val result = runCatching { updater.install(offered) }
            main.post {
                result.onFailure { error ->
                    installing = false
                    updateWords = "安装失败：${error.message ?: error.javaClass.simpleName}"
                    refresh()
                }
            }
        }
    }

    /** What the system said of the install it was handed (`InstallReceiver`). */
    private fun answered() {
        val told = Installing.take() ?: return
        installing = false
        confirming = false
        confirmShown = false
        when (told.status) {
            // It wants the person's word, and gives the screen of its own that asks for it. The package stays with
            // the system while it asks, and while it installs after a yes.
            PackageInstaller.STATUS_PENDING_USER_ACTION ->
                runCatching { startActivity(told.confirm!!) }
                    .onSuccess { installing = true; confirming = true }
                    .onFailure { error -> updateWords = "安装失败：${error.message ?: error.javaClass.simpleName}" }
            // The person said no: the package stays, for when they say yes. (A yes is not heard here: the app is ended
            // to be replaced.) The same word comes when the phone's own guard said no in their place — Google Play
            // Protect did, the first time, on the emulator this was tried on (2026-10-13): that much is said.
            PackageInstaller.STATUS_FAILURE_ABORTED, PackageInstaller.STATUS_SUCCESS ->
                updateWords = if (told.message?.contains("VERIFICATION") == true) "安装失败：被手机的安全检查拦截" else null
            else -> {
                updateWords = "安装失败：${Updater.reasonOf(told.status, told.message)}"
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

    private fun text(words: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = words
        textSize = size
        setTextColor(getColor(color))
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun spaced(top: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(top) }

    private companion object {
        /** The page's own margins, in dp, inside whatever the system's bars take. */
        const val PAGE_SIDE = 16
        const val PAGE_TOP = 8
        const val PAGE_FOOT = 24

        /** The large tile's height and a small tile's, in dp. */
        const val STAGE_HEIGHT = 214
        const val SMALL_HEIGHT = 128

        /** Each kind of work by its full name, as the panels and tiles say it. */
        val TASK_NAMES = mapOf(Task.HEAR to "语音识别", Task.TRANSLATE to "文本翻译", Task.COACH to "语法反馈")

        /**
         * Phone makers whose own power saving stops an app in the background though it shows a notification and
         * Android lets it run: their switch is on the app's own page. Matched against `Build.MANUFACTURER`.
         */
        val FREEZING_MAKERS = listOf("oppo", "realme", "oneplus", "xiaomi", "redmi", "vivo", "iqoo", "huawei", "honor", "meizu")

        /** How long after its last request a computer is still said to be using the phone. */
        const val RECENT_MS = 120_000L

        /** How long the small key says how asking for a newer version went, before it is the key again. */
        const val LOOK_WORDS_MS = 4_000L

        /** How long the system is given to install after its question went away, before the row can be touched again: it took ten seconds on a slow phone. */
        const val SYSTEM_INSTALLS_MS = 45_000L

        /** The system's refusals that asking again would not change. */
        val NEVER_TAKEN = setOf(PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, PackageInstaller.STATUS_FAILURE_INVALID)
    }

    private fun percent(had: Long, of: Long) = "${had * 100 / of}%"

    private fun speed(perSecond: Long) = if (perSecond >= 1024 * 1024) "%.1f MB/秒".format(perSecond / (1024.0 * 1024.0)) else "${perSecond / 1024} KB/秒"
}
