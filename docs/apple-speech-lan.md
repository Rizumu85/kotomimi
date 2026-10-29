# Apple Speech on a Mac for VRChat on Windows

The Windows app captures the microphone and VRChat audio as separate sources. A Mac running Kotomimi shares Apple Speech over the local network. Each source can request the same two languages, with independent recognition sessions and language preferences.

## Requirements and setup

1. Run builds containing the bilingual LAN changes on both computers. The Mac needs macOS 26 or later and a working Apple Speech installation.
2. In the Mac's sharing card, open the model library and install Apple Speech assets for both languages. Enable model sharing and keep Kotomimi running.
3. In Windows Kotomimi, select your language and the other language. Choose the Mac as the device for speech recognition and select Apple Speech. Refresh the connection after downloading another language on the Mac. The default sharing port is 8790.
4. Select the Windows microphone for your voice and VRChat audio for the other side. Enable both listening sources when both should have subtitles.
5. Configure translation and, if needed, grammar feedback. These stages can run on the Mac, Windows, or an API, independently of where speech recognition runs.
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

Translation and feedback have separate results attached to the same utterance in conversation history and subtitles. An answer arriving later cannot replace the other answer. Translation and feedback requests run independently, so a slow or failed feedback request does not block subsequent translations. If both stages share one local inference worker, requests to that worker remain serial. Local models for separate stages can require additional memory.

## Recognition and compatibility

The native helper uses `SpeechAnalyzer` and `SpeechTranscriber`. It already analyzes each utterance with two locale-specific candidates and selects one using transcription confidence, with a small tie margin and the same audio source's previous successful language as a tie preference. The two sources do not share this preference.

The LAN protocol advertises `bilingual` with the installed Apple Speech models. A session requests `languages: [A, B]`, confirms the pair in `session.updated`, and returns the actual language with each final transcript. The Windows pipeline displays provisional words but waits for the final language before translating or choosing feedback. An unsupported pair or unconfirmed negotiation is an error rather than a silent switch to single-language recognition.

The integration currently maps Chinese, Japanese, English, Korean, Spanish, French, German, Italian, Portuguese, Hindi, and Cantonese. The Mac's runtime inventory determines which of these are actually available. Regional variants use the integration's existing locale mapping. This is a selected pair, not unrestricted automatic detection of every language.

Switching languages between utterances is supported. Mixed-language speech inside one uninterrupted utterance still yields one winning candidate and one language. Similar-sounding short phrases and names may remain ambiguous; confidence comparison across models is a heuristic, not an accuracy guarantee. The helper creates fast and final listeners for each candidate, so simultaneous sources increase its workload.

## Validation on the actual devices

Automated tests exercise configuration, LAN negotiation, transcript language transport, routing, source-isolated preferences, failure recovery, and VRChat output with simulated recognition. They do not measure Apple Speech accuracy or latency on a Mac.

For a hardware check, use a pair such as English/French as well as the intended everyday pair. On both audio sources, alternate languages between sentences; then overlap the two sources briefly. Verify that your microphone's language choice does not change the other source's preference. With both options enabled, a practice sentence should produce a translation and private feedback, while a sentence in your own language should produce only a translation. Check the conversation, subtitle, and chatbox separately, including when feedback arrives slowly. Finally test silence, a short ambiguous phrase, and a sentence containing words from both languages to assess the recognizer's practical limits.
