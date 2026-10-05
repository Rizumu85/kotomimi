# Defensive security review — Kotomimi LAN model sharing

**Scope:** the "Share this computer's models" feature of Kotomimi (a fork of Sokuji).
**Branch reviewed:** `localai` (HEAD `6c76dd6`), working on `claude/friendly-thompson-3mdnzx`.
**Threat model:** an untrusted device on the same LAN (guest phone, compromised IoT box) and a
web page open in a browser on the sharing computer or another LAN device (cross-origin / DNS
rebinding). Internet is out of scope unless code makes the port internet-reachable.

**What "verified" means here:** findings marked **Verified** were demonstrated against the real
`electron/lan-server.js` / `lan-upstream.js` started in-process on the loopback (the same way the
existing tests start it) with small Node/curl clients. Findings marked **Inferred** come from
reading the code only. Six failing tests that pin the confirmed defects were added to the
neighbouring test files (`electron/lan-server.test.js`, `electron/lan-firewall.test.js`) under
`describe('security review: …')`; **no production code was changed.**

Run them with:

```bash
npm ci
npx vitest run electron/lan-server.test.js electron/lan-firewall.test.js
```

(6 new tests fail, all other LAN tests pass.)

---

## Summary of findings

| # | Severity | Title | File |
|---|----------|-------|------|
| F1 | High | Server binds to `0.0.0.0` (every interface, incl. VPN/tunnel), not the LAN only | `electron/lan-server.js:136`, `electron/main.js:1305` |
| F2 | **Critical** | No `Origin` / `Host` checks + wildcard CORS → any web page drives the server (CSRF / DNS rebinding) | `electron/lan-server.js:60-66,252-262` |
| F3 | **Critical** | Unbounded in-memory frame buffering while a socket is "undecided"/"deciding" → trivial host memory exhaustion | `electron/lan-server.js:301-318`, `lan-upstream.js:200-288` |
| F4 | High | No per-device / global limit on work; one device can pin all ASR slots or saturate GPU/CPU | `electron/lan-server.js:49,261`, `src/lib/lan/transcriber.ts` |
| F5 | High | No rate limiting on the access-key check; key is brute-forceable over the LAN | `electron/lan-server.js:139,191` |
| F6 | Medium | Windows firewall rule opens the port for **any program**, not just Kotomimi | `electron/lan-firewall.js:316-325` |
| F7 | Medium | Computer name (`X-Kotomimi-Name`) is disclosed to unauthenticated callers, even on 401 | `electron/lan-server.js:138,170,192` |
| F8 | Medium | Internal error text (incl. filesystem paths / model-load failures) is returned to clients | `src/lib/lan/host.ts:73`, `transcriber.ts:195`, `lan-upstream.js:263` |
| F9 | Low | No idle/handshake timeout on sockets; slow-loris style holds keep slots and recognizers | `electron/lan-server.js:43,245-250` |
| F10 | Low | DNS reverse-lookup of every discovered neighbour; minor info exposure / noise | `electron/lan-discover.js:155-161,186-194` |
| F11 | Info | No default key by design; with no key set, any LAN device gets full use | `src/stores/lanStore.ts:101`, `lan-server.js:139` |
| F12 | Info | Renderer IPC cannot start sharing or change the key without the user's UI action (this is correct) | `electron/main.js`, `preload.js`, `ipc-channels.js` |

The two **Critical** findings (F2, F3) are the ones to fix first: F2 turns "anyone on your
Wi-Fi" into "any web page anyone running Kotomimi visits", and F3 lets a single unauthenticated
TCP peer drive the host process to ~1 GB RSS in seconds.

---

## Q1 — Bind address & firewall rule

### F1 (High) — binds to every interface, including VPN/tunnel addresses

`startLanServer` defaults `host = '0.0.0.0'` (`electron/lan-server.js:136`) and `main.js:1305`
never passes a `host`, so the listener is on **all** IPv4/IPv6 interfaces.

`lanAddresses()` (`lan-server.js:71-80`) already knows which addresses are "private" vs. other,
and deliberately *lists* the non-private ones (VPN, tunnels) second — but the socket is open on
them regardless. **Verified**:

```js
lanAddresses({ wifi:[{family:'IPv4',internal:false,address:'192.168.1.20'}],
               tailscale:[{family:'IPv4',internal:false,address:'100.101.102.103'}],
               wan:[{family:'IPv4',internal:false,address:'203.0.113.7'}] })
// => [ '192.168.1.20', '100.101.102.103', '203.0.113.7' ]
```

If the host has a public IPv4 directly (some VPSes, some mobile-tethering setups, misconfigured
routers with the machine in a DMZ), the port is internet-reachable with no additional step. Even
in the common case, it is reachable over any VPN the machine is on — which the UI's own
"otherAddresses" list acknowledges.

**Impact:** larger exposure than the stated "local network" threat model. Combined with F11 (no
default key) this is an open OpenAI-compatible endpoint on every interface.

**Fix:** bind only to the interfaces you mean to serve. Simplest robust option: keep `0.0.0.0`
but gate acceptance on the peer address being private (see F2 fix — a single
`isPrivate(remoteAddress)` guard in both the HTTP handler and the `upgrade` handler rejects
non-LAN peers cheaply and covers public/VPN interfaces at once). A stricter option is to bind one
listener per private address from `lanAddresses().filter(isPrivate)`. Binding a single private
address is not enough on a multi-homed LAN host.

### Firewall rule (see F6)

On Windows the rule the "Allow" button installs (`elevatedScript`, `lan-firewall.js:316-325`)
allows **TCP on the port with no program filter** on Private+Domain, and (when asked) a second
Public rule scoped to `LocalSubnet`. Because it names no program, it opens the port for whatever
process happens to listen on it — see F6. Ports/profiles are otherwise reasonable; macOS/Linux
are left to the OS, which matches the FORK.md description.

---

## Q2 — Authentication

**Where the key is checked.** `allowed(request)` (`lan-server.js:139`) is called on every HTTP
route (`:191`) and on the WebSocket upgrade (`:260`). With a key set, model list, capabilities,
chat and the realtime upgrade are all refused with 401/Unauthorized without it. **Verified**:

```
$ curl -i http://127.0.0.1:PORT/v1/models            # key set, none given
HTTP/1.1 401 Unauthorized … "code":"invalid_api_key"
$ curl -i -H 'Authorization: Bearer s3cret-key' …/v1/models
HTTP/1.1 200 OK
```

Proxied LocalAI routes are covered too: the door checks the key *before* consulting `upstream`
(`:191` precedes `:235-241`), and the upstream connection to LocalAI is a fresh loopback request
the door makes itself — a client cannot reach LocalAI except through an already-authenticated door
request. Good.

**Constant-time comparison.** `sameKey` (`lan-server.js:115-120`) is constant-time *for equal
lengths* but early-returns on length mismatch, leaking key length via timing. Minor on a LAN;
worth noting. The bigger issue is F5.

**Is the key logged / returned / put in a URL / sent to a third party?** No. It is never logged
(`main.js` logs only the port and firewall state), never echoed in a response, and never placed
in a URL. The upstream proxy strips it (it builds its own loopback request with no `Authorization`
from the client). `src/lib/diagnostics/redact.ts:64` also redacts the
`openai-insecure-api-key.<key>` subprotocol form from diagnostics. Good.

### F5 (High) — the key is brute-forceable: no throttling, no lockout

`allowed()` does a plain compare on every request with no rate limiting, no backoff, no failure
counter. **Verified** — 5 000 wrong-key attempts completed in ~1.5 s with no slowdown or block:

```
key guesses: 5000 in 1462 ms, never slowed or blocked
```

Since the UI encourages short human-typed keys (a free-text field, no length requirement) and the
threat model includes a persistent LAN device, a short key is practically guessable.

**Impact:** the one real authentication control is weak against an on-LAN attacker.

**Fix:** add a simple per-peer failure throttle (e.g. exponential delay or a short ban after N
failures within a window, keyed on `request.socket.remoteAddress`), and make `sameKey` fully
constant-time (hash both sides to a fixed length, compare with `crypto.timingSafeEqual`).
Optionally require a minimum key length / suggest a generated key in the UI.

### F11 (Info) — no key set = full access

By design (`lanStore.ts:101` default `key:''`, `lan-server.js:139` `wanted === '' || …`). With no
key, any LAN (or per F1, VPN/public) device gets the full model list and can run unlimited ASR and
translation. This is the documented default ("deliberately no default key"). Combined with F1-F4
it is the worst-case baseline. Recommend at minimum: a prominent UI warning when sharing is on
with no key, and defaulting the bind to private interfaces only (F1).

---

## Q3 — Browser-origin attacks (Critical)

### F2 (Critical) — no `Origin`/`Host` validation + wildcard CORS → web pages can drive the server

The HTTP server sets `Access-Control-Allow-Origin: *` unconditionally (`CORS`,
`lan-server.js:60-66`) and never inspects `Origin` or `Host` on either the HTTP handler or the
`upgrade` handler. Consequences, all **Verified**:

1. **Any web page can read responses cross-origin.** Wildcard CORS returns on every request
   regardless of `Origin`:

   ```
   $ curl -i -H 'Origin: https://attacker.example' http://127.0.0.1:PORT/v1/models
   HTTP/1.1 200 OK
   Access-Control-Allow-Origin: *
   { … model list … }
   ```

2. **Any web page can open the Realtime WebSocket.** The upgrade handler ignores `Origin`
   entirely — a browser page (which always sends `Origin`) opens the socket and streams audio /
   drives recognizers. **Verified** with a forged browser `Origin`:

   ```
   evil Origin + forged Host, no key -> OPEN
   ```

   (WebSockets are not subject to CORS, so the server itself must reject disallowed origins.)

3. **DNS rebinding.** Nothing validates `Host`. A victim on the LAN browses to
   `http://rebind.attacker.example`, whose DNS flips to the victim's own `192.168.x.y` after the
   first load; the page then talks to Kotomimi as same-origin. **Verified** — a forged `Host`
   header is accepted and served:

   ```
   $ curl -i -H 'Host: rebind.attacker.example:PORT' http://127.0.0.1:PORT/v1/models
   HTTP/1.1 200 OK  … { model list }
   ```

4. **CSRF without preflight.** `POST /v1/chat/completions` with `Content-Type: text/plain` is a
   CORS "simple request" (no preflight), so a page can fire it blind even without reading the
   response. **Verified** — the body reaches the page handler:

   ```
   $ curl -X POST -H 'Content-Type: text/plain' --data '{…chat…}' …/v1/chat/completions
   HTTP/1.1 200 OK {"echo":110}
   ```

**Why this is Critical:** it widens the attacker set from "devices on your Wi-Fi" to "any web
page, loaded by anyone running Kotomimi or by anyone on the LAN." When no key is set (F11) this is
unauthenticated full use (free GPU inference, audio transcription) driven from the web. The DNS-
rebinding path defeats even a correct same-LAN assumption.

**Fix (small, high-value):**
- Drop `Access-Control-Allow-Origin: *`. For an API meant for other app installs, the simplest
  correct posture is: **reject any request carrying an `Origin` header** (the app's own clients —
  Electron main process / Node — send none), and do not emit wildcard CORS. If browser clients are
  ever wanted, reflect only an explicit allow-list.
- **Validate `Host`:** accept only a bare IP:port (or `localhost`) matching an address the server
  is actually serving; reject a hostname. This closes DNS rebinding cheaply.
- Apply the same `Origin` check to the WebSocket `upgrade` handler (reject when `Origin` present).
- Combine with the F1 private-peer guard.

Pinned by three failing tests: `F2: refuses a Realtime socket opened by a web page …`,
`F2: gives a cross-origin page no readable answer: no wildcard CORS`,
`F2: refuses a request whose Host is a domain name (DNS rebinding)`.

### Preflight

`OPTIONS` is answered 204 with the wildcard CORS headers (`lan-server.js:182-186`) without
touching the page — fine mechanically, but it advertises the permissive policy. Folds into the F2
fix.

---

## Q4 — The upstream proxy (`lan-upstream.js`)

**Can a client choose the upstream host / path / headers?** No. The upstream target is fixed by
the main process: `createUpstream({ port: local.port, … })` (`main.js:1301`), and every outgoing
request is built with `host: '127.0.0.1'`, the fixed `port`, and a literal `path`
(`/v1/chat/completions` at `lan-upstream.js:305`, `/v1/realtime?model=<pipeline>` at `:245`). The
only client-controlled value that crosses to LocalAI is the **model name**, and it is matched
against the server's own enumerated list before use:

- `chatModel()` only returns a model that is in `found.translators` or the pipeline's own
  (`lan-upstream.js:121-128`); the request body is rebuilt via `chatBody()` (`:55-59`) which keeps
  the client's chat fields but forces `model`. The client cannot inject a `path`, a header, or a
  host.
- `recognizer()` only routes to a recognizer that LocalAI actually lists (`:131-140`); the model
  name written into the pipeline is checked against `before.recognizers` in
  `local-server.js:setPipeline` (`:333`) before the `PATCH`. A `..` or encoded-slash model name
  cannot traverse: `configPath()` does `encodeURIComponent(name)` (`local-server.js:295`) and the
  name must first be an exact member of the listed recognizers/translators.

**SSRF to other local services / engine loopback ports:** not reachable. The destination host and
port are fixed to the configured LocalAI; there is no code path where a client value becomes a URL
host/port. (I looked specifically for a client-chosen base URL and found none.)

**LocalAI admin routes (install/delete/backends):** the door exposes only
`/v1/models`, `/v1/models/capabilities`, `/v1/chat/completions`, `/v1/realtime` (`ROUTES`,
`lan-server.js:52`); `/api/models/...` and `/backend/...` are reachable **only** from the main
process's own code (`local-server.js` for pipeline config/shutdown), never from a door request.
A LAN client cannot reach them. Good — this is the right boundary.

One **Inferred** note (Low): `lan-upstream.js:complete()` streams LocalAI's response headers'
`content-type` straight back (`:306`) and its body verbatim. That is intended (pass-through), but
it also passes back any LocalAI error body, feeding F8.

---

## Q5 — Input handling & resource exhaustion (Critical)

### F3 (Critical) — unbounded buffering of socket frames before the socket is "decided"

When a LocalAI upstream is present, a freshly opened socket starts as `whose = 'undecided'`
(`lan-server.js:271`). Until the first `session.update` arrives and the upstream decides who owns
the socket, **every frame is pushed onto `held[]`** (`:307`). Once the decision starts
(`whose = 'deciding'`), frames keep accumulating in `held[]` (`:307`) until the upstream's
`recognizer()` promise resolves — and if it routes to the page, every held frame is replayed
(`:281`); if to upstream, replayed into the bridge (`:298`). The bridge in turn has its own
unbounded `queue[]` (`lan-upstream.js:205,274`) that holds everything until LocalAI says
`session.created`.

`maxPayload` caps a single frame at 4 MiB (`:247`), but nothing caps the **number** of frames or
total bytes held. A client that sends a `session.update` and then streams 4 MiB frames while the
upstream is slow to answer (a cold LocalAI listing its models, or a model still loading) makes the
main process retain all of it.

**Verified** against the real door + real `lan-upstream.js` with a stand-in upstream that takes a
few seconds to answer (both the "deciding" and "queue" paths):

```
MODE=deciding: sent 748 MiB in 6 s over one socket; RSS 55 -> 927 MiB; handed to the page: 0 MiB
MODE=queue:    sent 736 MiB in 6 s over one socket; RSS 55 -> 907 MiB; handed to the page: 0 MiB
```

One unauthenticated socket drove the host process from 55 MB to ~920 MB in six seconds; sustained,
it is an OOM of the host — which FORK.md notes is "often also running a game." Even without an
upstream, the page's own `transcriber.ts` bounds held audio to one minute
(`MAX_HELD_SAMPLES`, `:43,217`), but that bound does **not** exist on the main-process side for the
undecided/deciding window, nor in the bridge queue.

**Fix:** cap `held[]` and the bridge `queue[]` by total bytes (mirror the renderer's
one-minute-of-audio ceiling, e.g. a few MB), dropping oldest or closing the socket with 1009
(message too big) / 1008 when exceeded. Also apply a short deadline to the "deciding" state
(close if no decision within a few seconds). Pinned by failing test `F3: does not keep every frame
a device sends while it decides whose the socket is`.

### F4 (High) — one device can monopolise all ASR capacity / saturate GPU

`MAX_SOCKETS = 6` (`lan-server.js:49`) is a **global** cap with no per-device limit. **Verified**
— a single peer opened all six sockets (sending nothing) and the seventh connection from anyone
else was refused:

```
attacker holds 6 sockets, sending nothing
legitimate device -> 503
```

Each socket can drive a recognizer (`transcriber.ts` loads a model per session), and translation
has its own `MAX_LOADED = 3` (`translator.ts:341`). There is no bound on how fast a client may
open/drive sessions or how much audio it streams once "ready" — audio past the load point is fed
straight to the engine (`transcriber.ts:211`). So one device can (a) deny service to everyone else
by grabbing all slots, and (b) pin the GPU/CPU by continuously streaming audio to multiple
recognizers.

**Verified** adjacent: a single socket accepts back-to-back 4 MiB frames indefinitely without
being throttled or closed:

```
sent 100 x 4.0 MiB frames in 2255 ms; socket still open: true
```

**Impact:** trivial DoS of the sharing host (and its concurrently-running game) by one LAN device,
authenticated or not.

**Fix:** add a per-device (per `remoteAddress`) socket cap (e.g. 2) in addition to the global one,
and reserve headroom so one device cannot take all slots. Consider a simple audio-rate ceiling per
socket. These bound the GPU/CPU surface that the threat model calls out.

### Body / frame / JSON limits that **are** present (good)

- HTTP body capped at 1 MiB (`MAX_BODY_BYTES`, `:37,200`); **Verified** 413 after a 50 MB upload:
  `oversized body: HTTP 413`.
- JSON parsed in a try/catch, bad JSON → 400 (`:210-214`); socket JSON likewise
  (`transcriber.ts:118`).
- Single socket frame capped at 4 MiB (`maxPayload`, `:247`).
These are fine; the gap is cumulative/stateful growth (F3) and concurrency (F4).

---

## Q6 — Information disclosure

### F7 (Medium) — computer name handed to unauthenticated callers (even on 401)

Every response, **including the 401**, carries `X-Kotomimi-Name` (the OS hostname by default,
`os.hostname()`), because `NAMED` is spread into `refuse()`'s headers (`lan-server.js:138,170`) and
the 401 goes through `refuse` (`:192`). **Verified**:

```
$ curl -i http://127.0.0.1:PORT/v1/models        # key set, none given
HTTP/1.1 401 Unauthorized
X-Kotomimi-Name: vm
```

So a device/web page that does *not* know the key still learns the machine's hostname (often a
person's name, e.g. "Rizumu-MacBook"). Discovery relies on this header, but it should only be
revealed to an authenticated caller when a key is set.

**Fix:** omit `X-Kotomimi-Name` from unauthorized (401) responses; only include it on 2xx/404 once
the key check has passed (or always when no key is set, since then everything is open anyway).
Pinned by failing test `F7: … no name on a 401`.

### F8 (Medium) — internal error text returned to clients

- `host.ts:73` returns `cause.message` to the client in a 500 body
  (`wireError('server_error', cause.message)`). Engine/model failures can include file paths and
  internal details.
- `transcriber.ts:195` sends `The speech recognition model could not load: <cause.message>` over
  the socket; `:291` forwards raw transcription-engine error strings.
- `lan-upstream.js:263,267,310` relay LocalAI's own error text and connection errors
  (`error.message`) back to the client.
- `translator.ts:385` returns `The translation failed: <cause.message>`.

**Impact:** **Inferred** — leaks local filesystem paths, model names, and library internals to an
untrusted client, aiding reconnaissance. Not a direct compromise.

**Fix:** return a generic message to the client and record the detail via the project's
diagnostics (`reportError`/`reportWarning`) instead of echoing `cause.message`. Keep the specific
wire-shaped validation messages (language required, model not found) — those are intended and
harmless; it is the `cause.message` interpolations that should be generalized.

### What a client legitimately learns

The model inventory (ids, capabilities, languages) is by design (that is the point of sharing).
Versions are not exposed by Kotomimi's own routes. No stack traces are serialized (only
`error.message`). Note: discovery's LocalAI fingerprint uses `GET /version` against *other*
servers, not Kotomimi's own.

---

## Q7 — Discovery (`lan-discover.js`)

**What the probe sends, and to whom.** For each neighbour address on ports 8790 and 8080 it sends
exactly one `GET /v1/models` with `Accept: application/json` (`:117,135`) — no body, no key, no
custom data. A matched non-Kotomimi server additionally gets one `GET /version` (`:145`). Scope is
bounded: only private-range interfaces are enumerated (`:66-71`), networks larger than /24 are
clamped to the 256 around the host (`neighbours`, `:47-55`), VPN/tunnel ranges are skipped. This
matches FORK.md.

**Reflection / amplification:** not usable — it is a plain outbound GET to LAN peers, response
bounded to 512 KiB (`MAX_LIST_BYTES`, `:30,122`), 600 ms timeout, concurrency 170. No attacker-
controlled target, no amplification vector. The concurrency of 170 in-flight connections is a
brief self-inflicted burst only.

**Host enumeration:** discovery enumerates the host's own subnet (expected for "find other
Kotomimis"). It is initiated only by the local user via the `lan:discover` IPC and cannot be
triggered by a remote device. Low concern.

### F10 (Low) — reverse-DNS of every responder

`discoverServers` calls `nameOf()` (reverse DNS, `:155-161`) for each discovered server lacking a
name (`:186-194`). This emits PTR queries for LAN peers to the configured resolver. Minor:
reveals the user's LAN activity to the DNS server and adds noise. Acceptable, but worth a note;
could be gated or skipped for RFC1918 peers.

---

## Q8 — Renderer / IPC exposure

### F12 (Info) — IPC is correctly gated; web content cannot start sharing or change the key silently

- `preload.js` exposes only an allow-listed `invoke` (`INVOKE_CHANNELS` from `ipc-channels.js`)
  and an allow-listed `receive`; an off-list channel is rejected (`preload.js:146-158`).
- `webPreferences`: `nodeIntegration:false`, `contextIsolation:true`, `sandbox` on by default,
  `webSecurity:!isDev` (`main.js:462-466`). `setWindowOpenHandler` denies arbitrary windows and
  routes web URLs to the system browser; popovers are pinned to `about:blank`
  (`popover-windows.js:82-124`). So a compromised renderer cannot conjure windows or navigate.
- The `lan:*` handlers are thin: `lan:start`/`lan:stop`/`lan:reply`/`lan:send`/`lan:close-socket`
  and `lan:firewall-status`/`lan:firewall-allow`. They *are* reachable from the renderer (that is
  how the settings UI works), but the renderer is the app's own trusted React code, and the key is
  only ever what the renderer passes in from the settings field.

The real question for the threat model — *can a LAN/web attacker reach these IPC channels?* — is
**no**: IPC is renderer→main only, and the renderer is not the attacker surface unless the
renderer is first compromised (e.g. via F2 feeding malicious data that triggers an XSS). Note the
one `dangerouslySetInnerHTML` in the app (`UpdateDialog.tsx:116`) renders the **update
changelog**, which comes from the update feed, not from LAN input — out of scope here but worth
tracking separately, as a renderer XSS would upgrade F2 into IPC access.

**Caveat (Inferred):** because `lan:start` takes the key from renderer args and the firewall-allow
path triggers an elevated PowerShell prompt, any future path that lets untrusted content run in
the renderer would be able to invoke `lan:firewall-allow`. Today that requires a user gesture in
the UI and is not reachable from LAN content, so it stays Info — but it is the reason F2 (which
can inject data into the renderer) matters beyond the server process.

---

## Q1 detail — F6 (Medium): firewall rule has no program filter

`elevatedScript` (`lan-firewall.js:316-325`) builds rules with `-Protocol TCP -LocalPort <port>`
and **no `-Program`**. **Verified** output:

```
New-NetFirewallRule -DisplayName 'Kotomimi sharing' -Group 'Kotomimi' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8790 -Profile Private,Domain
New-NetFirewallRule -DisplayName 'Kotomimi sharing (public network, its own devices only)' … -Profile Public -RemoteAddress LocalSubnet
```

So the rule opens port 8790 inbound for **whatever program is listening on it**, not specifically
Kotomimi. If Kotomimi later stops and another process binds 8790, the rule still admits it. The
status-reading side already correlates rules to the program path via
`Get-NetFirewallApplicationFilter`/`ApplicationName` (`STATUS_SCRIPT`, `judge`), so the data to do
this is in hand.

**Impact:** the opened hole is broader than intended and outlives the app's use of the port.

**Fix:** add `-Program <exe>` (the value is already available as `$env:KOTOMIMI_EXE` in the status
script, and `allowThroughFirewall` already passes `exe`) to both `New-NetFirewallRule` lines, so
the allowance is scoped to Kotomimi's binary. Pinned by failing test
`F6: lets the port through for this program alone`.

*(Per instructions, the Windows "allow" path was never executed and no system settings were
changed — this finding is from reading the generated script and the unit-level `elevatedScript`
output only.)*

---

## F9 (Low) — no handshake/idle timeout; slow holds keep slots & recognizers

The only idle mechanism is `IDLE_SESSION_MS = 30 min` of no *speech* (`:43,158-165`). A socket
that opens and never sends a `session.update` (or sends silence) holds a slot for 30 minutes, and
with F4's global-only cap, six such sockets lock out everyone. There is no connection-level
handshake timeout and no cap on how long the "deciding" state may last (ties into F3).

**Fix:** a short handshake deadline (close if no valid `session.update` within, say, 15 s), and a
shorter idle close for sockets that never produced speech. Keep the 30-min speech idle for active
sessions.

---

## Suggested fix order

1. **F2** — `Origin` reject + drop wildcard CORS + `Host` validation (HTTP and upgrade). Smallest
   change, removes the entire browser/DNS-rebinding attack class.
2. **F3** — bound `held[]` / bridge `queue[]` by bytes and add a deciding-state deadline. Stops
   the memory-exhaustion DoS.
3. **F1** — reject non-private peer addresses (one `isPrivate(remoteAddress)` guard reused by the
   HTTP and upgrade handlers), closing public/VPN exposure.
4. **F4 / F5 / F9** — per-device socket cap, key-attempt throttle + fully constant-time compare,
   handshake/idle timeouts.
5. **F6 / F7 / F8** — `-Program` on the firewall rule; drop the name from 401s; generalize
   client-facing error text.

Findings F2, F3, F6, F7 each have a failing test checked in beside the existing suite; they encode
the intended post-fix behaviour and will pass once the fixes land. F1, F4, F5, F8, F9, F10 are
described with enough detail to test similarly but were not pinned (the fix shape is a design
choice, e.g. the exact per-device cap).
