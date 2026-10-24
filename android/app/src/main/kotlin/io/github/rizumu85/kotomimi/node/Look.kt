package io.github.rizumu85.kotomimi.node

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.Surface
import android.view.View
import android.view.animation.DecelerateInterpolator
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The look: the OriginOS 1.0 desktop the user pointed to (2026-10-23) — a living wallpaper and, on it, round widgets
 * of several sizes, each one object that stands for what it does. Hearing is a glass of water whose surface is the
 * voice; a translation is two panes of frosted glass, the sentence behind and its translation in front; feedback is
 * a sheet of paper written over in red. The objects have a little real volume (a shadow, a translucent pane) and
 * nothing more. Everything is drawn: the app carries no images.
 */

/** Pixels of `dp` on this screen. */
fun Context.px(dp: Float): Float = dp * resources.displayMetrics.density
fun Context.px(dp: Int): Int = (dp * resources.displayMetrics.density + 0.5f).toInt()

/** Whether the screen is drawn dark: by the phone's setting, or by the person's choice laid over it. */
fun Context.night(): Boolean =
    (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

/**
 * A rounded face of one colour, with an edge where one is given. In the dark a page's tile is flat and lets more of the
 * glows behind it through, tinted by them, as Folia's are: a sheen drawn on it looked neither clean nor lit (the user,
 * 2026-10-23).
 */
fun Context.flat(color: Int, radius: Int, alpha: Int = 255, edge: Int? = null): Drawable =
    GradientDrawable().apply {
        setColor(getColor(color))
        cornerRadius = px(radius).toFloat()
        this.alpha = if (color == R.color.tile && alpha < 255 && night()) alpha * 3 / 4 else alpha
        if (edge != null) setStroke(px(1), getColor(edge))
    }

/** `a` toward `b` by `t`, alpha and all. */
fun blend(a: Int, b: Int, t: Float): Int {
    fun ch(shift: Int) = (((a ushr shift) and 0xFF) * (1 - t) + ((b ushr shift) and 0xFF) * t).toInt() and 0xFF
    return (ch(24) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
}

/** What the phone is doing, for the wallpaper's colours. */
enum class Mood { IDLE, HEAR, TRANSLATE, COACH }

/**
 * The wallpaper, and part of the app: large soft fields of colour, and in front of them a layer of fine dots held as if
 * in an acrylic block of oil with glitter in it (流麻: the user, 2026-10-23, wanted the dots to be a layer that is
 * physically there, not light laid over the page). The fields are coloured by what the phone is doing and always slowly
 * moving — slower while nothing is lent — and answer what happens: a reading heard sets their edges trembling, a
 * sentence translated sends a light sweeping across, a correction spreads like a drop of red ink.
 *
 * The dots stand in a grid, a touch of the technical against the soft fields; how much of it shows flows. The dots
 * gather where the page leaves room — never behind writing or a tile (`covered`), the edge of the room soft and
 * wandering — in drifts that slowly move, settle toward the way the phone is held, and sway when it is turned; a few
 * catch the light as the phone moves, as glitter does. A finger sends a wave out through them, wide and slow, as
 * through the oil (the user chose it of four, 2026-10-23: a ripple, parting them, a glitter burst, a dome pressed in).
 */
class Wall(context: Context) : View(context), SensorEventListener {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }

    /** Where the page has something in front — tiles and writing — in the wall's own pixels: the dots keep clear of it. */
    var covered: List<RectF> = emptyList()

    private var mood = Mood.IDLE
    /** The fields' colours now, and on their way to. */
    private var from = colours(Mood.IDLE)
    private var to = from
    private var turned = 1f
    private var t = 0f
    private var last = 0L
    /** How fast the fields drift: lent and at work, lent and waiting, not lent. */
    var pace = 0.35f

    /** Behind a scrolled page, by how much. */
    var scrolled = 0f
        set(value) { field = value; invalidate() }

    private var tremble = 0f
    private var sweep = -1f
    private class Drop(val x: Float, val y: Float, val color: Int, var age: Float = 0f)
    private val drops = ArrayList<Drop>()

    // Which way is down, on the screen, as a fraction of gravity: as the sensor says it, followed quickly, and slowly —
    // the dots sway by the difference and settle by the slow one, as glitter in oil does.
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val gravity = sensors?.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private var downX = 0f
    private var downY = 0.7f
    private var quickX = 0f
    private var quickY = 0.7f
    private var slowX = 0f
    private var slowY = 0.7f
    /** How much the phone has just been moved, or the dots stirred: more of the glitter catches the light. */
    private var stir = 0f

    // Waves running out through the dots, and the finger that sent the last: whether it is down, and where it was.
    private class Wave(val x: Float, val y: Float, val strength: Float, var age: Float = 0f)
    private val waves = ArrayList<Wave>()
    private var held = false
    private var markedX = 0f
    private var markedY = 0f

    // The dots of each strength, drawn together: plain ones of each layer, and those catching the light, by colour.
    private val plain = Array(2) { Array(LEVELS) { FloatArray(256) } }
    private val plainCount = Array(2) { IntArray(LEVELS) }
    private val lit = Array(GLINTS.size) { Array(LIT_LEVELS) { FloatArray(32) } }
    private val litCount = Array(GLINTS.size) { IntArray(LIT_LEVELS) }
    /** Pixels of a dp. */
    private val dp = context.resources.displayMetrics.density
    /** The dots' colour: dark on the day's wall, pale on the night's. */
    private val dotInk = context.getColor(R.color.dot)

    /** Runs while the screen is seen: `MainActivity` stops it when it is not. */
    var running = false
        set(value) {
            if (field == value) return
            field = value
            last = 0L
            if (value) {
                gravity?.let { sensors?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
                android.view.Choreographer.getInstance().postFrameCallback(tick)
            } else {
                sensors?.unregisterListener(this)
                android.view.Choreographer.getInstance().removeFrameCallback(tick)
            }
        }

    // Drawn on every frame while something moves — a finger, a wave, the phone turned, the colours changing — and on
    // every other one while all of it only drifts: the drift is slow enough, and the phone does half the work.
    //
    // Left alone longer, every fourth: each frame drawn composes the whole screen again — the translucent tiles over
    // the wall — and on the F22 Pro that cost the render thread over 40 % of a core at every other frame, the drift
    // so slow the eye does not tell 15 frames a second from 30 (measured 2026-10-24).
    private var frame = 0
    /** Every how many frames the wall is drawn now: 1 while something moves, then 2, then 4. */
    private var every = 1
    /** When something last moved, in the frame clock's nanoseconds. */
    private var stirredAt = 0L
    private val tick: android.view.Choreographer.FrameCallback = object : android.view.Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            if (!calm()) stirredAt = frameTimeNanos
            every = when {
                stirredAt == frameTimeNanos -> 1
                frameTimeNanos - stirredAt < QUIET_AFTER_NS -> 2
                else -> 4
            }
            frame += 1
            if (frame % every == 0) {
                invalidate()
                // Still water is drawn with the wall, in the same frame: on its own clock it doubled the frames.
                beside?.invalidate()
            }
            android.view.Choreographer.getInstance().postFrameCallback(this)
        }
    }

    /** A view in front drawn in the wall's frames while it is still: the water of the hearing tile. */
    var beside: View? = null

    private fun calm() = !held && waves.isEmpty() && drops.isEmpty() && stir < 0.08f && sweep < 0f && tremble <= 0f &&
        turned >= 1f && abs(quickX - slowX) + abs(quickY - slowY) < 0.02f && flash <= 0f && kicked <= 0f

    fun moodFor(next: Mood) {
        if (next == mood) return
        brightFrom = brightFrom + (brightTo - brightFrom) * ease(turned)
        brightTo = if (next == Mood.IDLE) IDLE_BRIGHT else 1f
        mood = next
        from = current()
        to = colours(next)
        turned = 0f
    }

    // How bright the night's smoke is, on its way from one to the other as the colours turn.
    private var brightFrom = IDLE_BRIGHT
    private var brightTo = IDLE_BRIGHT

    private fun ease(k: Float): Float = k * k * (3 - 2 * k)

    /** Something was done: the wallpaper answers it in the way of that work, and a wave runs out through the dots. */
    fun pulse(task: Task, x: Float = width * 0.5f, y: Float = height * 0.55f) {
        when (task) {
            Task.HEAR -> tremble = 1f
            Task.TRANSLATE -> sweep = 0f
            Task.COACH -> drops += Drop(x, y, context.getColor(R.color.ink_red))
        }
        waves += Wave(x, y, 0.8f)
        flash = 1f
        kick(x, y, 0.5f)
    }

    /** A finger comes down on the wallpaper, between the tiles: a wave runs out from it. */
    fun press(x: Float, y: Float) {
        held = true
        markedX = x; markedY = y
        stir = min(1f, stir + 0.2f)
        waves += Wave(x, y, 1f)
        kick(x, y, 1f)
    }
    /**
     * The night's linework, after the drawn lines over Folia's lyric scenes (the user, 2026-10-23): hairlines with
     * small diamonds at their ends, corner brackets, plus signs, four-dot flowers, arches, small crosses and triangles —
     * thin and faint, in the night's pale grey. Each drifts slowly, fades in, lingers and fades out, then comes back
     * elsewhere as another, so the scene keeps changing as a lyric video's does. The nearer sway further as the phone
     * turns; a touch's wave pushes those near it away; work done lights them a moment.
     */
    private class Shape(
        var x: Float, var y: Float, var kind: Int, var size: Float, val depth: Float,
        val driftX: Float, val driftY: Float, var vx: Float, var vy: Float, var age: Float, var life: Float,
    )
    private val shapes = ArrayList<Shape>()
    private val shapePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val shapePath = Path()
    private val random = java.util.Random(7)
    /** How much the shapes were just lit by work done, and how far a touch has stirred them. */
    private var flash = 0f
    private var kicked = 0f

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (!dark || w == 0 || h == 0) return
        shapes.clear()
        // Fewer on a small screen, more on a large one: about one to every 130 dp square.
        val count = ((w / dp) * (h / dp) / (130f * 130f)).toInt().coerceIn(8, 22)
        for (i in 0 until count) {
            val depth = 0.4f + random.nextFloat() * 0.6f
            val speed = dp * (1.5f + random.nextFloat() * 3.5f) * depth
            val heading = random.nextFloat() * TWO_PI
            val shape = Shape(0f, 0f, 0, 0f, depth, cos(heading) * speed, sin(heading) * speed, cos(heading) * speed, sin(heading) * speed, 0f, 1f)
            renew(shape, w.toFloat(), h.toFloat())
            // Begun at different points of their lives, so they do not all fade together.
            shape.age = random.nextFloat() * shape.life
            shapes += shape
        }
    }

    /** A shape comes back somewhere else, as another. */
    private fun renew(s: Shape, w: Float, h: Float) {
        s.x = random.nextFloat() * w
        s.y = random.nextFloat() * h
        s.kind = random.nextInt(7)
        s.size = dp * when (s.kind) { 0 -> 110f + random.nextFloat() * 150f; 4 -> 46f + random.nextFloat() * 40f; 1 -> 26f + random.nextFloat() * 20f; else -> 10f + random.nextFloat() * 8f }
        s.age = 0f
        s.life = 12f + random.nextFloat() * 12f
    }

    private fun stepShapes(dt: Float, w: Float, h: Float) {
        for (s in shapes) {
            s.vx += (s.driftX - s.vx) * min(1f, dt / 1.6f)
            s.vy += (s.driftY - s.vy) * min(1f, dt / 1.6f)
            s.x += s.vx * dt
            s.y += s.vy * dt
            s.age += dt
            if (s.age > s.life) renew(s, w, h)
        }
    }

    /** A touch's wave pushes the shapes near it away. */
    private fun kick(x: Float, y: Float, strength: Float) {
        val reach = 240f * dp
        for (s in shapes) {
            val dx = s.x - x
            val dy = s.y - y
            val r = sqrt(dx * dx + dy * dy)
            if (r > reach || r < 1f) continue
            val push = 60f * dp * strength * (1f - r / reach) * s.depth
            s.vx += dx / r * push
            s.vy += dy / r * push
        }
        kicked = min(1f, kicked + 0.6f * strength)
    }

    private fun drawShapes(canvas: Canvas) {
        val swayX = (quickX - slowX) * 26f * dp
        val swayY = (quickY - slowY) * 26f * dp
        val ink = dotInk and 0x00FFFFFF
        for (s in shapes) {
            val x = s.x + swayX * s.depth
            val y = s.y + swayY * s.depth - scrolled * 0.08f * s.depth
            // In, lingering, out: a soft rise and fall over its life.
            val k = s.age / s.life
            val envelope = smooth(0f, 0.2f, k) * (1f - smooth(0.75f, 1f, k))
            val alpha = ((0.12f + 0.22f * s.depth) * envelope * (1f + flash * 1.5f) * 255).toInt().coerceIn(0, 255)
            if (alpha < 2) continue
            shapePaint.color = ink or (alpha shl 24)
            shapePaint.strokeWidth = dp
            val r = s.size / 2
            when (s.kind) {
                0 -> {
                    // A hairline with a small diamond at each end.
                    canvas.drawLine(x - r, y, x + r, y, shapePaint)
                    for (e in listOf(x - r, x + r)) diamond(canvas, e, y, 3f * dp)
                }
                1 -> {
                    // A corner bracket.
                    canvas.drawLine(x, y, x + r, y, shapePaint); canvas.drawLine(x, y, x, y + r, shapePaint)
                }
                2 -> { canvas.drawLine(x - r, y, x + r, y, shapePaint); canvas.drawLine(x, y - r, x, y + r, shapePaint) }
                3 -> {
                    // Four dots about a centre, a small flower.
                    shapePaint.style = Paint.Style.FILL
                    for ((ox, oy) in listOf(0f to -1f, 1f to 0f, 0f to 1f, -1f to 0f)) canvas.drawCircle(x + ox * r * 0.6f, y + oy * r * 0.6f, 1.6f * dp, shapePaint)
                    shapePaint.style = Paint.Style.STROKE
                }
                4 -> {
                    // An arch: a tall round-topped outline, open at its foot.
                    shapePath.reset()
                    shapePath.moveTo(x - r * 0.6f, y + r)
                    shapePath.lineTo(x - r * 0.6f, y - r * 0.4f)
                    shapePath.arcTo(RectF(x - r * 0.6f, y - r, x + r * 0.6f, y + r * 0.2f), 180f, 180f)
                    shapePath.lineTo(x + r * 0.6f, y + r)
                    canvas.drawPath(shapePath, shapePaint)
                }
                5 -> { canvas.drawLine(x - r, y - r, x + r, y + r, shapePaint); canvas.drawLine(x - r, y + r, x + r, y - r, shapePaint) }
                else -> {
                    shapePath.reset()
                    shapePath.moveTo(x, y - r); shapePath.lineTo(x + r * 0.87f, y + r * 0.5f); shapePath.lineTo(x - r * 0.87f, y + r * 0.5f); shapePath.close()
                    canvas.drawPath(shapePath, shapePaint)
                }
            }
        }
    }

    private fun diamond(canvas: Canvas, x: Float, y: Float, r: Float) {
        shapePath.reset()
        shapePath.moveTo(x, y - r); shapePath.lineTo(x + r, y); shapePath.lineTo(x, y + r); shapePath.lineTo(x - r, y); shapePath.close()
        shapePaint.style = Paint.Style.FILL
        canvas.drawPath(shapePath, shapePaint)
        shapePaint.style = Paint.Style.STROKE
    }

    // The night's backdrop: a small picture of soft folds worked out each frame and drawn large, so it is blurred.
    private var fume: android.graphics.Bitmap? = null
    private var fumePixels = IntArray(0)
    private val fumePaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val fumeTo = RectF()

    /**
     * The night's backdrop, after the smoke and silk behind Folia's lyric scenes (the user, 2026-10-23): not two round
     * glows but one flowing field of soft folds, low and hazy, its light the two colours of what the phone is doing,
     * greyed and running into each other, its folds turning slowly. Worked out small and drawn large, so it is soft.
     */
    private fun drawFume(canvas: Canvas, w: Float, h: Float, c: IntArray) {
        val cols = 40
        val rows = (cols * h / w).toInt().coerceIn(24, 120)
        if (fume?.height != rows) {
            fume = android.graphics.Bitmap.createBitmap(cols, rows, android.graphics.Bitmap.Config.ARGB_8888)
            fumePixels = IntArray(cols * rows)
        }
        val night = c[0]
        // Not lent, the smoke is low, a dim room; lent, it lifts — at the pace the colours turn, never at once.
        val bright = brightFrom + (brightTo - brightFrom) * ease(turned)
        val a = muted(c[1])
        val b = muted(c[2])
        val unit = min(w, h)
        val tt = t * 0.9f
        for (j in 0 until rows) {
            val y = j.toFloat() / rows * h / unit * 2.2f + scrolled * 0.0006f
            for (i in 0 until cols) {
                val x = i.toFloat() / cols * w / unit * 2.2f
                val warp = fsin(y * 1.3f + tt * 0.35f) * 0.9f + fsin(x * 0.8f - tt * 0.22f) * 0.6f
                val fold = fsin((x * 1.5f + y * 0.9f) * 1.3f + warp + tt * 0.28f)
                val fold2 = fsin(x * 0.7f - y * 1.6f + tt * 0.17f + warp * 0.5f)
                var light = smooth(-0.3f, 1f, fold) * 0.6f + smooth(0f, 1f, fold2) * 0.3f
                // Darker toward the foot, where the tiles stand thickest, and a little at the sides.
                val v = j.toFloat() / rows
                light *= 0.55f + 0.45f * (1f - v * 0.7f) * (1f - 0.35f * abs(i.toFloat() / cols - 0.5f) * 2f)
                val hue = 0.5f + 0.5f * fsin(x * 0.6f + y * 0.45f + tt * 0.1f)
                // Never quite black: a haze of the colour everywhere, and the folds lighter in it, as Folia's smoke.
                fumePixels[j * cols + i] = blend(night, blend(a, b, hue), ((0.16f + light * 0.78f) * bright).coerceIn(0f, 1f))
            }
        }
        fume!!.setPixels(fumePixels, 0, cols, 0, 0, cols, rows)
        fumeTo.set(0f, 0f, w, h)
        canvas.drawBitmap(fume!!, null, fumeTo, fumePaint)
    }

    /** A colour greyed toward its own lightness, as smoke takes a colour. */
    private fun muted(color: Int): Int {
        val r = (color shr 16) and 0xFF
        val g = (color shr 8) and 0xFF
        val b = color and 0xFF
        val grey = (r * 0.3f + g * 0.59f + b * 0.11f).toInt()
        return blend(blend(color, Color.rgb(grey, grey, grey), 0.42f), Color.BLACK, 0.18f)
    }


    /** The finger moves: smaller waves follow it as it goes. */
    fun drag(x: Float, y: Float) {
        if (!held || hypot(x - markedX, y - markedY) < 56f * dp) return
        markedX = x; markedY = y
        waves += Wave(x, y, 0.4f)
        while (waves.size > 12) waves.removeAt(0)
    }

    /** The finger is lifted. */
    fun lift() {
        held = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        val ax = event.values[0]
        val ay = event.values[1]
        // The sensor speaks in the phone's own frame; the screen may be turned. Down on the screen is against it.
        val (sx, sy) = when (display?.rotation ?: Surface.ROTATION_0) {
            Surface.ROTATION_90 -> -ay to ax
            Surface.ROTATION_180 -> -ax to -ay
            Surface.ROTATION_270 -> ay to -ax
            else -> ax to ay
        }
        downX = (-sx / SensorManager.GRAVITY_EARTH).coerceIn(-1f, 1f)
        downY = (sy / SensorManager.GRAVITY_EARTH).coerceIn(-1f, 1f)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun current(): IntArray = IntArray(3) { blend(from[it], to[it], turned) }

    private val dark = context.night()
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    /** The glitter's colours: the day's four, or the night's ice blues and white. */
    private val glints = if (dark) NIGHT_GLINTS else GLINTS

    private fun colours(m: Mood): IntArray = if (dark) when (m) {
        // The colour of what the phone is doing, as an album's behind Folia's veil: the day's fields deepened to glow
        // on black — a blue and violet night looked like every other app made by a machine (the user, 2026-10-23).
        Mood.IDLE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.glow_sage), context.getColor(R.color.glow_mist))
        Mood.HEAR -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.glow_mint), context.getColor(R.color.glow_mist))
        Mood.TRANSLATE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.glow_apricot), context.getColor(R.color.glow_mist))
        Mood.COACH -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.glow_coral), context.getColor(R.color.glow_lilac))
    } else when (m) {
        Mood.IDLE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_mint_pale), context.getColor(R.color.field_blue))
        Mood.HEAR -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_mint), context.getColor(R.color.field_blue))
        Mood.TRANSLATE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_apricot), context.getColor(R.color.field_blue))
        Mood.COACH -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_coral), context.getColor(R.color.field_lilac))
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else min(0.05f, (now - last) / 1e9f)
        last = now
        step(dt)

        val c = current()
        val w = width.toFloat()
        val h = height.toFloat()
        // The fields lie furthest back: they sway a little as the phone turns, and move a little as the page scrolls.
        val swayX = (quickX - slowX) * context.px(4f)
        val swayY = (quickY - slowY) * context.px(4f)
        val shift = -scrolled * 0.12f + swayY
        canvas.drawColor(c[0])
        // The first field, up and to the left; the second, lower right. Each a round shape whose edge breathes.
        if (dark) drawFume(canvas, w, h, c) else {
            field(canvas, swayX + w * 0.08f + sin(t * 0.7f) * w * 0.05f, h * 0.06f + shift + cos(t * 0.5f) * w * 0.04f, w * 0.78f, c[1], 0f)
            field(canvas, swayX + w * 1.0f + cos(t * 0.6f) * w * 0.05f, h * 0.68f + shift * 1.5f + sin(t * 0.45f) * w * 0.05f, w * 0.72f, c[2], 2.1f)
        }

        // A sentence translated: a band of light sweeps across, left to right.
        if (sweep in 0f..1.3f) {
            val x = -w * 0.3f + sweep * w * 1.6f
            paint.color = Color.argb((70 * sin(min(1f, sweep) * PI).toFloat()).toInt().coerceAtLeast(0), 255, 255, 255)
            path.reset()
            path.moveTo(x, 0f); path.lineTo(x + w * 0.22f, 0f); path.lineTo(x + w * 0.02f, h); path.lineTo(x - w * 0.2f, h); path.close()
            canvas.drawPath(path, paint)
        }
        // A correction's red ink, spreading out in a ring.
        for (d in drops) {
            val k = d.age / 1.6f
            val fade = (1f - k).coerceIn(0f, 1f)
            paint.color = blend(d.color and 0x00FFFFFF, d.color, fade * 0.12f)
            canvas.drawCircle(d.x, d.y, context.px(10f) + k * w * 0.4f, paint)
        }
        if (dark) drawShapes(canvas)
        dots(canvas, w, h)
    }

    /** Time passes: the fields drift, the sensor's down is followed, what a finger did fades. */
    private fun step(dt: Float) {
        t += dt * pace
        // The colours turn over a second and a half: in the dark the whole room's light changes with them.
        if (turned < 1f) turned = min(1f, turned + dt / 1.5f)
        tremble = max(0f, tremble - dt * 1.2f)
        if (sweep >= 0f) sweep = if (sweep > 1.3f) -1f else sweep + dt / 1.1f
        drops.forEach { it.age += dt }
        drops.removeAll { it.age > 1.6f }
        val wasX = quickX
        val wasY = quickY
        quickX += (downX - quickX) * min(1f, dt / 0.12f)
        quickY += (downY - quickY) * min(1f, dt / 0.12f)
        slowX += (quickX - slowX) * min(1f, dt / 1.4f)
        slowY += (quickY - slowY) * min(1f, dt / 1.4f)
        // Turning the phone stirs the glitter; it calms in a second or two.
        stir = (stir + hypot(quickX - wasX, quickY - wasY) * 1.6f - dt * 0.55f).coerceIn(0f, 1f)
        waves.forEach { it.age += dt }
        waves.removeAll { it.age > WAVE_LASTS }
        // Set by touches and work in either look, so let go in either: decayed only in the dark, the light wall never
        // calmed after its first touch and drew every frame.
        flash = max(0f, flash - dt * 0.9f)
        kicked = max(0f, kicked - dt * 0.7f)
        if (dark) stepShapes(dt, width.toFloat(), height.toFloat())
    }

    /**
     * The layer of dots: two grids, one deeper in the block than the other, offset by half a step — the deeper one
     * smaller, fainter, and swaying less as the phone turns, so the block has a thickness. Each dot shows by how much
     * drift is where it stands — the drifts a slow flow, settling toward down, their edges grainy rather than a fade —
     * and by how far it is from what stands in front, the edge of that room wandering with the flow. A finger and work
     * done stir them; a few, by turn as the phone moves, catch the light in a colour of their own, as glitter does.
     *
     * Every dot is worked out on every frame drawn, on the weakest phones too (the F22 Pro, in a debuggable build), so
     * what can be is kept: each dot's distance from what stands in front until the page moves (`room`), the flow worked
     * out every third dot and read between, and a dot that cannot show behind a tile left at once; and while all of
     * it only drifts, the dots are worked out on every other frame drawn, and drawn again as they were between.
     */
    private fun dots(canvas: Canvas, w: Float, h: Float) {
        anew = !anew
        // At its slowest, every frame drawn is worked out: half of those would be too few to drift smoothly.
        if (anew || every >= 4 || !calm() || scrolled != workedAt || w * h != workedFor) work(w, h)
        workedAt = scrolled
        workedFor = w * h
        for (layer in 0..1) {
            val deep = layer == 0
            for (level in 1 until LEVELS) {
                val count = plainCount[layer][level]
                if (count == 0) continue
                val k = level / (LEVELS - 1f)
                dot.color = (dotInk and 0x00FFFFFF) or (((22 + 80 * k) * if (deep) 0.6f else 1f).toInt() shl 24)
                dot.strokeWidth = (1.0f + 1.8f * k) * (if (deep) 0.75f else 1f) * dp
                canvas.drawPoints(plain[layer][level], 0, count * 2, dot)
            }
        }
        for (hue in GLINTS.indices) {
            for (level in 0 until LIT_LEVELS) {
                val count = litCount[hue][level]
                if (count == 0) continue
                val k = (level + 1f) / LIT_LEVELS
                if (dark) {
                    dot.color = (glints[hue] and 0x00FFFFFF) or ((46 * k).toInt() shl 24)
                    dot.strokeWidth = (8f + 4f * k) * dp
                    canvas.drawPoints(lit[hue][level], 0, count * 2, dot)
                }
                dot.color = (glints[hue] and 0x00FFFFFF) or ((150 + 105 * k).toInt() shl 24)
                dot.strokeWidth = (2.2f + 1.4f * k) * dp
                canvas.drawPoints(lit[hue][level], 0, count * 2, dot)
                // The light caught: a small bright point to one side, toward where the light comes from.
                dot.color = Color.argb((235 * k).toInt(), 255, 255, 255)
                dot.strokeWidth = (0.7f + 0.4f * k) * dp
                canvas.save()
                canvas.translate(-0.55f * dp, -0.6f * dp)
                canvas.drawPoints(lit[hue][level], 0, count * 2, dot)
                canvas.restore()
            }
        }
    }

    // Whether this frame works the dots out anew, and the scroll and size they were last worked out for.
    private var anew = false
    private var workedAt = 0f
    private var workedFor = 0f

    /** Where each dot is and how strongly it shows, this frame. */
    private fun work(w: Float, h: Float) {
        val every = DOT_EVERY * dp
        val scale = 150f * dp
        val feather = 52f * dp
        val clear = 4f * dp
        val reach = 1.6f * dp
        val wander = 36f * dp
        val grainy = 18f * dp
        val hidden = clear - wander / 2 - grainy / 2
        // A wave: a broad, low swell, running out slowly and fading as it goes, past the finger's reach.
        val waveWide = 46f * dp
        val waveSpeed = 230f * dp
        for (counts in plainCount) counts.fill(0)
        for (counts in litCount) counts.fill(0)
        val light = quickX * 0.8f + quickY * 0.6f + t * 0.03f
        val shine = 0.3f + stir * 0.7f
        val waveCount = waves.size
        val columns = ceil(w / every).toInt()
        val across = columns + 2
        for (layer in 0..1) {
            val deep = layer == 0
            // The dots sway as the phone turns — the deeper less — and lie further back than the page as it scrolls.
            val sway = (if (deep) 3f else 8f) * dp
            val swayX = (quickX - slowX) * sway
            val swayY = (quickY - slowY) * sway
            val back = -scrolled * (if (deep) 0.03f else 0.05f) + if (deep) every / 2 else 0f
            val aside = if (deep) every / 2 else 0f
            val tt = t + if (deep) 7.3f else 0f
            val push = (if (deep) 1.8f else 3.2f) * dp
            val firstRow = floor((-every - back) / every).toInt()
            val rows = ceil((h + every - back) / every).toInt() - firstRow + 1
            val near = room(layer, firstRow, rows, across, every, back, aside)
            val flows = flow(layer, firstRow, rows, across, every, back, aside, scale, tt)
            val flowAcross = across / FLOW_EVERY + 2
            val plainOf = plain[layer]
            val countOf = plainCount[layer]
            for (row in 0 until rows) {
                val j = firstRow + row
                val ry = back + j * every
                val warpX = fsin(ry / scale * 1.3f + tt * 0.37f)
                val fb = row / FLOW_EVERY.toFloat()
                val b = fb.toInt()
                val vb = fb - b
                for (column in 0 until across) {
                    val distance = near[row * across + column]
                    if (distance < hidden) continue
                    val i = column - 1
                    val rx = i * every + every / 2 + aside
                    // The flow, read between the points it was worked out at.
                    val fa = column / FLOW_EVERY.toFloat()
                    val a = fa.toInt()
                    val va = fa - a
                    val at = b * flowAcross + a
                    val flow = (flows[at] * (1 - va) + flows[at + 1] * va) * (1 - vb) +
                        (flows[at + flowAcross] * (1 - va) + flows[at + flowAcross + 1] * va) * vb
                    var x = rx + warpX * reach + swayX
                    var y = ry + (flow - 0.5f) * 2f * reach + swayY
                    val grain = hash(i, j, 5 + layer) - 0.5f
                    // Toward down there is more of it; each dot has its own threshold, so a drift's edge is grains.
                    val settle = (slowX * (rx / w - 0.5f) + slowY * (ry / h - 0.5f)) * 0.5f
                    var amount = smooth(0.46f, 0.84f, flow + settle + grain * 0.32f)

                    var swell = 0f
                    for (k in 0 until waveCount) {
                        val wave = waves[k]
                        val dx = rx - wave.x
                        val dy = ry - wave.y
                        val r = sqrt(dx * dx + dy * dy)
                        val u = (r - wave.age * waveSpeed) / waveWide
                        if (u < -3f || u > 3f) continue
                        val s = exp(-u * u) * fcos(u * 1.5f) * wave.strength * exp(-wave.age * 0.95f)
                        if (r > 1f) { x += dx / r * s * push; y += dy / r * s * push }
                        swell += max(0f, s) * 0.9f
                    }
                    if (amount + swell <= 0.02f) continue

                    // How far from what stands in front: none behind it, more as the room opens; the edge wanders. A
                    // wave passing comes nearer — up to the writing, never behind it — so that it shows where the
                    // page leaves little room.
                    val room = smooth(clear, clear + feather, distance + (flow - 0.5f) * wander + grain * grainy)
                    val near = if (swell > 0f) smooth(clear, clear + feather * 0.3f, distance + grain * grainy * 0.5f) else 0f
                    if (room <= 0.01f && near <= 0.01f) continue
                    val shown = (amount * room + swell * near).coerceIn(0f, 1.2f)

                    // A few of the dots are glitter: each catches the light at its own turn of the phone, where the
                    // drift is.
                    if (!deep) {
                        var caught = 0f
                        if (hash(i, j, 17) < SEQUINS) {
                            val turn = fcos((hash(i, j, 3) * 3f + light) * TWO_PI)
                            if (turn > 0.95f) caught = exp((turn - 1f) * 80f) * shine * amount
                        }
                        val sparkle = (caught * room).coerceIn(0f, 1f)
                        if (sparkle > 0.1f) {
                            // Its colour turns with the light, as the colours of a sequin do.
                            val hue = ((hash(i, j, 13) * GLINTS.size + light * 2f).toInt() % GLINTS.size + GLINTS.size) % GLINTS.size
                            val level = min(LIT_LEVELS - 1, (sparkle * LIT_LEVELS).toInt())
                            lit[hue][level] = put(lit[hue][level], litCount[hue][level]++, x, y)
                            continue
                        }
                    }
                    val level = min(LEVELS - 1, (shown * (LEVELS - 1) / 1.2f).toInt())
                    if (level > 0) plainOf[level] = put(plainOf[level], countOf[level]++, x, y)
                }
            }
        }
    }

    // Each layer's dots' distances from what stands in front, and what they were worked out for.
    private val rooms = arrayOf(FloatArray(0), FloatArray(0))
    private val roomsFor = arrayOfNulls<List<Any>>(2)

    /** How far each dot of `layer` stands from what is in front — negative behind it — kept until the page moves. */
    private fun room(layer: Int, firstRow: Int, rows: Int, across: Int, every: Float, back: Float, aside: Float): FloatArray {
        val key = listOf(covered, firstRow, rows, across, back)
        if (roomsFor[layer] == key) return rooms[layer]
        roomsFor[layer] = key
        if (rooms[layer].size < rows * across) rooms[layer] = FloatArray(rows * across)
        val near = rooms[layer]
        for (row in 0 until rows) {
            val ry = back + (firstRow + row) * every
            for (column in 0 until across) {
                val rx = (column - 1) * every + every / 2 + aside
                var least = Float.MAX_VALUE
                for (r in covered) least = min(least, roundedDistance(rx, ry, r))
                near[row * across + column] = least
            }
        }
        return near
    }

    private var flows = FloatArray(0)

    /** The flow of `layer` now, worked out at every `FLOW_EVERY`th dot each way: it changes slowly across the wall. */
    private fun flow(layer: Int, firstRow: Int, rows: Int, across: Int, every: Float, back: Float, aside: Float, scale: Float, tt: Float): FloatArray {
        val flowAcross = across / FLOW_EVERY + 2
        val flowRows = rows / FLOW_EVERY + 2
        if (flows.size < flowAcross * flowRows) flows = FloatArray(flowAcross * flowRows)
        for (b in 0 until flowRows) {
            val fy = (back + (firstRow + b * FLOW_EVERY) * every) / scale
            val warpX = fsin(fy * 1.3f + tt * 0.37f)
            for (a in 0 until flowAcross) {
                val fx = ((a * FLOW_EVERY - 1) * every + every / 2 + aside) / scale
                val qx = fx + 0.55f * warpX
                val qy = fy + 0.55f * fcos(fx * 1.1f - tt * 0.29f)
                flows[b * flowAcross + a] = 0.5f + 0.5f * (fsin(qx * 1.7f + tt * 0.21f) * fcos(qy * 1.4f - tt * 0.26f) * 0.6f +
                    fsin((qx + qy) * 2.3f + tt * 0.33f) * 0.25f + fsin((qx - qy * 0.7f) * 3.1f - tt * 0.4f) * 0.15f)
            }
        }
        return flows
    }

    /** A sine near enough for drawing, several times quicker than the exact one. */
    private fun fsin(v: Float): Float {
        var x = v % TWO_PI
        if (x > PI_F) x -= TWO_PI else if (x < -PI_F) x += TWO_PI
        val y = 1.2732395f * x - 0.40528473f * x * abs(x)
        return 0.225f * (y * abs(y) - y) + y
    }

    private fun fcos(v: Float): Float = fsin(v + PI_F / 2)

    /** `points` with (`x`, `y`) at `index`, grown when it is full. */
    private fun put(points: FloatArray, index: Int, x: Float, y: Float): FloatArray {
        val room = if (points.size < index * 2 + 2) points.copyOf(points.size * 2) else points
        room[index * 2] = x
        room[index * 2 + 1] = y
        return room
    }

    /** How far (`x`, `y`) is outside `r`, taken as a rounded tile; negative inside. */
    private fun roundedDistance(x: Float, y: Float, r: RectF): Float {
        val radius = min(26f * dp, min(r.width(), r.height()) / 2)
        val qx = abs(x - r.centerX()) - (r.width() / 2 - radius)
        val qy = abs(y - r.centerY()) - (r.height() / 2 - radius)
        return hypot(max(qx, 0f), max(qy, 0f)) + min(max(qx, qy), 0f) - radius
    }

    private fun smooth(a: Float, b: Float, x: Float): Float {
        val k = ((x - a) / (b - a)).coerceIn(0f, 1f)
        return k * k * (3 - 2 * k)
    }

    /** A number from 0 to 1 for each dot of the grid, the same every frame. */
    private fun hash(i: Int, j: Int, salt: Int): Float {
        var n = i * 374761393 + j * 668265263 + salt * 1442695041
        n = (n xor (n ushr 13)) * 1274126177
        return ((n xor (n ushr 16)) and 0xFFFFFF) / 16777216f
    }

    /** One field: a round shape whose edge rises and falls in a few slow waves, and trembles after a reading. */
    private fun field(canvas: Canvas, cx: Float, cy: Float, r: Float, color: Int, seed: Float) {
        // In the dark a field is a glow: a soft light, full at its heart and gone at its edge, that breathes.
        if (dark) {
            val rr = r * (1.05f + 0.05f * sin(t * 1.3f + seed) + tremble * 0.04f * sin(t * 9f))
            val c = color and 0x00FFFFFF
            glowPaint.shader = android.graphics.RadialGradient(cx, cy, rr, intArrayOf(c or (0x70 shl 24), c or (0x2A shl 24), c), floatArrayOf(0f, 0.5f, 1f), android.graphics.Shader.TileMode.CLAMP)
            canvas.drawCircle(cx, cy, rr, glowPaint)
            return
        }
        path.reset()
        val n = 48
        for (i in 0..n) {
            val a = i * 2 * PI.toFloat() / n
            val wobble = sin(a * 3 + t * 1.3f + seed) * 0.035f + sin(a * 5 - t + seed * 2) * 0.02f +
                tremble * sin(a * 11 + t * 9f) * 0.025f
            val rr = r * (1f + wobble)
            val x = cx + cos(a) * rr
            val y = cy + sin(a) * rr * 1.06f
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()
        paint.color = color
        canvas.drawPath(path, paint)
    }

    private companion object {
        /** The grid's spacing, in dp. */
        const val DOT_EVERY = 13f
        /** How many strengths the dots are drawn in, and the glints. */
        const val LEVELS = 12
        const val LIT_LEVELS = 4
        /** The share of the near dots that are glitter. */
        const val SEQUINS = 0.22f
        /** Every how many dots, each way, the flow is worked out; between, it is read off those. */
        const val FLOW_EVERY = 3
        /** How long the wall is drawn at half the rate once nothing moves, before a quarter. */
        const val QUIET_AFTER_NS = 8_000_000_000L
        /** How bright the night's smoke is while nothing is lent, of its full light (the user liked it dim, 2026-10-24). */
        const val IDLE_BRIGHT = 0.22f
        /** How long a wave runs, in seconds. */
        const val WAVE_LASTS = 2.8f
        /** The colours glitter catches the light in: the app's coral, a mint, a blue, an apricot. */
        const val PI_F = PI.toFloat()
        const val TWO_PI = (2 * PI).toFloat()
        val GLINTS = intArrayOf(0xFFE86A52.toInt(), 0xFF3FAF8F.toInt(), 0xFF4D86D9.toInt(), 0xFFE9A23B.toInt())
        val NIGHT_GLINTS = intArrayOf(0xFFFFFFFF.toInt(), 0xFFFFE7C9.toInt(), 0xFFD3E8FF.toInt(), 0xFFF2D6FF.toInt())
    }
}

/** The share tile's switch: a track, coral while on, and its knob, which slides across. */
class Switch(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dark = context.night()
    private var at = 0f
    /** In the dark, the colour it is when on: the accent of what the phone is doing; 0 for the key's. */
    var tint = 0
        set(value) { if (field != value) { field = value; invalidate() } }
    private var slide: ValueAnimator? = null
    var on = false
        set(value) {
            if (field == value) return
            field = value
            slide?.cancel()
            slide = ValueAnimator.ofFloat(at, if (value) 1f else 0f).apply {
                duration = 260; interpolator = DecelerateInterpolator()
                addUpdateListener { at = it.animatedValue as Float; invalidate() }
                start()
            }
        }

    override fun onDraw(canvas: Canvas) {
        // The switch stands `GLOW` in from its edges, the room its glow spreads into: drawn to the edge, the glow was
        // cut square there.
        val m = context.px(GLOW.toFloat())
        canvas.translate(m, m)
        val h = height.toFloat() - 2 * m
        val w = width.toFloat() - 2 * m
        val on = if (dark && tint != 0) tint else context.getColor(R.color.key)
        paint.color = blend(context.getColor(R.color.switch_off), on, at)
        // In the dark it glows: rings of its colour, fainter as they spread — a shadow layer drew a dark box about it.
        if (dark && at > 0f) {
            val glow = paint.color
            for (k in 4 downTo 1) {
                val spread = context.px(2.2f) * k
                paint.color = (on and 0x00FFFFFF) or ((22 * at * (5 - k) / 4f).toInt() shl 24)
                canvas.drawRoundRect(RectF(-spread, -spread, w + spread, h + spread), h / 2 + spread, h / 2 + spread, paint)
            }
            paint.color = glow
        }
        canvas.drawRoundRect(RectF(0f, 0f, w, h), h / 2, h / 2, paint)
        val r = h / 2 - context.px(4f)
        val x = h / 2 + (w - h) * at
        paint.color = Color.argb(40, 0, 0, 0)
        canvas.drawCircle(x, h / 2 + context.px(1.5f), r, paint)
        paint.color = context.getColor(R.color.knob)
        canvas.drawCircle(x, h / 2, r, paint)
    }

    companion object {
        /** The room left about the switch, in dp, for its glow: whoever lays it out adds it to each side. */
        const val GLOW = 10
    }
}

/**
 * Hearing, large: a dark tile holding water. Its surface is the voice — still while nothing is heard, moving while
 * the phone reads — and its level how far ahead of speech the phone keeps (half way: as fast as speech).
 */
class Water(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = Color.argb(56, 255, 255, 255); strokeWidth = context.px(1f)
        pathEffect = DashPathEffect(floatArrayOf(context.px(4f), context.px(4f)), 0f)
    }
    private val path = Path()
    private val clip = Path()
    private var t = 0f
    private var last = 0L
    private var shown = 0.35f
    /** Of the tile's height, how high the water stands. */
    var level = 0.35f
    /** Moving: the phone is reading now. */
    var moving = false
        set(value) { if (field != value) { field = value; invalidate() } }
    var running = false
        set(value) { field = value; last = 0L; invalidate() }
    private val radius = context.px(30f)

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else min(0.05f, (now - last) / 1e9f)
        last = now
        t += dt * if (moving) 2.4f else 0.5f
        shown += (level - shown) * min(1f, dt * 2f)
        val w = width.toFloat()
        val h = height.toFloat()
        paint.color = context.getColor(R.color.water_tile)
        canvas.drawRoundRect(RectF(0f, 0f, w, h), radius, radius, paint)
        // Under the number and its line, however low the tile: a low one (a phone on its side) had it through the line.
        val dashY = maxOf(h * 0.47f, context.px(96f))
        canvas.drawLine(context.px(16f), dashY, w - context.px(16f), dashY, dash)
        // Never over the line and what is written above it: in a low tile, half its height was.
        val top = maxOf(h * (1f - shown.coerceIn(0.12f, 0.5f)), dashY + context.px(12f))
        val swell = context.px(if (moving) 7f else 3f)
        canvas.save()
        clip.reset()
        clip.addRoundRect(RectF(0f, 0f, w, h), radius, radius, Path.Direction.CW)
        canvas.clipPath(clip)
        surface(canvas, w, h, top - context.px(5f), swell, 1.3f, context.getColor(R.color.water_deep))
        if (context.night()) paint.setShadowLayer(context.px(14f), 0f, 0f, context.getColor(R.color.water))
        surface(canvas, w, h, top, swell, 0f, context.getColor(R.color.water))
        paint.clearShadowLayer()
        canvas.restore()
        if (running) {
            // Still, it hardly moves: drawn every other frame, as the wall is when calm — each frame of it drew the
            // whole screen again, and a lent phone with its screen on spent a core on it.
            // Moving, every frame; still, in the wall's frames (`Wall.beside`).
            if (moving) postInvalidateOnAnimation()
        }
    }

    private fun surface(canvas: Canvas, w: Float, h: Float, y: Float, swell: Float, seed: Float, color: Int) {
        path.reset()
        path.moveTo(0f, h)
        // Across to the very edge: the last step lands on it, or the water stopped short there in a sliver.
        val steps = max(1, (w / context.px(6f)).toInt())
        for (i in 0..steps) {
            val k = i.toFloat() / steps
            path.lineTo(w * k, y + sin(k * 7f + t * 1.6f + seed) * swell + sin(k * 3f - t + seed) * swell * 0.6f)
        }
        path.lineTo(w, h)
        path.close()
        paint.color = color
        canvas.drawPath(path, paint)
    }
}

/** A sheet of lined paper: under the sentence it is written on, and its correction. */
fun Context.lined(): Drawable = object : Drawable() {
    private val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = getColor(R.color.sheet) }
    private val rule = Paint().apply { color = getColor(R.color.paper_rule); strokeWidth = px(1f) }
    private val radius = px(14f)
    override fun draw(canvas: Canvas) {
        val b = bounds
        canvas.drawRoundRect(RectF(b), radius, radius, paper)
        var y = b.top + px(31f)
        while (y < b.bottom - px(8f)) { canvas.drawLine(b.left + px(10f), y, b.right - px(10f), y, rule); y += px(22f) }
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(filter: android.graphics.ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
    override fun getOutline(outline: android.graphics.Outline) { outline.setRoundRect(bounds, radius) }
}

/** The small objects of the small tiles, one for each kind of work and for the computer's side and the check. */
class Thing(context: Context, private val kind: Kind) : View(context) {
    enum class Kind { WATER, PANES, NOTE, LENS, DIAL, TOGGLES, DOTS, FADERS, HALVES, COG }
    private val shapeClip = Path()

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    /** The lens: lit while a computer is connected. */
    var lit = false
        set(value) { if (field != value) { field = value; invalidate() } }
    /** The dial: how far ahead of speech, of three times. */
    var amount = 0f
        set(value) { if (field != value) { field = value; invalidate() } }

    private val dark = context.night()

    override fun onDraw(canvas: Canvas) {
        val s = min(width, height).toFloat()
        val d = context.px(1f)
        if (kind == Kind.FADERS || kind == Kind.HALVES || kind == Kind.COG) { settingsIcon(canvas, s, d); return }
        if (dark) { night(canvas, s, d); return }
        when (kind) {
            Kind.WATER -> {
                val r = RectF(s * 0.12f, s * 0.04f, s * 0.86f, s * 0.96f)
                paint.color = context.getColor(R.color.water_tile)
                canvas.drawRoundRect(r, s * 0.2f, s * 0.2f, paint)
                canvas.save()
                canvas.clipRect(r.left, r.top + r.height() * 0.58f, r.right, r.bottom)
                paint.color = context.getColor(R.color.water)
                canvas.drawRoundRect(r, s * 0.2f, s * 0.2f, paint)
                canvas.restore()
            }
            Kind.PANES -> {
                paint.color = (context.getColor(R.color.field_apricot_deep) and 0x00FFFFFF) or (0x8C shl 24)
                canvas.drawRoundRect(RectF(s * 0.02f, s * 0.02f, s * 0.64f, s * 0.64f), s * 0.18f, s * 0.18f, paint)
                paint.setShadowLayer(d * 4, 0f, d * 2, Color.argb(50, 150, 100, 40))
                paint.color = Color.argb(240, 255, 255, 255)
                canvas.drawRoundRect(RectF(s * 0.32f, s * 0.32f, s * 0.94f, s * 0.94f), s * 0.18f, s * 0.18f, paint)
                paint.clearShadowLayer()
            }
            Kind.NOTE -> {
                paint.setShadowLayer(d * 4, 0f, d * 2, Color.argb(45, 120, 80, 70))
                paint.color = Color.WHITE
                val r = RectF(s * 0.12f, s * 0.08f, s * 0.82f, s * 0.96f)
                canvas.drawRoundRect(r, s * 0.12f, s * 0.12f, paint)
                paint.clearShadowLayer()
                paint.color = context.getColor(R.color.paper_rule)
                var y = r.top + s * 0.28f
                while (y < r.bottom - s * 0.1f) { canvas.drawRect(r.left + s * 0.1f, y, r.right - s * 0.1f, y + d, paint); y += s * 0.18f }
                paint.color = context.getColor(R.color.ink_red)
                canvas.drawCircle(r.right - s * 0.02f, r.top + s * 0.02f, s * 0.11f, paint)
            }
            Kind.LENS -> {
                paint.setShadowLayer(d * 4, 0f, d * 2, Color.argb(60, 0, 0, 0))
                paint.color = context.getColor(R.color.lens)
                canvas.drawCircle(s / 2, s / 2, s * 0.46f, paint)
                paint.clearShadowLayer()
                paint.color = context.getColor(R.color.lens_inner)
                canvas.drawCircle(s / 2, s / 2, s * 0.29f, paint)
                paint.color = context.getColor(if (lit) R.color.water else R.color.lens)
                if (lit) paint.setShadowLayer(s * 0.16f, 0f, 0f, context.getColor(R.color.water))
                canvas.drawCircle(s / 2, s / 2, s * 0.12f, paint)
                paint.clearShadowLayer()
            }
            Kind.TOGGLES -> {
                // The settings: two small switches, the upper one on in coral, the lower off — the share tile's switch,
                // in small.
                val tall = s * 0.3f
                val wide = s * 0.78f
                val left = s * 0.11f
                for ((i, on) in listOf(true, false).withIndex()) {
                    val y = s * (0.15f + 0.4f * i)
                    paint.color = context.getColor(if (on) R.color.key else R.color.switch_off)
                    canvas.drawRoundRect(RectF(left, y, left + wide, y + tall), tall / 2, tall / 2, paint)
                    paint.setShadowLayer(d * 2, 0f, d, Color.argb(50, 0, 0, 0))
                    paint.color = context.getColor(R.color.knob)
                    canvas.drawCircle(if (on) left + wide - tall / 2 else left + tall / 2, y + tall / 2, tall / 2 - s * 0.045f, paint)
                    paint.clearShadowLayer()
                }
            }
            Kind.FADERS, Kind.HALVES, Kind.COG -> {}
            Kind.DOTS -> {
                paint.color = context.getColor(R.color.ink_2)
                for (k in 0..2) canvas.drawCircle(s * (0.24f + 0.26f * k), s / 2, s * 0.075f, paint)
            }
            Kind.DIAL -> {
                paint.color = context.getColor(R.color.dial)
                canvas.drawCircle(s / 2, s / 2, s * 0.46f, paint)
                stroke.color = context.getColor(R.color.dial_edge); stroke.strokeWidth = d; stroke.strokeCap = Paint.Cap.BUTT
                canvas.drawCircle(s / 2, s / 2, s * 0.46f, stroke)
                // The red mark where speech is: once as fast, a third of the way round.
                val mark = (-210f + 240f / 3f) * PI.toFloat() / 180f
                paint.color = context.getColor(R.color.ink_red)
                canvas.drawCircle(s / 2 + cos(mark) * s * 0.33f, s / 2 + sin(mark) * s * 0.33f, s * 0.055f, paint)
                val a = (-210f + 240f * amount.coerceIn(0f, 1f)) * PI.toFloat() / 180f
                stroke.color = context.getColor(R.color.dial_hand); stroke.strokeWidth = s * 0.06f; stroke.strokeCap = Paint.Cap.ROUND
                canvas.drawLine(s / 2, s / 2, s / 2 + cos(a) * s * 0.32f, s / 2 + sin(a) * s * 0.32f, stroke)
            }
        }
    }

    /**
     * The object as the night has it: a surface of the page's blue a shade lighter (`face`), its rim lighter still,
     * and the light (`glow`) only where it gives it — the water, the lit lens, the dial's mark, the switch that is on,
     * the note's dot. In its day's colours it looked like a sticker on the night (the user, 2026-10-23).
     */
    private fun night(canvas: Canvas, s: Float, d: Float) {
        val face = context.getColor(R.color.dial)
        val rim = context.getColor(R.color.dial_edge)
        val glow = context.getColor(R.color.key)
        val pale = context.getColor(R.color.ink_2)
        val c = s / 2
        stroke.strokeWidth = d * 1.3f
        stroke.strokeCap = Paint.Cap.ROUND
        fun lit(color: Int, radius: Float) = paint.setShadowLayer(radius, 0f, 0f, color)
        when (kind) {
            Kind.WATER -> {
                val r = RectF(s * 0.14f, s * 0.06f, s * 0.84f, s * 0.94f)
                paint.color = face; canvas.drawRoundRect(r, s * 0.2f, s * 0.2f, paint)
                canvas.save(); canvas.clipRect(r.left, r.top + r.height() * 0.58f, r.right, r.bottom)
                paint.color = context.getColor(R.color.water); lit(paint.color, s * 0.12f)
                canvas.drawRoundRect(r, s * 0.2f, s * 0.2f, paint); paint.clearShadowLayer(); canvas.restore()
                stroke.color = rim; canvas.drawRoundRect(r, s * 0.2f, s * 0.2f, stroke)
            }
            Kind.PANES -> {
                val back = RectF(s * 0.04f, s * 0.04f, s * 0.64f, s * 0.64f)
                val front = RectF(s * 0.32f, s * 0.32f, s * 0.94f, s * 0.94f)
                paint.color = face; canvas.drawRoundRect(back, s * 0.18f, s * 0.18f, paint)
                stroke.color = rim; canvas.drawRoundRect(back, s * 0.18f, s * 0.18f, stroke)
                paint.color = (glow and 0x00FFFFFF) or (0x40 shl 24); canvas.drawRoundRect(front, s * 0.18f, s * 0.18f, paint)
                stroke.color = (glow and 0x00FFFFFF) or (0xB0 shl 24); canvas.drawRoundRect(front, s * 0.18f, s * 0.18f, stroke)
            }
            Kind.NOTE -> {
                val r = RectF(s * 0.14f, s * 0.08f, s * 0.82f, s * 0.94f)
                paint.color = face; canvas.drawRoundRect(r, s * 0.12f, s * 0.12f, paint)
                stroke.color = rim; canvas.drawRoundRect(r, s * 0.12f, s * 0.12f, stroke)
                var y = r.top + s * 0.28f
                while (y < r.bottom - s * 0.1f) { canvas.drawLine(r.left + s * 0.12f, y, r.right - s * 0.12f, y, stroke); y += s * 0.18f }
                paint.color = glow; lit(glow, s * 0.1f); canvas.drawCircle(r.right - s * 0.02f, r.top + s * 0.02f, s * 0.09f, paint); paint.clearShadowLayer()
            }
            Kind.LENS -> {
                paint.color = face; canvas.drawCircle(c, c, s * 0.44f, paint)
                stroke.color = rim; canvas.drawCircle(c, c, s * 0.44f, stroke); canvas.drawCircle(c, c, s * 0.27f, stroke)
                paint.color = if (lit) context.getColor(R.color.water) else rim
                if (lit) lit(paint.color, s * 0.18f)
                canvas.drawCircle(c, c, s * 0.11f, paint); paint.clearShadowLayer()
            }
            Kind.DIAL -> {
                paint.color = face; canvas.drawCircle(c, c, s * 0.44f, paint)
                stroke.color = rim; canvas.drawCircle(c, c, s * 0.44f, stroke)
                val mark = (-210f + 240f / 3f) * PI.toFloat() / 180f
                paint.color = glow; lit(glow, s * 0.08f)
                canvas.drawCircle(c + cos(mark) * s * 0.32f, c + sin(mark) * s * 0.32f, s * 0.05f, paint); paint.clearShadowLayer()
                val a = (-210f + 240f * amount.coerceIn(0f, 1f)) * PI.toFloat() / 180f
                stroke.color = context.getColor(R.color.dial_hand); stroke.strokeWidth = s * 0.06f
                canvas.drawLine(c, c, c + cos(a) * s * 0.3f, c + sin(a) * s * 0.3f, stroke)
            }
            Kind.TOGGLES -> {
                val tall = s * 0.3f
                val wide = s * 0.78f
                val left = s * 0.11f
                for ((i, on) in listOf(true, false).withIndex()) {
                    val y = s * (0.15f + 0.4f * i)
                    paint.color = if (on) glow else face
                    if (on) lit(glow, s * 0.1f)
                    canvas.drawRoundRect(RectF(left, y, left + wide, y + tall), tall / 2, tall / 2, paint); paint.clearShadowLayer()
                    if (!on) { stroke.color = rim; canvas.drawRoundRect(RectF(left, y, left + wide, y + tall), tall / 2, tall / 2, stroke) }
                    paint.color = if (on) context.getColor(R.color.wall) else pale
                    canvas.drawCircle(if (on) left + wide - tall / 2 else left + tall / 2, y + tall / 2, tall / 2 - s * 0.05f, paint)
                }
            }
            Kind.FADERS, Kind.HALVES, Kind.COG -> {}
            Kind.DOTS -> {
                paint.color = pale
                for (k in 0..2) canvas.drawCircle(s * (0.24f + 0.26f * k), c, s * 0.075f, paint)
            }
        }
    }

    /**
     * The settings' object, of three the user is shown to choose from (2026-10-24): faders on a small desk, a disc
     * half day and half night, or a soft gear of round lobes. Drawn alike by day and by night, in the objects' own faces.
     */
    private fun settingsIcon(canvas: Canvas, s: Float, d: Float) {
        val face = context.getColor(R.color.dial)
        val rim = context.getColor(R.color.dial_edge)
        val key = context.getColor(R.color.key)
        val ink = context.getColor(R.color.dial_hand)
        val c = s / 2
        stroke.strokeCap = Paint.Cap.ROUND
        when (kind) {
            Kind.FADERS -> {
                val r = RectF(s * 0.06f, s * 0.1f, s * 0.94f, s * 0.9f)
                paint.color = face; canvas.drawRoundRect(r, s * 0.18f, s * 0.18f, paint)
                stroke.color = rim; stroke.strokeWidth = d * 1.2f; canvas.drawRoundRect(r, s * 0.18f, s * 0.18f, stroke)
                for ((i, at) in listOf(0.38f, 0.64f, 0.46f).withIndex()) {
                    val x = s * (0.28f + 0.22f * i)
                    stroke.color = rim; stroke.strokeWidth = s * 0.05f
                    canvas.drawLine(x, s * 0.24f, x, s * 0.76f, stroke)
                    paint.color = if (i == 1) key else ink
                    canvas.drawRoundRect(RectF(x - s * 0.08f, s * at - s * 0.045f, x + s * 0.08f, s * at + s * 0.045f), s * 0.03f, s * 0.03f, paint)
                }
            }
            Kind.HALVES -> {
                val r = s * 0.42f
                paint.color = face; canvas.drawCircle(c, c, r, paint)
                canvas.save()
                shapeClip.reset(); shapeClip.addCircle(c, c, r, Path.Direction.CW)
                canvas.clipPath(shapeClip)
                paint.color = context.getColor(R.color.lens)
                canvas.drawRect(c, 0f, s, s, paint)
                canvas.restore()
                stroke.color = rim; stroke.strokeWidth = d * 1.2f; canvas.drawCircle(c, c, r, stroke)
                // A small sun on the day's half and a moon's sliver on the night's.
                paint.color = key; canvas.drawCircle(c - r * 0.45f, c, s * 0.07f, paint)
                paint.color = face; canvas.drawCircle(c + r * 0.45f, c, s * 0.075f, paint)
                paint.color = context.getColor(R.color.lens); canvas.drawCircle(c + r * 0.52f, c - s * 0.03f, s * 0.065f, paint)
            }
            else -> {
                // A soft gear: round lobes about a disc, a coral hub.
                paint.color = face
                for (k in 0 until 6) {
                    val a = k * PI.toFloat() / 3f
                    canvas.drawCircle(c + cos(a) * s * 0.3f, c + sin(a) * s * 0.3f, s * 0.13f, paint)
                }
                canvas.drawCircle(c, c, s * 0.32f, paint)
                stroke.color = rim; stroke.strokeWidth = d * 1.2f; canvas.drawCircle(c, c, s * 0.32f, stroke)
                paint.color = key; canvas.drawCircle(c, c, s * 0.12f, paint)
                paint.color = face; canvas.drawCircle(c, c, s * 0.05f, paint)
            }
        }
    }
}

/** How far a self-check has come: a thin groove, filled with the coral of the key. */
class Bar(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var done = 0f
        set(value) { field = value.coerceIn(0f, 1f); invalidate() }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(context.px(6), heightSpec))

    override fun onDraw(canvas: Canvas) {
        val r = height / 2f
        paint.color = context.getColor(R.color.switch_off)
        canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), r, r, paint)
        if (done <= 0f) return
        paint.color = context.getColor(R.color.key)
        canvas.drawRoundRect(RectF(0f, 0f, max(height.toFloat(), width * done), height.toFloat()), r, r, paint)
    }
}

/**
 * How fast the phone hears, against speech itself: a track to 4×, filled to the speed — green where it keeps up, coral
 * where it does not — and marked at 1×, where it keeps up exactly.
 */
class Meter(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val words = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = context.px(10.5f); color = context.getColor(R.color.ink_3) }
    var speed = 0f
        set(value) { field = value; invalidate() }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(context.px(36), heightSpec))

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val thick = context.px(6f)
        // Room above the track for its glow in the dark.
        val top = context.px(9f)
        val r = thick / 2
        paint.color = context.getColor(R.color.switch_off)
        canvas.drawRoundRect(RectF(0f, top, w, top + thick), r, r, paint)
        paint.color = context.getColor(if (speed >= 1f) R.color.good else R.color.key)
        if (context.night()) paint.setShadowLayer(context.px(6f), 0f, 0f, paint.color)
        canvas.drawRoundRect(RectF(0f, top, max(thick, w * (speed / MOST).coerceIn(0f, 1f)), top + thick), r, r, paint)
        paint.clearShadowLayer()
        // Real time: a mark across the track, and its word under it.
        val at = w / MOST
        paint.color = context.getColor(R.color.ink_2)
        canvas.drawRoundRect(RectF(at - context.px(1f), top - context.px(4f), at + context.px(1f), top + thick + context.px(4f)), context.px(1f), context.px(1f), paint)
        val label = "实时 1×"
        canvas.drawText(label, at - words.measureText(label) / 2, height - context.px(2f), words)
        val end = "${MOST.toInt()}×"
        canvas.drawText(end, w - words.measureText(end), height - context.px(2f), words)
    }

    private companion object {
        const val MOST = 4f
    }
}

/**
 * Small tiles in rows of `columns`, each `cell` high, `gap` apart: a hidden one takes no place, so the tiles shown
 * close up. How many to a row is the page's choice (`MainActivity.arrange`): two on a phone, four on a tablet. With
 * `stretch`, given a height, the rows share it, none lower than `cell`. Fewer tiles shown than `columns` take the
 * row between them (two of four on a tablet, not lent, were left in its left half), and so does a last row with
 * fewer than the others (three tiles two to a row left an empty half).
 */
class TileGrid(context: Context) : android.view.ViewGroup(context) {
    var columns = 2
    var cell = 0
    var gap = 0
    var stretch = false
    /** Each row's height, as last measured. */
    private var high = 0

    private fun shown() = (0 until childCount).map(::getChildAt).filter { it.visibility != View.GONE }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val width = MeasureSpec.getSize(widthSpec)
        val tiles = shown()
        val columns = across()
        val rows = (tiles.size + columns - 1) / columns
        high = if (stretch && rows > 0 && MeasureSpec.getMode(heightSpec) == MeasureSpec.EXACTLY) {
            max(cell, (MeasureSpec.getSize(heightSpec) - (rows - 1) * gap) / rows)
        } else cell
        tiles.forEachIndexed { i, tile -> tile.measure(MeasureSpec.makeMeasureSpec(wide(i, tiles.size, columns, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(high, MeasureSpec.EXACTLY)) }
        setMeasuredDimension(width, if (rows == 0) 0 else rows * high + (rows - 1) * gap)
    }

    /** How many to a row: `columns`, or as many as there are when fewer, but never one alone. */
    private fun across() = shown().size.coerceIn(minOf(2, columns), columns)

    /** How wide the `i`th of `count` tiles is: a last row with fewer than `columns` shares the row between them. */
    private fun wide(i: Int, count: Int, columns: Int, width: Int): Int {
        val inRow = minOf(columns, count - i / columns * columns)
        return ((width - gap * (inRow - 1)) / inRow).coerceAtLeast(0)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val tiles = shown()
        val columns = across()
        tiles.forEachIndexed { i, tile ->
            val w = wide(i, tiles.size, columns, width)
            val x = (i % columns) * (w + gap)
            val y = (i / columns) * (high + gap)
            tile.layout(x, y, x + w, y + high)
        }
    }
}
