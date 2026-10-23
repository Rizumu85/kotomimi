package io.github.rizumu85.kotomimi.node

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
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
 * The phone side's one screen, in the look the user settled on (`Look.kt`): the phone drawn as a recorder — a mint
 * body with a dark screen that says what is going on, the model card in its slot, and the coral power key that lends
 * the phone — and under it two widgets, "connect a device" and the self-check's toolbox. The models, the computer's
 * side and the self-check each open as a box over the page (`open`), which itself never grows.
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
    private lateinit var room: Room
    private lateinit var page: FrameLayout
    private lateinit var updatePill: TextView
    private lateinit var screenLabel: TextView
    private lateinit var led: Led
    private lateinit var title: TextView
    private lateinit var sub: TextView
    private lateinit var dots: Dots
    private lateinit var cardName: TextView
    private lateinit var cardSub: TextView
    private lateinit var keyLabel: TextView
    private lateinit var power: PowerKey
    private lateinit var laptop: Laptop
    private lateinit var deviceSub: TextView
    private lateinit var toolSub: TextView

    // The boxes, made once and laid over the page when opened.
    private lateinit var modelsBox: View
    private lateinit var toolsBox: View
    private lateinit var devicesBox: View
    private var opened: View? = null
    private var scrim: View? = null
    /** The back key or gesture, while a box is open: it closes the box (Android 13 on; before, `onBackPressed`). */
    private val backCloses: Any? = if (Build.VERSION.SDK_INT >= 33) OnBackInvokedCallback { close() } else null

    // In the models box.
    private lateinit var rule: TextView
    private val rows = HashMap<Model, Row>()
    /** The lent row's mark: made once, since the screen is redrawn every time sharing says how it stands. */
    private val lentMark by lazy { flat(R.color.box_pale, 16) }

    // In the toolbox.
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

    // In the devices box.
    private lateinit var address: TextView
    private lateinit var lastComputer: TextView
    private lateinit var stay: TextView

    private lateinit var updater: Updater

    /** A model's row in the models box: the whole row (to mark the one lent, and to hide), what it says, and its key. */
    private class Row(val view: View, val state: TextView, val act: TextView)

    /** What this screen's own worker is doing: nothing, a check, or the download of one model or of a newer version. */
    private var busy: Any? = null
    private var lastReport: String? = null
    private var lastVerdict: Pair<String, String>? = null
    /** How far the self-check under way has come, of one. */
    private var checked = 0f

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
     * With --ez update true it asks whether there is a newer version, as the toolbox's key does. (Where it asks is not
     * to be told this way: `Updater.testAddress`.) With --es open models (or tools, devices) that box is opened, and
     * with --es open none whatever is open is closed: for screenshots.
     */
    private fun asked(intent: Intent) {
        if (intent.getBooleanExtra("update", false)) look(asked = true)
        if (intent.getBooleanExtra("selfcheck", false)) {
            check(Llama.Build.values().firstOrNull { it.words == intent.getStringExtra("llama") }, intent.getStringExtra("force")?.split(',')?.map { it.trim() }?.toSet().orEmpty())
        }
        if (intent.getBooleanExtra("share", false)) lend(MODELS.firstOrNull { it.id == intent.getStringExtra("model") }, intent.getStringExtra("llama"))
        else if (intent.hasExtra("share") && Sharing.on) ShareService.stop(this)
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
        // Nothing moves on a screen nobody sees: `refresh` sets it going again.
        room.working = false
        dots.show(Dots.Mode.OFF)
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

    /** The back key closes an open box first. */
    @Deprecated("The platform's own, kept for the versions before predictive back.")
    override fun onBackPressed() {
        if (opened != null) close() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ── The page ────────────────────────────────────────────────────────────────────────────────────────────────

    private fun build(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(PAGE_SIDE), px(PAGE_TOP), px(PAGE_SIDE), px(PAGE_FOOT))
        }

        // The name, and — only when there is one — the newer version, which opens the toolbox where it is fetched.
        val head = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; minimumHeight = px(40) }
        head.addView(text("KOTOMIMI", 17f, R.color.screen, bold = true).apply { letterSpacing = 0.18f }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        updatePill = text("", 13f, R.color.tile, bold = true).apply {
            gravity = Gravity.CENTER
            background = faced(R.color.key, R.color.key_deep, 16, 2)
            setPadding(px(14), 0, px(14), px(2))
            setOnClickListener { open(toolsBox) }
        }
        head.addView(updatePill, LinearLayout.LayoutParams(WRAP_CONTENT, px(34)))
        column.addView(head)

        column.addView(body(), spaced(top = 12))

        // The two widgets.
        val widgets = LinearLayout(this)
        laptop = Laptop(this)
        deviceSub = text("", 12.5f, R.color.ink_2)
        widgets.addView(widget(laptop, "连接设备", deviceSub) { open(devicesBox) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        toolSub = text("", 12.5f, R.color.ink_2)
        widgets.addView(widget(Toolbox(this), "自检工具箱", toolSub) { open(toolsBox) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = px(12) })
        column.addView(widgets, spaced(top = 16))

        column.addView(text("声音只在这台手机上识别，不会留下。", 12f, R.color.ink_2).apply { gravity = Gravity.CENTER }, spaced(top = 16))

        modelsBox = box("模型", "点一行就借那一个", modelsContent())
        toolsBox = box("自检工具箱", "看看这台手机跟不跟得上", toolsContent())
        devicesBox = box("连接设备", "让电脑用上这台手机", devicesContent())

        // The page lies under the status bar and the navigation bar — Android 15 puts every app there, and here it is
        // asked for on the versions before, so that all of them are one case — and keeps its content clear of them:
        // on the first phone of that kind it was shown on, the name sat against the clock (2026-10-11).
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            addView(column)
        }
        room = Room(this)
        page = FrameLayout(this).apply {
            addView(room, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(scroll, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            // The bars' room is the page's own, so what scrolls is cut off at the bars and never runs under the clock;
            // the room shows there.
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

    /** The system bars' room, for a box that opens over the page. */
    private class Bars(val top: Int, val bottom: Int)
    private var bars = Bars(0, 0)

    /** The recorder: a mint body, its dark screen, the model card in its slot, and the power key. */
    private fun body(): View {
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = faced(R.color.body, R.color.body_deep, 34, 7)
            setPadding(px(14), px(14), px(14), px(14 + 7))
        }

        // The screen: what it is for and a light, what is going on in large, and the row of dots along its foot.
        val screen = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = faced(R.color.screen, R.color.screen_rim, 24, 4)
            setPadding(px(20), px(16), px(20), px(10 + 4))
        }
        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        screenLabel = text("", 12.5f, R.color.screen_ink_2)
        led = Led(this)
        top.addView(screenLabel, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        top.addView(led, LinearLayout.LayoutParams(px(12), px(12)))
        screen.addView(top)
        title = text("", 28f, R.color.screen_ink, bold = true)
        sub = text("", 13.5f, R.color.screen_ink_2).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
        dots = Dots(this)
        screen.addView(title, spaced(top = 14))
        screen.addView(sub, spaced(top = 4))
        screen.addView(dots, spaced(top = 14))
        body.addView(screen)

        // The model card, in a slot of the body: what is lent, and the way to the others.
        val slot = FrameLayout(this).apply {
            background = flat(R.color.body_slot, 22)
            setPadding(px(4), px(4), px(4), px(4))
        }
        val card = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = faced(R.color.tile, R.color.card_edge, 18, 3)
            setPadding(px(14), px(10), px(12), px(10 + 3))
            setOnClickListener { open(modelsBox) }
        }
        card.addView(Chip(this), LinearLayout.LayoutParams(px(26), px(34)))
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        cardName = text("", 16f, R.color.ink, bold = true).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        cardSub = text("", 12.5f, R.color.ink_2).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        words.addView(cardName)
        words.addView(cardSub, spaced(top = 1))
        card.addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = px(12); rightMargin = px(8) })
        card.addView(Eject(this), LinearLayout.LayoutParams(px(22), px(22)))
        slot.addView(card)
        body.addView(slot, spaced(top = 12))

        // The grille, and the key with what it does beside it.
        val foot = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        foot.addView(Grille(this), LinearLayout.LayoutParams(px(84), px(30)))
        foot.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        keyLabel = text("", 15f, R.color.screen, bold = true)
        foot.addView(keyLabel, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = px(12) })
        power = PowerKey(this).apply {
            setOnClickListener { if (Sharing.on) ShareService.stop(this@MainActivity) else if (busy == null) lend() }
        }
        foot.addView(power, LinearLayout.LayoutParams(px(62), px(67)))
        body.addView(foot, spaced(top = 14))
        return body
    }

    /** One of the two widgets under the body: its object, what it is, and how that stands; a touch opens its box. */
    private fun widget(thing: View, name: String, state: TextView, onTouch: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = flat(R.color.tile, 26, alpha = 235)
            setPadding(px(16), px(14), px(14), px(16))
            setOnClickListener { onTouch() }
            addView(thing, LinearLayout.LayoutParams(MATCH_PARENT, px(70)))
            addView(text(name, 16f, R.color.ink, bold = true), spaced(top = 12))
            addView(state.apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, spaced(top = 2))
        }

    // ── The boxes ───────────────────────────────────────────────────────────────────────────────────────────────

    /**
     * A box, as the mockup has it: a lid on top with what the box is, its red catch, and the tray under it with the
     * contents. Opened, it comes up from the foot of the page and its lid lifts into place; a touch outside closes it.
     */
    private fun box(name: String, about: String, contents: View): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; isClickable = true }
        val lid = FrameLayout(this)
        val lidFace = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = faced(R.color.shell, R.color.box, 26, 4)
            setPadding(px(18), px(22), px(18), px(14 + 4))
            addView(text(name, 18f, R.color.ink, bold = true).apply { gravity = Gravity.CENTER })
            addView(text(about, 12.5f, R.color.ink_2).apply { gravity = Gravity.CENTER }, spaced(top = 2))
        }
        lid.addView(lidFace, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(9); leftMargin = px(16); rightMargin = px(16) })
        lid.addView(View(this).apply { background = faced(R.color.key, R.color.key_deep, 9, 3) }, FrameLayout.LayoutParams(px(52), px(22), Gravity.CENTER_HORIZONTAL))
        box.addView(lid)
        val tray = FrameLayout(this).apply {
            background = faced(R.color.box, R.color.box_deep, 30, 6)
            setPadding(px(10), px(10), px(10), px(10 + 6))
        }
        val inside = ScrollView(this).apply {
            background = flat(R.color.tile, 22)
            isVerticalScrollBarEnabled = false
            addView(contents)
        }
        tray.addView(inside)
        box.addView(tray, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = -px(6) })
        box.tag = lid
        return box
    }

    private fun open(which: View) {
        if (opened === which) return
        close(at = false)
        // Still on its way out, from a close a moment ago: taken off the page now, as it was before it opened.
        which.animate().cancel()
        (which.parent as? ViewGroup)?.removeView(which)
        which.translationY = 0f
        ((which as ViewGroup).getChildAt(1)).let { it.layoutParams = (it.layoutParams as LinearLayout.LayoutParams).apply { height = WRAP_CONTENT } }
        val shade = View(this).apply {
            setBackgroundColor(getColor(R.color.scrim))
            setOnClickListener { close() }
            alpha = 0f
        }
        page.addView(shade, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        val room = page.height - bars.top - bars.bottom
        page.addView(which, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply {
            leftMargin = px(10); rightMargin = px(10); bottomMargin = bars.bottom + px(8)
        })
        // A box no higher than the page leaves of the room: its tray scrolls inside.
        (which as ViewGroup).getChildAt(1).let { tray ->
            ((tray as ViewGroup).getChildAt(0) as ScrollView).layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            tray.post {
                // Not laid out yet (a box asked for before the first layout): as high as it is.
                if (room <= 0) return@post
                val most = maxOf(px(160), (room * 0.86f).toInt() - (which as ViewGroup).getChildAt(0).height)
                if (tray.height > most) tray.layoutParams = (tray.layoutParams as LinearLayout.LayoutParams).apply { height = most }
                tray.requestLayout()
            }
        }
        opened = which
        scrim = shade
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCloses as OnBackInvokedCallback)
        shade.animate().alpha(1f).setDuration(220).start()
        which.translationY = page.height.toFloat()
        which.animate().translationY(0f).setDuration(420).setInterpolator(OvershootInterpolator(0.9f)).start()
        // The lid lifts into place a moment after the box is up, with a little spring.
        val lid = which.tag as View
        lid.pivotY = lid.height.toFloat().takeIf { it > 0 } ?: px(80f)
        lid.rotationX = -55f
        lid.animate().rotationX(0f).setStartDelay(260).setDuration(380).setInterpolator(OvershootInterpolator(2f)).start()
        refresh()
    }

    /** Closes the box that is open: at once where another opens in its place. */
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
            ((which as ViewGroup).getChildAt(1)).layoutParams = (which.getChildAt(1).layoutParams as LinearLayout.LayoutParams).apply { height = WRAP_CONTENT }
        }.start()
    }

    /**
     * The models, in three short groups by what they are lent for, each under a small heading. The recognizer that is
     * lent is marked; a touch on another that is here lends that one instead. The text models are all lent, so a
     * touch on one does nothing.
     */
    private fun modelsContent(): View {
        val models = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(16), px(6), px(12), px(12))
        }
        rule = text("", 12f, R.color.ink_2)
        for (task in Task.values()) {
            models.addView(
                text(task.words, 12.5f, R.color.ink_2, bold = true).apply { letterSpacing = 0.08f },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(if (task == Task.HEAR) 10 else 16) },
            )
            for (model in ALL_MODELS.filter { it.task == task }) {
                val row = LinearLayout(this).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    minimumHeight = px(60)
                    setPadding(px(10), px(6), px(4), px(6))
                    setOnClickListener { if (model in choices.lendable(store) && busy == null && !Sharing.on) { choices.share(model); lastVerdict = null; refresh() } }
                }
                val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                val state = text("", 12.5f, R.color.ink_2)
                words.addView(text(model.name, 15.5f, R.color.ink, bold = true))
                words.addView(state, spaced(top = 2))
                val act = text("", 14f, R.color.screen, bold = true).apply {
                    gravity = Gravity.CENTER
                    background = faced(R.color.body, R.color.body_deep, 18, 3)
                    setPadding(px(16), 0, px(16), px(3))
                    setOnClickListener { if (busy == null) fetch(model) else if (busy === model) halt() }
                }
                row.addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = px(8) })
                row.addView(act, LinearLayout.LayoutParams(WRAP_CONTENT, px(38)))
                models.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(2) })
                rows[model] = Row(row, state, act)
            }
            // Under the recognizers, how the one that is lent comes to be it.
            if (task == Task.HEAR) models.addView(rule, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(4); leftMargin = px(10); rightMargin = px(6) })
        }
        return models
    }

    /** The toolbox: the self-check and its report; a newer version of the app, and the key that asks for one. */
    private fun toolsContent(): View {
        val tools = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(16), px(14), px(16), px(16))
        }
        // A newer version, when there is one: first in the box, and not there otherwise.
        updateRow = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = flat(R.color.box_pale, 18)
            setPadding(px(14), px(10), px(10), px(10))
            val words = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            updateTitle = text("", 15.5f, R.color.ink, bold = true)
            updateState = text("", 12.5f, R.color.ink_2)
            words.addView(updateTitle)
            words.addView(updateState, spaced(top = 2))
            updateAct = text("", 14f, R.color.tile, bold = true).apply {
                gravity = Gravity.CENTER
                background = faced(R.color.key, R.color.key_deep, 18, 3)
                setPadding(px(16), 0, px(16), px(3))
                setOnClickListener { release?.let(::touched) }
            }
            addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { rightMargin = px(10) })
            addView(updateAct, LinearLayout.LayoutParams(WRAP_CONTENT, px(38)))
        }
        tools.addView(updateRow, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = px(14) })

        checkState = text("", 13.5f, R.color.ink)
        tools.addView(checkState)
        checkBar = Bar(this)
        tools.addView(checkBar, spaced(top = 10))
        checkKey = text("", 16f, R.color.tile, bold = true).apply {
            gravity = Gravity.CENTER
            background = faced(R.color.key, R.color.key_deep, 24, 4)
            setPadding(0, 0, 0, px(4))
            setOnClickListener { if (busy == "check") halt() else if (busy == null && !Sharing.on) check() }
        }
        tools.addView(checkKey, LinearLayout.LayoutParams(MATCH_PARENT, px(50)).apply { topMargin = px(12) })

        // The report: kept shut, it is long and only wanted when asked for, or to send.
        val keys = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        reportKey = text("", 14f, R.color.screen, bold = true).apply {
            gravity = Gravity.CENTER
            background = faced(R.color.body, R.color.body_deep, 18, 3)
            setPadding(0, 0, 0, px(3))
            setOnClickListener { reportOpen = !reportOpen; refresh() }
        }
        share = text("分享报告", 14f, R.color.screen, bold = true).apply {
            gravity = Gravity.CENTER
            background = faced(R.color.body, R.color.body_deep, 18, 3)
            setPadding(0, 0, 0, px(3))
            setOnClickListener { lastReport?.let(::send) }
        }
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
        version.addView(text("手机端 ${BuildConfigLite.VERSION}", 13f, R.color.ink_2), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        lookKey = text("", 13f, R.color.ink_2).apply {
            gravity = Gravity.CENTER
            background = flat(R.color.room_3, 16)
            setPadding(px(14), 0, px(14), 0)
            setOnClickListener { look(asked = true) }
        }
        version.addView(lookKey, LinearLayout.LayoutParams(WRAP_CONTENT, px(34)))
        tools.addView(version, spaced(top = 16))
        return tools
    }

    /** The computer's side: where this phone is, how a computer finds it, which one used it last, and staying awake. */
    private fun devicesContent(): View {
        val devices = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(18), px(16), px(18), px(18))
        }
        address = text("", 20f, R.color.ink, bold = true)
        devices.addView(address)
        devices.addView(text("在电脑上打开 Kotomimi，在「另一台设备」里点搜索，就能找到这台手机。两台要连同一个 Wi-Fi。", 13.5f, R.color.ink_2).apply { setLineSpacing(0f, 1.15f) }, spaced(top = 8))
        lastComputer = text("", 13.5f, R.color.ink)
        devices.addView(lastComputer, spaced(top = 14))
        // Where the phone may still be stopped in the background: the one place to let it run.
        stay = text("", 14f, R.color.screen, bold = true).apply {
            gravity = Gravity.CENTER
            background = faced(R.color.body, R.color.body_deep, 18, 3)
            setPadding(px(12), px(10), px(12), px(10 + 3))
            setOnClickListener { letRun() }
        }
        devices.addView(stay, spaced(top = 16))
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
        val (_, free) = device.memory()

        // The models box.
        for ((model, row) in rows) {
            val begun = store.begun(model)
            val isText = model.task != Task.HEAR
            // A text model this phone could not hold says so in its row, and is not offered for download: it is
            // three gigabytes that would lie there for nothing. One it holds, but not now, beside what is open.
            val tooLarge = isText && !choices.fits(model)
            val tight = isText && !tooLarge && store.has(model) && !shared && model.holdsMb > free
            // The second engine's row of a model that has two is offered only once it is here: to the person they
            // are one model, and the self-check, not they, decides between the two.
            row.view.visibility = if (model.twin && model.reader == Reader.LLAMA_CPP && !store.has(model) && busy !== model) View.GONE else View.VISIBLE
            row.view.background = if (model === lent && lendable.size > 1) lentMark else null
            if (busy !== model) {
                // What a row is good for, where that is known; for a model in two rows, which of the two it is.
                val whose = model.note ?: twinWords(model)
                row.state.text = when {
                    tooLarge -> listOfNotNull("已下载".takeIf { store.has(model) }, model.sizeInWords, "这台手机内存不够")
                    tight -> listOfNotNull("已下载", model.sizeInWords, "现在内存不够，关掉别的应用再借")
                    store.has(model) -> if (model === lent && lendable.size > 1) listOfNotNull("借出去的是这个", whose) else listOfNotNull("已下载", whose, model.sizeInWords)
                    begun > 0 -> listOfNotNull(whose, "下载到 ${percent(begun, model.bytes)}，可以接着下")
                    else -> listOfNotNull(whose, model.sizeInWords)
                }.joinToString(" · ")
                row.act.text = if (begun > 0 && !store.has(model)) "继续" else "下载"
                row.act.alpha = if (busy == null) 1f else 0.4f
            }
            row.act.visibility = if (store.has(model) || (tooLarge && busy !== model)) View.GONE else View.VISIBLE
        }
        rule.visibility = if (lendable.size > 1) View.VISIBLE else View.GONE
        rule.text = if (choices.chosen(store) != null) "借的是你点的那一个。点别的就换。" else "没点过：按自检的结果挑，跟得上的里最准的。"

        // The model card.
        when {
            lent != null -> {
                cardName.text = lent.name
                cardSub.text = listOfNotNull(
                    if (shared && sharing.phase != Share.Phase.LOADING) "已装入" else lent.sizeInWords,
                    twinWords(lent),
                    lentText.takeIf { it.isNotEmpty() }?.let { "还借${textWords(it)}" },
                ).joinToString(" · ")
            }
            lentText.isNotEmpty() -> { cardName.text = lentText.first().name; cardSub.text = textWords(lentText) + if (lentText.size > 1) " · 共 ${lentText.size} 个" else "" }
            else -> { cardName.text = "还没有模型"; cardSub.text = "点这里下载一个" }
        }

        // The key.
        keyLabel.text = if (shared) "停止共享" else "开始共享"
        power.lit = shared
        power.alpha = if (shared || (busy == null && (lent != null || lentText.isNotEmpty()) && engine.present)) 1f else 0.45f
        led.on = shared

        // The screen.
        screenLabel.text = when {
            sharing.phase == Share.Phase.WORKING && sharing.task == Task.TRANSLATE -> "翻译"
            sharing.phase == Share.Phase.WORKING && sharing.task == Task.COACH -> "语法反馈"
            lent == null && lentText.isNotEmpty() -> "翻译"
            else -> "语音识别"
        }
        if (busy != "check") {
            when {
                !engine.present -> say("引擎不在", "这个安装包里没有带上识别引擎")
                shared || sharing.phase == Share.Phase.FAILED -> ShareService.wordsOf(sharing).let { say(it.first, it.second) }
                here.isEmpty() -> say("先下载模型", "点下面的模型卡，建议连着 Wi-Fi")
                lastVerdict != null -> say(lastVerdict!!.first, lastVerdict!!.second)
                // Only llama.cpp's files are here, in a package built without its server: enough to check with, not to lend.
                lent == null && lentText.isEmpty() -> say("可以自检", "要借给电脑，还得下载一个识别模型")
                else -> say("没有开启", "按右下角的键，借给电脑")
            }
            dots.show(
                when (sharing.phase) {
                    Share.Phase.WORKING -> Dots.Mode.WAVE
                    Share.Phase.WAITING, Share.Phase.LOADING -> Dots.Mode.WAITING
                    else -> Dots.Mode.OFF
                },
            )
        } else {
            dots.show(Dots.Mode.PROGRESS, checked)
        }
        room.working = sharing.phase == Share.Phase.WORKING

        // The widgets.
        val recently = sharing.seen != null && System.currentTimeMillis() - sharing.seenAt < RECENT_MS
        laptop.linked = shared && recently
        deviceSub.text = when {
            !shared -> "没开"
            recently -> "${sharing.seen} · 在用"
            else -> "还没有电脑连上"
        }
        toolSub.text = when {
            busy == "check" -> "正在检查 ${(checked * 100).toInt()}%"
            lastVerdict != null -> lastVerdict!!.first
            lastReport != null -> "检查过了"
            else -> "还没自检过"
        }

        // The toolbox.
        checkKey.text = if (busy == "check") "停下" else if (lastReport == null) "开始自检" else "再自检一次"
        checkKey.alpha = if (busy == "check" || (busy == null && !shared && here.isNotEmpty() && engine.present)) 1f else 0.45f
        if (busy != "check") {
            checkState.text = when {
                shared -> "共享时不能自检，先停止共享。"
                lastVerdict != null -> "${lastVerdict!!.first} · ${lastVerdict!!.second}"
                here.isEmpty() -> "先下载一个模型，才能自检。"
                else -> "用一段录好的话，看这台手机识别得跟不跟得上说话的速度。手机放着别动，要等一阵子。"
            }
        }
        checkBar.visibility = if (busy == "check") View.VISIBLE else View.GONE
        checkBar.done = checked
        reportKey.visibility = if (lastReport == null) View.GONE else View.VISIBLE
        share.visibility = reportKey.visibility
        reportKey.text = if (reportOpen) "收起报告" else "看报告"
        report.text = lastReport.orEmpty()
        report.visibility = if (lastReport != null && reportOpen) View.VISIBLE else View.GONE

        // The devices box.
        address.text = if (shared) sharing.address?.let { "地址 $it" } ?: "这台手机没连 Wi-Fi" else "还没开始共享"
        lastComputer.text = sharing.seen?.let { "最近用它的电脑：$it · ${ago(sharing.seenAt)}" } ?: if (shared) "还没有电脑连上。" else "按右下角的键开始共享，电脑才能找到它。"
        val runs = mayRun()
        stay.visibility = if (!runs || FREEZING_MAKERS.any { Build.MANUFACTURER.lowercase().contains(it) }) View.VISIBLE else View.GONE
        stay.text = if (!runs) "锁屏久了会断？允许后台运行" else "还会断的话，去设置里允许后台运行"

        showUpdate()
        if (busy == null) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** For a model in two rows — the same model for each engine —, which of the two this is; null for any other. */
    private fun twinWords(model: Model): String? = if (!model.twin) null else if (model.reader == Reader.AUDIO_CPP) "显卡版" else "处理器版"

    /** The text models lent, in a few words: what they are for. */
    private fun textWords(models: List<Model>): String = models.map { it.task }.distinct().joinToString("和") { it.words }

    private fun ago(at: Long): String {
        val seconds = (System.currentTimeMillis() - at) / 1000
        return when {
            seconds < 60 -> "刚刚"
            seconds < 3600 -> "${seconds / 60} 分钟前"
            else -> "${seconds / 3600} 小时前"
        }
    }

    /** The newer version's pill on the page and its row in the toolbox. Its download writes its own lines over this. */
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
            installing -> "已交给系统，稍等…"
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
        say("正在检查", "手机放着别动，要等一阵子")
        checkState.text = "正在检查：手机放着别动，要等一阵子"
        refresh()
        worker.execute {
            val result = runCatching {
                SelfCheck(this, engine, llama, store).run(
                    onStep = { done, of, words ->
                        main.post {
                            title.text = if (done < of) "正在检查 ${done + 1}/$of" else "正在检查"
                            sub.text = words
                            checkState.text = "${title.text}：$words"
                            checked = if (of == 0) 0f else done.toFloat() / of
                            dots.show(Dots.Mode.PROGRESS, checked)
                            checkBar.done = checked
                            toolSub.text = "正在检查 ${(checked * 100).toInt()}%"
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
                        // What the screen says is about lending the phone: the model it is lent with, by its size, and
                        // which of its two rows where it has two. Where no recognizer was checked, the first text
                        // model speaks: what it is for, and how long it takes.
                        lastVerdict = done.texts.takeIf { done.models.isEmpty() }?.firstNotNullOfOrNull { it.words } ?: (done.verdict.words to (done.lending?.let { of ->
                            of.lent?.speed?.let { listOfNotNull(of.model.size, twinWords(of.model), "${"%.1f".format(it)} 倍速").joinToString(" · ") }
                        } ?: "看下面的报告"))
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
                            row.state.text = if (now.from.isBlank()) "${which}找最快的下载地址…" else "$which${percent(now.had, model.bytes)} · ${speed(now.perSecond)} · ${now.from}"
                            row.act.alpha = 1f
                        }
                    },
                    onChecking = { main.post { row.state.text = "核对中…"; row.act.alpha = 0.4f } },
                    stopped = stop::get,
                )
            }
            main.post {
                busy = null
                refresh()
                result.onFailure { error -> row.state.text = "没下成：${error.message ?: error.javaClass.simpleName}" }
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
        handed++
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
        confirming = false
        confirmShown = false
        when (told.status) {
            // It wants the person's word, and gives the screen of its own that asks for it. The package stays with
            // the system while it asks, and while it installs after a yes.
            PackageInstaller.STATUS_PENDING_USER_ACTION ->
                runCatching { startActivity(told.confirm!!) }
                    .onSuccess { installing = true; confirming = true }
                    .onFailure { error -> updateWords = "没装成：${error.message ?: error.javaClass.simpleName}" }
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
        const val PAGE_TOP = 10
        const val PAGE_FOOT = 24

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
