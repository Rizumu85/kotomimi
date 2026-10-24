#!/usr/bin/env python3
"""
Fork: builds the speed test's recordings, one short read sentence per language
the pipeline hears (`src/providers/openai/speedTest.ts`).

Every language but Japanese comes from Google's FLEURS (CC BY 4.0): the first
read sentence of 8-11 s in its `dev` split. Only the head of each archive is
streamed, never the whole of it. Japanese is the phone's own self-check clip
(LibriVox, public domain; android/README.md), so the two can be compared.

Each clip is trimmed to its speech, 0.2 s kept on either side, and written as
mono Opus to public/speed-test/<lang>.ogg; the list of them, with where each
one's speech ends, goes to src/providers/openai/speedClips.generated.ts.

    python scripts/dev/build-speed-clips.py   (needs ffmpeg on PATH)
"""
import io
import json
import subprocess
import sys
import tarfile
import urllib.request
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'speed-test'
TS = ROOT / 'src' / 'providers' / 'openai' / 'speedClips.generated.ts'
BASE = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data'
RATE = 16000
PAD_S = 0.2
MIN_S, MAX_S = 7.0, 11.0
HEAD_BYTES = 48 * 1024 * 1024

# The app's base language codes, as `speedClipFor` reduces the picker's, to FLEURS configurations.
FLEURS = {
    'ar': 'ar_eg', 'am': 'am_et', 'bg': 'bg_bg', 'bn': 'bn_in', 'ca': 'ca_es', 'cs': 'cs_cz', 'da': 'da_dk',
    'de': 'de_de', 'el': 'el_gr', 'en': 'en_us', 'es': 'es_419', 'et': 'et_ee', 'fa': 'fa_ir', 'fi': 'fi_fi',
    'fil': 'fil_ph', 'fr': 'fr_fr', 'gu': 'gu_in', 'he': 'he_il', 'hi': 'hi_in', 'hr': 'hr_hr', 'hu': 'hu_hu',
    'id': 'id_id', 'it': 'it_it', 'kn': 'kn_in', 'ko': 'ko_kr', 'lt': 'lt_lt', 'lv': 'lv_lv', 'ml': 'ml_in',
    'mr': 'mr_in', 'ms': 'ms_my', 'nl': 'nl_nl', 'no': 'nb_no', 'pl': 'pl_pl', 'pt': 'pt_br', 'ro': 'ro_ro',
    'ru': 'ru_ru', 'sk': 'sk_sk', 'sl': 'sl_si', 'sr': 'sr_rs', 'sv': 'sv_se', 'sw': 'sw_ke', 'ta': 'ta_in',
    'te': 'te_in', 'th': 'th_th', 'tr': 'tr_tr', 'uk': 'uk_ua', 'vi': 'vi_vn', 'zh': 'cmn_hans_cn',
    'yue': 'yue_hant_hk',
}
JAPANESE = ROOT / 'android' / 'app' / 'src' / 'main' / 'assets' / 'selfcheck-ja.wav'


def fetch(url: str):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'kotomimi-build'}), timeout=60)


class Head(io.RawIOBase):
    """The first `limit` bytes of a response, read as a stream: tarfile's `r|gz` never seeks."""

    def __init__(self, response, limit):
        self.response, self.left = response, limit

    def readable(self):
        return True

    def readinto(self, b):
        if self.left <= 0:
            return 0
        data = self.response.read(min(len(b), self.left))
        self.left -= len(data)
        b[:len(data)] = data
        return len(data)


def mono16k(raw: bytes) -> array:
    """Any WAV (FLEURS's are 32-bit float) as 16 kHz mono 16-bit samples, through ffmpeg."""
    pcm = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', '-', '-f', 's16le', '-ac', '1', '-ar', str(RATE), '-'],
                         input=raw, capture_output=True, check=True).stdout
    return array('h', pcm)


def speech_span(samples: array) -> tuple[int, int]:
    """The first and last sample of speech: 20 ms frames within 35 dB of the loudest one and 15 dB over the room's floor."""
    frame = RATE // 50
    energies = []
    for i in range(0, len(samples) - frame, frame):
        chunk = samples[i:i + frame]
        energies.append(sum(s * s for s in chunk) / frame)
    # The quietest tenth of the recording is its room: a noisy one must not read as speaking to the end.
    room = sorted(energies)[len(energies) // 10]
    floor = max(max(energies) / (10 ** 3.5), room * (10 ** 1.5))
    loud = [i for i, e in enumerate(energies) if e >= floor]
    if not loud:
        return 0, 0  # Never 15 dB over its own room: no clip to use.
    return loud[0] * frame, (loud[-1] + 1) * frame


def write(lang: str, samples: array) -> dict:
    start, end = speech_span(samples)
    pad = int(PAD_S * RATE)
    clip = samples[max(0, start - pad):min(len(samples), end + pad)]
    speech_end_ms = round((min(end, len(samples)) - max(0, start - pad)) * 1000 / RATE)
    OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(RATE), '-ac', '1', '-i', '-',
         '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', str(OUT / f'{lang}.ogg')],
        input=clip.tobytes(), check=True)
    return {'file': f'{lang}.ogg', 'ms': round(len(clip) * 1000 / RATE), 'speechEndMs': speech_end_ms}


def from_fleurs(lang: str, config: str) -> tuple[dict, str]:
    texts = {}
    for line in fetch(f'{BASE}/{config}/dev.tsv').read().decode('utf-8').splitlines():
        cols = line.split('\t')
        if len(cols) > 2:
            texts[cols[1]] = cols[2]
    with fetch(f'{BASE}/{config}/audio/dev.tar.gz') as response:
        with tarfile.open(fileobj=io.BufferedReader(Head(response, HEAD_BYTES)), mode='r|gz') as tar:
            try:
                for member in tar:
                    name = member.name.rsplit('/', 1)[-1]
                    if not member.isfile() or name not in texts:
                        continue
                    samples = mono16k(tar.extractfile(member).read())
                    # Read by its speech, not its file: FLEURS's recordings carry seconds of silence.
                    start, end = speech_span(samples)
                    if MIN_S <= (end - start) / RATE <= MAX_S:
                        return write(lang, samples), texts[name]
            except tarfile.ReadError:
                pass  # The head ran out mid-member.
    raise SystemExit(f'{lang}: no {MIN_S:.0f}-{MAX_S:.0f} s of speech in the first {HEAD_BYTES >> 20} MB of {config}')


def main() -> None:
    clips, credits = {}, {}
    clips['ja'] = write('ja', mono16k(JAPANESE.read_bytes()))
    credits['ja'] = 'LibriVox, 芥川龍之介「杜子春」 (public domain)'
    for lang, config in FLEURS.items():
        clips[lang], text = from_fleurs(lang, config)
        credits[lang] = f'FLEURS {config} (CC BY 4.0): {text}'
        print(lang, clips[lang], text[:60], flush=True)
    (OUT / 'SOURCES.json').write_text(json.dumps(credits, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    body = ',\n'.join(f"  {json.dumps(k)}: {{ file: {json.dumps(v['file'])}, ms: {v['ms']}, speechEndMs: {v['speechEndMs']} }}"
                      for k, v in sorted(clips.items()))
    TS.write_text(
        '// Generated by scripts/dev/build-speed-clips.py: do not edit by hand.\n'
        '/** The speed test\'s recordings, by base language: the file under `speed-test/`, its length, and where its speech ends. */\n'
        'export const SPEED_CLIPS: Readonly<Record<string, { file: string; ms: number; speechEndMs: number }>> = {\n'
        f'{body},\n}};\n', encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())
