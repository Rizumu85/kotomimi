package io.github.rizumu85.kotomimi.node

import android.content.Context

/** What is remembered between runs: which model is shared, and what the self-check found of each. */
class Choices(private val context: Context) {
    private val kept = context.getSharedPreferences("choices", Context.MODE_PRIVATE)

    /** Whether a server of llama.cpp's that this phone's processor runs came with the app. */
    private val servesLlama: Boolean by lazy { Llama(context).serverFor(Device(context).features) != null }

    /** The models the phone can be lent with: here whole, with a server for them in the app. */
    fun lendable(store: ModelStore): List<Model> = MODELS.filter { store.has(it) && (it.reader == Reader.AUDIO_CPP || servesLlama) }

    /** The model the user chose to lend, by touching its row, while it is still here. */
    fun chosen(store: ModelStore): Model? = lendable(store).firstOrNull { it.id == kept.getString(SHARED, null) }

    /**
     * The model that is shared: the one chosen; else the one the self-check found fastest, of those it read right;
     * else, before any check, the smaller model first, and of one model llama.cpp's before audio.cpp's — on the two
     * phones both were measured on, it read about twice as fast.
     */
    fun shared(store: ModelStore): Model? {
        val here = lendable(store)
        return chosen(store)
            ?: here.filter { speedOf(it) != null }.maxByOrNull { speedOf(it)!! }
            ?: here.minWithOrNull(compareBy({ model -> MODELS.indexOfFirst { it.name == model.name } }, { it.reader != Reader.LLAMA_CPP }))
    }

    fun share(model: Model) = kept.edit().putString(SHARED, model.id).apply()

    /** How a model is run: on the graphics chip or not, and on how many threads. */
    class Way(val graphics: Boolean, val threads: Int)

    /** What the self-check found of a model: the way it is lent fastest, and how fast that is, in seconds of speech a second. */
    fun remember(model: Model, graphics: Boolean, threads: Int, speed: Double) =
        kept.edit().putBoolean("$GRAPHICS${model.id}", graphics).putInt("$THREADS${model.id}", threads).putFloat("$SPEED${model.id}", speed.toFloat()).apply()

    /** The self-check could not read the recording right with it: it has no speed, and is run as before any check. */
    fun forget(model: Model) = kept.edit().remove("$GRAPHICS${model.id}").remove("$THREADS${model.id}").remove("$SPEED${model.id}").apply()

    /** The way the self-check found fastest; before any check, four threads of the processor. */
    fun wayOf(model: Model) = Way(kept.getBoolean("$GRAPHICS${model.id}", false), kept.getInt("$THREADS${model.id}", DEFAULT_THREADS))

    /** How fast the self-check found it; null before any check that read it right. */
    fun speedOf(model: Model): Double? = kept.getFloat("$SPEED${model.id}", 0f).takeIf { it > 0f }?.toDouble()

    private companion object {
        const val SHARED = "shared"
        const val GRAPHICS = "graphics:"
        const val THREADS = "threads:"
        const val SPEED = "speed:"
        const val DEFAULT_THREADS = 4
    }
}
