# Apple Speech on a Mac for VRChat on Windows

The Windows app captures the microphone and VRChat audio as separate sources. A Mac running Kotomimi shares Apple Speech over the local network. Each source can request the same two languages, with independent recognition sessions and language preferences.

## Requirements and setup

1. Run builds containing the bilingual LAN changes on both computers. The Mac needs macOS 26 or later and a working Apple Speech installation.
2. In the Mac's sharing card, open the model library and install Apple Speech assets for both languages. Enable model sharing and keep Kotomimi running.
3. In Windows Kotomimi, select your language and the other language. Choose the Mac as the device for speech recognition and select Apple Speech. Refresh the connection after downloading another language on the Mac. The default sharing port is 8790.
4. Select the Windows microphone for your voice and VRChat audio for the other side. Enable both listening sources when both should have subtitles.
5. Configure translation and, if needed, grammar feedback. These stages can run on the Mac, Windows, or an API, independently of where speech recognition runs. Download the required native models on the computer serving each local stage. A missing selected translator blocks readiness; it does not fall back to Bing.
6. Enable **I speak the other language too** for automatic translation in both directions on your microphone. Enable **grammar feedback** alongside it to receive a separate correction or explanation when you speak the other language. Either option can also be used alone.

## What each mode does

Here, A is your language and B is the other language. A and B can be any two distinct languages supported and installed by this Apple Speech integration.

| Audio source and mode | Recognized language | Result |
| --- | --- | --- |
| Your microphone, ordinary mode | A | Translate to B |
| Your microphone, I speak B too | A / B | Translate to B / A respectively |
| Your microphone, I speak B too + grammar feedback | B | Translate to A and show separate grammar feedback |
| Your microphone, I speak B too + grammar feedback | A | Translate to B without grammar feedback |
| Your microphone, grammar feedback | B | Give grammar feedback |
| Your microphone, grammar feedback | A | Translate to B when a translation stage is configured |
| VRChat audio | B / A | Translate to A / show the original respectively |

Grammar feedback remains private. With both options enabled, VRChat's chatbox follows its selected translation display setting in either direction; corrections and explanations never go into the chatbox. With grammar feedback alone, the chatbox sends the practiced original sentence. Typed input is translated without grammar feedback.

Translation and feedback have separate results attached to the same utterance in conversation history and subtitles. An answer arriving later cannot replace the other answer. Translation and feedback requests run independently, so a slow or failed feedback request does not block subsequent translations. Native translation and feedback use separate engines; local models for separate stages can require additional memory. An external service may apply its own request scheduling.

## Shared models and saved choices

Kotomimi shares installed native models, including Apple Speech language assets, native translators, and native feedback models. The sharing library does not expose browser/WASM/WebGPU models or forward a locally managed LocalAI server. Downloads started in the sharing library leave the host's own session selections unchanged. External compatible services remain available through the API/another-device choices.

A selected recognizer that does not report transcript language can remain selected. Kotomimi uses best-effort text-based language identification and shows a badge explaining the limitation. It does not silently replace that selection with a language-detecting model. This fallback is distinct from Apple Speech's negotiated pair: the paired protocol must confirm both languages before the session proceeds.

## Recognition and compatibility

The native helper uses `SpeechAnalyzer` and `SpeechTranscriber`. It analyzes each utterance with two locale-specific candidates. A locale-specific recognizer can also transcribe the other language, so its requested locale alone does not prove the spoken language. When both sufficiently long candidate texts independently agree on a language with high confidence, macOS Natural Language selects the matching candidate. Otherwise, transcription confidence selects the candidate, with a small tie margin and the same audio source's previous successful language as a tie preference. The two sources do not share this preference. The text check runs locally using the system framework and requires no additional model download.

The LAN protocol advertises `bilingual` with the installed Apple Speech models. A session requests `languages: [A, B]`, confirms the pair in `session.updated`, and returns the actual language with each final transcript. The Windows pipeline displays provisional words but waits for the final language before translating or choosing feedback. An unsupported pair or unconfirmed negotiation is an error rather than a silent switch to single-language recognition.

The integration currently maps Chinese, Japanese, English, Korean, Spanish, French, German, Italian, Portuguese, Hindi, and Cantonese. The Mac's runtime inventory determines which of these are actually available. Regional variants use the integration's existing locale mapping. This is a selected pair, not unrestricted automatic detection of every language.

Switching languages between utterances is supported. Mixed-language speech inside one uninterrupted utterance still yields one winning candidate and one language. Similar-sounding short phrases and names may remain ambiguous; text identification and confidence comparison across models are heuristics, not accuracy guarantees. The helper creates fast and final listeners for each candidate, so simultaneous sources increase its workload.

## Validation on the actual devices

Automated tests exercise configuration, LAN negotiation, transcript language transport, routing, source-isolated preferences, failure recovery, and VRChat output with simulated recognition. They do not measure Apple Speech accuracy or latency on a Mac.

On a Mac, `bash native/apple-speech/verify.sh` runs the candidate-selection regression cases against the real Natural Language framework, including the measured English-as-Chinese failure, same-script French text, ambiguous short text, and conflicting candidates. Build the complete helper with `bash native/apple-speech/build.sh`.

### Repeatable two-device acceptance

`src/providers/openai/kotomimi.bilingual.live.test.ts` runs the real client provider, readiness check, pipeline, and network transport against a Mac sharing actual models. It is skipped unless the host and both audio files are explicitly supplied. It does not capture a live microphone or operate the UI.

The Mac must run the current bilingual-capable host, have Apple Speech assets for both languages, and share the translation and feedback models named below. An older host may pass ordinary recognition tests but omit `bilingual` from `/v1/models/capabilities`; that does not verify paired recognition.

Prepare one clear utterance in your own language and one in the practiced language as 24 kHz, mono, PCM16 WAV files. For the defaults below, use Chinese and English respectively. The practiced utterance can contain a simple grammar error. On Windows, run from the repository root:

```powershell
$env:KOTOMIMI_BILINGUAL_LIVE = '192.168.1.20:8790' # Replace with the Mac's sharing address.
$env:KOTOMIMI_NATIVE_LANGUAGE = 'zh-CN'
$env:KOTOMIMI_PRACTICE_LANGUAGE = 'en'
$env:KOTOMIMI_NATIVE_WAV = 'C:\test-audio\native.wav'
$env:KOTOMIMI_PRACTICE_WAV = 'C:\test-audio\practice.wav'
$env:KOTOMIMI_TRANSLATOR = 'index-translate-2b'
$env:KOTOMIMI_COACH = 'gemma-4-e2b'
npx vitest run src/providers/openai/kotomimi.bilingual.live.test.ts --disable-console-intercept
```

If sharing requires a key, supply it through `KOTOMIMI_LIVE_KEY`. `KOTOMIMI_TYPED_TEXT` overrides the default English typed sentence when testing another practiced language. Changing the language pair also requires matching installed Apple Speech assets and WAV contents.

The two cases verify:

- Practice speech produces separate, completed translation and feedback results attached to the same source utterance. Subsequent native speech and typed text translate without adding feedback.
- Simultaneous speaker and participant streams keep their language results separate. The participant's native-language speech is shown without redundant translation; switching that source to the practiced language produces a translation without feedback.

Sessions stop in `finally`, including when an assertion fails. Review the printed transcripts and answers as well as the pass/fail result: the assertions check routing and result ownership, not translation quality. For ordinary typed, automatic-turn, and manual-turn checks, use the separate `kotomimi.live.test.ts` with its documented `KOTOMIMI_LIVE*` variables.

### Recorded acceptance: 2026-10-30

A Windows client passed both bilingual cases and all three ordinary live cases against an isolated current-source Electron host on macOS 27.0.1, using Apple Speech (Chinese/English), Index-Translate 2B, and Gemma 4 E2B. Inputs were synthesized WAV fixtures streamed in real time. The English practice sentence produced a Chinese translation and a separate past-tense correction; Chinese speech produced only an English translation. Simultaneous source routing and participant language switching also passed.

The first bilingual run failed because both locale-specific recognizers returned English, but the confidence tie selected the Chinese locale. The final-candidate text check fixes that reproduced case. These results cover real network and native inference, not microphone capture, UI rendering, VRChat capture/chatbox output, broader language-pair accuracy, or a packaged release. The installed Mac application was not replaced, and the isolated test host was stopped after verification.

### Empty-final audit: 2026-10-30

Per-utterance `transcription_failed` degradations no longer insert notices into the conversation. The adapter still records the original failure frame and emits diagnostics; fatal session failures remain visible. The LAN integration regression verifies that rejected tentative text is cleared, never translated, and the next utterance recovers without a notice.

An empty adapter result does not necessarily mean Apple returned no final words. The native adapter also discards VAD misfires (sounds below the configured minimum speech duration), even if recognition produced text. Apple additionally uses separate fast and considered recognizers: tentative text from the fast recognizer is not a final result from the considered one. The LAN diagnostic therefore describes an absent usable transcript without claiming which stage discarded it.

The paired selector had a reproducible boundary defect: an empty preferred candidate could defeat nonempty final text when confidence metadata was absent; punctuation-only candidates could also win. It now selects the only candidate containing letters or numbers before comparing confidence. Both-empty cases remain empty, and tentative text is never promoted as a fallback. Four additional Swift cases cover these boundaries; all twelve pass on macOS.

An isolated helper on the user's Mac ran 22 synthetic-input probes: short English words and a sentence, single/paired modes, silence, reduced volume, and clipped 50–400 ms fragments. Complete short utterances produced final text; extremely short fragments could produce empty final results. This did not reproduce the user's full intermittent failure sequence or establish its frequency. The probes bypassed app VAD and did not capture the user's microphone or VRChat audio. Existing VAD/early-close regression tests passed, without changing VAD settings.

Short-word language attribution remains a known limitation: a Chinese/English pair can label `Hello` or `OK` as Chinese because both models recognize Latin text and the long-text consensus rule intentionally does not decide ambiguous short words. The previous two-device acceptance covered full sentences, not this case. Do not describe that acceptance or the empty-candidate fix as comprehensive bilingual accuracy validation.

### Manual application walkthrough

For a hardware check, use a pair such as English/French as well as the intended everyday pair. On both audio sources, alternate languages between sentences; then overlap the two sources briefly. Verify that your microphone's language choice does not change the other source's preference. With both options enabled, a practice sentence should produce a translation and private feedback, while a sentence in your own language should produce only a translation. Check the conversation, subtitle, and chatbox separately, including when feedback arrives slowly. Finally test silence, a short ambiguous phrase, and a sentence containing words from both languages to assess the recognizer's practical limits.
