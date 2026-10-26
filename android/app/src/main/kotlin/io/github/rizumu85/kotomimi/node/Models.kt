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
 * Which engine reads a model. audio.cpp is the engine the desktop app runs; llama.cpp reads the same models from
 * files of its own, about twice as fast on a phone's processor (measured 2026-10-12, README). The phone is lent with
 * either: the self-check says which is the faster here. (Qwen3-ASR, that is. SenseVoice-Small is audio.cpp's alone.)
 */
enum class Reader(val words: String) { AUDIO_CPP("audio.cpp"), LLAMA_CPP("llama.cpp") }

/**
 * What a model is lent for, and the heading its rows stand under. Hearing is what the phone was made to lend. The
 * other two are text models, the desktop app's own (`TRANSLATORS` and `COACHES` in electron/native-engine.js), which
 * llama.cpp's server runs: one puts a sentence into another language, the other says what was wrong with one.
 */
enum class Task(val words: String) { HEAR("识别"), TRANSLATE("翻译"), COACH("语法反馈") }

/**
 * A file that is fetched (`Downloads`): the name it is kept under here, the size and SHA-256 that tell it is the
 * right one, and the places it is asked for. A model's file is one, and a new version of the app itself another
 * (`Release`).
 */
interface Fetched {
    val name: String
    val bytes: Long
    val sha256: String

    /** Where it is fetched from, the likelier first. Which is used is settled by trying them (`Downloads.fastestFirst`); this order only breaks a tie. */
    fun addresses(): List<Source>
}

private val CHINA_ZONES = setOf("Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "PRC")

/** A guess that only orders the addresses a file is asked for: by the phone's clock, or the region it is set to. */
fun inMainlandChina() = TimeZone.getDefault().id in CHINA_ZONES || Locale.getDefault().country == "CN"

/**
 * One file of a model: the repository it is published in and its place there, the name it is kept under here, and
 * the size and SHA-256 that tell it is the right one. `onModelScope` is whether ModelScope keeps that repository
 * too: one it does not keep is not asked there, where the answer could only be that it is not found. And
 * `modelScope` is the repository's name there, where its makers publish under another name than on Hugging Face
 * (Tencent is `tencent` there and `Tencent-Hunyuan` here).
 */
class ModelFile(
    val repository: String, val revision: String, val path: String,
    override val name: String, override val bytes: Long, override val sha256: String, val onModelScope: Boolean = true,
    val modelScope: String = repository,
) : Fetched {
    /**
     * Hugging Face is where the files are published; ModelScope keeps the same repository (the same bytes: the
     * sizes and checksums were compared, 2026-10-10) and is reached from mainland China without a proxy, where
     * Hugging Face is not.
     */
    override fun addresses(): List<Source> {
        val published = Source("Hugging Face", "https://huggingface.co/$repository/resolve/$revision/$path")
        val mirrored = Source("魔搭", "https://modelscope.cn/models/$modelScope/resolve/master/$path").takeIf { onModelScope }
        // A public mirror of Hugging Face, a volunteer's: the same path, answered from Beijing where Hugging Face is
        // not (2026-10-12). A second way in should ModelScope be down — and the only one from there for a file
        // ModelScope does not keep; what it brings is checked like the rest.
        val relayed = Source("HF 镜像", "https://hf-mirror.com/$repository/resolve/$revision/$path")
        return if (inMainlandChina()) listOfNotNull(mirrored, relayed, published) else listOfNotNull(published, mirrored, relayed)
    }
}

/**
 * A model an engine reads, in one file or several. audio.cpp's are the same files as the desktop app's
 * (`electron/native-engine.js`), under the same name there (`id`). Two models of one `name` are the same model for
 * the two engines: the self-check sets them side by side.
 *
 * `lentAs` is the name a computer is told when the phone is lent with it: audio.cpp's name for the model, whichever
 * engine reads. The desktop app looks that name up to know how the model is told a language and how long a stretch
 * it may be sent; a name it does not know (SenseVoice's) it tells the language by its bare code, which is what the
 * door takes.
 *
 * `accuracy` is its place among the models by how right it reads, 1 the best — the same for either engine, which
 * write the same text. It is what the phone goes by when it picks the model to lend (`Choices.preferred`), and it
 * was not measured on a phone: the same engine writes the same text of the same sound anywhere. On a desktop, of
 * the 59 stretches the app itself cut from seven clips of real Japanese conversation (2026-10-13), Qwen3-ASR 1.7B
 * wrote 16.9 % of the kana wrong, SenseVoice-Small 20.3 % and Qwen3-ASR 0.6B 20.7 %. Seven clips do not tell the
 * last two apart; they stand in the order they came out.
 *
 * What a model needs that the others do not, each left as it is for those:
 * - `note`: what its row says of it in place of the engine it is for, where the engine tells nobody anything.
 * - `hears`: the languages it reads, by the codes it is told them with and their names — where they are few
 *   enough that a computer may ask for one it cannot read, and has to be told so (`Share.readByAudioCpp`).
 * - `options`: what audio.cpp is told with every reading of it (`--request-option`, and the server's
 *   `default_request_options`).
 * - `graphics`: whether the self-check also reads it on the graphics chip.
 * - `unspaced`: whether it puts spaces into writing that has none, to be taken out again (`Share.unspaced`).
 *
 * `task` is what it is lent for; a text model (`TEXT_MODELS`) is one whose task is not hearing.
 *
 * `holdsMb` is the memory its engine keeps that the system cannot take back while it runs (megabytes of the
 * engine's own, `RssAnon`): what the phone must have to spare before the engine is started beside another
 * (`Share.ensure`). The file an engine maps is not in it — the system takes those pages back when it is short, and
 * gives them again. Measured on the F22 Pro where a figure is said to be; an estimate otherwise.
 */
class Model(
    val id: String, val name: String, val reader: Reader, val family: String, val files: List<ModelFile>, val accuracy: Int, val lentAs: String = id,
    val note: String? = null, val hears: Map<String, String>? = null, val options: Map<String, String> = emptyMap(),
    val graphics: Boolean = true, val unspaced: Boolean = false,
    val task: Task = Task.HEAR, val holdsMb: Int = 0,
) {
    val bytes: Long = files.sumOf { it.bytes }

    /** What tells it from the other models of its family: the last word of its name, "0.6B". */
    val size: String get() = name.substringAfterLast(' ')

    /** Whether another row carries its name: the same model for the other engine, which the two are then told apart by. */
    val twin: Boolean get() = MODELS.any { it !== this && it.name == name }

    /** As the desktop app writes sizes: in units of 1024. */
    val sizeInWords: String get() = "%.1f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))

    /** The model itself. */
    val file: ModelFile get() = files.first()

    /** What llama.cpp keeps in a file of its own beside the model: the part that hears (its `--mmproj`). */
    val projector: ModelFile? get() = files.getOrNull(1)
}

/** A place a file is fetched from, and what it is called on the screen. */
class Source(val name: String, val address: String)

private const val AUDIO_CPP_REPOSITORY = "audio-cpp/audio.cpp-gguf"
private const val AUDIO_CPP_REVISION = "e36610ac69b5262e914a52635324050bee8f1ad2"
private const val LLAMA_CPP_SMALL = "ggml-org/Qwen3-ASR-0.6B-GGUF"
private const val LLAMA_CPP_SMALL_REVISION = "928ab958557df9aa2ef1c93e0e83c7ad0933fae2"
private const val LLAMA_CPP_LARGE = "ggml-org/Qwen3-ASR-1.7B-GGUF"
private const val LLAMA_CPP_LARGE_REVISION = "36a678687ba7d07a74ca70ccb0e36902e005fb80"
private const val SENSEVOICE = "FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp"
private const val SENSEVOICE_REVISION = "5c3fcfe748a8714216bc135476d5863084fddb72"

/**
 * The smaller model first, and the same model for the two engines next to each other. The order is also what the
 * phone is lent with before any self-check (`Choices.preferred`): the smaller reads the faster, and whether a
 * larger one keeps up on this phone is not known until it is measured.
 *
 * SenseVoice-Small is audio.cpp's alone (llama.cpp has no such model), a quarter of the small Qwen3-ASR in size
 * and three times as fast on the phone both were tried on (3.4 against 1.1 times real time, F22 Pro, 2026-10-13),
 * in 0.3 GB of memory against 1.7. It reads five languages and no other.
 * - Its file is published on Hugging Face only: ModelScope has no repository of that name (asked 2026-10-12; it
 *   has the makers' `FunAudioLLM/SenseVoiceSmall-GGUF`, which is another file — the same weights without
 *   audio.cpp's description of the model in them, 2,880 bytes shorter). So from mainland China it comes by the
 *   mirror of Hugging Face alone.
 * - Left to itself audio.cpp cuts a recording at its pauses before it reads this model, with a second model the
 *   app does not carry, and fails for the lack of it (`Silero VAD model path does not exist`):
 *   `audio_chunk_mode=none` has it read the stretch whole, which is what a computer sends anyway.
 * - It is not read on the graphics chip by the self-check. audio.cpp's graphics backend has ended the program on
 *   both phones it was tried on, with either size of Qwen3-ASR; this model is the one that needs it least (the
 *   slowest phone tried reads a quarter of a minute of it in five seconds on its processor); and every run is
 *   one more wait for the phone to cool. A phone with a Qwen3-ASR for audio.cpp still tries the backend with that.
 * - It writes Japanese and Chinese with spaces in them now and then (in 27 of the 59 stretches of the measurement
 *   above; a second or two cut out of a sentence comes back a word at a time): `unspaced`.
 *
 * llama.cpp's files are kept under names of our own: as published, `Qwen3-ASR-0.6B-Q8_0.gguf` is audio.cpp's
 * `qwen3-asr-0.6b-q8_0.gguf` in other letters, and the app's folder on shared storage does not tell capitals from
 * small letters (seen on the test phone, 2026-10-12) — one would be taken for the other.
 *
 * `holdsMb` of the three that are on the F22 Pro is what each server held of its own after a reading there
 * (2026-10-13: 251, 1869 and 1295 MB). The two 1.7B were never run on it: theirs are reckoned from the 0.6B's, by
 * the size of the files, and are no better than that.
 */
val MODELS = listOf(
    Model(
        id = "sensevoice-small-q8",
        name = "SenseVoice-Small",
        reader = Reader.AUDIO_CPP,
        family = "sense_asr",
        accuracy = 2,
        holdsMb = 250,
        note = "快 · 只听中粤英日韩",
        hears = mapOf("zh" to "Chinese", "yue" to "Cantonese", "en" to "English", "ja" to "Japanese", "ko" to "Korean"),
        options = mapOf("audio_chunk_mode" to "none"),
        graphics = false,
        unspaced = true,
        files = listOf(
            ModelFile(
                SENSEVOICE, SENSEVOICE_REVISION,
                path = "sensevoice-small-q8-audiocpp-v1.gguf",
                name = "sensevoice-small-q8.gguf",
                bytes = 254_211_200,
                sha256 = "4dedf169f625437fb336f2959674f399819729a765e184128c0e25a6e16ff0ec",
                onModelScope = false,
            ),
        ),
    ),
    Model(
        id = "qwen3-asr-0.6b-q8",
        name = "Qwen3-ASR 0.6B",
        reader = Reader.AUDIO_CPP,
        family = "qwen3_asr",
        accuracy = 3,
        holdsMb = 1870,
        files = listOf(
            ModelFile(
                AUDIO_CPP_REPOSITORY, AUDIO_CPP_REVISION,
                path = "Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf",
                name = "qwen3-asr-0.6b-q8_0.gguf",
                bytes = 1_151_272_416,
                sha256 = "6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7",
                // ModelScope keeps only a later version of this file (larger by 7,552 bytes, another checksum: seen
                // 2026-10-25), and has no history to ask for this one: from there it never checks out.
                onModelScope = false,
            ),
        ),
    ),
    Model(
        id = "llama-qwen3-asr-0.6b-q8",
        lentAs = "qwen3-asr-0.6b-q8",
        name = "Qwen3-ASR 0.6B",
        reader = Reader.LLAMA_CPP,
        family = "qwen3_asr",
        accuracy = 3,
        holdsMb = 1300,
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
        accuracy = 1,
        holdsMb = 4000,
        files = listOf(
            ModelFile(
                AUDIO_CPP_REPOSITORY, AUDIO_CPP_REVISION,
                path = "Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
                name = "qwen3-asr-1.7b-q8_0.gguf",
                bytes = 2_473_010_048,
                sha256 = "da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8",
                // ModelScope keeps only a later version of this file (larger by 7,552 bytes, another checksum: seen
                // 2026-10-25), and has no history to ask for this one: from there it never checks out.
                onModelScope = false,
            ),
        ),
    ),
    Model(
        id = "llama-qwen3-asr-1.7b-q8",
        lentAs = "qwen3-asr-1.7b-q8",
        name = "Qwen3-ASR 1.7B",
        reader = Reader.LLAMA_CPP,
        family = "qwen3_asr",
        accuracy = 1,
        holdsMb = 3200,
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

private const val HUNYUAN = "tencent/Hy-MT2-1.8B-GGUF"
private const val HUNYUAN_REVISION = "a0c709d9fac510f2c807aa3af52872340dc37a4a"
private const val INDEX_TRANSLATE = "IndexTeam/Index-Translate-2B-GGUF"
private const val INDEX_TRANSLATE_REVISION = "449c9e6457b3632d328c6cbb78ae8e8e0c8059a5"
private const val GEMMA = "unsloth/gemma-4-E2B-it-GGUF"
private const val GEMMA_REVISION = "0314792d7f1f7e229411f620751375812bb9faf2"

/**
 * The text models: the desktop app's own translation and feedback models — the same files, by the same checksums
 * (`TRANSLATORS` and `COACHES` in electron/native-engine.js), under the desktop's own names for them (`id`), which
 * is what a computer asks for them by and what it picks its words to each by (`translatorRequest`,
 * `NATIVE_COACH_EXTRA`). llama.cpp's server runs them, on the processor.
 *
 * Every one that is downloaded is lent while the phone is shared; none is chosen, and none is loaded before it is
 * asked for (`Share.ensure`). The smaller translator first, as the recognizers stand. `accuracy` is their order on
 * the desktop's own measurement (thirty sentences of Japanese talk into Chinese, 2026-10-05: serious errors in
 * about 3 for Index-Translate and 8 for Hunyuan MT 2), not anything a phone measured.
 *
 * All three are on Hugging Face, on its mirror and on ModelScope: each address was asked for the first bytes of
 * its file and answered with the file's right length (2026-10-13, from outside mainland China).
 *
 * `holdsMb`: the two translators were measured on the F22 Pro with the armv8.2 server, which rewrites a model's
 * Q4_K weights into a copy of its own at loading — that copy is the memory, and the speed (NOTES.md, 2026-10-12:
 * 1190 and 1541 MB, against 309 and 338 MB for a server that does not rewrite them and reads half as fast; lent
 * from the app on 2026-10-13, Hunyuan MT 2 held 1212 MB). Gemma's was never measured on any phone: it is its file
 * and what Index-Translate holds beyond its own.
 */
val TEXT_MODELS = listOf(
    Model(
        id = "hy-mt2-1.8b",
        name = "Hunyuan MT 2 1.8B",
        reader = Reader.LLAMA_CPP,
        family = "hunyuan",
        task = Task.TRANSLATE,
        accuracy = 2,
        holdsMb = 1210,
        files = listOf(
            ModelFile(
                HUNYUAN, HUNYUAN_REVISION,
                path = "Hy-MT2-1.8B-Q4_K_M.gguf",
                name = "Hy-MT2-1.8B-Q4_K_M.gguf",
                bytes = 1_133_080_448,
                sha256 = "dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699",
                modelScope = "Tencent-Hunyuan/Hy-MT2-1.8B-GGUF",
            ),
        ),
    ),
    Model(
        id = "index-translate-2b",
        name = "Index-Translate 2B",
        reader = Reader.LLAMA_CPP,
        family = "index",
        task = Task.TRANSLATE,
        accuracy = 1,
        note = "更准",
        holdsMb = 1541,
        files = listOf(
            ModelFile(
                INDEX_TRANSLATE, INDEX_TRANSLATE_REVISION,
                path = "Index-Translate-2B.Q4_K_M.gguf",
                name = "Index-Translate-2B.Q4_K_M.gguf",
                bytes = 1_312_164_352,
                sha256 = "044b313d29342bd3b2c77cbb64023ca0d209bd9b3247763f9d162767ef2d746a",
            ),
        ),
    ),
    Model(
        id = "gemma-4-e2b",
        name = "Gemma 4 E2B",
        reader = Reader.LLAMA_CPP,
        family = "gemma",
        task = Task.COACH,
        accuracy = 1,
        holdsMb = 3250,
        files = listOf(
            ModelFile(
                GEMMA, GEMMA_REVISION,
                path = "gemma-4-E2B-it-Q4_K_M.gguf",
                name = "gemma-4-E2B-it-Q4_K_M.gguf",
                bytes = 3_106_738_272,
                sha256 = "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
            ),
        ),
    ),
)

/** Every row of the screen, in the order of the screen. */
val ALL_MODELS = MODELS + TEXT_MODELS

/**
 * Where the models are kept — the app's own folder on shared storage, which goes when the app is removed — and how
 * they get there (`Downloads`).
 */
class ModelStore(context: Context) {
    private val downloads = Downloads(File(context.getExternalFilesDir(null), "models"))
    val folder: File get() = downloads.folder

    fun fileOf(file: ModelFile) = downloads.fileOf(file)

    /** Whole and of the right size. (Its checksum was looked at when it was fetched.) */
    fun has(file: ModelFile) = downloads.has(file)

    /** Every file of it is here. */
    fun has(model: Model) = model.files.all { has(it) }

    /** Bytes here so far, of a download begun: the files that are whole, and what there is of the one in hand. */
    fun begun(model: Model): Long = model.files.sumOf { downloads.begun(it) }

    /**
     * Takes a model off the phone, when the person asks: its files, and what there is of a download of them. A file
     * that another model here also reads stays.
     */
    fun remove(model: Model, all: List<Model>) {
        val kept = all.filter { it !== model && has(it) }.flatMap { other -> other.files.map { fileOf(it).name } }.toSet()
        for (file in model.files) if (fileOf(file).name !in kept) downloads.remove(file)
    }

    /**
     * How a download stands: the bytes had of the whole model, how many come in a second, where from (blank while
     * that is being found out), and which of the model's files it is at.
     */
    class Progress(val had: Long, val perSecond: Long, val from: String, val file: Int, val files: Int)

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
            downloads.fetch(file, { had, perSecond, from -> onProgress(Progress(before + had, perSecond, from, index + 1, model.files.size)) }, onChecking, stopped)
            // Stopped in the middle of it.
            if (!has(file)) return
        }
    }
}

/**
 * Files fetched into one folder: the models into theirs, a new version of the app into its own.
 *
 * A download is taken in several pieces at once, from whichever of the file's addresses is the faster for this
 * phone at this moment. One connection to either was slow enough for the first person who tried it to give up
 * ("太慢了", 2026-10-11): a file server gives each connection a share, and four take four shares. What each piece has
 * is written down beside the file, so a download that was stopped goes on where every piece left off.
 */
class Downloads(val folder: File) {
    init {
        folder.mkdirs()
    }

    fun fileOf(file: Fetched) = File(folder, file.name)
    private fun partOf(file: Fetched) = File(folder, "${file.name}.part")
    private fun notesOf(file: Fetched) = File(folder, "${file.name}.part.pieces")

    /** Whole and of the right size. (Its checksum was looked at when it was fetched.) */
    fun has(file: Fetched) = fileOf(file).length() == file.bytes

    /** The file gone, and what there was of a download of it. */
    fun remove(file: Fetched) {
        for (it in listOf(fileOf(file), partOf(file), notesOf(file))) it.delete()
    }

    /** Bytes of it here so far: all of it, or what there is of a download begun. */
    fun begun(file: Fetched): Long = if (has(file)) file.bytes else piecesOf(file).sumOf { it.at - it.start }

    /** A stretch of the file, `start` to `end`, of which everything before `at` is here. */
    private class Piece(val start: Long, @Volatile var at: Long, val end: Long)

    /**
     * One file: fetched in pieces, then checked. `onProgress` is told the bytes had of this file, the speed and the
     * source (blank while that is being found out) twice a second, and `onChecking` when the download is over;
     * `stopped` is asked between pieces of work, and what is had is kept when it says yes.
     */
    fun fetch(file: Fetched, onProgress: (Long, Long, String) -> Unit, onChecking: () -> Unit, stopped: () -> Boolean) {
        val part = partOf(file)
        val pieces = piecesOf(file)
        val had = AtomicLong(pieces.sumOf { it.at - it.start })
        // The file at its full length from the start: each piece writes at its own place in it.
        RandomAccessFile(part, "rw").use { it.setLength(file.bytes) }
        save(file, pieces)

        val open = pieces.filter { it.at < it.end }
        if (open.isNotEmpty()) {
            onProgress(had.get(), 0, "")
            val sources = fastestFirst(file.addresses(), file.bytes, stopped)
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
                            pull(source, part, piece, file.bytes, had, stopped)
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
    private fun fastestFirst(sources: List<Source>, expected: Long, stopped: () -> Boolean): List<Source> {
        if (sources.size < 2) return sources
        val speeds = LongArray(sources.size)
        sources.mapIndexed { index, source ->
            thread(name = "try-${source.name}") { speeds[index] = runCatching { speedOf(source, expected, stopped) }.getOrDefault(0L) }
        }.forEach { it.join() }
        return sources.indices.sortedByDescending { speeds[it] }.map { sources[it] }
    }

    /** Bytes a second, over the first megabyte of the file or a few seconds, whichever ends first. */
    private fun speedOf(source: Source, expected: Long, stopped: () -> Boolean): Long {
        val connection = URL(source.address).openConnection() as HttpURLConnection
        connection.connectTimeout = TRY_FOR_MS.toInt()
        connection.readTimeout = TRY_FOR_MS.toInt()
        connection.setRequestProperty("Range", "bytes=0-${TRY_BYTES - 1}")
        val started = System.currentTimeMillis()
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) return 0
            // Another length is another file: what it brought would not check out, however quickly it came.
            if (!sameLength(connection, expected)) return 0
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

    /** Whether an answer to a range says the whole file is `expected` bytes long; one that does not say is taken at its word. */
    private fun sameLength(connection: HttpURLConnection, expected: Long): Boolean {
        val total = connection.getHeaderField("Content-Range")?.substringAfterLast('/')?.trim()?.toLongOrNull() ?: return true
        return total == expected
    }

    /** What one address brings of one piece, written at the piece's place in the file. */
    private fun pull(source: Source, part: File, piece: Piece, expected: Long, had: AtomicLong, stopped: () -> Boolean) {
        val connection = URL(source.address).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("Range", "bytes=${piece.at}-${piece.end - 1}")
        try {
            // Anything but the stretch asked for would be written in the wrong place.
            if (connection.responseCode != HttpURLConnection.HTTP_PARTIAL) throw IOException("回答 ${connection.responseCode}")
            // Another version of the file, at the same address: its bytes in this one's places would never check out,
            // and every try again would end the same way (ModelScope, 2026-10-25). The next address is asked instead.
            if (!sameLength(connection, expected)) throw IOException("这里的文件是另一个版本")
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
    private fun piecesOf(file: Fetched): List<Piece> {
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

    private fun save(file: Fetched, pieces: List<Piece>) {
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
