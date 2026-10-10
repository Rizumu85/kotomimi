package io.github.rizumu85.kotomimi.node

import android.content.Context

/** What is remembered between runs: which model is shared, and the fastest way the self-check found to run each. */
class Choices(context: Context) {
    private val kept = context.getSharedPreferences("choices", Context.MODE_PRIVATE)

    /** The model that is shared: the one chosen, while it is still here; else the first that is. */
    fun shared(store: ModelStore): Model? {
        val here = MODELS.filter { store.has(it) }
        return here.firstOrNull { it.id == kept.getString(SHARED, null) } ?: here.firstOrNull()
    }

    fun share(model: Model) = kept.edit().putString(SHARED, model.id).apply()

    /** How a model is run: on the graphics chip or not, and on how many threads. */
    class Way(val graphics: Boolean, val threads: Int)

    fun remember(model: Model, graphics: Boolean, threads: Int) =
        kept.edit().putBoolean("$GRAPHICS${model.id}", graphics).putInt("$THREADS${model.id}", threads).apply()

    /** The way the self-check found fastest; before any check, four threads of the processor. */
    fun wayOf(model: Model) = Way(kept.getBoolean("$GRAPHICS${model.id}", false), kept.getInt("$THREADS${model.id}", DEFAULT_THREADS))

    private companion object {
        const val SHARED = "shared"
        const val GRAPHICS = "graphics:"
        const val THREADS = "threads:"
        const val DEFAULT_THREADS = 4
    }
}
