package io.github.rizumu85.kotomimi.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.util.concurrent.Executors

/**
 * What the phone has done for computers of one kind of work since it was last lent: how many, how long they took,
 * and the last one — what it was asked and what it answered. The screen shows it; it is kept in memory only, and
 * forgotten when sharing starts again.
 */
class Work {
    @Volatile var count = 0
    @Volatile var spentMs = 0L
    /** For recognition: the sound read, against `spentMs`, says how far ahead of speech the phone keeps. */
    @Volatile var soundMs = 0L
    @Volatile var said: String? = null
    @Volatile var answer: String? = null
    /** For translation: the language it was asked to write in, in its own words (中文, 日语). */
    @Volatile var into: String? = null
    /** When the last was done, and how long it took: the first of a run also waits for its model to load. */
    @Volatile var at = 0L
    @Volatile var lastMs = 0L

    fun done(tookMs: Long, said: String?, answer: String?, soundMs: Long = 0L, into: String? = null) {
        count += 1
        spentMs += tookMs
        this.soundMs += soundMs
        if (said != null) this.said = said
        if (answer != null) this.answer = answer
        if (into != null) this.into = into
        at = System.currentTimeMillis()
        lastMs = tookMs
    }
}

/** What sharing is doing now, for whoever shows it: the service writes it, the screen reads it. */
object Sharing {
    private val works = java.util.concurrent.ConcurrentHashMap<Task, Work>().apply { for (task in Task.values()) put(task, Work()) }

    /** What has been done of this kind of work since sharing began. */
    fun work(task: Task): Work = works.getValue(task)

    /** When sharing last began. */
    @Volatile var since = 0L
        private set

    /** Sharing begins again: what was done before is not this time's. */
    fun forget() {
        since = System.currentTimeMillis()
        for (task in Task.values()) works[task] = Work()
    }

    private val main = Handler(Looper.getMainLooper())

    @Volatile var state = Share.State(Share.Phase.OFF)
        private set

    /** Called on the main thread at every change. */
    var listener: ((Share.State) -> Unit)? = null

    fun tell(next: Share.State) {
        state = next
        main.post { listener?.invoke(next) }
    }

    val on: Boolean get() = state.phase != Share.Phase.OFF && state.phase != Share.Phase.FAILED
}

/**
 * Keeps sharing alive while the app is not on screen: a service with a notification, which Android leaves running,
 * holding the processor and the Wi-Fi awake — a phone lent to a computer lies beside it with its screen off.
 */
class ShareService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private var share: Share? = null
    private var awake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            end()
            return START_NOT_STICKY
        }
        val store = ModelStore(this)
        val choices = Choices(this)
        // The recognition model that is lent; none on a phone that has text models alone, which are lent without it.
        val model = choices.lendable(store).firstOrNull { it.id == intent?.getStringExtra(MODEL) } ?: choices.shared(store)
        if ((model == null && choices.lendableText(store).isEmpty()) || share != null) {
            if (share == null) stopSelf()
            return START_NOT_STICKY
        }
        val startWith = Llama.Build.values().firstOrNull { it.words == intent?.getStringExtra(LLAMA) }
        show(noticeOf(Share.State(Share.Phase.LOADING, model)))
        hold()
        val sharing = Share(this, Engine(this), Llama(this), store)
        share = sharing
        sharing.onState = { state ->
            Sharing.tell(state)
            if (state.phase != Share.Phase.OFF) getSystemService(NotificationManager::class.java).notify(NOTICE, noticeOf(state))
        }
        worker.execute {
            runCatching { sharing.start(model, startWith) }
                .onFailure { error -> Sharing.tell(Share.State(Share.Phase.FAILED, model, message = error.message ?: error.javaClass.simpleName)) }
            // Not up: nothing to keep alive for.
            if (Sharing.state.phase == Share.Phase.FAILED) Handler(Looper.getMainLooper()).post { end(keep = Sharing.state) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        end()
        worker.shutdownNow()
        super.onDestroy()
    }

    /** Ends sharing; `keep` is a failure left on the screen for the user to read. */
    private fun end(keep: Share.State? = null) {
        val sharing = share
        share = null
        sharing?.onState = {}
        sharing?.stop()
        Sharing.tell(keep ?: Share.State(Share.Phase.OFF))
        awake?.takeIf { it.isHeld }?.release()
        wifi?.takeIf { it.isHeld }?.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun hold() {
        awake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kotomimi:share").apply { acquire() }
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createWifiLock(mode, "kotomimi:share").apply { acquire() }
    }

    private fun show(notice: Notification) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "共享", NotificationManager.IMPORTANCE_LOW))
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) else startForeground(NOTICE, notice)
    }

    private fun noticeOf(state: Share.State): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ShareService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val (big, small) = wordsOf(state)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_note)
            .setContentTitle(big)
            .setContentText(small)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止共享", stop).build())
            .build()
    }

    companion object {
        private const val CHANNEL = "sharing"
        private const val NOTICE = 1
        private const val STOP = "io.github.rizumu85.kotomimi.node.STOP"
        private const val MODEL = "model"
        private const val LLAMA = "llama"

        /**
         * Lends the phone with `model` to recognize by (none: with its text models alone); `llamaBuild` is for trying
         * a build of llama.cpp's server the phone would not pick itself.
         */
        fun start(context: Context, model: Model?, llamaBuild: String? = null) {
            context.startForegroundService(Intent(context, ShareService::class.java).putExtra(MODEL, model?.id).putExtra(LLAMA, llamaBuild))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ShareService::class.java).setAction(STOP))
        }

        /** What a state reads as: a few words, and a line under them, which names the engine that is lent. */
        fun wordsOf(state: Share.State): Pair<String, String> {
            // The engine is not named: to the person it is one model (the self-check, not they, picks the engine).
            val by = ""
            return when (state.phase) {
                Share.Phase.OFF -> "共享未启用" to "启用后，电脑即可使用这台手机上的模型"
                Share.Phase.LOADING -> "正在加载" to (state.model?.name.orEmpty() + by)
                Share.Phase.WAITING -> "等待电脑连接" to ((state.address?.let { "本机 $it" } ?: "这台手机未连接 Wi-Fi") + by)
                // (The engine named is the recognizer's: a text model's answer is not its work, and is told without it.)
                Share.Phase.WORKING -> when (state.task) {
                    Task.TRANSLATE -> "正在翻译" to "来自 ${state.peer ?: "电脑"}"
                    Task.COACH -> "正在生成语法反馈" to "来自 ${state.peer ?: "电脑"}"
                    else -> "正在识别语音" to "来自 ${state.peer ?: "电脑"}$by"
                }
                Share.Phase.FAILED -> "未能启用共享" to (state.message ?: "")
            }
        }
    }
}
