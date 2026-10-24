package io.github.rizumu85.kotomimi.node

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import java.io.File

/** What the phone is, as far as a recognizer cares: its processor, its memory, how warm it is. */
class Device(private val context: Context) {
    val name: String = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ")
    val chip: String =
        if (Build.VERSION.SDK_INT >= 31) listOf(Build.SOC_MANUFACTURER, Build.SOC_MODEL).filter { it.isNotBlank() && it != Build.UNKNOWN }.joinToString(" ").ifBlank { Build.HARDWARE }
        else Build.HARDWARE
    val android: String = "Android ${Build.VERSION.RELEASE}"

    /** Each core's highest clock, in kHz; 0 for one that does not say. */
    val cores: List<Long> = (0 until Runtime.getRuntime().availableProcessors()).map { core ->
        runCatching { File("/sys/devices/system/cpu/cpu$core/cpufreq/cpuinfo_max_freq").readText().trim().toLong() }.getOrDefault(0L)
    }

    /** The instruction sets the processor names, as the kernel spells them. */
    val features: Set<String> = runCatching {
        File("/proc/cpuinfo").readLines().firstOrNull { it.startsWith("Features") }?.substringAfter(':')?.trim()?.split(' ')?.toSet()
    }.getOrNull() ?: emptySet()

    /** "6 × 1.8 GHz + 2 × 2.0 GHz", slowest first. */
    fun coresInWords(): String {
        if (cores.all { it == 0L }) return "${cores.size} 核"
        val groups = cores.groupingBy { it }.eachCount().toSortedMap()
        return "${cores.size} 核，" + groups.entries.joinToString(" + ") { (khz, count) -> "$count × ${"%.1f".format(khz / 1_000_000.0)} GHz" }
    }

    /** The ones that matter to the engine's speed, in the order they came to phones. */
    fun featuresInWords(): String {
        val told = listOf("asimddp" to "dotprod", "asimdhp" to "fp16", "i8mm" to "i8mm", "bf16" to "bf16", "sve" to "sve", "sve2" to "sve2", "sme" to "sme")
        return told.filter { it.first in features }.joinToString(" ") { it.second }.ifBlank { "只有基本的" }
    }

    /** Memory in megabytes: all of it, and what is free now. */
    fun memory(): Pair<Long, Long> {
        val info = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
        return info.totalMem / MB to info.availMem / MB
    }

    /** Whether the system itself says memory is short: it is then ending apps to get some back. */
    fun memoryShort(): Boolean {
        val info = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
        return info.lowMemory
    }

    /** What the system last said of the battery. */
    private fun battery(): Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

    /** The battery's temperature in °C — the one every phone reports. */
    fun warmth(): Double? {
        val tenths = battery()?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: return null
        return if (tenths == Int.MIN_VALUE) null else tenths / 10.0
    }

    /** How full the battery is, in per cent. */
    fun charge(): Int? {
        val battery = battery() ?: return null
        val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        return if (level < 0 || scale <= 0) null else level * 100 / scale
    }

    /** Whether it is plugged in: a phone that is charging is warmer for it. */
    fun charging(): Boolean? = battery()?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)?.takeIf { it >= 0 }?.let { it != 0 }

    /** Whether power saving is on, under which a phone holds its processor back. */
    fun savingPower(): Boolean = power().isPowerSaveMode

    /**
     * How hot the system says the phone is — `PowerManager`'s thermal status, 0 for not at all, each step up to 6 a
     * harder holding back; null on the Androids that do not say (before 10).
     */
    fun thermal(): Int? = if (Build.VERSION.SDK_INT >= 29) power().currentThermalStatus else null

    /**
     * How near the phone is to being held back for heat, by the warmth of its case as the system reckons it: 1 is
     * where the holding back becomes severe. Null where the system does not say (before Android 11, or a phone that
     * gives it no figures). The system answers this once a second at most: it is asked once a run.
     */
    fun headroom(): Double? = if (Build.VERSION.SDK_INT >= 30) power().getThermalHeadroom(0).takeUnless { it.isNaN() }?.toDouble() else null

    private fun power() = context.getSystemService(Context.POWER_SERVICE) as PowerManager

    companion object {
        private const val MB = 1024L * 1024L

        const val THERMAL_NONE = 0

        /** A thermal status in a word, as the report says it. */
        fun thermalInWords(status: Int): String = when (status) {
            0 -> "不热"
            1 -> "轻度"
            2 -> "中度"
            3 -> "严重"
            else -> "很严重"
        }
    }
}
