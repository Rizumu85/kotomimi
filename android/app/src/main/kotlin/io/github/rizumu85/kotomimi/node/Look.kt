package io.github.rizumu85.kotomimi.node

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The look the user settled on (`.dev/phone-node/DESIGN.md`, the apricot-and-mint mockup of 2026-10-10): flat
 * skeuomorphism — objects stand for what they do, with a little volume and no gradients, gloss or outline icons.
 * Volume is one thing only: a second, deeper face under the first (`faced`), for the body, the key, the card and the
 * box alike. Everything here is drawn: the app carries no images.
 */

/** Pixels of `dp` on this screen. */
fun Context.px(dp: Float): Float = dp * resources.displayMetrics.density
fun Context.px(dp: Int): Int = (dp * resources.displayMetrics.density + 0.5f).toInt()

/** A face of `color` with a deeper one `depth` dp under it: the one way this look gives anything volume. */
fun Context.faced(color: Int, deep: Int, radius: Int, depth: Int): Drawable {
    fun face(c: Int) = GradientDrawable().apply { setColor(getColor(c)); cornerRadius = px(radius).toFloat() }
    return LayerDrawable(arrayOf(face(deep), face(color))).apply { setLayerInset(1, 0, 0, 0, px(depth)) }
}

/** A flat face: a widget's white, a screen's dark. */
fun Context.flat(color: Int, radius: Int, alpha: Int = 255): Drawable =
    GradientDrawable().apply { setColor(getColor(color)); cornerRadius = px(radius).toFloat(); this.alpha = alpha }

/**
 * The room the phone stands in: a pale wall with the apricot rings of a sound spreading through it. While the phone
 * is at work the rings breathe a little.
 */
class Room(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var breath = 0f
    private val breathing = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 2600; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE
        addUpdateListener { breath = it.animatedValue as Float; invalidate() }
    }

    var working = false
        set(value) {
            if (field == value) return
            field = value
            if (value) breathing.start() else { breathing.cancel(); breath = 0f; invalidate() }
        }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(context.getColor(R.color.room_3))
        val w = width.toFloat()
        val cx = w * 0.62f
        val cy = height * 0.72f
        val grow = 1f + breath * 0.025f
        paint.color = context.getColor(R.color.room_4)
        canvas.drawCircle(cx, cy, w * 1.25f * grow, paint)
        paint.color = context.getColor(R.color.room_2)
        canvas.drawCircle(cx, cy, w * 0.95f * grow, paint)
        paint.color = context.getColor(R.color.room_1)
        canvas.drawCircle(cx, cy, w * 0.62f * grow, paint)
    }

    override fun onDetachedFromWindow() { breathing.cancel(); super.onDetachedFromWindow() }
}

/**
 * The row of dots along the foot of the screen — the sound wave at rest. Off: dim. Loading or checking: lit one by
 * one as far as it has come. Waiting for a computer: a light runs along them. At work: the same dots grow into a
 * wave.
 */
class Dots(context: Context) : View(context) {
    enum class Mode { OFF, PROGRESS, WAITING, WAVE }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private var mode = Mode.OFF
    private var lit = 0f
    private var phase = 0f
    private val clock = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1800; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
        addUpdateListener { phase = it.animatedValue as Float; invalidate() }
    }

    fun show(next: Mode, fraction: Float = 0f) {
        lit = fraction.coerceIn(0f, 1f)
        if (next == mode) { invalidate(); return }
        mode = next
        if (next == Mode.WAITING || next == Mode.WAVE) clock.start() else clock.cancel()
        invalidate()
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(context.px(30), heightSpec))

    override fun onDraw(canvas: Canvas) {
        val dot = context.px(3f)
        val gap = context.px(8.5f)
        val count = max(8, ((width - dot) / gap).toInt() + 1)
        val start = (width - (count - 1) * gap) / 2f
        val mid = height / 2f
        val on = context.getColor(R.color.glow)
        // At rest the dots are there to be seen, only dim.
        val off = blend(context.getColor(R.color.led_off), on, 0.3f)
        for (i in 0 until count) {
            val x = start + i * gap
            val at = i / (count - 1f)
            when (mode) {
                Mode.OFF -> { paint.color = off; canvas.drawCircle(x, mid, dot / 2, paint) }
                Mode.PROGRESS -> { paint.color = if (at <= lit) on else off; canvas.drawCircle(x, mid, dot / 2, paint) }
                Mode.WAITING -> {
                    // A soft light that runs left to right and round again.
                    val near = 1f - min(1f, abs(at - phase) * 5f)
                    paint.color = blend(off, on, 0.35f + 0.65f * near)
                    canvas.drawCircle(x, mid, dot / 2, paint)
                }
                Mode.WAVE -> {
                    // Higher in the middle, moving: two sines at different paces read as a voice, not a pendulum.
                    val shape = sin(at * PI).toFloat()
                    val swing = abs(sin((at * 7f + phase * 2f) * PI.toFloat()) * 0.6f + sin((at * 3f - phase) * 2f * PI.toFloat()) * 0.4f)
                    val half = max(dot / 2, (height / 2f - dot) * shape * (0.25f + 0.75f * swing))
                    paint.color = on
                    paint.strokeWidth = dot
                    canvas.drawLine(x, mid - half, x, mid + half, paint)
                }
            }
        }
    }

    override fun onDetachedFromWindow() { clock.cancel(); super.onDetachedFromWindow() }
}

/** A small round light: lit while the phone is lent. */
class Led(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var on = false
        set(value) { field = value; invalidate() }

    override fun onDraw(canvas: Canvas) {
        val r = min(width, height) / 2f
        paint.color = context.getColor(R.color.led_off)
        canvas.drawCircle(width / 2f, height / 2f, r, paint)
        paint.color = context.getColor(if (on) R.color.glow else R.color.screen_ink_3)
        canvas.drawCircle(width / 2f, height / 2f, r * 0.55f, paint)
    }
}

/** The model card's chip: a card with a cut corner and its contacts, in the body's deeper green. */
class Chip(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val r = context.px(5f)
        val cut = w * 0.34f
        path.reset()
        path.moveTo(r, 0f)
        path.lineTo(w - cut, 0f)
        path.lineTo(w, cut)
        path.lineTo(w, h - r)
        path.quadTo(w, h, w - r, h)
        path.lineTo(r, h)
        path.quadTo(0f, h, 0f, h - r)
        path.lineTo(0f, r)
        path.quadTo(0f, 0f, r, 0f)
        paint.color = context.getColor(R.color.body_deep)
        canvas.drawPath(path, paint)
        paint.color = context.getColor(R.color.tile)
        val pad = w * 0.22f
        canvas.drawRoundRect(RectF(pad, h * 0.48f, w - pad, h * 0.8f), r * 0.6f, r * 0.6f, paint)
        paint.color = context.getColor(R.color.body_deep)
        val step = (w - 2 * pad) / 4f
        for (i in 1..3) canvas.drawRect(pad + i * step - context.px(0.7f), h * 0.48f, pad + i * step + context.px(0.7f), h * 0.8f, paint)
    }
}

/** The small mark at the card's right: it opens, the way an eject key does. */
class Eject(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        paint.color = context.getColor(R.color.body_deep)
        path.reset()
        path.moveTo(w * 0.5f, h * 0.22f)
        path.lineTo(w * 0.82f, h * 0.58f)
        path.lineTo(w * 0.18f, h * 0.58f)
        path.close()
        canvas.drawPath(path, paint)
        canvas.drawRoundRect(RectF(w * 0.18f, h * 0.68f, w * 0.82f, h * 0.8f), h * 0.05f, h * 0.05f, paint)
    }
}

/** The speaker grille beside the key: rows of small holes. */
class Grille(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        paint.color = context.getColor(R.color.body_deep)
        val gap = context.px(7f)
        val r = context.px(1.6f)
        var y = r
        while (y <= height - r) {
            var x = r
            while (x <= width - r) { canvas.drawCircle(x, y, r, paint); x += gap }
            y += gap
        }
    }
}

/**
 * The power key: round, coral, standing on its deeper face, with the power mark. Pressed, it goes down onto that face,
 * as a key does; let go, it comes back up.
 */
@SuppressLint("ClickableViewAccessibility")
class PowerKey(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val mark = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private var down = false
    /** Lit: the phone is lent. */
    var lit = false
        set(value) { field = value; invalidate() }

    init {
        isClickable = true
        setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { down = true; invalidate() }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { down = false; invalidate() }
            }
            false
        }
    }

    override fun onDraw(canvas: Canvas) {
        val depth = context.px(5f)
        val r = min(width.toFloat(), height - depth) / 2f
        val cx = width / 2f
        val top = if (down) depth * 0.8f else 0f
        paint.color = context.getColor(R.color.key_deep)
        canvas.drawCircle(cx, r + depth, r, paint)
        paint.color = context.getColor(R.color.key)
        canvas.drawCircle(cx, r + top, r, paint)
        mark.color = context.getColor(R.color.tile)
        mark.strokeWidth = r * 0.12f
        val m = r * 0.38f
        val oval = RectF(cx - m, r + top - m, cx + m, r + top + m)
        canvas.drawArc(oval, -60f, 300f, false, mark)
        canvas.drawLine(cx, r + top - m * 1.25f, cx, r + top - m * 0.15f, mark)
    }
}

/**
 * The laptop of the "connect a device" widget, drawn straight on (one drawn at an angle read as crooked), with the
 * phone lying beside it. Faint while no computer uses the phone; solid, with the phone's light green, while one does.
 */
class Laptop(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var linked = false
        set(value) {
            field = value
            // Faint as a whole: faded colour by colour, the laptop showed through the phone lying on it.
            alpha = if (value) 1f else 0.5f
            invalidate()
        }

    init { alpha = 0.5f }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val s = min(w / 1.6f, h)
        val left = (w - s * 1.5f) / 2f
        val top = (h - s) / 2f + s * 0.06f
        fun color(id: Int) = context.getColor(id)
        // The lid: frame and screen.
        paint.color = color(R.color.laptop)
        canvas.drawRoundRect(RectF(left + s * 0.1f, top, left + s * 1.05f, top + s * 0.66f), s * 0.07f, s * 0.07f, paint)
        paint.color = color(R.color.laptop_screen)
        canvas.drawRoundRect(RectF(left + s * 0.17f, top + s * 0.07f, left + s * 0.98f, top + s * 0.59f), s * 0.04f, s * 0.04f, paint)
        // The base, a slab wider than the lid, on its deeper face.
        paint.color = color(R.color.laptop_deep)
        canvas.drawRoundRect(RectF(left, top + s * 0.68f, left + s * 1.15f, top + s * 0.8f), s * 0.05f, s * 0.05f, paint)
        paint.color = color(R.color.laptop)
        canvas.drawRoundRect(RectF(left, top + s * 0.66f, left + s * 1.15f, top + s * 0.76f), s * 0.05f, s * 0.05f, paint)
        // The phone beside it, lying down, with its light.
        paint.color = color(R.color.shell_deep)
        canvas.drawRoundRect(RectF(left + s * 0.92f, top + s * 0.5f, left + s * 1.5f, top + s * 0.86f), s * 0.07f, s * 0.07f, paint)
        paint.color = color(R.color.shell)
        canvas.drawRoundRect(RectF(left + s * 0.92f, top + s * 0.46f, left + s * 1.5f, top + s * 0.81f), s * 0.07f, s * 0.07f, paint)
        paint.color = context.getColor(if (linked) R.color.good else R.color.shell_deep)
        canvas.drawRoundRect(RectF(left + s * 1.0f, top + s * 0.6f, left + s * 1.14f, top + s * 0.65f), s * 0.03f, s * 0.03f, paint)
    }
}

/** The closed toolbox of the self-check widget: a lid, an orange band, and the red catch on its side. */
class Toolbox(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val bw = min(w * 0.82f, h * 1.75f)
        val bh = bw * 0.5f
        val left = (w - bw) / 2f
        val top = (h - bh) / 2f
        val r = bh * 0.22f
        paint.color = context.getColor(R.color.shell_deep)
        canvas.drawRoundRect(RectF(left, top + bh * 0.1f, left + bw, top + bh), r, r, paint)
        paint.color = context.getColor(R.color.shell)
        canvas.drawRoundRect(RectF(left, top, left + bw, top + bh * 0.9f), r, r, paint)
        paint.color = context.getColor(R.color.box)
        canvas.drawRect(left, top + bh * 0.36f, left + bw, top + bh * 0.54f, paint)
        paint.color = context.getColor(R.color.key)
        canvas.drawRoundRect(RectF(left + bw * 0.93f, top + bh * 0.27f, left + bw * 1.04f, top + bh * 0.63f), bh * 0.06f, bh * 0.06f, paint)
    }
}

/** How far a self-check has come, in the toolbox: a groove in the box's pale, filled with its orange. */
class Bar(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var done = 0f
        set(value) { field = value.coerceIn(0f, 1f); invalidate() }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), resolveSize(context.px(8), heightSpec))

    override fun onDraw(canvas: Canvas) {
        val r = height / 2f
        paint.color = context.getColor(R.color.shell)
        canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), height.toFloat()), r, r, paint)
        if (done <= 0f) return
        paint.color = context.getColor(R.color.box)
        canvas.drawRoundRect(RectF(0f, 0f, max(height.toFloat(), width * done), height.toFloat()), r, r, paint)
    }
}

/** `a` toward `b` by `t`. */
fun blend(a: Int, b: Int, t: Float): Int {
    fun ch(shift: Int) = (((a shr shift) and 0xFF) * (1 - t) + ((b shr shift) and 0xFF) * t).toInt() and 0xFF
    return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
}
