/**
 * Fork: the sharing host as the app runs it — the bridge to the main
 * process, the app's own engines, and what the model store says is
 * downloaded (`appModels.ts`). The one module of `src/lib/lan` that knows the app; the rest
 * is handed what it needs.
 */
import { realClock } from '../contract/clock';
import { defaultEngines } from '../../providers/localInference/engines';
import { createLanHost, type LanBridge, type LanHost } from './host';
import { FIREWALL_UNKNOWN, firewallAnswer, type LanFirewall } from './protocol';
import { appLanModels } from './appModels';
import { nativeCoachAnswer, nativeOrOwnTranslator, nativeRecognizer } from './nativeShare';
import { holdNative } from '../../providers/openai/localaiNative';
import { NATIVE_COACH_EXTRA } from '../../providers/openai/nativeCoaches';

interface ElectronApi {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, listener: (payload: never) => void): void;
  removeListener(channel: string, listener: (payload: never) => void): void;
}

/** `window.electron`, as the bridge the host is written against; null outside Electron. */
function electronBridge(): LanBridge | null {
  const api = (window as unknown as { electron?: ElectronApi }).electron;
  if (!api) return null;
  return {
    invoke: (channel, data) => api.invoke(channel, data),
    on: (channel, listener) => {
      api.receive(channel, listener);
      return () => api.removeListener(channel, listener);
    },
  };
}

/**
 * Asks the main process of the system's firewall: `status` reads, `allow` adds
 * the rule — after the system has asked the user. Never rejects: no answer is `unknown`.
 */
export async function askLanFirewall(action: 'status' | 'allow'): Promise<LanFirewall> {
  const bridge = electronBridge();
  if (!bridge) return FIREWALL_UNKNOWN;
  try {
    return firewallAnswer(await bridge.invoke(`lan:firewall-${action}`));
  } catch {
    return FIREWALL_UNKNOWN;
  }
}

/** The app's sharing host; null where there is no main process to listen (the extension, the web). */
export function createAppLanHost(onClients: (count: number) => void): LanHost | null {
  const bridge = electronBridge();
  if (!bridge) return null;
  return createLanHost({
    bridge,
    models: appLanModels,
    engines: {
      // A native engine's model is run by that engine (`nativeShare.ts`); any other by the app's own.
      recognizer: (model) => nativeRecognizer(model) ?? defaultEngines.asr(model),
      translator: () => nativeOrOwnTranslator(() => defaultEngines.translation()),
      // The feedback model is the native engine's alone: the app's own chat models are not lent.
      // Asked as this computer asks it for itself, unless the device says otherwise.
      coach: { answer: (model, messages, extra) => nativeCoachAnswer(model, messages, { ...NATIVE_COACH_EXTRA, ...extra }), hold: () => holdNative('coach') },
    },
    clock: realClock,
    onClients,
  });
}

