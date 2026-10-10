package io.github.rizumu85.kotomimi.node

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/** A model the engine reads: the same files, from the same addresses, as the desktop app (`electron/native-engine.js`). */
class Model(val name: String, val file: String, val url: String, val bytes: Long, val family: String) {
    /** As the desktop app writes sizes: in units of 1024. */
    val sizeInWords: String get() = "%.1f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))
}

val MODELS = listOf(
    Model(
        name = "Qwen3-ASR 0.6B",
        file = "qwen3-asr-0.6b-q8_0.gguf",
        url = "$SOURCE/Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf",
        bytes = 1_151_272_416,
        family = "qwen3_asr",
    ),
    Model(
        name = "Qwen3-ASR 1.7B",
        file = "qwen3-asr-1.7b-q8_0.gguf",
        url = "$SOURCE/Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
        bytes = 2_473_010_048,
        family = "qwen3_asr",
    ),
)

private const val SOURCE = "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/e36610ac69b5262e914a52635324050bee8f1ad2"

/** Where the models are kept: the app's own folder on shared storage, which goes when the app is removed. */
class ModelStore(context: Context) {
    val folder: File = File(context.getExternalFilesDir(null), "models").apply { mkdirs() }

    fun fileOf(model: Model) = File(folder, model.file)
    private fun partOf(model: Model) = File(folder, "${model.file}.part")

    /** Whole and of the right size. */
    fun has(model: Model) = fileOf(model).length() == model.bytes

    /** Bytes here so far, of a download begun. */
    fun begun(model: Model) = partOf(model).length()

    /**
     * Fetches it, taking up where an earlier try left off. `onProgress` is told the bytes had; `stopped` is asked
     * between pieces, and what is had is kept when it says yes.
     */
    fun fetch(model: Model, onProgress: (Long) -> Unit, stopped: () -> Boolean) {
        val part = partOf(model)
        var had = part.length()
        if (had > model.bytes) { part.delete(); had = 0 }
        if (had < model.bytes) {
            val connection = URL(model.url).openConnection() as HttpURLConnection
            connection.connectTimeout = 20_000
            connection.readTimeout = 30_000
            if (had > 0) connection.setRequestProperty("Range", "bytes=$had-")
            try {
                when (connection.responseCode) {
                    HttpURLConnection.HTTP_PARTIAL -> Unit
                    // The whole file again: the server would not take up from the middle.
                    HttpURLConnection.HTTP_OK -> had = 0
                    else -> throw IOException("服务器回答 ${connection.responseCode}")
                }
                RandomAccessFile(part, "rw").use { out ->
                    out.setLength(had)
                    out.seek(had)
                    connection.inputStream.use { input ->
                        val buffer = ByteArray(1 shl 16)
                        var told = 0L
                        while (true) {
                            if (stopped()) return
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            had += read
                            if (had - told >= PROGRESS_EVERY) { told = had; onProgress(had) }
                        }
                    }
                }
            } finally {
                connection.disconnect()
            }
        }
        if (had != model.bytes) throw IOException("下载到的大小不对：$had / ${model.bytes}")
        if (!part.renameTo(fileOf(model))) throw IOException("存不下来")
        onProgress(had)
    }

    private companion object {
        const val PROGRESS_EVERY = 4L * 1024 * 1024
    }
}
