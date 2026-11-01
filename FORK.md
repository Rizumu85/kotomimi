# Kotomimi

Kotomimi (ことみみ, from 言葉 "words" and 耳 "ear") is a fork of [Sokuji](https://github.com/kizuna-ai-lab/sokuji) with stages you place freely, on-device models, and aids for language learners. [README.md](README.md) introduces the app; this file covers what the fork adds.

Repository: <https://github.com/Rizumu85/kotomimi>. `main` is the fork. `upstream` is a mirror of Sokuji on GitHub; merges do not depend on it and it can lag. The fork is based on Sokuji v0.43.1 (`acecb3c81`), the last upstream release merged into `main`.

Kotomimi is a separate application with its own name, install folder and profile, so it can be installed and run beside Sokuji. A first launch into an empty profile copies an existing Sokuji profile's settings and sign-in (`adoptUpstreamProfile` in `electron/main.js`). Downloaded models are not copied.

## What the fork adds

| Feature | What it does | Main code |
|---|---|---|
| Kotomimi provider | Each stage runs on this computer, an API or another device; first in the provider list, and where a new install starts | `src/providers/openai/localai.ts`, `src/providers/openai/pipeline.ts`, `src/providers/openai/LocalAIAssist.tsx` |
| Native engines | Downloaded recognizers, translators and feedback models run locally with no server; see [native engines](docs/fork/native-engines.md) | `electron/native-engine.js`, `src/providers/openai/localaiNative.ts` |
| Apple Speech | The system recognizer of macOS 26 and later, through a small helper | `native/apple-speech/SpeechHelper.swift`, `electron/apple-speech.js` |
| Another device | Models shared over the LAN, devices found by search, and a phone lent to the computer; see [LAN and phone](docs/fork/lan-and-phone.md) | `electron/lan-server.js`, `electron/lan-discover.js`, `src/lib/lan/nativeShare.ts` |
| Subtitles | The conversation as a strip in a window of its own; see [subtitles](docs/fork/subtitles.md) | `src/components/Subtitle/SubtitleWindow.tsx` |
| Other side's language | A switch leaves the other side's language to be identified | `src/providers/openai/localaiDevice.ts`, `src/lib/language/identify.ts` |
| Model notes | A note on each native model card; the library on web and extension ranks recognizers as measured | `src/providers/openai/NativeEngineCard.tsx`, `src/lib/local-inference/selection/measuredRank.ts` |
| Grammar feedback | A sentence in the practiced language gets ✓, or a correction and its reason | `src/providers/openai/coachPrompt.ts` |
| Typed lookup | Ctrl+K (Cmd+K) puts the cursor in a box that translates what you type | `src/components/MainPanel/panel/TypedText.tsx` |
| Mic activation threshold | Sound below a level is heard as silence | `src/lib/audio/capture/micGate.ts`, `src/components/Settings/sections/MicGateControl.tsx` |
| Reading aids | Furigana, romanization (Japanese, Korean, Russian, Ukrainian), pinyin and source italics, at the foot of the display popover | `src/lib/annotate/annotate.ts`, `src/components/Annotated/ReadingAidToggles.tsx` |
| Reading correction | Japanese words the dictionary misreads in speech, read again from context | `src/lib/annotate/japaneseReadings.ts` |
| Fonts | Separate fonts for the interface, Latin letters, romanization, and each language's text and readings | `src/lib/fonts/fontCss.ts`, `src/components/Fonts/FontSection.tsx` |
| Language pins | Language menus with pinned languages first and a filter | `src/components/providers/LanguageMenu.tsx`, `src/stores/languagePinStore.ts` |
| Start in background | An optional hidden start at Windows sign-in | `electron/autostart.js`, `src/components/Autostart/AutostartSection.tsx` |
| VRChat link | Mute, chatbox and world videos, on the same computer | `electron/vrchat.js`, `src/app/vrchat.ts` |
| API model lists | A menu of the models an API lists, in every stage | `src/providers/openai/ApiModelPicker.tsx`, `src/providers/openai/apiModelList.ts` |
| Setup wizard and tour | Four steps; the provider and device steps are hidden and answered with Kotomimi on this computer, and a re-run keeps the saved provider and where each stage runs | `src/components/SetupWizard/setupDraft.ts`, `src/components/Tour/steps.ts` |

## Stages

Speech recognition, translation and optional grammar feedback are independent. Each runs on **This computer**, **API model** or **Another device**.

| Stage | This computer | API model | Another device |
| --- | --- | --- | --- |
| Speech recognition | Downloaded native recognizer, or installed Apple Speech language assets | An OpenAI-compatible transcription endpoint | A sharing Kotomimi, a compatible phone, or an external LocalAI Realtime server |
| Translation | Downloaded native translation model | An OpenAI-compatible chat endpoint | A compatible shared translation or text model |
| Grammar feedback | Downloaded native feedback model | An OpenAI-compatible chat endpoint | A shared feedback or chat model |

This computer always means the native engines: `migrateLocalAISettings` (`localai.ts`) reads the local-runner fields of any older settings as `native`. External LocalAI services are reached through the API and Another device choices; Kotomimi does not install, start, stop or proxy one. Kotomimi's pipeline produces text, not synthesized speech.

### Settings

Settings has three categories: General, Audio and Provider. The stage cards are in Provider. Audio starts with Speech mode; under Auto, a collapsed Speech detection disclosure holds the provider's tuning, which appears nowhere else. A running session keeps its parameters locked.

With Kotomimi (`localai`) selected, controls that serve translated speech output are hidden: the echo-cancellation picker and Original Audio Passthrough (`showVoiceOutputControls` in `src/components/Settings/AdvancedSettings/AdvancedSettings.tsx`) and the Text Only / Keep audio for replay block (`OutputToggles` in `src/components/Settings/sections/SpeechSection.tsx`). Only the controls are hidden: saved preferences, audio processing and other providers are untouched. Restore them at those two guards once speech output is supported and validated.

### Choosing models

- Recognition has a row for each language a run hears. An explicit choice is kept, including a recognizer that needs best-effort language identification.
- Native translation has one row: the engine runs one model for the whole stage, so its menu lists only models that take every direction the run translates.
- **Model library** in a stage downloads native models. A download selects its model for the original stage and row when it finishes, even if the library has closed. Downloads from the sharing library change no selection.
- Readiness checks that the needed native models are downloaded and starts nothing. Engines start with a session, once ahead for a start at sign-in, and from a failed engine's retry.
- A selected native translator that is missing, or cannot translate a required direction, stops the session from starting. Nothing is substituted.
- Models advertising translation directions are checked for every required direction, the reverse included when you speak both languages. A remote session shows the model that served the request when it differs from the choice.

### API and remote services

The API service selector supplies known endpoints; a custom endpoint is always possible. Recognition posts to `/audio/transcriptions` under the base URL; translation and feedback post to `/chat/completions`. Text requests originate in the renderer, so the service must permit CORS.

A shared device hears over the Realtime protocol. A sharing Kotomimi takes any of its recognizers in any session; an external LocalAI always hears with its default recognizer when translation or feedback uses a model chosen here. A phone provides the stages it advertises, at its own address rather than over that session.

### Translation and private feedback

**I speak the other language too** translates either of your two languages into the other. **Grammar feedback** can be on at the same time: a practice sentence then receives a translation and a separate private correction. A sentence in your own language and typed input are translated without feedback. With feedback alone, practice speech receives feedback and no translation.

Translation and feedback stay attached to the same utterance as separate results. Feedback never replaces its translation, and never reaches the VRChat chatbox or caption viewers. See [Apple Speech over LAN](docs/apple-speech-lan.md) for the two-source behavior.

Prompts follow the native and practiced languages: the native language picks the template, the practiced one what to look for and the examples. A custom prompt replaces the template and can use `{{SPOKEN}}` and `{{NATIVE}}`.

## Small features

### Mic activation threshold

`src/lib/audio/capture/mic.ts` puts the gate between the recorder and every listener. Loudness is the one difference between the user and a loudspeaker's leak that holds in every mode; comparing the two legs' text (`heardLately` in `pipeline.ts`) works only while both are heard, and stays beside it. Below the threshold the gate delivers zeros of the same length, never nothing: the VAD counts its pause in frames it receives (`redemptionMs`), and the echo monitor, meters and passthrough keep time on this stream. `GATE_LOOKAHEAD_MS` delays the microphone so a soft onset passes whole; `GATE_HOLD_MS` bridges dips between words at the cost of some leak. `levelOf` scales RMS in dBFS to 0–100. Threshold 0 is off, the default. The microphone test ends when a run starts: some drivers refuse to open one device twice.

### Model lists in the API column

The button beside an API's model field asks `GET {base}/models`, with the key in the `Authorization` header, never the address. What is typed in the field is what is requested, so a failed list costs only the menu; the last check's models stand in meanwhile. `preferredModel`'s pick comes first with a star, the rest in the service's order. Lists longer than `SEARCH_FROM` get a fuzzy search (`searchModels`) that leaves input methods alone: composing text filters, and a key the input method takes chooses nothing.

### Start in background

The switch, off by default, shows only in an installed Windows app. It adds a login item with `--hidden` for the launcher one folder above the app, which survives updates. That start shows no window and holds engine starts for `QUIET_MS`, or until the window shows, because a computer that has just started is busy. `primeNativeOnce` then loads the engines the settings name and lets them go a minute later, so the first session after a boot is quick; it is the only load ahead of use. The tray icon (`electron/tray.js`, Windows and Linux) shows the window or quits; closing the window still quits. macOS wants a notarized app for a login item, and the Mac build is not notarized.

### Retained upstream Bing translation

Bing translation stays in upstream's LocalInference provider (`src/lib/bing-translator/BingTranslatorClient.ts`), including its `cn.bing.com` redirect handling. Kotomimi's native stages and LAN sharing never fall back to it. LocalInference is hidden on desktop (`isPresent` in `src/lib/provider/presence.ts`) and remains on web and in the extension. Edge speech services are retained separately.

### Kana readings and reading correction

Readings come from text, not sound: kuromoji with IPADIC reads each recognized word on the CPU, with no model and no network. IPADIC prefers newspaper readings and reads numerals and counters apart, so `correctReadings` reads the words it gets wrong in speech again. Each rule names what must stand beside the word; a case it does not recognize, or one only meaning can settle, keeps the dictionary's reading. The dictionary stays because Sudachi makes as many mistakes of its own ([measurements](docs/fork/measurements.md)). `japaneseReadings.test.ts` uses the real dictionary, since the rules depend on how it splits and reads. `holdLastReading` keeps back the last word's reading until a sentence is final, because the dictionary reads a word from what follows it.

### VRChat link

Windows only, with no socket of the app's own listening. `electron/vrchat.js` follows VRChat's log for its ports, video starts and world changes, asks its OSCQuery service for `MuteSelf`, and sends `/chatbox/input` over UDP. VRChat tells no other program who is speaking, and logs nothing when a video stops. While the user is muted there (`vrchatHolds`), their leg hears silence of the same length, so a sentence ends as at a pause. The chatbox gets each finished sentence of the user's, spoken or typed, cut to `CHATBOX_MOST`. VRChat drops lines sent too fast, so a line holds the chatbox for its reading time and waiting lines are joined while they fit. A sentence answered with feedback goes up as said.

A world's video has no place in the world: its sound is the same in both channels to the last bit, so left minus right removes it and keeps the players (`src/lib/audio/capture/stereoSplit.ts`). Mixed with video, the players' words are lost in recognition, so `settings.vrchat.onVideo` has no "translate everything": it is `ask`, `quick` (the people), `both` (the people, and the video in its own lane) or `pause`. A voice straight ahead is nearly identical in both channels too and the subtraction weakens it, so `createVideoJudge` demands bit-level identity and a sound with a direction before it splits, and the mix returns when the video ends. Until then, or where capture is mono (the macOS per-app helper), `quick` only shortens stretches (`AdapterSession.pace`). `both` opens a second session (`Run.openSide`) under `VIDEO_ORIGIN`, on `localai` only; it is never played, sent to the chatbox or shared. An `ask` unanswered for `ASK_WAIT_MS`, or one that cannot be shown, falls back to `quick`.

### Fonts

`fontCss` turns the settings into a style sheet. A chosen font goes in front of the stack it replaces, never instead of it, so a missing glyph falls to the app's fonts. The interface font is set on the page and on `.App`, because the root names its own stack. The Latin font reaches conversation text only through an `@font-face` named `kt-latin` limited by `unicode-range`: many fonts picked for their Latin letters also draw Chinese and Japanese, and at the head of the stack one would take the whole line. `local()` finds a face by its full or PostScript name, so `latinFaces` keeps those names from the moment of choosing. Languages written in Latin letters put their own font first.

## More

- [Native engines](docs/fork/native-engines.md)
- [LAN sharing and the phone](docs/fork/lan-and-phone.md)
- [Subtitles](docs/fork/subtitles.md)
- [Building and releasing](docs/fork/release.md)
- [Measurements](docs/fork/measurements.md)
- [Apple Speech over LAN](docs/apple-speech-lan.md)
- [README.md](README.md)

## License

AGPL-3.0, as upstream ([LICENSE](LICENSE)). The Japanese dictionary is the IPADIC shipped with kuromoji; its license is in the NOTICE.md of the @sglkc/kuromoji package.
