/**
 * Fork: the wizard's step for the Kotomimi provider, in place of "Your API
 * key" — it has none. One question instead: where the listening and the
 * translating run. Another device on the network (a Kotomimi sharing its
 * models, or a LocalAI) is found by searching — a click chooses it and tries
 * it at once — with the address field kept for what the search cannot reach; this
 * computer needs nothing typed, and its models are downloaded after setup,
 * as on the offline path. The answer is the provider's `asrVia`, carried in
 * the draft as its credential choice and written at Finish like any other.
 *
 * A third start, where there is a main process to listen: this computer, and
 * lending its models to the other devices on the network — the computer the
 * first card's "another device" is, set up from its own side. It is this
 * computer for every stage, and Finish turns the sharing on (`applySetup.ts`:
 * the draft carries it as the choice's value `share`, which is no place).
 *
 * A device that asks for an access key is asked it here, in a field that
 * appears for one: picked from the list as one, or found to be one when tried.
 * Finish then has the device asked with it from then on (`applySetup.ts`).
 *
 * Everything finer — a text model for the translation, grammar feedback, the
 * sharing's key — is in Settings, and the tour that follows says so.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Server, Share2 } from 'lucide-react';
import { useProviderStore } from '../../../stores/providerStore';
import { useLanStore } from '../../../stores/lanStore';
import { canFindServers } from '../../../lib/lan/discover';
import { LAN_PIPELINE } from '../../../lib/lan/protocol';
import { useAuthContext } from '../../providers/useAuthContext';
import { checkErrorWords } from '../../../lib/provider/checkError';
import { readCredentials, isMissing } from '../../../lib/provider/credentials';
import { noticeText } from '../../../lib/view/noticeText';
import { describeCause } from '../../../lib/diagnostics/describeCause';
import { legsFor } from '../../../lib/session/appShape';
import { getScenario } from '../../../lib/setup/scenarios';
import { wizardProvider } from '../providerPaths';
import Button from '../../Settings/shared/Button';
import FormInput from '../../Settings/shared/FormInput';
import StatusMessage from '../../Settings/shared/StatusMessage';
import { ServerFinder } from '../../LanSharing/ServerFinder';
import type { ProviderType } from '../../../types/Provider';
import type { SetupAction, SetupDraft } from '../setupDraft';

/** The provider's id, as the wizard's drafts and the registry both spell it. The old enum the drafts are typed by does not list it: no old build stored it. */
export const KOTOMIMI_PROVIDER = 'localai' as ProviderType;
const SETTING = 'asrVia';
type Place = 'server' | 'device';
/** What a card answers: a place for every stage, or this computer lending its models too. */
type Start = Place | 'share';
/** The draft's value for the third card (`applySetup.ts` reads it). */
export const SHARE_START = 'share';

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
  /** `hint`: what to do next, not a failure. */
  const [message, setMessage] = useState<{ ok: boolean; text: string; hint?: boolean } | null>(null);
  /** The device turned out to ask for an access key: its field is shown. */
  const [keyAsked, setKeyAsked] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => { if (p && !entry) void useProviderStore.getState().load(p); }, [p, entry]);
  useEffect(() => () => inFlight.current?.abort(), []);

  const saved = entry?.credentials ?? {};
  const stored = (entry?.settings as Record<string, unknown> | undefined)?.[SETTING];
  // A key asked for before (a re-run), one picked as wanting it, one typed: the field is there.
  const keyedBefore = (entry?.settings as Record<string, unknown> | undefined)?.serverNeedsKey === true;
  const keyed = keyAsked || keyedBefore || draft.credentials.serverKey !== undefined;
  // Sharing needs a main process to listen: the extension and the web have none.
  const canShare = canFindServers();
  const sharing = useLanStore((s) => s.enabled);
  const chosen = draft.credentialChoice?.setting === SETTING ? draft.credentialChoice.value : undefined;
  // Nothing chosen yet: as this computer is set up now, so a re-run shows what is saved.
  const start: Start = chosen === 'server' || chosen === 'device' ? chosen
    : chosen === SHARE_START && canShare ? 'share'
    : chosen === SHARE_START ? 'device'
    : stored === 'device' ? (canShare && sharing ? 'share' : 'device') : 'server';
  const place: Place = start === 'server' ? 'server' : 'device';

  // The saved address, shown once: a re-run must not look as if none was ever set. Its key with it, while it is asked for.
  const endpoint = draft.credentials.endpoint;
  useEffect(() => {
    if (endpoint === undefined && typeof saved.endpoint === 'string' && saved.endpoint) dispatch({ type: 'prefillCredentials', credentials: { endpoint: saved.endpoint } });
  }, [endpoint, saved.endpoint, dispatch]);
  const serverKey = draft.credentials.serverKey;
  useEffect(() => {
    if (serverKey === undefined && keyedBefore && typeof saved.serverKey === 'string' && saved.serverKey) dispatch({ type: 'prefillCredentials', credentials: { serverKey: saved.serverKey } });
  }, [serverKey, keyedBefore, saved.serverKey, dispatch]);

  // This computer asks for nothing: the step is complete as soon as it is chosen.
  useEffect(() => {
    if (place === 'device' && !draft.credentialsValidated) dispatch({ type: 'credentialsValidated' });
  }, [place, draft.credentialsValidated, dispatch]);

  if (!p || !entry) return <section className="setup-step"><h2>{t('fork.wizard.title')}</h2></section>;

  const choose = (next: Start) => {
    if (next === start) return;
    inFlight.current?.abort();
    setMessage(null);
    dispatch({ type: 'setCredentialChoice', setting: SETTING, value: next });
  };

  /** `address`: the one just picked from the list, which the draft does not hold yet. `withKey`: whether the device is asked with its key. */
  const validate = async (address?: string, withKey = keyed) => {
    inFlight.current?.abort();
    const mine = new AbortController();
    inFlight.current = mine;
    setMessage(null);
    const settings = { ...(entry.settings as Record<string, unknown>), [SETTING]: 'server', serverNeedsKey: withKey };
    const credentials = readCredentials(p, settings, { ...saved, ...draft.credentials, ...(address ? { endpoint: address } : {}) }, auth);
    if (isMissing(credentials)) {
      setMessage(credentials.code === 'server_key_missing' ? { ok: false, hint: true, text: t('fork.wizard.keyNeeded') } : { ok: false, text: t('fork.wizard.addressMissing') });
      return;
    }
    setValidating(true);
    try {
      const result = await p.check(credentials, settings, { pair: entry.pair, legs: legsFor(getScenario(draft.scenario!).mode), signal: mine.signal });
      if (mine.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: 'credentialsValidated' });
        setMessage({ ok: true, text: t('fork.wizard.serverFound', { count: (result.models ?? []).filter((m) => m.id !== LAN_PIPELINE).length }) });
      } else if (result.code === 'server_key_needed') {
        // It asks for a key it was not given: the field, and what to type in it.
        setKeyAsked(true);
        setMessage({ ok: false, hint: true, text: t('fork.wizard.keyNeeded') });
      } else {
        if (result.code === 'server_key_refused') setKeyAsked(true);
        setMessage({ ok: false, text: noticeText(t, { code: result.code, params: result.params, message: result.reason }) });
      }
    } catch (error) {
      // It could not be reached: in the words the settings use where the check says what went wrong (`CheckError`), else the server's own.
      if (mine.signal.aborted) return;
      const words = checkErrorWords(error);
      setMessage({ ok: false, text: words ? noticeText(t, { ...words, message: describeCause(error) }) : t('fork.wizard.serverUnreachable', { message: describeCause(error) }) });
    } finally {
      if (inFlight.current === mine) setValidating(false);
    }
  };

  const cards: Array<{ start: Start; icon: React.ReactNode; title: string; desc: string }> = [
    { start: 'server', icon: <Server size={16} />, title: t('fork.wizard.server'), desc: t('fork.wizard.serverDesc') },
    { start: 'device', icon: <Monitor size={16} />, title: t('fork.wizard.device'), desc: t('fork.wizard.deviceDesc') },
    ...(canShare ? [{ start: 'share' as const, icon: <Share2 size={16} />, title: t('fork.wizard.share'), desc: t('fork.wizard.shareDesc') }] : []),
  ];

  return (
    <section className="setup-step">
      <h2>{t('fork.wizard.title')}</h2>
      <p>{t('fork.wizard.intro')}</p>
      <div className="setup-cards" role="radiogroup" aria-label={t('fork.wizard.title')}>
        {cards.map((card) => (
          <label key={card.start} className={`setup-card${start === card.start ? ' is-selected' : ''}`}>
            <input type="radio" name="kotomimi-place" value={card.start} checked={start === card.start} onChange={() => choose(card.start)} disabled={validating} />
            <span className="setup-card__title">{card.icon}&nbsp;{card.title}</span>
            <span className="setup-card__desc">{card.desc}</span>
          </label>
        ))}
      </div>

      {place === 'server' ? (
        <>
          <ServerFinder
            auto
            value={draft.credentials.endpoint ?? ''}
            disabled={validating}
            onPick={(server) => {
              dispatch({ type: 'setCredential', key: 'endpoint', value: server.address });
              // One that wants a key is tried once it has one: tried without, it could only refuse.
              if (server.needsKey && !draft.credentials.serverKey?.trim()) {
                inFlight.current?.abort();
                setKeyAsked(true);
                setMessage({ ok: false, hint: true, text: t('fork.wizard.keyNeeded') });
                return;
              }
              void validate(server.address, keyed || server.needsKey);
            }}
          />
          <label className="setup-field">
            <span>{t('fork.find.manual')}</span>
            <FormInput
              type="text"
              value={draft.credentials.endpoint ?? ''}
              placeholder={t('providers.localai.endpointPlaceholder')}
              onChange={(e) => {
                inFlight.current?.abort();
                dispatch({ type: 'setCredential', key: 'endpoint', value: e.target.value });
              }}
              status={draft.credentialsValidated ? 'valid' : message && !message.ok && !message.hint ? 'invalid' : null}
            />
          </label>
          {keyed && (
            <label className="setup-field">
              <span>{t('providers.localai.serverKey')}</span>
              <FormInput
                type="password"
                aria-label={t('providers.localai.serverKey')}
                value={draft.credentials.serverKey ?? ''}
                autoComplete="off"
                onChange={(e) => {
                  inFlight.current?.abort();
                  dispatch({ type: 'setCredential', key: 'serverKey', value: e.target.value });
                }}
              />
            </label>
          )}
          <div className="setup-actions">
            <Button variant="primary" onClick={() => { void validate(); }} loading={validating} disabled={validating || !(draft.credentials.endpoint ?? '').trim()}>
              {t('fork.wizard.tryServer')}
            </Button>
            {skipButton(draft.credentialsValidated && Boolean(saved.endpoint))}
          </div>
          {message && <StatusMessage variant={message.ok ? 'success' : message.hint ? 'warning' : 'error'}>{message.text}</StatusMessage>}
          {draft.credentialsPending && <StatusMessage variant="warning">{t('fork.wizard.pendingAddress')}</StatusMessage>}
        </>
      ) : (
        <StatusMessage variant="info">{t(start === 'share' ? 'fork.wizard.shareNotice' : 'fork.wizard.deviceNotice')}</StatusMessage>
      )}
    </section>
  );
};

export default StepKotomimi;
