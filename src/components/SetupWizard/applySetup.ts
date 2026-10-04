// src/components/SetupWizard/applySetup.ts
//
// The one place the wizard writes anything (spec §1.5). Store actions come in
// as an argument so this stays testable without the stores' import graph, and
// so the ORDER is a fact of this file rather than of whichever component calls
// it: the provider's write before the record (the app session's readiness
// then re-checks once, over final values), record last. No display mode: a
// mode the user chose stays chosen, whatever the scenario and however often
// the wizard runs (Stage 2 session end, ruling 1).
import { getScenario } from '../../lib/setup/scenarios';
import type { ProviderPath, ScenarioId } from '../../lib/setup/types';
import type { ProviderType } from '../../types/Provider';
import type { SetupDraft } from './setupDraft';

export interface ApplySetupDeps {
  setMode: (m: 'speaker' | 'participant' | 'both') => void;
  setTextOnly: (v: boolean) => void;
  /** The provider, its pair and — on the own-key path — its credentials and
   *  the credential choice its step showed (a settings patch; F4), written
   *  where the session reads them; the one write the wizard makes besides
   *  the presets and the record. Rejects with `SetupPersistError` when a
   *  write did not land; the record is then not written. */
  applyProvider: (
    provider: ProviderType,
    pair: { source: string; target: string },
    credentials: Record<string, string>,
    settings: Record<string, string | boolean>,
  ) => Promise<void>;
  completeSetup: (r: { scenario: ScenarioId; providerPath: ProviderPath; provider: string }) => Promise<void>;
  /** Fork: turns on the sharing of this computer's models (the Kotomimi step's third start). Absent where nothing can be shared. */
  shareModels?: () => Promise<void>;
}

export async function applySetupDraft(draft: SetupDraft, deps: ApplySetupDeps): Promise<void> {
  const { scenario, providerPath, provider, sourceLanguage, targetLanguage } = draft;
  if (!scenario || !providerPath || !provider || !sourceLanguage || !targetLanguage) {
    throw new Error('applySetupDraft: draft is incomplete');
  }
  const preset = getScenario(scenario);

  deps.setMode(preset.mode);
  deps.setTextOnly(preset.textOnly);

  const credentials = providerPath === 'own-key' && !draft.credentialsPending ? draft.credentials : {};
  // The credential choice the step showed is written even when the key was
  // skipped: Settings then shows the fields the user chose (Stage 2
  // Volcengine AST2, ruling 1).
  const choice = providerPath === 'own-key' ? draft.credentialChoice : null;
  const settings: Record<string, string | boolean> = choice ? { [choice.setting]: choice.value } : {};
  // Fork: the Kotomimi step asks one question for every stage — another device, or this computer. Its third start
  // (`share`) is this computer too, lending its models to the other devices: no place of its own.
  const kotomimi = choice !== null && (provider as string) === 'localai' && choice.setting === 'asrVia';
  const shares = kotomimi && choice.value === 'share';
  if (kotomimi) {
    const place = shares ? 'device' : choice.value;
    Object.assign(settings, { asrVia: place, translateAt: place, coachAt: place });
    // The other device's access key, given in the step: it is asked for from then on (the setting shows its field).
    if (place === 'server' && credentials.serverKey?.trim()) settings.serverNeedsKey = true;
  }
  // Awaited: a rejected write has to reach Finish's error path rather than
  // becoming an unhandled rejection behind a "done" wizard.
  await deps.applyProvider(provider, { source: sourceLanguage, target: targetLanguage }, credentials, settings);
  // Fork: the sharing is a convenience of this setup, not a condition of it — a port that is taken must not leave
  // the setup undone. Its section in Settings says what is wrong, and how to put it right.
  if (shares) await deps.shareModels?.().catch(() => undefined);
  await deps.completeSetup({ scenario, providerPath, provider });
}
