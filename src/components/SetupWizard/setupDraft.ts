// src/components/SetupWizard/setupDraft.ts
//
// Everything the wizard collects, and the rules for moving through it. Pure:
// no store, no DOM. The UI dispatches actions; Finish hands the draft to
// applySetup. Nothing here is persisted — backing out of the wizard discards
// the draft, which is what makes every step reversible (spec §1.1).
import type { ScenarioId, ProviderPath } from '../../lib/setup/types';
import type { ProviderType } from '../../types/Provider';

export type SetupStep = 0 | 1 | 2 | 3 | 4 | 5;
export const LAST_STEP: SetupStep = 5;

/**
 * Fork: the two steps the wizard no longer shows — which service (2), and
 * which device runs it (3). They asked a newcomer to choose between things
 * they had not seen yet, a wrong pick led into another product (an account
 * to register, or a different engine), and both answers can be changed in
 * Settings at any time. They are answered here instead (`kotomimiStart`).
 * The steps keep their numbers, so that everything written against them —
 * the step components, the tour's hand-off, the analytics ids — stands, and
 * the steps themselves stay in the code: their tests show them again
 * (`setHiddenSetupSteps([])`), which is the only use of that switch.
 */
export const KOTOMIMI_HIDDEN_STEPS: readonly SetupStep[] = [2, 3];
let hidden: readonly SetupStep[] = KOTOMIMI_HIDDEN_STEPS;
export function setHiddenSetupSteps(steps: readonly SetupStep[]): void {
  hidden = steps;
}
/** The steps the wizard walks, in order. */
export const shownSteps = (): SetupStep[] => ([0, 1, 2, 3, 4, 5] as SetupStep[]).filter((step) => !hidden.includes(step));

/**
 * What the hidden steps asked, answered for a draft that names no provider:
 * Kotomimi's own, with every stage on this computer — the one start that
 * needs nothing else to exist (no other device, no key). A draft that already
 * names a provider (a Help re-run over a saved setup) keeps it, and its
 * places: no choice is written, so the saved ones stand.
 */
function kotomimiStart(d: SetupDraft): SetupDraft {
  if (d.providerPath !== null && d.provider !== null) return d;
  return { ...d, providerPath: 'own-key', provider: 'localai' as ProviderType, credentials: {}, credentialChoice: { setting: 'asrVia', value: 'device' }, credentialsValidated: true, credentialsPending: false };
}

export interface SetupDraft {
  step: SetupStep;
  scenario: ScenarioId | null;
  providerPath: ProviderPath | null;
  /** Resolved from the path (managed/offline) or picked by the user (own-key). */
  provider: ProviderType | null;
  /** own-key only: slice key → value, cleared when path or provider changes. */
  credentials: Record<string, string>;
  /**
   * own-key only: the credential choice the step shows (F4; Stage 2
   * Volcengine AST2, ruling 1) — the provider's `credentials.choice.setting` and
   * the option picked. Null until one is picked: the saved setting stands.
   * Written at Finish, and cleared when path or provider changes.
   */
  credentialChoice: { setting: string; value: string } | null;
  credentialsValidated: boolean;
  /** "Skip for now" was taken on step 3 (spec §1.4). */
  credentialsPending: boolean;
  sourceLanguage: string | null;
  targetLanguage: string | null;
}

export type SetupAction =
  | { type: 'setScenario'; scenario: ScenarioId; keepProvider: boolean }
  | { type: 'setPath'; path: ProviderPath; provider: ProviderType | null }
  | { type: 'setProvider'; provider: ProviderType }
  | { type: 'setCredential'; key: string; value: string }
  | { type: 'setCredentialChoice'; setting: string; value: string }
  | { type: 'prefillCredentials'; credentials: Record<string, string> }
  | { type: 'credentialsValidated' }
  | { type: 'skipCredentials'; keepExisting?: boolean }
  | { type: 'setLanguages'; source: string; target: string }
  | { type: 'next' }
  | { type: 'back' };

export interface AdvanceEnv {
  isSignedIn: boolean;
}

export function initialDraft(): SetupDraft {
  return {
    step: 0,
    scenario: null,
    providerPath: null,
    provider: null,
    credentials: {},
    credentialChoice: null,
    credentialsValidated: false,
    credentialsPending: false,
    sourceLanguage: null,
    targetLanguage: null,
  };
}

/** Pre-fill for a Help re-run (spec §1.6). A migrated record carries nulls and
 *  yields a blank draft. */
export function draftFromRecord(
  r: { scenario: ScenarioId | null; providerPath: ProviderPath | null; provider: string },
  opts: { credentialsAlreadyValid: boolean },
): SetupDraft {
  if (!r.scenario || !r.providerPath) return initialDraft();
  return {
    ...initialDraft(),
    scenario: r.scenario,
    providerPath: r.providerPath,
    provider: r.provider as ProviderType,
    credentialsValidated: r.providerPath === 'own-key' && opts.credentialsAlreadyValid,
  };
}

const cleared = {
  credentials: {} as Record<string, string>,
  credentialChoice: null,
  credentialsValidated: false,
  credentialsPending: false,
  sourceLanguage: null,
  targetLanguage: null,
};

export function canAdvance(d: SetupDraft, env: AdvanceEnv): boolean {
  switch (d.step) {
    case 0: return true;
    case 1: return d.scenario !== null;
    case 2: return d.providerPath !== null && d.provider !== null;
    case 3:
      if (d.credentialsPending) return true;
      if (d.providerPath === 'managed') return env.isSignedIn;
      if (d.providerPath === 'own-key') return d.credentialsValidated;
      return true; // offline: nothing to provide
    case 4: return d.sourceLanguage !== null && d.targetLanguage !== null;
    case 5: return true;
  }
}

export function setupReducer(d: SetupDraft, a: SetupAction): SetupDraft {
  switch (a.type) {
    case 'setScenario':
      if (a.keepProvider) return { ...d, scenario: a.scenario };
      return { ...d, scenario: a.scenario, providerPath: null, provider: null, ...cleared };
    case 'setPath':
      return { ...d, providerPath: a.path, provider: a.provider, ...cleared };
    case 'setProvider':
      return { ...d, provider: a.provider, ...cleared };
    case 'setCredential':
      return {
        ...d,
        credentials: { ...d.credentials, [a.key]: a.value },
        credentialsValidated: false,
        credentialsPending: false,
      };
    // Another set of fields: what was validated was the other set. Typed
    // values of either set stay, as the settings panel keeps both.
    case 'setCredentialChoice':
      return {
        ...d,
        credentialChoice: { setting: a.setting, value: a.value },
        credentialsValidated: false,
        credentialsPending: false,
      };
    // The key already in settings, mirrored into the draft so a re-run shows
    // what is saved instead of an empty box. Unlike a keystroke it says nothing
    // new about the key, so it must not disturb the validated/pending flags the
    // record seeded (spec §1.6).
    case 'prefillCredentials':
      return { ...d, credentials: { ...a.credentials, ...d.credentials } };
    case 'credentialsValidated':
      return { ...d, credentialsValidated: true, credentialsPending: false };
    case 'skipCredentials':
      // With a usable credential already in settings, skipping means "leave it
      // as it is": the draft drops whatever was typed (the step refills it from
      // settings) and nothing is pending, because nothing is missing. Reported
      // 2026-08-25 — the old branch called a saved key absent and blanked the
      // box the user had just seen it in.
      return a.keepExisting
        ? { ...d, credentials: {}, credentialsPending: false }
        : { ...d, credentials: {}, credentialsValidated: false, credentialsPending: true };
    case 'setLanguages':
      return { ...d, sourceLanguage: a.source, targetLanguage: a.target };
    case 'next': {
      const next = shownSteps().find((step) => step > d.step);
      if (next === undefined) return d;
      // Passing the hidden steps answers them.
      const passed = hidden.some((step) => step > d.step && step < next);
      return { ...(passed ? kotomimiStart(d) : d), step: next };
    }
    case 'back': {
      const previous = shownSteps().reverse().find((step) => step < d.step);
      return previous === undefined ? d : { ...d, step: previous };
    }
  }
}
