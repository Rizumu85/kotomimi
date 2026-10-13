package io.github.rizumu85.kotomimi.node

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReferenceArray
import kotlin.concurrent.thread

/**
 * A version of the app that is published, as `phone.json` tells it: its name and number, where its package is, the
 * size and SHA-256 that tell a download of it is whole, the oldest Android it installs on, and a line about what is
 * new in it.
 */
class Release(val version: String, val code: Long, val apk: String, override val bytes: Long, override val sha256: String, val sdk: Int, val notes: String) : Fetched {
    /** Kept under its number and the start of its checksum: a version that came with another package is another file. */
    override val name: String = "update-$code-${sha256.take(8)}.apk"

    override fun addresses(): List<Source> = addressesOf(apk)

    val sizeInWords: String get() = "%.0f MB".format(bytes / (1024.0 * 1024.0))

    /** As it is kept between runs: in the words it came in. */
    fun written(): String = JSONObject().put("version", version).put("code", code).put("apk", apk).put("bytes", bytes).put("sha256", sha256).put("sdk", sdk).put("notes", notes).toString()

    companion object {
        private val VERSION = Regex("""[0-9A-Za-z][0-9A-Za-z.+-]{0,23}""")
        private val SHA256 = Regex("""[0-9a-f]{64}""")

        /** No package of this app is near this size: a `phone.json` that says more is not asked for it. */
        private const val BYTES_MOST = 400L * 1024 * 1024
        private const val NOTES_MOST = 40

        /**
         * Reads a `phone.json`; null for what is not one. Fields it does not know are passed over, so that a later
         * version of the file may say more. The package has to be under `packagesAt` — the project's own releases —
         * whoever the file came from: a relay may hand over a file of its own making, and is not thereby to send
         * the phone to a server of its choosing. The notes are held to one short line for the same reason: they are
         * put on the screen.
         */
        fun read(words: String, packagesAt: String): Release? = runCatching {
            val json = JSONObject(words)
            val version = json.getString("version").takeIf { VERSION.matches(it) } ?: return null
            val code = json.getLong("code").takeIf { it > 0 } ?: return null
            val apk = json.getString("apk").takeIf { it.startsWith(packagesAt) && it.length < 400 && it.none(Char::isWhitespace) } ?: return null
            val bytes = json.getLong("bytes").takeIf { it in 1..BYTES_MOST } ?: return null
            val sha256 = json.getString("sha256").lowercase().takeIf { SHA256.matches(it) } ?: return null
            val notes = (json.opt("notes") as? String).orEmpty().lineSequence().firstOrNull().orEmpty().trim().take(NOTES_MOST)
            Release(version, code, apk, bytes, sha256, json.optInt("sdk", 0), notes)
        }.getOrNull()
    }
}

/**
 * GitHub's release downloads are often not reached from mainland China: they time out, or come at some 30 KB/s (an
 * exit in Beijing, 2026-10-12; FORK.md). These are public relays of them, run by volunteers — the three the desktop
 * app asks (`electron/fetch-file.js`), used as `<relay><the whole GitHub address>`. All three answered a part of a
 * file asked for by its place in it (HTTP 206), which the download in pieces needs, and passed a query on
 * (2026-10-13).
 */
private val GITHUB_RELAYS = listOf("https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.net/")
private const val GITHUB = "https://github.com/"

private fun hostOf(address: String) = runCatching { URL(address).host }.getOrNull() ?: address

/** The relays' addresses for a file on GitHub, each called by its host; none for a file that is somewhere else. */
private fun relaysOf(address: String): List<Source> = if (address.startsWith(GITHUB)) GITHUB_RELAYS.map { Source(hostOf(it), it + address) } else emptyList()

/** The address itself, called "GitHub" where it is there. */
private fun directOf(address: String) = Source(if (address.startsWith(GITHUB)) "GitHub" else hostOf(address), address)

/** Every place a file on GitHub is asked for, as the desktop orders them: the relays first on a phone set to mainland China, last elsewhere. */
fun addressesOf(address: String): List<Source> = if (inMainlandChina()) relaysOf(address) + directOf(address) else listOf(directOf(address)) + relaysOf(address)

/**
 * The app's own update: asking whether a newer version is published, fetching its package, and handing that to the
 * system to install.
 *
 * Versions are prereleases of the project on GitHub, tagged `phone-vX.Y.Z` (never the repository's "latest": that is
 * the desktop app's, whose own updater looks it up). One more prerelease, `phone-latest`, holds `phone.json`, which
 * says what the newest is (`Release.read`; `scripts/publish.sh` writes it).
 *
 * What protects the person is Android, not this: the system installs a package over the app only if it is signed
 * with the key the installed copy was signed with and its number is not lower. So a relay — a stranger — cannot
 * have the phone install anything else; the worst it can do is waste a download and have the system refuse it. The
 * SHA-256 that `phone.json` gives is checked all the same before the system is asked (`Downloads.fetch`): it spares
 * the person a prompt that could only fail, and catches a download that broke.
 */
class Updater(private val context: Context) {
    private val kept = context.getSharedPreferences("update", Context.MODE_PRIVATE)

    /** In the app's private folder: nothing else on the phone can put a file where the system is handed one from. */
    private val downloads = Downloads(File(context.filesDir, "update"))

    /** The number of the version that is installed, as the system has it. */
    val installed: Long = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode

    /**
     * For trying an update without publishing one: an address on the phone itself that is asked in place of GitHub
     * (`adb reverse` leads it to a computer; README). It is read from a file in the app's private folder, on a build
     * that can be debugged: only `adb shell run-as` writes there, which no other app can do and which a build that
     * cannot be debugged does not allow at all. `MainActivity` is open to every app on the phone, so nothing an
     * intent carries is let near this; and since every build so far is one that can be debugged, the flag alone
     * would guard nothing. What is read is held to `http://127.0.0.1:port/…`, where a mistake leads nowhere.
     */
    fun testAddress(): String? {
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
        return runCatching { File(context.filesDir, TEST_FILE).readText().trim() }.getOrNull()?.takeIf { TEST_ADDRESS.matches(it) }
    }

    /** Where a package may be: the project's releases; under test, the test's own server. */
    private fun packagesAt(test: String?) = test?.let { it.substring(0, it.indexOf('/', "http://".length) + 1) } ?: PACKAGES

    /** The newer version last heard of, if it is still newer than what is installed. */
    fun offered(): Release? = kept.getString(OFFERED, null)?.let { Release.read(it, packagesAt(testAddress())) }?.takeIf(::newer)

    private fun newer(release: Release) = release.code > installed && release.sdk <= Build.VERSION.SDK_INT

    /** Whether it is time to ask by itself: about once a day. (Under test, every time the app is opened.) */
    fun due(): Boolean = testAddress() != null || System.currentTimeMillis() - kept.getLong(CHECKED, 0) !in 0..CHECK_EVERY_MS

    private sealed class Answer {
        class Newest(val release: Release) : Answer()

        /** There is no `phone.json` there. */
        object Absent : Answer()
        class Failed(val why: String) : Answer()
    }

    /**
     * Asks what the newest version is, and returns it where it is newer than this one (null: there is none).
     * Throws when nobody could say. Takes a few seconds, a quarter of a minute at most: not for the main thread.
     *
     * GitHub and the relays are all asked at once. A relay that tells of a newer version is believed at once: a
     * copy it kept from an earlier day could only tell of an older one, and where GitHub is not reached — mainland
     * China, where it is waited on for seconds in vain — the relays are who answers. That there is nothing new is
     * GitHub's to say; where it does not answer, the newest that a relay knows of is taken, and never an older one
     * than was heard of before.
     */
    fun check(): Release? {
        val test = testAddress()
        val packagesAt = packagesAt(test)
        // The hour in the address: a relay that keeps copies has none under this one until it has asked GitHub.
        val address = "${test ?: MANIFEST}?t=${System.currentTimeMillis() / 3_600_000}"
        val sources = addressesOf(address)
        val answers = AtomicReferenceArray<Answer?>(sources.size)
        val asking = sources.mapIndexed { index, source ->
            thread(name = "update-${source.name}", isDaemon = true) {
                answers.set(index, runCatching { ask(source.address, packagesAt) }.getOrElse { Answer.Failed(it.message ?: it.javaClass.simpleName) })
            }
        }
        val until = System.currentTimeMillis() + ANSWER_WITHIN_MS
        val direct = sources.indexOfFirst { it.address == address }
        fun newestTold() = sources.indices.mapNotNull { (answers.get(it) as? Answer.Newest)?.release }.maxByOrNull { it.code }
        while (System.currentTimeMillis() < until && answers.get(direct) == null && newestTold()?.let(::newer) != true && asking.any { it.isAlive }) Thread.sleep(50)
        val said = answers.get(direct)
        var found: Release? = null
        if (said is Answer.Newest) found = said.release
        else if (said !is Answer.Absent) {
            if (newestTold()?.let(::newer) != true) asking.forEach { it.join((until - System.currentTimeMillis()).coerceAtLeast(1)) }
            val relayed = newestTold()
            if (relayed == null) {
                val why = sources.indices.joinToString(" · ") { "${sources[it].name}：${(answers.get(it) as? Answer.Failed)?.why ?: if (answers.get(it) == null) "没有回答" else "没有"}" }
                Log.i(TAG, "check failed: $why")
                throw IOException(why)
            }
            found = listOfNotNull(relayed, offered()).maxByOrNull { it.code }
        }
        val update = found?.takeIf(::newer)
        Log.i(TAG, "check: installed $installed, newest ${found?.code ?: "none"} (${found?.version.orEmpty()})")
        kept.edit().apply {
            if (update != null) putString(OFFERED, update.written()) else remove(OFFERED)
            // A test's answer is not the day's.
            if (test == null) putLong(CHECKED, System.currentTimeMillis())
        }.apply()
        return update
    }

    private fun ask(address: String, packagesAt: String): Answer {
        val connection = URL(address).openConnection() as HttpURLConnection
        connection.connectTimeout = ASK_FOR_MS
        connection.readTimeout = ASK_FOR_MS
        try {
            val code = connection.responseCode
            if (code == HttpURLConnection.HTTP_NOT_FOUND) return Answer.Absent
            if (code != HttpURLConnection.HTTP_OK) return Answer.Failed("回答 $code")
            val words = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (words.size() <= MANIFEST_MOST) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    words.write(buffer, 0, read)
                }
            }
            if (words.size() > MANIFEST_MOST) return Answer.Failed("太长")
            return Release.read(words.toString("UTF-8"), packagesAt)?.let { Answer.Newest(it) } ?: Answer.Failed("看不懂")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Removes what was fetched of any version but `keep`: a package the app has since become, or one a newer has
     * taken the place of. With nothing to keep, what was last heard of goes too: it is no longer news.
     */
    fun tidy(keep: Release?) {
        downloads.folder.listFiles().orEmpty().filter { keep == null || !it.name.startsWith(keep.name) }.forEach { it.delete() }
        if (keep == null && kept.contains(OFFERED)) kept.edit().remove(OFFERED).apply()
    }

    fun has(release: Release) = downloads.has(release)
    fun begun(release: Release) = downloads.begun(release)
    fun fetch(release: Release, onProgress: (Long, Long, String) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) = downloads.fetch(release, onProgress, onChecking, stopped)

    /** A version the system would not take is not kept, nor offered again as it is: the next time the app is opened it asks what there is. */
    fun drop() {
        kept.edit().remove(OFFERED).remove(CHECKED).apply()
        tidy(null)
    }

    /** Whether the person has let this app install apps: the system asks that of every app that is not a store. */
    fun allowed(): Boolean = context.packageManager.canRequestPackageInstalls()

    /**
     * That the person was sent to the system's screen to allow it, a moment ago: where they come back having
     * allowed it, the install goes on by itself. Kept between runs because some versions of Android end the app
     * when that switch is turned; and only for a few minutes, so that it is still what the person was doing.
     */
    var sentToAllow: Boolean
        get() = System.currentTimeMillis() - kept.getLong(SENT_TO_ALLOW, 0) in 0..ALLOW_WITHIN_MS
        set(value) = kept.edit().apply { if (value) putLong(SENT_TO_ALLOW, System.currentTimeMillis()) else remove(SENT_TO_ALLOW) }.apply()

    /**
     * Hands the package to the system to install over the app. Returns when the system has it; what the system then
     * says comes to `InstallReceiver` — first that it wants the person's word, which it asks for on a screen of its
     * own. Throws where the system would not take it.
     */
    fun install(release: Release) {
        val installer = context.packageManager.packageInstaller
        // One the person left unanswered (the system's question put away with the home key) is still with the
        // system, and says nothing more.
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(release.bytes)
        }
        val id = installer.createSession(parameters)
        Installing.session = id
        try {
            installer.openSession(id).use { session ->
                session.openWrite("update.apk", 0, release.bytes).use { out ->
                    downloads.fileOf(release).inputStream().use { it.copyTo(out, 1 shl 16) }
                    session.fsync(out)
                }
                // The system writes its answer into the intent, so it has to be one that can be written into; and
                // it names the receiver outright, as Android 14 asks of such an intent.
                val changeable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val told = PendingIntent.getBroadcast(context, id, Intent(context, InstallReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or changeable)
                session.commit(told.intentSender)
            }
        } catch (error: Exception) {
            runCatching { installer.abandonSession(id) }
            throw error
        }
    }

    companion object {
        const val TAG = "update"

        /** The one address that stays the same from version to version. */
        private const val MANIFEST = "https://github.com/Rizumu85/kotomimi/releases/download/phone-latest/phone.json"
        private const val PACKAGES = "https://github.com/Rizumu85/kotomimi/releases/download/"

        private const val TEST_FILE = "update-test"
        private val TEST_ADDRESS = Regex("""http://127\.0\.0\.1:\d{1,5}/[\w./-]*""")

        private const val OFFERED = "offered"
        private const val CHECKED = "checked"
        private const val SENT_TO_ALLOW = "sentToAllow"

        private const val CHECK_EVERY_MS = 20L * 60 * 60 * 1000
        private const val ALLOW_WITHIN_MS = 10L * 60 * 1000

        /** One address is waited on this long to connect, and as long again to answer; all of them together, twice that. */
        private const val ASK_FOR_MS = 6_000
        private const val ANSWER_WITHIN_MS = 13_000L
        private const val MANIFEST_MOST = 64 * 1024

        /**
         * Why the system did not install it, in a few words, with the system's own name for it where it gave one
         * (`INSTALL_FAILED_…`): what a person can read out when asking for help.
         */
        fun reasonOf(status: Int, message: String?): String {
            val named = message?.substringBefore(':')?.trim()?.takeIf { Regex("[A-Z_]{6,}").matches(it) }?.let { "（$it）" }.orEmpty()
            return when (status) {
                PackageInstaller.STATUS_FAILURE_STORAGE -> "手机存储空间不够"
                PackageInstaller.STATUS_FAILURE_CONFLICT -> "和已装的不是同一个签名$named"
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "这台手机装不了这一版$named"
                PackageInstaller.STATUS_FAILURE_INVALID -> "安装包不对$named"
                PackageInstaller.STATUS_FAILURE_BLOCKED -> "被系统拦下了$named"
                else -> message?.take(80) ?: "系统没说原因"
            }
        }
    }
}

/**
 * What the system last said of the install it was handed, for the screen to take: the receiver writes it, the
 * screen reads it when it is there to — an answer that comes while the app is not on screen waits here.
 */
object Installing {
    class Told(val status: Int, val message: String?, val confirm: Intent?)

    private val main = Handler(Looper.getMainLooper())

    /** The install the app is waiting to hear of: an answer about an earlier one, given up since, is not its. */
    @Volatile var session = -1

    @Volatile private var told: Told? = null

    /** Called on the main thread when there is something to take. */
    var listener: (() -> Unit)? = null

    fun tell(next: Told) {
        told = next
        main.post { listener?.invoke() }
    }

    fun take(): Told? = told.also { told = null }
}

/**
 * Where the system says how an install stands. It is not open to other apps (the manifest), so what arrives is the
 * system's: among it the intent of the system's own screen that asks the person whether to install, which the app
 * then opens — an intent taken from just anybody and opened would be the app doing a stranger's bidding.
 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        Log.i(Updater.TAG, "install $session: status $status ${message.orEmpty()}")
        if (session != Installing.session) return
        @Suppress("DEPRECATION")
        val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
        Installing.tell(Installing.Told(status, message, confirm))
    }
}
