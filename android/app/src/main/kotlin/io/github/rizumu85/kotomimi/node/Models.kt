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
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

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
     * mainland China without a proxy, where Hugging Face is not. Which is used is settled by trying both
     * (`ModelStore.fastestFirst`); this order only breaks a tie.
     */
    fun addresses(): List<Source> {
        val published = Source("Hugging Face", "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/$REVISION/$path")
        val mirrored = Source("魔搭", "https://modelscope.cn/models/audio-cpp/audio.cpp-gguf/resolve/master/$path")
        return if (inMainlandChina()) listOf(mirrored, published) else listOf(published, mirrored)
    }

    private companion object {
        const val REVISION = "e36610ac69b5262e914a52635324050bee8f1ad2"
        val CHINA_ZONES = setOf("Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "PRC")

        /** A guess that only orders the two addresses: by the phone's clock, or the region it is set to. */
        fun inMainlandChina() = TimeZone.getDefault().id in CHINA_ZONES || Locale.getDefault().country == "CN"
    }
}

/** A place a model is fetched from, and what it is called on the screen. */
class Source(val name: String, val address: String)

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

/**
 * Where the models are kept — the app's own folder on shared storage, which goes when the app is removed — and how
 * they get there.
 *
 * A download is taken in several pieces at once, from whichever of the model's addresses is the faster for this
 * phone at this moment. One connection to either was slow enough for the first person who tried it to give up
 * ("太慢了", 2026-10-11): a file server gives each connection a share, and four take four shares. What each piece has
 * is written down beside the file, so a download that was stopped goes on where every piece left off.
 */
class ModelStore(context: Context) {
    val folder: File = File(context.getExternalFilesDir(null), "models").apply { mkdirs() }

    fun fileOf(model: Model) = File(folder, model.file)
    private fun partOf(model: Model) = File(folder, "${model.file}.part")
    private fun notesOf(model: Model) = File(folder, "${model.file}.part.pieces")

    /** Whole and of the right size. (Its checksum was looked at when it was fetched.) */
    fun has(model: Model) = fileOf(model).length() == model.bytes

    /** Bytes here so far, of a download begun. */
    fun begun(model: Model): Long = piecesOf(model).sumOf { it.at - it.start }

    /** How a download stands: the bytes had, how many come in a second, and where from (blank while that is being found out). */
    class Progress(val had: Long, val perSecond: Long, val from: String)

    /** A stretch of the file, `start` to `end`, of which everything before `at` is here. */
    private class Piece(val start: Long, @Volatile var at: Long, val end: Long)

    /**
     * Fetches it, then checks it is the file it should be. `onProgress` is told how it stands twice a second, and
     * `onChecking` when the download is over; `stopped` is asked between pieces of work, and what is had is kept
     * when it says yes.
     */
    fun fetch(model: Model, onProgress: (Progress) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) {
        val part = partOf(model)
        val pieces = piecesOf(model)
        val had = AtomicLong(pieces.sumOf { it.at - it.start })
        // The file at its full length from the start: each piece writes at its own place in it.
        RandomAccessFile(part, "rw").use { it.setLength(model.bytes) }
        save(model, pieces)

        val open = pieces.filter { it.at < it.end }
        if (open.isNotEmpty()) {
            onProgress(Progress(had.get(), 0, ""))
            val sources = fastestFirst(model.addresses(), stopped)
            if (stopped()) return
            val failure = AtomicReference<IOException?>(null)
            val from = AtomicReference(sources.first().name)
            val workers = open.map { piece ->
                thread(name = "piece-${piece.start}") {
                    var last: IOException? = null
                    // The faster address, twice; then the other: a piece that fails at both is the download's failure.
                    for (source in sources + sources) {
                        if (stopped() || failure.get() != null) return@thread
                        try {
                            pull(source, part, piece, had, stopped)
                            if (piece.at >= piece.end || stopped()) return@thread
                        } catch (error: IOException) {
                            last = IOException("${source.name}：${error.message ?: error.javaClass.simpleName}")
                            if (source !== sources.first()) from.set(source.name)
                        }
                    }
                    failure.compareAndSet(null, last ?: IOException("下载中断了"))
                }
            }
            // Told from here: how fast, over the last few seconds; and written down, for a download that is stopped.
            val seen = ArrayDeque<Pair<Long, Long>>()
            var saved = 0L
            while (workers.any { it.isAlive }) {
                Thread.sleep(REPORT_EVERY_MS)
                val now = System.currentTimeMillis()
                seen += now to had.get()
                while (seen.size > 1 && now - seen.first().first > SPEED_OVER_MS) seen.removeFirst()
                val (since, then) = seen.first()
                onProgress(Progress(had.get(), if (now > since) (had.get() - then) * 1000 / (now - since) else 0, from.get()))
                if (now - saved > SAVE_EVERY_MS) { saved = now; save(model, pieces) }
            }
            save(model, pieces)
            if (stopped()) return
            failure.get()?.let { throw it }
        }
        if (pieces.any { it.at < it.end }) throw IOException("没有下完，再点一次接着下")

        onChecking()
        if (sha256Of(part, stopped) != model.sha256) {
            if (stopped()) return
            // Not the file: nothing of it is worth keeping.
            part.delete()
            notesOf(model).delete()
            throw IOException("下载到的文件不对，已删掉，请再下一次")
        }
        if (!part.renameTo(fileOf(model))) throw IOException("存不下来")
        notesOf(model).delete()
    }

    /**
     * The addresses, the one that brings the most in a few seconds first. Both are asked for the same first megabyte
     * at once; one that does not answer is last, and it is an error only when neither does. (From mainland China
     * Hugging Face does not answer at all; behind a proxy it may, slowly, and ModelScope slower still: no rule about
     * where the phone is knows which, and a megabyte from each does.)
     */
    private fun fastestFirst(sources: List<Source>, stopped: () -> Boolean): List<Source> {
        if (sources.size < 2) return sources
        val speeds = LongArray(sources.size)
        sources.mapIndexed { index, source ->
            thread(name = "try-${source.name}") { speeds[index] = runCatching { speedOf(source, stopped) }.getOrDefault(0L) }
        }.forEach { it.join() }
        if (speeds.all { it == 0L } && !stopped()) throw IOException("两个下载地址都连不上，检查一下网络")
        return sources.indices.sortedByDescending { speeds[it] }.map { sources[it] }
    }

    /** Bytes a second, over the first megabyte of the file or a few seconds, whichever ends first. */
    private fun speedOf(source: Source, stopped: () -> Boolean): Long {
        val connection = URL(source.address).openConnection() as HttpURLConnection
        connection.connectTimeout = TRY_FOR_MS.toInt()
        connection.readTimeout = TRY_FOR_MS.toInt()
        connection.setRequestProperty("Range", "bytes=0-${TRY_BYTES - 1}")
        val started = System.currentTimeMillis()
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) return 0
            var read = 0L
            connection.inputStream.use { input ->
                val buffer = ByteArray(1 shl 15)
                while (read < TRY_BYTES && System.currentTimeMillis() - started < TRY_FOR_MS && !stopped()) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    read += count
                }
            }
            val took = (System.currentTimeMillis() - started).coerceAtLeast(1)
            return read * 1000 / took
        } finally {
            connection.disconnect()
        }
    }

    /** What one address brings of one piece, written at the piece's place in the file. */
    private fun pull(source: Source, part: File, piece: Piece, had: AtomicLong, stopped: () -> Boolean) {
        val connection = URL(source.address).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("Range", "bytes=${piece.at}-${piece.end - 1}")
        try {
            // Anything but the stretch asked for would be written in the wrong place.
            if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) throw IOException("回答 ${connection.responseCode}")
            RandomAccessFile(part, "rw").use { out ->
                out.seek(piece.at)
                connection.inputStream.use { input ->
                    val buffer = ByteArray(1 shl 16)
                    while (piece.at < piece.end && !stopped()) {
                        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), piece.end - piece.at).toInt())
                        if (read < 0) break
                        out.write(buffer, 0, read)
                        piece.at += read
                        had.addAndGet(read.toLong())
                    }
                }
            }
            if (piece.at < piece.end && !stopped()) throw IOException("中途断了")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * The pieces of a model's download: as they were written down; or, for a download begun before there were
     * pieces — one run of bytes from the start — that run and the rest in pieces; or, for none begun, the whole file
     * in pieces.
     */
    private fun piecesOf(model: Model): List<Piece> {
        val part = partOf(model)
        val notes = notesOf(model)
        if (!part.exists()) return planned(0, model.bytes)
        if (notes.exists()) {
            val read = runCatching {
                notes.readLines().filter { it.isNotBlank() }.map { line -> line.split(' ').map(String::toLong).let { Piece(it[0], it[1], it[2]) } }
            }.getOrNull()
            // Held to its shape: stretches end to end over the whole file, each with its mark inside it.
            val whole = read != null && read.isNotEmpty() && read.first().start == 0L && read.last().end == model.bytes &&
                read.zipWithNext().all { (a, b) -> a.end == b.start } && read.all { it.at in it.start..it.end }
            if (whole) return read!!
            return planned(0, model.bytes)
        }
        val run = part.length().coerceAtMost(model.bytes)
        return listOf(Piece(0, run, run)).filter { it.end > 0 } + planned(run, model.bytes)
    }

    private fun planned(from: Long, to: Long): List<Piece> {
        if (from >= to) return emptyList()
        val size = maxOf((to - from + PIECES - 1) / PIECES, PIECE_LEAST)
        return generateSequence(from) { it + size }.takeWhile { it < to }.map { Piece(it, it, minOf(it + size, to)) }.toList()
    }

    private fun save(model: Model, pieces: List<Piece>) {
        runCatching { notesOf(model).writeText(pieces.joinToString("\n") { "${it.start} ${it.at} ${it.end}" }) }
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
        /** Connections at once, and the least one of them is worth opening for. */
        const val PIECES = 4
        const val PIECE_LEAST = 32L * 1024 * 1024
        const val TRY_BYTES = 1024L * 1024
        const val TRY_FOR_MS = 5_000L
        const val REPORT_EVERY_MS = 500L
        const val SPEED_OVER_MS = 4_000L
        const val SAVE_EVERY_MS = 2_000L
    }
}
