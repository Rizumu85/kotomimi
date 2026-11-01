# Another device, and the phone

A stage can run on a sharing Kotomimi, an external OpenAI-compatible server such as a LocalAI on the Mac, or a phone. Sharing this computer's models is a separate choice from where its own stages run. Paired Apple Speech: [docs/apple-speech-lan.md](../apple-speech-lan.md). Numbers: [docs/fork/measurements.md](measurements.md).

## Sharing and ownership

- Download native models in the sharing library, turn sharing on, keep Kotomimi running. Default port 8790; below 1024 the main process falls back to it.
- A key holds only `A-Za-z0-9._~!*+-` (`lanKeyOf`): it travels in a WebSocket subprotocol.
- The client chooses language, model and turn detection. The host owns the installed models and the key.
- Shared: downloaded native recognizers (Apple Speech included), translators, feedback models. Browser models are not, and Kotomimi forwards no LocalAI; an external one is used directly.
- Listing a model does not load it.
- A shared request is served by a native model or refused, never by online translation.

## Discovery

`electron/lan-discover.js` asks `GET /v1/models` on ports 8790 (Kotomimi), 8080 (LocalAI) and 8792 (phone), at every address of this computer's private IPv4 networks, at most the 256 around it, never a VPN's. The loopback is asked on ports this app does not use.

`X-Kotomimi-Node: engine` is a phone. `owned_by: kotomimi` is a Kotomimi. 401 or 403 wants a key: with the node header a phone, with `X-Kotomimi-Name` a Kotomimi, else a server. Any other model list is a server; `GET /version` tells a LocalAI. A phone search misses can be typed in as an API, `http://<phone>:8792/v1`.

## The sharing door

The door is `electron/lan-server.js`.

| Request | Answer |
|---|---|
| `GET /v1/models` | `{id, object, owned_by: 'kotomimi'}`, the pipeline `kotomimi` first |
| `GET /v1/models/capabilities` | `{id, capabilities, languages?, pair?}` |
| `POST /v1/chat/completions` | a translation or feedback, whole or SSE; `model` names what ran |
| `WS /v1/realtime` | a transcription session |

Every HTTP answer, refusals included, carries the URL-encoded name in `X-Kotomimi-Name`. Errors are `{error: {message, type, code}}`, with file paths replaced by `…` (`withoutPaths`).

Capabilities are `transcript` (plus `bilingual` on Apple Speech), `translate`, `feedback`; the pipeline has `null`. Empty `languages` means any; `auto` among them means the recognizer names the language. `pair: [source, target]` marks a one-way translator.

Translation needs `source_language`, `target_language` and a `user` message; the system message is not read. `model` is a shared translator, or `kotomimi` for the host's choice. A model that cannot take the pair never answers: 422 `model_unfit`, or 503 `translator_busy` when such a model holds the engine. Otherwise the model holding the engine answers for the named one, and the answer's `model` says so. Nothing fits: 404 `model_not_found`.

Feedback: `model` names a feedback model; `messages` pass unchanged, the prompt being the asking device's.

The socket only transcribes. `session.update` must give `audio.input.transcription.language`, a code or `auto`, and may give `model`, `keywords` and `languages: [A, B]`. `session.updated` comes at once; the model loads behind it. `response.create` gets `transcription_only`. No recognizer: `model_not_found`.

## What the door refuses

Against an untrusted device on the network, and a web page in a browser there.

| Required | Else | Why |
|---|---|---|
| Peer is loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `::1`, `fc00::/7` or `fe80::/10` | 403 `forbidden` | All interfaces listen, for VPNs; a public address is no neighbour |
| `Origin` absent or `file://` | 403 | No web page may run models; no wildcard CORS |
| `Host` is an IP, a bare name, or ends `.local`, `.lan`, `.home`, `.internal`, `.localdomain`, `.home.arpa`, `.fritz.box` | 403 | DNS rebinding |
| The key: `Authorization: Bearer`, or subprotocol `openai-insecure-api-key.<key>` | 401 `invalid_api_key` | SHA-256 digests, compared in constant time |
| Under 10 wrong keys from an address in a minute | 429 `too_many_attempts` until a minute after the first, right key included | No key is not counted: searching devices send none |
| 6 sockets, 4 per device | 503 at upgrade | One device cannot take every place |
| `session.update` within 30 s | close 1008 | An open socket holds a place |
| Speech on a device's sockets within 30 minutes | `session_idle`, close 1000 | A forgotten session holds a model |

Accepted on purpose:

- The firewall rule (`electron/lan-firewall.js`) is by port: each update installs to a new folder, and a program rule would ask for admin consent again. Private and domain networks; a public one only when on it, `LocalSubnet` only.
- The name is answered without the key: search needs it, and a LAN knows it anyway.
- No default key, by the owner's decision: with none, any program on the local network can use the models.
- Discovery can be spoofed; traffic is plain HTTP and WebSocket.
- No heartbeat: a computer that vanishes shows only at the connection's timeout.

## The phone

A phone lends recognition and text models on port 8792, answering the same whether audio.cpp or llama.cpp reads. Limits and memory rules: [android/README.md](../../android/README.md).

| Request | Answer |
|---|---|
| `GET /v1/models` | `data`: only the recognizer lent, since a desktop takes every name there for one. `text`: `{id, kind, name, loaded, holds_mb}`, `kind` being `translate` or `coach`. `memory_mb: {total, available}` |
| `POST /v1/audio/transcriptions` | Form with a WAV `file` and optional `language`, read whole; `{text}` |
| `POST /v1/chat/completions` | OpenAI's shape, whole or SSE; `model` is the desktop's id |

Every answer carries `X-Kotomimi-Name` and `X-Kotomimi-Node: engine`; errors are `{error: {message}}`. 401 is a missing key; 403 a web `Origin` or a public `Host`; 404 nothing lent by that name; 429 with `Retry-After: 2` four text requests in hand; 503 with `Retry-After: 5` no memory for the model, which the client knows by the words `has not the memory`.

The key is blank by default: any device on the Wi-Fi may use the phone. Its owner can generate a six-character key (`DoorKey`); every request then needs `Authorization: Bearer <key>`. Picking such a phone asks for the key, stores it by address in `settings.lan.phoneKeys` and searches again. Every request to that phone carries it.

Each stage on "another device" may name its own device as `host:port`: `asrOther`, `translateOther`, `coachOther`, each beside its `...Model`. Blank is the shared device. Only phones can be one, so two computers cannot each run a stage. Picking a phone in the top search (`useServer`) gives it recognition from wherever that was, and translation and feedback only where they are on "another device". If that changes nothing, a text-only phone takes translation, else feedback. With no stage on the shared device its address is not asked for (`needsServer`).

`settled` reads a recognition phone as `asrVia: 'api'` at its address. At session start `engineNode` asks its model list. With the header, the voice is read live as on the local engine (`openWindow`, through `electron/remote-engine.js`), re-read as often as the last reading allows. Without it: an ordinary API, one upload per sentence. The model is what the phone lends then, whatever was saved. A stretch's last reading gets 60 s (`REMOTE_LAST_WORDS_MS`), not this computer's 15 s.

A text stage is asked as the local engine is, at the phone's address: `translatorRequest`, or `coachPrompt` with `NATIVE_COACH_EXTRA`. A model this computer does not know gets an API's generic form. The readiness check reads `text`, never `data`: `phone_unreachable`, `phone_model_gone`, `phone_model_too_big`, `phone_translator_unfit`.

A phone loads a model on first request and does one thing at a time, recognition and text in one queue. So one answer may take 120 s (`PHONE_TEXT_TIMEOUT_MS`); 429 and 503 are retried after `Retry-After`, up to 3 times within those 120 s (`busyRetries`); and at session start `warmPhones` sends a one-token request, unawaited, for each model with `loaded: false`. The feedback warm-up begins with exactly the messages of every real request, so the phone reads them once.

Room for a model is `memory_mb.available` plus the `holds_mb` of the engines the phone would end for it (`phoneRoom`, matching its `Share.ensure`). A model without room gets `fits: false`: `lentChoice` passes over it, the card marks it, the check refuses it, and a 503 mid-session gives `phone_no_memory`.

Some systems freeze the app on a locked phone. While a session runs, `src/providers/openai/phoneWatch.ts` asks each phone in use for `/models` every 5 s, allowing 3 s. Two misses give one `phone_quiet` until it answers again. The session is left alone.

## What an external Realtime server must provide

Handshake: `ws://<host>:<port>/v1/realtime?model=<name>`, no subprotocol without a key, else `realtime` and `openai-insecure-api-key.<key>`. Server `session.created`, client `session.update`, server `session.updated`, within 30 s.

| `session.type` | When | Carries |
|---|---|---|
| `realtime` | The device hears, and translation is left to it with no model named | `output_modalities: ['text']`, `instructions`, `tool_choice: 'none'`, `tools: []`, `max_output_tokens`, `audio.input` |
| `transcription` | Translation names a model or runs elsewhere, feedback is on, the speaker speaks both, or the host is a Kotomimi | `audio.input` alone. The server must not answer here |

- `audio.input` is `{turn_detection, transcription, noise_reduction}`; `noise_reduction` is `null` unless the user chose one.
- `transcription.language` is a code, absent if there is none; `auto` goes only to a Kotomimi. `transcription.model` goes only when the user chose a recognizer, and never to a non-Kotomimi transcription session.
- Manual turns: `turn_detection: null`. On release `input_audio_buffer.commit`, or `.clear` if nothing was said, and never `response.create`: the server answers by itself after transcribing.
- Audio: `input_audio_buffer.append`, 24 kHz mono PCM16, base64.

The client reads `input_audio_buffer.committed`, `.speech_started`, `.speech_stopped`, `.cleared`; `conversation.item.input_audio_transcription.delta`, `.completed`, `.failed`; `response.created`, `response.output_item.added`, `response.output_text.delta`, `.done`, `response.output_item.done`, and `response.done`, without which the leg stays busy. `error` before `session.updated` refuses the start; after it, it is logged and the session goes on, unless its `code` is `session_idle` or `session_expired`.

Text: `POST <base>/chat/completions` with `{model, stream: true, messages}`, SSE or whole; `<think>…</think>` is stripped. `GET <base>/models` lists. `GET <base>/models/capabilities` is optional (`kindOf`): `transcript` a recognizer, `chat` or `completion` a text model, `translate` a translator, empty a pipeline, others (`vad`, `tts`) offered nowhere.

## LocalAI behaviour the client works around

- A page's POST without `Authorization` gets `400 missing csrf token in request header`, so requests send `Bearer no-key` (`NO_KEY`).
- `turn_detection.create_response: false` is ignored, so recognition alone uses a transcription session.
- An out-of-band `response.create` is answered as a real turn, so none is sent; one right after a manual commit cancels the transcription.
- In manual mode, transcription events use another `item_id` than `input_audio_buffer.committed`.
- Asking for audio errors and never sends `response.done`.
- `apple-speech-transcriber` errors without `language`, so the source cannot be auto-detect.
- A `transcription` session refuses a chosen recognizer (`model is not a valid pipeline model`), so no name is sent there (`transcriptionFor`).

## Known limit

The readiness check reuses its last "ready" until a setting it reads changes (`checkReads`), so a phone that stops sharing is not re-asked until then.
