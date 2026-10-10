package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.TimeZone

/**
 * A model the engine reads: the same file as the desktop app's (`electron/native-engine.js`), under the same name
 * there (`id`), told to be the right one by its size and its SHA-256.
 */
class Model(val id: String, val name: String, val file: String, val path: String, val bytes: Long, val sha256: String, val family: String) {
    /** As the desktop app writes sizes: in units of 1024. */
    val sizeInWords: String get() = "%.1f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))

    /**
     * Where it is fetched from, the likelier first. Hugging Face is where the files are published; ModelScope keeps
     * the same repository (the same bytes: the sizes and checksums were compared, 2026-10-10) and is reached from
     * mainland China without a proxy, where Hugging Face is not.
     */
    fun addresses(): List<String> {
        val published = "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/$REVISION/$path"
        val mirrored = "https://modelscope.cn/models/audio-cpp/audio.cpp-gguf/resolve/master/$path"
        return if (inMainlandChina()) listOf(mirrored, published) else listOf(published, mirrored)
    }

    private companion object {
        const val REVISION = "e36610ac69b5262e914a52635324050bee8f1ad2"
        val CHINA_ZONES = setOf("Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "PRC")

        /** A guess that only orders the two addresses: by the phone's clock, or the region it is set to. */
        fun inMainlandChina() = TimeZone.getDefault().id in CHINA_ZONES || Locale.getDefault().country == "CN"
    }
}

val MODELS = listOf(
    Model(
        id = "qwen3-asr-0.6b-q8",
        name = "Qwen3-ASR 0.6B",
        file = "qwen3-asr-0.6b-q8_0.gguf",
        path = "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf",
        bytes = 1_151_272_416,
        sha256 = "6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7",
        family = "qwen3_asr",
    ),
    Model(
        id = "qwen3-asr-1.7b-q8",
        name = "Qwen3-ASR 1.7B",
        file = "qwen3-asr-1.7b-q8_0.gguf",
        path = "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
        bytes = 2_473_010_048,
        sha256 = "da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8",
        family = "qwen3_asr",
    ),
)

/** Where the models are kept: the app's own folder on shared storage, which goes when the app is removed. */
class ModelStore(context: Context) {
    val folder: File = File(context.getExternalFilesDir(null), "models").apply { mkdirs() }

    fun fileOf(model: Model) = File(folder, model.file)
    private fun partOf(model: Model) = File(folder, "${model.file}.part")

    /** Whole and of the right size. (Its checksum was looked at when it was fetched.) */
    fun has(model: Model) = fileOf(model).length() == model.bytes

    /** Bytes here so far, of a download begun. */
    fun begun(model: Model) = partOf(model).length()

    /**
     * Fetches it, taking up where an earlier try left off, from the first address that answers; then checks it is
     * the file it should be. `onProgress` is told the bytes had, and `onChecking` when the download is over;
     * `stopped` is asked between pieces, and what is had is kept when it says yes.
     */
    fun fetch(model: Model, onProgress: (Long) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) {
        val part = partOf(model)
        if (part.length() > model.bytes) part.delete()
        var failure: IOException? = null
        for (address in model.addresses()) {
            if (part.length() == model.bytes) break
            try {
                pull(address, part, model.bytes, onProgress, stopped)
                failure = null
            } catch (error: IOException) {
                failure = IOException("${URL(address).host}：${error.message ?: error.javaClass.simpleName}")
            }
            if (stopped()) return
        }
        if (part.length() != model.bytes) throw failure ?: IOException("下载到的大小不对")
        onChecking()
        if (sha256Of(part, stopped) != model.sha256) {
            if (stopped()) return
            // Not the file: nothing of it is worth keeping.
            part.delete()
            throw IOException("下载到的文件不对，已删掉，请再下一次")
        }
        if (!part.renameTo(fileOf(model))) throw IOException("存不下来")
    }

    private fun pull(address: String, part: File, bytes: Long, onProgress: (Long) -> Unit, stopped: () -> Boolean) {
        var had = part.length()
        val connection = URL(address).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        if (had > 0) connection.setRequestProperty("Range", "bytes=$had-")
        try {
            when (connection.responseCode) {
                HttpURLConnection.HTTP_PARTIAL -> Unit
                // The whole file again: the server would not take up from the middle.
                HttpURLConnection.HTTP_OK -> had = 0
                else -> throw IOException("回答 ${connection.responseCode}")
            }
            RandomAccessFile(part, "rw").use { out ->
                out.setLength(had)
                out.seek(had)
                connection.inputStream.use { input ->
                    val buffer = ByteArray(1 shl 16)
                    var told = 0L
                    while (had < bytes) {
                        if (stopped()) return
                        val read = input.read(buffer)
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        had += read
                        if (had - told >= PROGRESS_EVERY) { told = had; onProgress(had) }
                    }
                }
            }
            onProgress(had)
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256Of(file: File, stopped: () -> Boolean): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 20)
            while (!stopped()) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val PROGRESS_EVERY = 4L * 1024 * 1024
    }
}
