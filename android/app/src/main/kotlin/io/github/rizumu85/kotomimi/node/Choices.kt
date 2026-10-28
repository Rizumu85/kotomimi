package io.github.rizumu85.kotomimi.node

import android.content.Context

/** What is remembered between runs: which model is shared, and what the self-check found of each. */
class Choices(private val context: Context) {
    private val kept = context.getSharedPreferences("choices", Context.MODE_PRIVATE)

    /** Whether a server of llama.cpp's that this phone's processor runs came with the app. */
    private val servesLlama: Boolean by lazy { Llama(context).serverFor(Device(context).features) != null }

    /** All the phone's memory, in megabytes. */
    private val memoryMb: Long by lazy { Device(context).memory().first }

    /** The models the phone can be lent with: here whole, with a server for them in the app. */
    fun lendable(store: ModelStore): List<Model> = MODELS.filter { store.has(it) && (it.reader == Reader.AUDIO_CPP || servesLlama) }

    /**
     * The text models that are lent while the phone is shared: every one that is here whole, has its server in the
     * app, and that this phone could hold at all. None is chosen: a computer asks for the one it wants by name.
     */
    fun lendableText(store: ModelStore): List<Model> = TEXT_MODELS.filter { store.has(it) && servesLlama && fits(it) }

    /** Whether this phone could hold a text model's engine with nothing else of the app's running (`fitsIn`). */
    fun fits(model: Model): Boolean = fitsIn(model, memoryMb)

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

    /** How a model is run: on so many threads of the processor. */
    class Way(val threads: Int)

    /** What the self-check found of a model: the thread count it is lent fastest with, and how fast that is, in seconds of speech a second. */
    fun remember(model: Model, threads: Int, speed: Double) =
        kept.edit().remove("$GRAPHICS${model.id}").putInt("$THREADS${model.id}", threads).putFloat("$SPEED${model.id}", speed.toFloat()).apply()

    /** The self-check could not read the recording right with it: it has no speed, and is run as before any check. */
    fun forget(model: Model) = kept.edit().remove("$GRAPHICS${model.id}").remove("$THREADS${model.id}").remove("$SPEED${model.id}").apply()

    /** What the self-check found of a text model: the thread count it answered fastest with. (It runs on the processor alone.) */
    fun rememberText(model: Model, threads: Int) = kept.edit().putInt("$THREADS${model.id}", threads).apply()

    /** The way the self-check found fastest; before any check, four threads. */
    fun wayOf(model: Model) = Way(kept.getInt("$THREADS${model.id}", DEFAULT_THREADS))

    /** How fast the self-check found it; null before any check that read it right. */
    fun speedOf(model: Model): Double? = kept.getFloat("$SPEED${model.id}", 0f).takeIf { it > 0f }?.toDouble()

    companion object {
        private const val SHARED = "shared"
        /** Where versions before 0.9.4 kept whether a model was lent on the graphics chip: no phone ever was, and it is let go. */
        private const val GRAPHICS = "graphics:"
        private const val THREADS = "threads:"
        private const val SPEED = "speed:"
        private const val DEFAULT_THREADS = 4

        /**
         * What a phone keeps for itself whatever is asked of it — the system, and the app's own screen — in
         * megabytes: a guess on the low side. The F22 Pro (3.8 GB) has 2.1 GB to spare with nothing running.
         */
        private const val PHONE_KEEPS_MB = 1024

        /**
         * Whether a phone with `memoryMb` in all could hold a model's engine with nothing else of the app's running.
         * A model that fails this is not lent and its row says so: a download of three gigabytes would be for
         * nothing. One that passes may still be refused when it is asked for, by the memory there is at that
         * moment (`Share.ensure`).
         */
        fun fitsIn(model: Model, memoryMb: Long): Boolean = model.holdsMb + PHONE_KEEPS_MB <= memoryMb

        /** `preferred`, of these models, given how fast the self-check found each (null: not read right, or not yet). */
        fun pick(here: List<Model>, speedOf: (Model) -> Double?): Model? {
            val checked = here.filter { speedOf(it) != null }
            return checked.filter { speedOf(it)!! >= SelfCheck.FAST_FROM }.minWithOrNull(compareBy<Model> { it.accuracy }.thenByDescending { speedOf(it)!! })
                ?: checked.maxByOrNull { speedOf(it)!! }
                ?: here.minWithOrNull(compareBy({ model -> MODELS.indexOfFirst { it.name == model.name } }, { it.reader != Reader.LLAMA_CPP }))
        }
    }
}
