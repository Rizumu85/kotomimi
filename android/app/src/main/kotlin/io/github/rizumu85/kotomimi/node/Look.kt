package io.github.rizumu85.kotomimi.node

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.animation.DecelerateInterpolator
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

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

/** A rounded face of one colour, with an edge where one is given. */
fun Context.flat(color: Int, radius: Int, alpha: Int = 255, edge: Int? = null): Drawable =
    GradientDrawable().apply {
        setColor(getColor(color))
        cornerRadius = px(radius).toFloat()
        this.alpha = alpha
        if (edge != null) setStroke(px(1), getColor(edge))
    }

/** `a` toward `b` by `t`, alpha and all. */
fun blend(a: Int, b: Int, t: Float): Int {
    fun ch(shift: Int) = (((a ushr shift) and 0xFF) * (1 - t) + ((b ushr shift) and 0xFF) * t).toInt() and 0xFF
    return (ch(24) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
}

/** What the wallpaper is coloured by: what the phone is doing. */
enum class Mood { IDLE, HEAR, TRANSLATE, COACH }

/**
 * The wallpaper, and part of the app: large soft fields of colour under a fine grid of dots, coloured by what the phone is
 * doing and always slowly moving — slower while nothing is lent. It answers what happens: a reading heard sets the
 * fields' edges trembling, a sentence translated sends a light sweeping across, a correction spreads like a drop of
 * red ink, and a touch on it rings out from the finger. The page scrolling moves the fields a little behind it, and
 * the dots less still: a grid held further back. (Dots in place of a grain the user took for them, 2026-10-23: a
 * touch of the technical against the soft fields.)
 */
class Wall(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val grid = BitmapShader(dotTile(), Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
    private val dots = Paint().apply { shader = grid }
    private val gridAt = android.graphics.Matrix()
    private val path = Path()

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

    /** Runs while the screen is seen: `MainActivity` stops it when it is not. */
    var running = false
        set(value) { field = value; last = 0L; if (value) invalidate() }

    fun moodFor(next: Mood) {
        if (next == mood) return
        mood = next
        from = current()
        to = colours(next)
        turned = 0f
    }

    /** Something was done: the wallpaper answers it in the way of that work. */
    fun pulse(task: Task, x: Float = width * 0.5f, y: Float = height * 0.55f) {
        when (task) {
            Task.HEAR -> tremble = 1f
            Task.TRANSLATE -> sweep = 0f
            Task.COACH -> drops += Drop(x, y, context.getColor(R.color.ink_red))
        }
    }

    /** A touch on the wallpaper rings out from the finger. */
    fun touched(x: Float, y: Float) {
        drops += Drop(x, y, Color.WHITE)
    }

    private fun current(): IntArray = IntArray(3) { blend(from[it], to[it], turned) }

    private fun colours(m: Mood): IntArray = when (m) {
        Mood.IDLE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_mint_pale), context.getColor(R.color.field_blue))
        Mood.HEAR -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_mint), context.getColor(R.color.field_blue))
        Mood.TRANSLATE -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_apricot), context.getColor(R.color.field_blue))
        Mood.COACH -> intArrayOf(context.getColor(R.color.wall), context.getColor(R.color.field_coral), context.getColor(R.color.field_lilac))
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (last == 0L) 0f else min(0.05f, (now - last) / 1e9f)
        last = now
        t += dt * pace
        if (turned < 1f) turned = min(1f, turned + dt / 0.9f)
        tremble = max(0f, tremble - dt * 1.2f)
        if (sweep >= 0f) sweep = if (sweep > 1.3f) -1f else sweep + dt / 1.1f
        drops.forEach { it.age += dt }
        drops.removeAll { it.age > 1.6f }

        val c = current()
        val w = width.toFloat()
        val h = height.toFloat()
        val shift = -scrolled * 0.12f
        canvas.drawColor(c[0])
        // The first field, up and to the left; the second, lower right. Each a round shape whose edge breathes.
        field(canvas, w * 0.08f + sin(t * 0.7f) * w * 0.05f, h * 0.06f + shift + cos(t * 0.5f) * w * 0.04f, w * 0.78f, c[1], 0f)
        field(canvas, w * 1.0f + cos(t * 0.6f) * w * 0.05f, h * 0.68f + shift * 1.5f + sin(t * 0.45f) * w * 0.05f, w * 0.72f, c[2], 2.1f)

        // A sentence translated: a band of light sweeps across, left to right.
        if (sweep in 0f..1.3f) {
            val x = -w * 0.3f + sweep * w * 1.6f
            paint.color = Color.argb((70 * sin(min(1f, sweep) * PI).toFloat()).toInt().coerceAtLeast(0), 255, 255, 255)
            path.reset()
            path.moveTo(x, 0f); path.lineTo(x + w * 0.22f, 0f); path.lineTo(x + w * 0.02f, h); path.lineTo(x - w * 0.2f, h); path.close()
            canvas.drawPath(path, paint)
        }
        // Drops: a correction's red ink, or a touch, spreading out in a ring.
        for (d in drops) {
            val k = d.age / 1.6f
            val fade = (1f - k).coerceIn(0f, 1f)
            ring.color = blend(d.color and 0x00FFFFFF, d.color, fade * if (d.color == Color.WHITE) 0.8f else 0.55f)
            ring.strokeWidth = context.px(2f) + k * context.px(10f)
            canvas.drawCircle(d.x, d.y, context.px(12f) + k * w * 0.55f, ring)
            if (d.color != Color.WHITE) {
                paint.color = blend(d.color and 0x00FFFFFF, d.color, fade * 0.12f)
                canvas.drawCircle(d.x, d.y, context.px(10f) + k * w * 0.4f, paint)
            }
        }
        gridAt.setTranslate(0f, -scrolled * 0.05f)
        grid.setLocalMatrix(gridAt)
        canvas.drawRect(0f, 0f, w, h, dots)
        if (running) postInvalidateOnAnimation()
    }

    /** One field: a round shape whose edge rises and falls in a few slow waves, and trembles after a reading. */
    private fun field(canvas: Canvas, cx: Float, cy: Float, r: Float, color: Int, seed: Float) {
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

    /** One cell of the grid: a small soft dot in a square of nothing, repeated over the whole wall. */
    private fun dotTile(): Bitmap {
        val size = context.px(DOT_EVERY).coerceAtLeast(6)
        val tile = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(tile)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(46, 40, 52, 70) }
        canvas.drawCircle(size / 2f, size / 2f, context.px(1.05f), paint)
        return tile
    }

    private companion object {
        /** The grid's spacing, in dp. */
        const val DOT_EVERY = 13
    }
}

/** The share tile's switch: a track, coral while on, and its knob, which slides across. */
class Switch(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var at = 0f
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
        val h = height.toFloat()
        val w = width.toFloat()
        paint.color = blend(context.getColor(R.color.switch_off), context.getColor(R.color.key), at)
        canvas.drawRoundRect(RectF(0f, 0f, w, h), h / 2, h / 2, paint)
        val r = h / 2 - context.px(4f)
        val x = h / 2 + (w - h) * at
        paint.color = Color.argb(40, 0, 0, 0)
        canvas.drawCircle(x, h / 2 + context.px(1.5f), r, paint)
        paint.color = context.getColor(R.color.tile)
        canvas.drawCircle(x, h / 2, r, paint)
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
        val dashY = h * 0.47f
        canvas.drawLine(context.px(16f), dashY, w - context.px(16f), dashY, dash)
        val top = h * (1f - shown.coerceIn(0.12f, 0.5f))
        val swell = context.px(if (moving) 7f else 3f)
        canvas.save()
        clip.reset()
        clip.addRoundRect(RectF(0f, 0f, w, h), radius, radius, Path.Direction.CW)
        canvas.clipPath(clip)
        surface(canvas, w, h, top - context.px(5f), swell, 1.3f, context.getColor(R.color.water_deep))
        surface(canvas, w, h, top, swell, 0f, context.getColor(R.color.water))
        canvas.restore()
        if (running) postInvalidateOnAnimation()
    }

    private fun surface(canvas: Canvas, w: Float, h: Float, y: Float, swell: Float, seed: Float, color: Int) {
        path.reset()
        path.moveTo(0f, h)
        var x = 0f
        while (x <= w) {
            val k = x / w
            path.lineTo(x, y + sin(k * 7f + t * 1.6f + seed) * swell + sin(k * 3f - t + seed) * swell * 0.6f)
            x += context.px(6f)
        }
        path.lineTo(w, h)
        path.close()
        paint.color = color
        canvas.drawPath(path, paint)
    }
}

/** A sheet of lined paper: under the sentence it is written on, and its correction. */
fun Context.lined(): Drawable = object : Drawable() {
    private val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
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
    enum class Kind { WATER, PANES, NOTE, LENS, DIAL }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    /** The lens: lit while a computer is connected. */
    var lit = false
        set(value) { if (field != value) { field = value; invalidate() } }
    /** The dial: how far ahead of speech, of three times. */
    var amount = 0f
        set(value) { if (field != value) { field = value; invalidate() } }

    override fun onDraw(canvas: Canvas) {
        val s = min(width, height).toFloat()
        val d = context.px(1f)
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
                stroke.color = context.getColor(R.color.ink); stroke.strokeWidth = s * 0.06f; stroke.strokeCap = Paint.Cap.ROUND
                canvas.drawLine(s / 2, s / 2, s / 2 + cos(a) * s * 0.32f, s / 2 + sin(a) * s * 0.32f, stroke)
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
