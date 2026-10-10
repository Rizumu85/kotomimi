package io.github.rizumu85.kotomimi.node

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
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

    /** The battery's temperature in °C — the one every phone reports. */
    fun warmth(): Double? {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val tenths = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        return if (tenths == Int.MIN_VALUE) null else tenths / 10.0
    }

    private companion object {
        const val MB = 1024L * 1024L
    }
}
