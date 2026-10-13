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

    /** The model that is shared: the one chosen, else the one the phone picks by itself. */
    fun shared(store: ModelStore): Model? = chosen(store) ?: preferred(store)

    /**
     * The model the phone lends where nobody chose one. Of those the self-check read right:
     *
     * - the most accurate that keeps up (`SelfCheck.FAST_FROM`), and of one model the faster engine;
     * - where none keeps up, the fastest: a text that comes late is worth less than one a little less right.
     *
     * The fastest alone, which it was before, would lend SenseVoice-Small on every phone from now on — also on one
     * that keeps up with Qwen3-ASR 1.7B, which reads better.
     *
     * A model fetched since the last check has no speed and is not among them: what it does on this phone is not
     * known until the next check, or until its row is touched.
     *
     * Before any check, the smaller model first (`MODELS`), and of one model llama.cpp's before audio.cpp's, which
     * read about twice as fast on the two phones both were measured on: the likeliest to keep up, and no more than
     * that is known.
     */
    fun preferred(store: ModelStore): Model? = pick(lendable(store), ::speedOf)

    /** Whether the self-check has read any of the models that can be lent: what `preferred` then goes by. */
    fun checked(store: ModelStore): Boolean = lendable(store).any { speedOf(it) != null }

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

    companion object {
        private const val SHARED = "shared"
        private const val GRAPHICS = "graphics:"
        private const val THREADS = "threads:"
        private const val SPEED = "speed:"
        private const val DEFAULT_THREADS = 4

        /** `preferred`, of these models, given how fast the self-check found each (null: not read right, or not yet). */
        fun pick(here: List<Model>, speedOf: (Model) -> Double?): Model? {
            val checked = here.filter { speedOf(it) != null }
            return checked.filter { speedOf(it)!! >= SelfCheck.FAST_FROM }.minWithOrNull(compareBy<Model> { it.accuracy }.thenByDescending { speedOf(it)!! })
                ?: checked.maxByOrNull { speedOf(it)!! }
                ?: here.minWithOrNull(compareBy({ model -> MODELS.indexOfFirst { it.name == model.name } }, { it.reader != Reader.LLAMA_CPP }))
        }
    }
}
