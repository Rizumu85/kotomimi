package io.github.rizumu85.kotomimi.node

import android.content.Context

/**
 * How the app looks: as the phone is set, or always light, or always dark (the user, 2026-10-23). Kept on the phone;
 * `MainActivity.attachBaseContext` lays it over the configuration the screen is made with.
 */
enum class Look(val words: String) {
    SYSTEM("跟随系统"),
    LIGHT("浅色"),
    DARK("深色");

    companion object {
        private const val KEPT = "look"
        private const val KEY = "theme"

        fun of(context: Context): Look =
            context.getSharedPreferences(KEPT, Context.MODE_PRIVATE).getString(KEY, null)?.let { kept -> values().firstOrNull { it.name == kept } } ?: SYSTEM

        fun choose(context: Context, look: Look) =
            context.getSharedPreferences(KEPT, Context.MODE_PRIVATE).edit().putString(KEY, look.name).apply()
    }
}
