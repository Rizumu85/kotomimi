// src/app/vrOverlayPorts.ts
/**
 * Fork: what the SteamVR overlay (`vrOverlay.ts`) reads and changes, over the
 * app's stores: the selected provider's pair and languages, and — where
 * LocalAI hears or translates on this computer — its downloaded models. And
 * the headset's words, in the user's language.
 */
import { getProvider } from '../providers/registry';
import { isApple, NATIVE_MODELS, nativeDownloaded } from '../providers/openai/localaiNative';
import { NATIVE_TRANSLATORS, nativeTranslates } from '../providers/openai/nativeTranslators';
import type { LocalAISettings } from '../providers/openai/localai';
import { useLanguagePinStore } from '../stores/languagePinStore';
import { useNativeEngineStore, useNativeTranslatorStore } from '../stores/nativeEngineStore';
import { useProviderStore } from '../stores/providerStore';
import type { VrWords } from '../vr/types';
import type { VrSettingsPort } from './vrOverlay';

const baseOf = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];

function selected() {
  const store = useProviderStore.getState();
  const id = store.selected;
  const entry = id ? store.entries[id] : undefined;
  const provider = id ? getProvider(id) : undefined;
  return entry && provider ? { id: id!, entry, provider } : null;
}

function localai(): LocalAISettings | null {
  const s = selected();
  return s && s.id === 'localai' ? (s.entry.settings as unknown as LocalAISettings) : null;
}

/** Fork: the other side's languages, where the selected provider switches them by hand (`MoreLanguages.light`). */
function theirSide() {
  const s = selected();
  const theirs = s?.provider.languages.more?.(s.entry.settings, useProviderStore.getState().models[s.id] ?? [], s.entry.pair).theirs;
  return s && theirs?.light ? { s, theirs } : null;
}

export function vrSettingsPort(): VrSettingsPort {
  return {
    pair: () => selected()?.entry.pair ?? null,
    setPair: (pair) => {
      const s = selected();
      if (s) useProviderStore.getState().setPair(s.provider, pair);
    },
    theirOptions: () => {
      const s = selected();
      if (!s) return [];
      return s.provider.languages.targets(s.entry.pair.source, s.entry.settings).map((o) => o.value).filter((v) => v !== s.entry.pair.source);
    },
    myOptions: () => {
      const s = selected();
      if (!s) return [];
      return s.provider.languages.sources(s.entry.settings).map((o) => o.value).filter((v) => v !== 'auto');
    },
    pins: () => useLanguagePinStore.getState().pins,
    theirs: () => {
      const side = theirSide();
      if (!side) return null;
      return { main: side.s.entry.pair.target, row: side.theirs.chosen, lit: side.theirs.lit ?? '', two: side.theirs.most !== 0 };
    },
    applyTheirs: (next) => {
      const side = theirSide();
      if (!side) return;
      const { s, theirs } = side;
      const store = useProviderStore.getState();
      if (next.main !== s.entry.pair.target) store.setPair(s.provider, { source: s.entry.pair.source, target: next.main });
      store.updateSettings(s.provider, { ...theirs.set(next.row), ...theirs.light!(next.lit) });
    },
    hearers: () => {
      const s = localai();
      const pair = selected()?.entry.pair;
      if (!s || !pair || s.asrVia !== 'device') return null;
      const base = baseOf(pair.target);
      const status = useNativeEngineStore.getState().status;
      const options = NATIVE_MODELS
        .filter((m) => !isApple(m.id) && m.languages.includes(base) && nativeDownloaded(status, m.id))
        .map((m) => ({ id: m.id, label: m.name }));
      if (options.length === 0) return null;
      return { value: s.asrNativeByLanguage?.[base] ?? s.asrNativeModel, options };
    },
    setHearer: (id) => {
      const s = selected();
      const settings = localai();
      if (!s || !settings) return;
      const base = baseOf(s.entry.pair.target);
      useProviderStore.getState().updateSettings(s.provider, { asrNativeByLanguage: { ...(settings.asrNativeByLanguage ?? {}), [base]: id } });
    },
    translators: () => {
      const s = localai();
      const pair = selected()?.entry.pair;
      if (!s || !pair || s.translateAt !== 'device') return null;
      const status = useNativeTranslatorStore.getState().status;
      const options = NATIVE_TRANSLATORS
        .filter((m) => !m.retired && nativeDownloaded(status, m.id) && nativeTranslates(m, pair.target, pair.source))
        .map((m) => ({ id: m.id, label: m.name }));
      if (options.length === 0) return null;
      return { value: s.translateNativeModel, options };
    },
    setTranslator: (id) => {
      const s = selected();
      if (s) useProviderStore.getState().updateSettings(s.provider, { translateNativeModel: id });
    },
    flush: () => {
      const s = selected();
      return s ? useProviderStore.getState().flush(s.provider) : Promise.resolve(true);
    },
    subscribe: (listener) => {
      const offs = [
        useProviderStore.subscribe(listener),
        useLanguagePinStore.subscribe(listener),
        useNativeEngineStore.subscribe(listener),
        useNativeTranslatorStore.subscribe(listener),
      ];
      return () => { for (const off of offs) off(); };
    },
  };
}

type T = (key: string, fallback: string) => string;

export function vrWords(t: T): VrWords {
  return {
    me: t('fork.vr.me', 'Me'),
    them: t('fork.vr.them', 'Them'),
    pause: t('fork.vr.pause', 'Pause'),
    resume: t('fork.vr.resume', 'Start'),
    hide: t('fork.vr.hide', 'Hide headset captions'),
    show: t('fork.vr.show', 'Show headset captions'),
    tune: t('fork.vr.tune', 'Adjust'),
    back: t('fork.vr.back', 'Back'),
    theirs: t('fork.vr.theirs', 'They speak'),
    mine: t('fork.vr.mine', 'I speak'),
    hear: t('fork.vr.hear', 'Recognition'),
    translate: t('fork.vr.translate', 'Translation'),
    more: t('fork.vr.more', 'More languages'),
    switching: t('fork.vr.switching', 'Switching to {name}, back in a few seconds'),
    loading: t('fork.vr.loading', 'Loading…'),
    behind: t('fork.vr.behind', '{s} s behind'),
    perSentence: t('fork.vr.perSentence', '{s} s a sentence'),
    fps: t('fork.vr.fps', 'VR at {fps} fps'),
    dropping: t('fork.vr.dropping', 'dropping frames'),
    vram: t('fork.vr.vram', 'VRAM {used} / {total} GB'),
    stopped: t('fork.vr.stopped', 'Recognition stopped. Turn your wrist to start again.'),
    stoppedShort: t('fork.vr.stoppedShort', 'Stopped'),
    muted: t('fork.vr.muted', 'Muted in VRChat'),
    chatbox: t('fork.vr.chatbox', 'Chatbox'),
    height: t('fork.vr.height', 'Caption height'),
    heightHigh: t('fork.vr.heightHigh', 'High'),
    heightMid: t('fork.vr.heightMid', 'Middle'),
    heightLow: t('fork.vr.heightLow', 'Low'),
    panel: t('fork.vr.panelTitle', 'Kotomimi wrist panel'),
  };
}
