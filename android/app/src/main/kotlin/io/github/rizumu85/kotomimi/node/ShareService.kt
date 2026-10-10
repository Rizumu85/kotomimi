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

/** What sharing is doing now, for whoever shows it: the service writes it, the screen reads it. */
object Sharing {
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
        val model = MODELS.firstOrNull { it.id == intent?.getStringExtra(MODEL) && store.has(it) } ?: Choices(this).shared(store)
        if (model == null || share != null) {
            if (share == null) stopSelf()
            return START_NOT_STICKY
        }
        show(noticeOf(Share.State(Share.Phase.LOADING, model)))
        hold()
        val sharing = Share(this, Engine(this), store)
        share = sharing
        sharing.onState = { state ->
            Sharing.tell(state)
            if (state.phase != Share.Phase.OFF) getSystemService(NotificationManager::class.java).notify(NOTICE, noticeOf(state))
        }
        worker.execute {
            runCatching { sharing.start(model, Choices(this).wayOf(model)) }
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
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
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

        fun start(context: Context, model: Model) {
            context.startForegroundService(Intent(context, ShareService::class.java).putExtra(MODEL, model.id))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ShareService::class.java).setAction(STOP))
        }

        /** What a state reads as: a few words, and a line under them. */
        fun wordsOf(state: Share.State): Pair<String, String> = when (state.phase) {
            Share.Phase.OFF -> "没有开启" to "按下面的键，把这台手机借给电脑"
            Share.Phase.LOADING -> "正在装入" to (state.model?.name ?: "")
            Share.Phase.WAITING -> "等电脑连上" to (state.address?.let { "地址 $it" } ?: "这台手机没连 Wi-Fi")
            Share.Phase.WORKING -> "正在识别" to "来自 ${state.peer ?: "一台电脑"}"
            Share.Phase.FAILED -> "没开起来" to (state.message ?: "")
        }
    }
}
