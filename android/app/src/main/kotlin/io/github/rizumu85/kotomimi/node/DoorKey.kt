package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.security.SecureRandom

/**
 * The phone's access key: blank, as it comes, and every device on its Wi-Fi may use what it lends; set by its owner,
 * and every request must carry it (`Authorization: Bearer`), as a sharing computer's key is asked for (the desktop's
 * `electron/lan-server.js`). A request without it is answered 401, still naming the phone (`Share.answer`), so a
 * computer's search lists it as a phone that wants a key, and the key is typed there once (`src/lib/lan/phoneKeys.ts`).
 */
object DoorKey {
    private const val KEPT = "door"
    private const val KEY = "key"
    /** Letters and digits nobody misreads: no O or 0, no I or 1. */
    private const val LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    private const val LENGTH = 6

    fun of(context: Context): String = context.getSharedPreferences(KEPT, Context.MODE_PRIVATE).getString(KEY, null).orEmpty()

    /** A new key, kept, and returned. */
    fun make(context: Context): String {
        val random = SecureRandom()
        val key = String(CharArray(LENGTH) { LETTERS[random.nextInt(LETTERS.length)] })
        context.getSharedPreferences(KEPT, Context.MODE_PRIVATE).edit().putString(KEY, key).apply()
        return key
    }

    /** No key any more: every device on the Wi-Fi may use the phone again. */
    fun clear(context: Context) = context.getSharedPreferences(KEPT, Context.MODE_PRIVATE).edit().remove(KEY).apply()
}
