# Native engines

Kotomimi downloads a native runtime and a model, runs the engine on this computer and streams audio to it. Numbers behind the conclusions here are in [measurements](measurements.md).

## Runtime and where it lives

One manager, `createNativeEngine` in `electron/native-engine.js`, runs three engines, each with its catalog and runtime.

| Engine | Runtime | Catalog | Folder in userData |
|---|---|---|---|
| Recognition | audio.cpp | `MODELS` | `native-engine` |
| Translation | llama.cpp | `TRANSLATORS` | `native-translator` |
| Feedback | llama.cpp | `COACHES` | `native-coach` |

- Runtimes are the projects' release archives: Vulkan on Windows x64, Metal on Apple silicon.
- Address, size and SHA-256 of every file are fixed in code. The page names a model by id and nothing else.
- A server listens on 127.0.0.1, on a port picked at each start. It is ready after the health endpoint answers and one warm-up: a second of faint noise, or one short answer.

## Engine lifecycle

An engine holds video memory only while something uses it. Holds and the rest timer are in `src/providers/openai/localaiNative.ts`.

- Readiness (`nativeGap`, `translatorGap`, `coachGap`) only checks downloads. It never starts an engine.
- `prepareLocalAI`, the session's `prepare` hook, starts the engines side by side and waits. Translation and feedback are built afterwards, because their ports are unknown until then.
- `holdNativeForRun` holds from that step to the run's abort signal, so the rest timer cannot fire during loading or between legs.
- `restNative` stops unused engines a minute (`NATIVE_REST_MS`) after the last release, so a quick restart loads nothing twice. A card's retry and the sign-in start (`primeNativeOnce`) hold nothing and end this way.
- A device using a shared engine holds it with `holdNative`. A shared translator's connection idles out first (`TRANSLATOR_IDLE_MS`), so it stops about eleven minutes after last use.
- When settings stop needing an engine, the check stops it at once (`nativeIdle`), never during a run or under a device.
- A restart changes port and key, so the pipeline asks for the address before each request (`TextStage.engine`, `engineBaseNow`).

Downloaded recognition and translation engines run one model at a time, and one in use does not switch:

- A device naming another model gets the running one where it fits, otherwise nothing (`nativeTaken`, `src/lib/lan/nativeShare.ts`).
- A local run needing another model under a device ends with `native_busy` or `native_translator_busy`.
- A device naming no model gets the owner's choice first (`preferNative`), so the owner's next run switches nothing.

Engines stop with the app, on `process.exit` paths, with the last window on a Mac, and when the page crashes or reloads (`electron/main.js`): holds are counted in the page. On a Mac `joinEngines` gets `idleMs: Infinity`, since its own timer cannot see those holds and would stop an engine under a silent run.

## Audio path and segmentation

A page cannot hold an upload stream over HTTP/1.1, so the main process holds the live request and audio and text cross IPC. The page resamples to 16 kHz (`src/lib/native/resample.ts`) because the engine's own downsampling costs accuracy.

Segmentation is in `src/providers/openai/nativeAsr.ts`, on the app's VAD.

- One VAD speech turn is one recognition, opened with the 0.8 s before it and closed when the pause has passed.
- At a VAD forced cut the speaker has not stopped: text so far goes on as a result and the recognition stays open, so nothing is lost at the seam.
- `NativeLimits` restarts a recognition at a gap between words after `rollAfter`, at a VAD cut after `rollAt`, anywhere at `rollHard`: 45, 60 and 90 s by default, under the engine's limit near two minutes.
- After a gap the next recognition begins with the next voice, because reading silence produced phantom words.
- The engine writes the end of what it heard only after about a second of silence, so the app adds what the pause did not supply (`TRAILING_SILENCE_SECONDS`).
- R2T2 sometimes listens without writing, then writes everything at once. Closing then loses later text, so the app waits. Known limitation.

## Model roster

`NATIVE_MODELS` in `src/providers/openai/localaiNative.ts` is the order of recommendation and of fallback.

| Model | Why it sits here | Limits |
|---|---|---|
| Apple Speech | Most accurate | macOS 26+; 11 languages |
| Qwen3-ASR 1.7B | Most accurate download; `NATIVE_DEFAULT_MODEL` | 30 languages |
| Confucius4 R2T2 | Written text never changes | Windows only; 11 languages |
| SenseVoice-Small | As accurate as 0.6B, far lighter | 5 languages |
| Qwen3-ASR 0.6B | Runs beside a game | 30 languages |
| Nemotron 3.5 ASR 0.6B | Drops short sentences, so it ranks last | Kept for its languages |

R2T2 is the only `mode: 'streaming'` model. Streaming costs it far more than reading a stretch costs the others, so an M2 cannot keep up although memory is ample, and Macs are not offered it. A weak Windows GPU can fall behind too, which the app does not detect.

A language resolves (`nativePicked`) to the model chosen for it, else the model in use if it hears it, else the first downloaded that hears it, else none. An explicit choice is kept: readiness reports it missing rather than substituting. Two downloaded-engine models in one run are refused (`native_two_models`); Apple Speech can run beside the downloaded engine.

Both Qwen3-ASR sizes and SenseVoice have `detects`; SenseVoice only among its five, writing any other language as one of them. R2T2 writes the first words in the wrong language and Nemotron wrote Japanese as an English letter.

## Qwen3-ASR windowed reading

Qwen3-ASR reads a whole stretch, and its own streaming mode writes only every thirty seconds. A reading is fast enough to fake live text, so `openWindow` does that for every `mode: 'offline'` model.

- The main process keeps the stretch and re-reads it while it grows. Each reading is a `partial` event: the whole text, which the next may rewrite.
- One more reading at the end is final, unless the last one missed only a quiet tail of at most 3 s. Quiet is under a tenth of the peak, capped near -30 dB, so a soft last word after a laugh counts.
- The next reading waits 0.6 s or as long as the last took, and needs 0.4 s of new sound. A slow GPU refreshes partials less often and is never behind on finals.
- `WINDOW_LIMITS` restarts at a gap or VAD cut after 8 s and anywhere at 24 s: readings slow as a stretch grows, and nothing is translated before a final. Past 120 s a stretch fails (`WINDOW_MOST_SECONDS`).

### Repetition guard

These models occasionally write one phrase until stopped, and no request option prevents it.

`lostAt` flags a unit of up to 20 characters repeated at least 8 times, in a run of at least 40 characters, with at most 20 characters after it. Real speech repeats briefly and goes on, so digits, laughter and interjections pass.

- A partial is cut where the repeat begins, keeping the unit once (`unloop`).
- A final is read again after 0.5 s of silence. If it still repeats, a stretch of at least 4 s, no more than 8 s after it ended, is split at the quietest moment of its middle third and the halves read apart. Otherwise the text is cut.

## SenseVoice-Small

- One CTC pass: it cannot repeat, and a reading costs almost nothing. It uses `openWindow` and `WINDOW_LIMITS`.
- It needs `audio_chunk_mode: 'none'` (`requestOptions`). By default audio.cpp first cuts recordings with Silero VAD, which the app does not carry, and reading fails.
- Told a language outside its five it does not refuse; it writes the speech as one of the five. So it is offered for those alone and has no `detects`.
- It puts spaces inside Japanese and Chinese. `unspaced` removes them; the rule matches the phone's `Share.unspaced`, and `electron/remote-engine.js` applies it again by model name.
- It rarely punctuates, so a long run waits for its end before translation. The mark ending each reading closes nothing: `src/providers/openai/sentenceCut.ts` wants more said past it.
- On a Mac it was validated with the command-line program on Metal, not through the server with re-reading.

## Apple Speech

macOS 26 and later carry an on-device recognizer. The helper `native/apple-speech/SpeechHelper.swift` reaches it, one process per stretch, and `electron/apple-speech.js` answers the same interface as the downloaded engine.

- No runtime or server: it is ready at once if the language is installed. Its models are system language assets (`apple-speech:ja`), fetched by the system. Russian is not among them.
- Two recognizers hear the same audio: the fast one shows text, the considered one writes what is kept, because fast results degrade even the final text. Each needs its own analyzer, or the fast one stops being fast.
- Settled text arrives about every ten seconds or at the end, so `APPLE_LIMITS` restarts at a gap after 10 s, and at a VAD cut only after 20 s, since those fall inside words.

`joinEngines` in `electron/native-engines.js` presents both engines as one, sending each request to the model's own engine. The engine started last is the reported `run`; an earlier one stays up, since a device may be listening through it.

The system lets an app reserve only `AssetInventory.maximumReservedLocales` languages. Before reserving another, `makeRoom` releases one not downloaded, then the one used longest ago (order in `apple-speech-used.json`), never one in use. Release does not delete assets.

`native/apple-speech/build.sh` builds the helper as a small `.app`, because recognition is granted only to a bundle. Without the macOS 26 SDK it skips, and that build lacks the recognizer.

Apple Speech can compare two installed candidates per audio source: a selected pair, not open detection. Only the final transcript's language routes translation and feedback, and a pair that cannot be met fails rather than falling back. See `docs/apple-speech-lan.md`.

## Native translation

`llama-server` speaks the OpenAI chat wire, so translation streams like an API model. `NATIVE_TRANSLATORS` in `src/providers/openai/nativeTranslators.ts` is the order: Index-Translate 2B (any language, fewest serious errors), PLaMo 3 Translate 2B (most natural; 52 languages, no Cantonese; non-commercial only), Hunyuan MT 2 1.8B (36 languages), PLaMo 3 Translate 0.8B (lightest). PLaMo is asked by its chat template's own options and needs llama.cpp b12182 or later.

- These are not chat models. A request is one user message in the model card's form, no system prompt (`translatorRequest`).
- Hunyuan MT 1.5 is `retired`: nothing over MT 2, and it adds words.
- Index-Translate 9B is not used: no fewer serious errors, slower and heavier.

## Native feedback

Feedback runs in its own llama.cpp process, because one run can need it and translation at once.

- Gemma 4 E2B caught the most mistakes among small models without correcting valid casual speech.
- The prompt in `src/providers/openai/coachPrompt.ts` says this is talk between friends and to answer ✓ when unsure. Small models otherwise correct valid speech.
- Requests carry `NATIVE_COACH_EXTRA`, temperature 0 and thinking off, locally and shared. Gemma otherwise thinks first: slower, and a capped answer can come back empty.

## Language identification

Qwen3-ASR and SenseVoice, told no language, report the one they heard (audio.cpp's `/v1/audio/transcriptions/details`; the phone app's answer); the pipeline keeps it when it is one the leg may be in. The selected recognizer stays selected even when it cannot report the language. The pipeline then infers it from the text, by script and then a small detector (`src/lib/language/script.ts`, `src/lib/language/identify.ts`), and the language menu calls this a best effort. No installed model silently replaces the selection. Short or uncertain text stays unlabelled while translation continues.

## Sharing

`nativeShared` in `src/lib/lan/nativeShare.ts` advertises downloaded recognizers, translators and feedback models. A translator must fit every direction a session needs, the reverse included when the speaker speaks both languages. A device names the recognizer serving each leg in `session.updated`, kept for the UI by `src/stores/heardByStore.ts`.

## Download sources

`pullWhole` in `electron/fetch-file.js` decides who is asked and how patiently; `electron/native-engine.js` only verifies.

- Models come from Hugging Face, and `hf-mirror.com` serves the same paths. Seven also have a `mirror` on ModelScope; R2T2 and SenseVoice-Small have no copy there.
- Runtimes come from GitHub releases, plus the relays in `GITHUB_RELAYS`. No mirror of our own exists in China.
- A mainland China time zone (`inMainlandChina`) asks mirrors and relays first. That guess only orders addresses: a large file tries all at once and starts at the quickest (`quickestFirst`), since a slow relay that still delivers is never left.
- An address that fails or breaks off with nothing new is left, and the next goes on from the `.part`. A download fails only after every address came up empty twice; the error names each host's reply.
- Mirrors and relays are volunteer services, trusted with nothing: size and SHA-256 decide.

From mainland China: Hugging Face is not reached; GitHub often fails or crawls; ModelScope and `hf-mirror.com` are reached; relays are reached from a China Telecom exit and unverified on China Mobile. VB-CABLE is reached but very slow. OpenAI and Gemini need a proxy.

On Windows `electron/update-download.js` fetches the update the same way. The installer gets run, so it is kept only if size and SHA-512 match `latest.yml`, read from GitHub directly. macOS uses electron-updater's own download.

## Hardening the engine processes

- Each start and stop is a turn, and a start no longer the last gives way, or crossed starts would orphan a process holding memory.
- A stop waits for exit, killing after `STOP_PATIENCE_MS`, so models never overlap in memory and Windows can delete one that was in use.
- `run.json` records the process. After a crash the next launch ends it, if that number still runs this engine's program.
- `.unpacking` marks an unpack in progress; a runtime left with the mark is fetched again.
- Paths outside the system code page reach programs as question marks on Windows, so `tar` and the engines run inside their folders with relative names.
- llama.cpp answers only a random per-run key (`--api-key`), its slots endpoint is off, and `LLAMA_*` variables are removed. Without the key any web page could use the GPU. audio.cpp has no key option but sends no CORS headers, so pages cannot read it.
- Only on Windows does an engine load at low priority: elsewhere it may not get its priority back.
- Known gaps: a port can be taken between probing and starting, and hashing cannot be cancelled.

## Adding a model

1. Add it to `MODELS` in `electron/native-engine.js`: address, size, SHA-256, family, mode, options.
2. Add its name and languages to `NATIVE_MODELS` in `src/providers/openai/localaiNative.ts`, in rank order.
3. Add its note to `NOTES` in `src/providers/openai/NativeEngineCard.tsx` and to `scripts/fork-localai-locales.cjs`. A test fails on a model without one.

Sharing, and a phone lending a model of the same name, follow from those tables.
