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
 * Which engine reads a model. audio.cpp is the one the phone is lent with; llama.cpp reads the same models from
 * files of its own, and is here for the self-check to compare the two.
 */
enum class Reader(val words: String) { AUDIO_CPP("audio.cpp"), LLAMA_CPP("llama.cpp") }

/**
 * One file of a model: the repository it is published in and its place there, the name it is kept under here, and
 * the size and SHA-256 that tell it is the right one.
 */
class ModelFile(val repository: String, val revision: String, val path: String, val name: String, val bytes: Long, val sha256: String) {
    /**
     * Where it is fetched from, the likelier first. Hugging Face is where the files are published; ModelScope keeps
     * the same repository (the same bytes: the sizes and checksums were compared, 2026-10-10) and is reached from
     * mainland China without a proxy, where Hugging Face is not. Which is used is settled by trying both
     * (`ModelStore.fastestFirst`); this order only breaks a tie.
     */
    fun addresses(): List<Source> {
        val published = Source("Hugging Face", "https://huggingface.co/$repository/resolve/$revision/$path")
        val mirrored = Source("魔搭", "https://modelscope.cn/models/$repository/resolve/master/$path")
        // A public mirror of Hugging Face, a volunteer's: the same path, answered from Beijing where Hugging Face is
        // not (2026-10-12). A second way in should ModelScope be down; what it brings is checked like the rest.
        val relayed = Source("HF 镜像", "https://hf-mirror.com/$repository/resolve/$revision/$path")
        return if (inMainlandChina()) listOf(mirrored, relayed, published) else listOf(published, mirrored, relayed)
    }

    private companion object {
        val CHINA_ZONES = setOf("Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "PRC")

        /** A guess that only orders the two addresses: by the phone's clock, or the region it is set to. */
        fun inMainlandChina() = TimeZone.getDefault().id in CHINA_ZONES || Locale.getDefault().country == "CN"
    }
}

/**
 * A model an engine reads, in one file or several. audio.cpp's are the same files as the desktop app's
 * (`electron/native-engine.js`), under the same name there (`id`). Two models of one `name` are the same model for
 * the two engines: the self-check sets them side by side.
 */
class Model(val id: String, val name: String, val reader: Reader, val family: String, val files: List<ModelFile>) {
    val bytes: Long = files.sumOf { it.bytes }

    /** As the desktop app writes sizes: in units of 1024. */
    val sizeInWords: String get() = "%.1f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))

    /** The model itself. */
    val file: ModelFile get() = files.first()

    /** What llama.cpp keeps in a file of its own beside the model: the part that hears (its `--mmproj`). */
    val projector: ModelFile? get() = files.getOrNull(1)
}

/** A place a model is fetched from, and what it is called on the screen. */
class Source(val name: String, val address: String)

private const val AUDIO_CPP_REPOSITORY = "audio-cpp/audio.cpp-gguf"
private const val AUDIO_CPP_REVISION = "e36610ac69b5262e914a52635324050bee8f1ad2"
private const val LLAMA_CPP_SMALL = "ggml-org/Qwen3-ASR-0.6B-GGUF"
private const val LLAMA_CPP_SMALL_REVISION = "928ab958557df9aa2ef1c93e0e83c7ad0933fae2"
private const val LLAMA_CPP_LARGE = "ggml-org/Qwen3-ASR-1.7B-GGUF"
private const val LLAMA_CPP_LARGE_REVISION = "36a678687ba7d07a74ca70ccb0e36902e005fb80"

/**
 * The same model for the two engines next to each other, the smaller model first.
 *
 * llama.cpp's files are kept under names of our own: as published, `Qwen3-ASR-0.6B-Q8_0.gguf` is audio.cpp's
 * `qwen3-asr-0.6b-q8_0.gguf` in other letters, and the app's folder on shared storage does not tell capitals from
 * small letters (seen on the test phone, 2026-10-12) — one would be taken for the other.
 */
val MODELS = listOf(
    Model(
        id = "qwen3-asr-0.6b-q8",
        name = "Qwen3-ASR 0.6B",
        reader = Reader.AUDIO_CPP,
        family = "qwen3_asr",
        files = listOf(
            ModelFile(
                AUDIO_CPP_REPOSITORY, AUDIO_CPP_REVISION,
                path = "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf",
                name = "qwen3-asr-0.6b-q8_0.gguf",
                bytes = 1_151_272_416,
                sha256 = "6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7",
            ),
        ),
    ),
    Model(
        id = "llama-qwen3-asr-0.6b-q8",
        name = "Qwen3-ASR 0.6B",
        reader = Reader.LLAMA_CPP,
        family = "qwen3_asr",
        files = listOf(
            ModelFile(
                LLAMA_CPP_SMALL, LLAMA_CPP_SMALL_REVISION,
                path = "Qwen3-ASR-0.6B-Q8_0.gguf",
                name = "llama-qwen3-asr-0.6b-q8_0.gguf",
                bytes = 804_749_248,
                sha256 = "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
            ),
            ModelFile(
                LLAMA_CPP_SMALL, LLAMA_CPP_SMALL_REVISION,
                path = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
                name = "llama-qwen3-asr-0.6b-q8_0-mmproj.gguf",
                bytes = 214_392_480,
                sha256 = "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
            ),
        ),
    ),
    Model(
        id = "qwen3-asr-1.7b-q8",
        name = "Qwen3-ASR 1.7B",
        reader = Reader.AUDIO_CPP,
        family = "qwen3_asr",
        files = listOf(
            ModelFile(
                AUDIO_CPP_REPOSITORY, AUDIO_CPP_REVISION,
                path = "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
                name = "qwen3-asr-1.7b-q8_0.gguf",
                bytes = 2_473_010_048,
                sha256 = "da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8",
            ),
        ),
    ),
    Model(
        id = "llama-qwen3-asr-1.7b-q8",
        name = "Qwen3-ASR 1.7B",
        reader = Reader.LLAMA_CPP,
        family = "qwen3_asr",
        files = listOf(
            ModelFile(
                LLAMA_CPP_LARGE, LLAMA_CPP_LARGE_REVISION,
                path = "Qwen3-ASR-1.7B-Q8_0.gguf",
                name = "llama-qwen3-asr-1.7b-q8_0.gguf",
                bytes = 2_165_034_944,
                sha256 = "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
            ),
            ModelFile(
                LLAMA_CPP_LARGE, LLAMA_CPP_LARGE_REVISION,
                path = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
                name = "llama-qwen3-asr-1.7b-q8_0-mmproj.gguf",
                bytes = 355_709_344,
                sha256 = "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
            ),
        ),
    ),
)

/** The models the phone can be lent with: sharing runs audio.cpp's server, which reads audio.cpp's files only. */
val LENDABLE = MODELS.filter { it.reader == Reader.AUDIO_CPP }

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

    fun fileOf(file: ModelFile) = File(folder, file.name)
    private fun partOf(file: ModelFile) = File(folder, "${file.name}.part")
    private fun notesOf(file: ModelFile) = File(folder, "${file.name}.part.pieces")

    /** Whole and of the right size. (Its checksum was looked at when it was fetched.) */
    fun has(file: ModelFile) = fileOf(file).length() == file.bytes

    /** Every file of it is here. */
    fun has(model: Model) = model.files.all { has(it) }

    /** Bytes here so far, of a download begun: the files that are whole, and what there is of the one in hand. */
    fun begun(model: Model): Long = model.files.sumOf { file -> if (has(file)) file.bytes else piecesOf(file).sumOf { it.at - it.start } }

    /**
     * How a download stands: the bytes had of the whole model, how many come in a second, where from (blank while
     * that is being found out), and which of the model's files it is at.
     */
    class Progress(val had: Long, val perSecond: Long, val from: String, val file: Int, val files: Int)

    /** A stretch of the file, `start` to `end`, of which everything before `at` is here. */
    private class Piece(val start: Long, @Volatile var at: Long, val end: Long)

    /**
     * Fetches a model: each of its files in turn, the ones already here passed over, each checked to be the file it
     * should be before the next is begun. `onProgress` is told how it stands twice a second, and `onChecking` when a
     * file's download is over; `stopped` is asked between pieces of work, and what is had is kept when it says yes.
     */
    fun fetch(model: Model, onProgress: (Progress) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) {
        for ((index, file) in model.files.withIndex()) {
            if (stopped()) return
            if (has(file)) continue
            // Every file before this one is whole by now.
            val before = model.files.take(index).sumOf { it.bytes }
            fetch(file, { had, perSecond, from -> onProgress(Progress(before + had, perSecond, from, index + 1, model.files.size)) }, onChecking, stopped)
            // Stopped in the middle of it.
            if (!has(file)) return
        }
    }

    /** One file: fetched in pieces, then checked. `onProgress` is told the bytes had of this file, the speed and the source. */
    private fun fetch(file: ModelFile, onProgress: (Long, Long, String) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) {
        val part = partOf(file)
        val pieces = piecesOf(file)
        val had = AtomicLong(pieces.sumOf { it.at - it.start })
        // The file at its full length from the start: each piece writes at its own place in it.
        RandomAccessFile(part, "rw").use { it.setLength(file.bytes) }
        save(file, pieces)

        val open = pieces.filter { it.at < it.end }
        if (open.isNotEmpty()) {
            onProgress(had.get(), 0, "")
            val sources = fastestFirst(file.addresses(), stopped)
            if (stopped()) return
            val failure = AtomicReference<IOException?>(null)
            val from = AtomicReference(sources.first().name)
            val workers = open.map { piece ->
                thread(name = "piece-${piece.start}") {
                    var last: IOException? = null
                    // The addresses in turn, the faster first: one that brought something is asked for the rest, one
                    // that brought nothing is left for the next. A piece that breaks off — as a long one does, on a
                    // poor line — goes on by itself; it is the download's failure only once every address has been
                    // asked twice in a row for nothing. (The desktop does the same: electron/fetch-file.js.)
                    var at = 0
                    var barren = 0
                    while (barren < sources.size * ROUNDS_IN_VAIN) {
                        if (stopped() || failure.get() != null) return@thread
                        val source = sources[at % sources.size]
                        val before = piece.at
                        try {
                            pull(source, part, piece, had, stopped)
                            if (piece.at >= piece.end || stopped()) return@thread
                        } catch (error: Exception) {
                            last = IOException("${source.name}：${error.message ?: error.javaClass.simpleName}")
                        }
                        if (piece.at > before) { barren = 0; from.set(source.name) } else { barren += 1; at += 1 }
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
                onProgress(had.get(), if (now > since) (had.get() - then) * 1000 / (now - since) else 0, from.get())
                if (now - saved > SAVE_EVERY_MS) { saved = now; save(file, pieces) }
            }
            save(file, pieces)
            if (stopped()) return
            failure.get()?.let { throw it }
        }
        if (pieces.any { it.at < it.end }) throw IOException("没有下完，再点一次接着下")

        onChecking()
        if (sha256Of(part, stopped) != file.sha256) {
            if (stopped()) return
            // Not the file: nothing of it is worth keeping.
            part.delete()
            notesOf(file).delete()
            throw IOException("下载到的文件不对，已删掉，请再下一次")
        }
        if (!part.renameTo(fileOf(file))) throw IOException("存不下来")
        notesOf(file).delete()
    }

    /**
     * The addresses, the one that brings the most in a few seconds first. All are asked for the same first megabyte
     * at once; one that does not answer is last. (From mainland China Hugging Face does not answer at all; behind a
     * proxy it may, slowly, and ModelScope slower still: no rule about where the phone is knows which, and a megabyte
     * from each does.)
     *
     * This only orders them. None answering in these few seconds is not yet a failure — from an exit in Beijing,
     * 2026-10-12, ModelScope took up to three seconds to begin, and a poorer line takes longer: the pieces then ask
     * in the order given, with the patience of a download, and say what stopped them.
     */
    private fun fastestFirst(sources: List<Source>, stopped: () -> Boolean): List<Source> {
        if (sources.size < 2) return sources
        val speeds = LongArray(sources.size)
        sources.mapIndexed { index, source ->
            thread(name = "try-${source.name}") { speeds[index] = runCatching { speedOf(source, stopped) }.getOrDefault(0L) }
        }.forEach { it.join() }
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
            // It answered: ahead of one that did not, however little came in the time.
            return (read * 1000 / took).coerceAtLeast(1)
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
     * The pieces of a file's download: as they were written down; or, for a download begun before there were
     * pieces — one run of bytes from the start — that run and the rest in pieces; or, for none begun, the whole file
     * in pieces.
     */
    private fun piecesOf(file: ModelFile): List<Piece> {
        val part = partOf(file)
        val notes = notesOf(file)
        if (!part.exists()) return planned(0, file.bytes)
        if (notes.exists()) {
            val read = runCatching {
                notes.readLines().filter { it.isNotBlank() }.map { line -> line.split(' ').map(String::toLong).let { Piece(it[0], it[1], it[2]) } }
            }.getOrNull()
            // Held to its shape: stretches end to end over the whole file, each with its mark inside it.
            val whole = read != null && read.isNotEmpty() && read.first().start == 0L && read.last().end == file.bytes &&
                read.zipWithNext().all { (a, b) -> a.end == b.start } && read.all { it.at in it.start..it.end }
            if (whole) return read!!
            return planned(0, file.bytes)
        }
        val run = part.length().coerceAtMost(file.bytes)
        return listOf(Piece(0, run, run)).filter { it.end > 0 } + planned(run, file.bytes)
    }

    private fun planned(from: Long, to: Long): List<Piece> {
        if (from >= to) return emptyList()
        val size = maxOf((to - from + PIECES - 1) / PIECES, PIECE_LEAST)
        return generateSequence(from) { it + size }.takeWhile { it < to }.map { Piece(it, it, minOf(it + size, to)) }.toList()
    }

    private fun save(file: ModelFile, pieces: List<Piece>) {
        runCatching { notesOf(file).writeText(pieces.joinToString("\n") { "${it.start} ${it.at} ${it.end}" }) }
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
        /** Every address is asked this many times in a row, with nothing to show for it, before a piece gives up. */
        const val ROUNDS_IN_VAIN = 2
        const val TRY_BYTES = 1024L * 1024
        const val TRY_FOR_MS = 5_000L
        const val REPORT_EVERY_MS = 500L
        const val SPEED_OVER_MS = 4_000L
        const val SAVE_EVERY_MS = 2_000L
    }
}
