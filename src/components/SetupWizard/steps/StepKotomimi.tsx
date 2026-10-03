/**
 * Fork: the wizard's step for the Kotomimi provider, in place of "Your API
 * key" — it has none. One question instead: where the listening and the
 * translating run. A server on the network (a LocalAI, or another Kotomimi
 * sharing its models) is asked for its address and tried at once; this
 * computer needs nothing typed, and its models are downloaded after setup,
 * as on the offline path. The answer is the provider's `asrVia`, carried in
 * the draft as its credential choice and written at Finish like any other.
 * Everything finer — a text model for the translation, grammar feedback,
 * sharing — is in Settings, and the tour that follows says so.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Server } from 'lucide-react';
import { useProviderStore } from '../../../stores/providerStore';
import { useAuthContext } from '../../providers/useAuthContext';
import { readCredentials, isMissing } from '../../../lib/provider/credentials';
import { noticeText } from '../../../lib/view/noticeText';
import { describeCause } from '../../../lib/diagnostics/describeCause';
import { legsFor } from '../../../lib/session/appShape';
import { getScenario } from '../../../lib/setup/scenarios';
import { wizardProvider } from '../providerPaths';
import Button from '../../Settings/shared/Button';
import FormInput from '../../Settings/shared/FormInput';
import StatusMessage from '../../Settings/shared/StatusMessage';
import type { ProviderType } from '../../../types/Provider';
import type { SetupAction, SetupDraft } from '../setupDraft';

/** The provider's id, as the wizard's drafts and the registry both spell it. The old enum the drafts are typed by does not list it: no old build stored it. */
export const KOTOMIMI_PROVIDER = 'localai' as ProviderType;
const SETTING = 'asrVia';
type Place = 'server' | 'device';

interface Props {
  draft: SetupDraft;
  dispatch: React.Dispatch<SetupAction>;
  skipButton(keepExisting: boolean): React.ReactNode;
}

const StepKotomimi: React.FC<Props> = ({ draft, dispatch, skipButton }) => {
  const { t } = useTranslation();
  const auth = useAuthContext();
  const p = wizardProvider(draft.provider);
  const entry = useProviderStore((s) => (p ? s.entries[p.id] : undefined));
  const [validating, setValidating] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => { if (p && !entry) void useProviderStore.getState().load(p); }, [p, entry]);
  useEffect(() => () => inFlight.current?.abort(), []);

  const saved = entry?.credentials ?? {};
  const stored = (entry?.settings as Record<string, unknown> | undefined)?.[SETTING];
  const place: Place = (draft.credentialChoice?.setting === SETTING ? draft.credentialChoice.value : stored) === 'device' ? 'device' : 'server';

  // The saved address, shown once: a re-run must not look as if none was ever set.
  const endpoint = draft.credentials.endpoint;
  useEffect(() => {
    if (endpoint === undefined && typeof saved.endpoint === 'string' && saved.endpoint) dispatch({ type: 'prefillCredentials', credentials: { endpoint: saved.endpoint } });
  }, [endpoint, saved.endpoint, dispatch]);

  // This computer asks for nothing: the step is complete as soon as it is chosen.
  useEffect(() => {
    if (place === 'device' && !draft.credentialsValidated) dispatch({ type: 'credentialsValidated' });
  }, [place, draft.credentialsValidated, dispatch]);

  if (!p || !entry) return <section className="setup-step"><h2>{t('fork.wizard.title')}</h2></section>;

  const choose = (next: Place) => {
    if (next === place) return;
    inFlight.current?.abort();
    setMessage(null);
    dispatch({ type: 'setCredentialChoice', setting: SETTING, value: next });
  };

  const validate = async () => {
    inFlight.current?.abort();
    const mine = new AbortController();
    inFlight.current = mine;
    setMessage(null);
    const settings = { ...(entry.settings as Record<string, unknown>), [SETTING]: 'server' };
    const credentials = readCredentials(p, settings, { ...saved, ...draft.credentials }, auth);
    if (isMissing(credentials)) {
      setMessage({ ok: false, text: t('fork.wizard.addressMissing') });
      return;
    }
    setValidating(true);
    try {
      const result = await p.check(credentials, settings, { pair: entry.pair, legs: legsFor(getScenario(draft.scenario!).mode), signal: mine.signal });
      if (mine.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: 'credentialsValidated' });
        setMessage({ ok: true, text: t('fork.wizard.serverFound', { count: result.models?.length ?? 0 }) });
      } else {
        setMessage({ ok: false, text: noticeText(t, { code: result.code, params: result.params, message: result.reason }) });
      }
    } catch (error) {
      // It could not be reached: say why, in the server's own words where it has any.
      if (!mine.signal.aborted) setMessage({ ok: false, text: t('fork.wizard.serverUnreachable', { message: describeCause(error) }) });
    } finally {
      if (inFlight.current === mine) setValidating(false);
    }
  };

  const cards: Array<{ place: Place; icon: React.ReactNode; title: string; desc: string }> = [
    { place: 'server', icon: <Server size={16} />, title: t('fork.wizard.server'), desc: t('fork.wizard.serverDesc') },
    { place: 'device', icon: <Monitor size={16} />, title: t('fork.wizard.device'), desc: t('fork.wizard.deviceDesc') },
  ];

  return (
    <section className="setup-step">
      <h2>{t('fork.wizard.title')}</h2>
      <p>{t('fork.wizard.intro')}</p>
      <div className="setup-cards" role="radiogroup" aria-label={t('fork.wizard.title')}>
        {cards.map((card) => (
          <label key={card.place} className={`setup-card${place === card.place ? ' is-selected' : ''}`}>
            <input type="radio" name="kotomimi-place" value={card.place} checked={place === card.place} onChange={() => choose(card.place)} disabled={validating} />
            <span className="setup-card__title">{card.icon}&nbsp;{card.title}</span>
            <span className="setup-card__desc">{card.desc}</span>
          </label>
        ))}
      </div>

      {place === 'server' ? (
        <>
          <label className="setup-field">
            <span>{t('providers.localai.endpoint')}</span>
            <FormInput
              type="text"
              value={draft.credentials.endpoint ?? ''}
              placeholder={t('providers.localai.endpointPlaceholder')}
              onChange={(e) => {
                inFlight.current?.abort();
                dispatch({ type: 'setCredential', key: 'endpoint', value: e.target.value });
              }}
              status={draft.credentialsValidated ? 'valid' : message && !message.ok ? 'invalid' : null}
            />
          </label>
          <div className="setup-actions">
            <Button variant="primary" onClick={validate} loading={validating} disabled={validating || !(draft.credentials.endpoint ?? '').trim()}>
              {t('fork.wizard.tryServer')}
            </Button>
            {skipButton(draft.credentialsValidated && Boolean(saved.endpoint))}
          </div>
          {message && <StatusMessage variant={message.ok ? 'success' : 'error'}>{message.text}</StatusMessage>}
          {draft.credentialsPending && <StatusMessage variant="warning">{t('fork.wizard.pendingAddress')}</StatusMessage>}
        </>
      ) : (
        <StatusMessage variant="info">{t('fork.wizard.deviceNotice')}</StatusMessage>
      )}
    </section>
  );
};

export default StepKotomimi;
