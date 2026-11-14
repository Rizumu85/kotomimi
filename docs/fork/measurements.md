# Measurements

What the choices in the other docs rest on. One row per subject: when something is measured again, change its row in place, and add no dated row beside it.

## Native recognition

Corpus unless noted: seven clips of real Japanese VRChat talk. Error is wrong characters in the kana reading against a hand-checked reference; lag is how far the text sits behind the voice.

In the app, one recognition per sentence:

| Model | Hardware | Error | Lag | Measured |
|---|---|---|---|---|
| Apple Speech | M2 | 12.5 % | 1.7 s in the Qwen3-ASR comparison, 2.4 s in its own run | 2026-10-05 |
| Qwen3-ASR 1.7B q8 | RTX 5070 Ti | 16.4 % | about 1 s | 2026-10-05 |
| Qwen3-ASR 1.7B q8 | M2 | 16.6 % | about 2.3 s | |
| R2T2 q8 | RTX 5070 Ti | 18.2 % | 2.5 s | 2026-10-05 |
| Qwen3-ASR 0.6B q8 (4 clips) | RTX 5070 Ti | matches 22.0 % below | about 1.3 s | 2026-10-06 |
| Whisper Large V3 Turbo | | 20.8 % | about 10 s | |

Read by the model directly, on an RTX 5070 Ti. "App stretches" replays the exact audio the app sent:

| Model | Whole clip | App stretches | 10 s read in | VRAM | Measured |
|---|---|---|---|---|---|
| Qwen3-ASR 1.7B q8 | 16.0 % | 16.4-17.2 % | 0.29 s | about 3.0 GB | 2026-10-06 |
| Qwen3-ASR 0.6B q8 | 21.4 % | 22.0 % | 0.22 s | about 1.8 GB | 2026-10-06 |
| Nemotron 3.5 ASR 0.6B q8 | 20.8 % | 26.8 %; about 12 of 60 sentences empty | 0.15 s | about 1.0 GB | 2026-10-06 |

The 59 stretches the app cut from the seven clips, each read alone:

| Model | Backend | Error | Empty readings | Measured |
|---|---|---|---|---|
| Qwen3-ASR 1.7B | Vulkan | 16.9 % | | 2026-10-13 |
| SenseVoice-Small q8 | Vulkan | 20.3 % | 0 | 2026-10-13 |
| SenseVoice-Small q8 | Metal, M2, CLI | 19.9 % | 0 | 2026-10-13 |
| Qwen3-ASR 0.6B | Vulkan | 20.7 % | | 2026-10-13 |

Rejected on the engine, whole clips: Nemotron 3.5 Streaming 0.6B 20.6 %, Fun-ASR Nano 51 % (two clips fell into repetition).

Told no language, 12 s of each of ten speed-test clips: both Qwen3-ASR sizes wrote all ten in the right language; SenseVoice-Small its five, the other five as garbled English.

R2T2 parameters, engine direct, 60 s unbroken:

| chunk ms / unfixed_chunk_num / unfixed_token_num | Error | Lag |
|---|---|---|
| 160 / 0 / 1 | 16.0 % | 1.6 s |
| 160 / 0 / 3 (used) | 14.5 % | 2.1 s |
| 160 / 2 / 5 | 14.5 % | 3.0 s |
| 320 / 0 / 1 | 16.0 % | |
| unfixed_token_num 0 | 33 %, the model stalls | |

Qwen3-ASR stretch limits, in the app:

| Restart at a gap / at a VAD cut | Error | Longest wait for a line |
|---|---|---|
| 10 s / 20 s | 17.2 % | 20 s |
| 8 s / every cut | 16.1 % on six clips; one stretch cut too short | |
| 8 s / 8 s (used) | 16.4 % | 15 s |

Realtime factors:

| Model and path | RTX 5070 Ti | M2 | Measured |
|---|---|---|---|
| Qwen3-ASR 1.7B, whole read | about 46x | about 8.7x | 2026-10-06 |
| R2T2, 160 ms steps | about 2-2.8x | about 0.4x | 2026-10-06 |

SenseVoice-Small q8, through the engine server unless noted:

| Subject | Value | Measured |
|---|---|---|
| VRAM (RTX 5070 Ti) | about 0.27 GB loaded; peak 0.38 GB | 2026-10-12 |
| Reading 8.6 s | 48-95 ms | 2026-10-12 |
| Speech end to final text | 38 ms | 2026-10-12 |
| CPU backend, server default threads | 4.5-5x realtime | 2026-10-12 |
| M2 Metal, CLI, 8.6 s clip | 0.29 s; peak memory 0.53-0.54 GB | 2026-10-13 |

Failure rates: Qwen3-ASR repeats a phrase in about 1 in 100 finals; R2T2 stalls on 1 clip of 7, in the engine's own client too.

## Native translation

Thirty sentences of Japanese VRChat talk into Chinese:

| Model | Serious errors | Note | Measured |
|---|---|---|---|
| Index-Translate 2B Q4_K_M | about 3 | | 2026-10-05 |
| Hunyuan MT 2 1.8B Q4_K_M | about 8 | | 2026-10-05 |
| Index-Translate 9B Q4_K_M | 3-4 | twice as slow, about 4 GB more VRAM | 2026-10-05 |

105 sentences (57 app stretches of Japanese VRChat talk as Qwen3-ASR read them, 48 casual lines among zh/ja/ko/en), blind-judged by GPT, RTX 5070 Ti (2026-11-07): serious errors / best of four / time a sentence / VRAM: Index-Translate 2B 4 / 26 / 0.19 s / 1.5 GB; PLaMo 3 Translate 2B 9 / 39 / 0.16 s / 1.9 GB; Hunyuan MT 2 1.8B 8 / 15 / 0.20 s / 1.4 GB; PLaMo 3 Translate 0.8B 11 / 25 / 0.08 s / 0.6 GB.

Hy-MT2 StreamRevise v4, the 87 zh/en/ja stretches of that set: whole 19 serious (Index 20, Hunyuan MT 2 22); what live updates left 30 of 67, so a closed sentence is translated again. Live: 95 % of what showed kept, 0.09 s an update.

## Native feedback

28 sentences of Japanese from a Chinese speaker, 14 wrong and 14 correct casual, RTX 5070 Ti:

| Model | Wrong caught | Correct passed | Per sentence | Measured |
|---|---|---|---|---|
| Gemma 4 E2B Q4_K_M | 11/14 | 14/14 | 0.14 s | 2026-10-05 |
| Qwen3-4B Instruct 2507 | 6/14 | 14/14 | 0.10 s | 2026-10-05 |
| Qwen3.5-4B | 9/14 | 4/14 | 0.28 s | 2026-10-05 |
| Qwen3.5-2B | 8/14 | 5/14 | 0.18 s | 2026-10-05 |
| DeepSeek deepseek-flash, API, thinking off | 14/14 | 14/14 | 0.9 s | 2026-10-05 |

Gemma with thinking on: 1.8 s for a sentence that takes 0.3 s without. Gemma uses about 1.5 GB of VRAM.

## Whole pipeline

This computer; Qwen3-ASR 1.7B, Index-Translate 2B, Gemma 4 E2B feedback, both-sides mode, three stable runs (2026-10-24): source text 0.6-0.7 s after speech, translation 0.2 s per sentence, feedback 0.2-0.5 s, speech end to translation 0.6-0.9 s. Another device, phone and API not measured.

## Subtitles

One 60 s Japanese talk, other-side mode, one run each:

| Subject | Whole stretch | By sentence | Measured |
|---|---|---|---|
| First translation of a 4-sentence, 14 s stretch | 20.9 s | 8.9 s | 2026-10-06 |
| Rows in the run | 8 | 12-14 | 2026-10-06 |

Sentences closed early on VRChat Japanese talk. Final text against closed: same / marks only / a few letters:

| Recognizer | Audio | Closed early | Final vs closed | Measured |
|---|---|---|---|---|
| Qwen3-ASR 1.7B | 5 min | 20 | 8 / 1 / 4 of 13 stretches | 2026-10-06 |
| Qwen3-ASR 0.6B | 2 min | 6 | 1 / 0 / 2 of 3 stretches | 2026-10-06 |

Early turn end, voice stopped to translation finished: Japanese 1.3 s against 2.0 s, Korean 1.5 s against 1.8 s (2026-10-28).

The sentence before as context, 12 Japanese sentences: Hunyuan MT 2 never translated it, 3 better and 1 worse; Index-Translate 2B translated it in 1-3 of 12 (2026-10-06).

Glossary: Qwen3-ASR on 10 rare-name sentences went from 1 right to 5-7; 40 terms cost no time, 300 about 0.6 s (2026-10-30).

## Phones

Stand-in phone: this computer's engine held to each speed, one 20 s Japanese clip (2026-10-10). Text complete at every speed:

| Phone speed | First text | First translated sentence | Longest reading |
|---|---|---|---|
| Unslowed | 5.3 s | 18.5 s | 0.5 s |
| 4x | 7.0 s | 25.3 s | 4.2 s |
| 2x | 5.5 s | 29.1 s | 8.4 s |
| 1x | 7.7 s | 47.6 s | 16.9 s |

| Subject | Result | Measured |
|---|---|---|
| 4 GB phone, Index-Translate 2B | Frees about 1.4 GB, the model needs 1.5 GB: 503 on every sentence | 2026-10-23 |
| Dimensity 9500, Index-Translate | 1.5 s a sentence; load 3.5 s | 2026-10-14 |
| Dimensity 9500, Gemma | Load 4.6-5.2 s; first request 8 s to first token, second 0.5 s | 2026-10-14 |

## Japanese readings

| Subject | Result | Measured |
|---|---|---|
| kuromoji + IPADIC | About 0.2 ms per line; dictionary load about 0.25 s | 2026-10-06 |
| Sudachi against IPADIC | 123 MB against 17 MB; as many errors, in other places, on four corpora | 2026-10-06 |
| Correction rules on fresh corpora | 46 readings changed: 45 right, 1 arguable, none wrong | 2026-10-06 |

## VRChat video sound

| Subject | Result | Measured |
|---|---|---|
| Left minus right, video | Down 43-86 dB; a voice from the side almost unchanged | 2026-10-26 |
| Left minus right, voice straight ahead | 40-55 dB lower | 2026-10-26 |
| Offline detection | About 6 s after a video starts; no false hit on speech straight ahead | 2026-10-26 |

## Downloads

Real installer, 2.4 s trial:

| Address | From the PC, direct | From a Beijing exit | Measured |
|---|---|---|---|
| gh-proxy.com | about 2.4 MB/s | 0.6-1.2 MB/s | 2026-10-13 |
| GitHub | about 2.4 MB/s | no connection | 2026-10-13 |
| ghfast.top | 0.9 MB/s | 0.4-0.5 MB/s | 2026-10-13 |
| ghproxy.net | 0.3 MB/s | under 0.1 MB/s | 2026-10-13 |
