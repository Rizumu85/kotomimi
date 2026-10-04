/**
 * Fork: the settings of "share this computer's models on the local network".
 * One switch; and while it is on, what another device needs to use it — the
 * address to type, with a button that copies it — and what it will find: the
 * models this computer has ready. The port and the access key sit behind
 * "Options", since most never touch them. Model management is here too: a
 * computer that only shares has no stage of its own to hang it on. And it
 * says which side's settings count — the other device chooses the languages
 * and the model; this one only what there is to choose from — so nobody has
 * to wonder which screen is the one to set. Below it, where one is installed,
 * the LocalAI of this computer (`LocalServerCard`): its models are shared
 * through the same switch (`electron/lan-upstream.js`), and are listed here
 * beside the app's own.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleHelp, Copy, Languages, Loader, Mic, Share2, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CustomModels } from '../CustomModels/CustomModels';
import { LocalServerCard } from './LocalServerCard';
import { languageNameFor } from '../Settings/engine/languageName';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import { ModelManagementSection } from '../Settings/sections/ModelManagementSection';
import Tooltip from '../Tooltip/Tooltip';
import { appLanModels } from '../../lib/lan/appModels';
import { askLocalPipelines, NO_PIPELINES, type LocalPipelines } from '../../lib/lan/localServer';
import { modelLabel } from '../../lib/lan/modelLabel';
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import type { LanguagePair } from '../../lib/provider/types';
import { LOCAL_INFERENCE_DEFAULTS } from '../../providers/localInference/settings';
import { useLanStore, validLanPort } from '../../stores/lanStore';
import { useLocalServerStore } from '../../stores/localServerStore';
import { useModelStatuses, useModelStore } from '../../stores/modelStore';
import './LanSharingSection.scss';

const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;
const FALLBACK_PAIR: LanguagePair = { source: 'ja', target: 'en' };
const noUpdate = () => {};

/** An address, and a button that copies it and says so for a moment. */
function Address({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="kt-lan__address">
      <code>{value}</code>
      <button type="button" className="kt-lan__copy" aria-label={t('fork.lan.copy')} onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true), () => {}); }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t('fork.lan.copied') : t('fork.lan.copy')}</span>
      </button>
    </div>
  );
}

export function LanSharingSection({ disabled = false, pair = FALLBACK_PAIR }: { disabled?: boolean; pair?: LanguagePair }) {
  const { t } = useTranslation();
  const enabled = useLanStore((s) => s.enabled);
  const status = useLanStore((s) => s.status);
  const clients = useLanStore((s) => s.clients);
  const port = useLanStore((s) => s.port);
  const key = useLanStore((s) => s.key);
  const firewall = useLanStore((s) => s.firewall);
  const firewallBusy = useLanStore((s) => s.firewallBusy);
  const firewallDeclined = useLanStore((s) => s.firewallDeclined);
  const [portText, setPortText] = useState(String(port));
  const [keyText, setKeyText] = useState(key);
  const [managing, setManaging] = useState(false);
  // The library lists the models of one direction: the other device may ask for either of the pair's.
  const [reversed, setReversed] = useState(false);
  useEffect(() => setPortText(String(port)), [port]);
  useEffect(() => setKeyText(key), [key]);

  // What is downloaded decides what is shared: read again when a download finishes.
  const statuses = useModelStatuses();
  const initialized = useModelStore((s) => s.initialized);
  const shared = useMemo(() => (enabled ? appLanModels.shared() : []), [enabled, statuses, initialized]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (id: string) => {
    const entry = getManifestEntry(id);
    return entry ? shortenModelName(entry.name, entry.shortName) : id;
  };
  const recognizers = shared.filter((m) => m.kind === 'asr');
  const translators = shared.filter((m) => m.kind === 'translate');
  // The LocalAI of this computer, while it is up: its models go out through the same door.
  const localUp = useLocalServerStore((s) => s.status.state === 'running' || s.status.state === 'external');
  const localModels = useLocalServerStore((s) => s.status.models.length);
  const [theirs, setTheirs] = useState<LocalPipelines>(NO_PIPELINES);
  useEffect(() => {
    if (!enabled || !localUp) {
      setTheirs(NO_PIPELINES);
      return undefined;
    }
    let live = true;
    void askLocalPipelines().then((found) => { if (live) setTheirs(found); });
    return () => { live = false; };
  }, [enabled, localUp, localModels]);
  const lent = theirs.recognizers.length + theirs.translators.length;
  // The library's own pair: the catalog's base codes, in the direction chosen.
  const libraryPair = useMemo(() => {
    const source = pair.source.split('-')[0];
    const target = pair.target.split('-')[0];
    return reversed ? { source: target, target: source } : { source, target };
  }, [pair.source, pair.target, reversed]);
  const directions = [false, true].map((back) => ({ back, label: back ? `${languageNameFor(pair.target)} → ${languageNameFor(pair.source)}` : `${languageNameFor(pair.source)} → ${languageNameFor(pair.target)}` }));

  const commitPort = () => {
    const next = Number(portText);
    if (validLanPort(next)) void useLanStore.getState().setPort(next);
    else setPortText(String(port));
  };

  return (
    <div className="settings-section kt-stage kt-lan">
      <h2>
        <Share2 size={15} className="kt-stage__icon" />
        {t('fork.lan.title')}
        <Tooltip content={t('fork.lan.tooltip')} position="top">{helpIcon}</Tooltip>
      </h2>
      <p className="kt-note kt-lan__intro">{t('fork.lan.intro')}</p>
      <ToggleSwitch checked={enabled} onChange={() => { void useLanStore.getState().setEnabled(!enabled); }} label={t('fork.lan.enable')} disabled={disabled} />

      {enabled && (
        <div className="kt-lan__card">
          {status.state === 'starting' && (
            <div className="kt-lan__status"><Loader size={14} className="kt-lan__spin" /><span>{t('fork.lan.starting')}</span></div>
          )}
          {status.state === 'error' && (
            <div className="kt-lan__status kt-lan__status--error">
              <TriangleAlert size={14} />
              <span>{status.code === 'EADDRINUSE' ? t('fork.lan.portInUse', { port }) : t('fork.lan.failed', { message: status.message })}</span>
            </div>
          )}
          {status.state === 'on' && (
            <>
              <div className="kt-lan__status kt-lan__status--on">
                <span className="kt-lan__dot" aria-hidden />
                <span>{clients > 0 ? t('fork.lan.onWithClients', { count: clients }) : t('fork.lan.on')}</span>
              </div>
              <p className="kt-lan__found">{status.name ? t('fork.lan.foundAs', { name: status.name }) : t('fork.lan.foundAsUnnamed')}</p>
              <div className="kt-lan__label">{t('fork.lan.address')}</div>
              {status.addresses.length > 0
                ? status.addresses.map((address) => <Address key={address} value={`${address}:${status.port}`} />)
                : <p className="kt-note">{t('fork.lan.noNetwork')}</p>}
              {firewall.state === 'blocked' && (
                <div className="kt-lan__firewall" role="status">
                  <ShieldAlert size={16} aria-hidden />
                  <div className="kt-lan__firewall-text">
                    <strong>{t('fork.lan.firewallBlocked')}</strong>
                    <span>{firewall.public ? t('fork.lan.firewallPublic') : t('fork.lan.firewallPrivate')}</span>
                    {firewallDeclined && !firewallBusy && <span className="kt-lan__firewall-declined">{t('fork.lan.firewallDeclined')}</span>}
                    <button type="button" className="kt-lan__allow" disabled={firewallBusy} onClick={() => { void useLanStore.getState().allowFirewall(); }}>
                      {firewallBusy && <Loader size={13} className="kt-lan__spin" />}
                      {firewallBusy ? t('fork.lan.firewallWaiting') : t('fork.lan.firewallAllow')}
                    </button>
                  </div>
                </div>
              )}
              {firewall.state === 'allowed' && (
                <div className="kt-lan__firewall-ok"><ShieldCheck size={13} aria-hidden /><span>{t('fork.lan.firewallOk')}</span></div>
              )}
            </>
          )}

          <div className="kt-lan__label">{t('fork.lan.models')}</div>
          <div className="kt-lan__models">
            {recognizers.map((m) => <span key={m.id} className="kt-lan__model"><Mic size={12} />{nameOf(m.id)}</span>)}
            {translators.map((m) => <span key={m.id} className="kt-lan__model"><Languages size={12} />{nameOf(m.id)}</span>)}
            {theirs.recognizers.map((id) => <span key={`localai:${id}`} className="kt-lan__model kt-lan__model--theirs" title={id}><Mic size={12} />{modelLabel(id)}</span>)}
            {theirs.translators.map((id) => <span key={`localai:${id}`} className="kt-lan__model kt-lan__model--theirs" title={id}><Languages size={12} />{modelLabel(id)}</span>)}
            {/* Missing only once the model store has looked: before, nothing is known to be downloaded, which is not the same. */}
            {initialized && recognizers.length === 0 && theirs.recognizers.length === 0 && <span className="kt-lan__model kt-lan__model--missing"><TriangleAlert size={12} />{t('fork.lan.noRecognizer')}</span>}
          </div>
          {lent > 0 && <p className="kt-note kt-lan__lent">{t('fork.lan.localaiToo')}</p>}
          <button type="button" className="kt-lan__link" aria-expanded={managing} onClick={() => setManaging(!managing)}>
            {managing ? t('fork.lan.hideLibrary') : t('fork.lan.showLibrary')}
          </button>
          {managing && (
            <div className="kt-lan__library">
              <div className="setting-item">
                <div className="turn-detection-options" role="group" aria-label={t('fork.lan.direction')}>
                  {directions.map(({ back, label }) => (
                    <button key={String(back)} type="button" className={`option-button ${back === reversed ? 'active' : ''}`} aria-pressed={back === reversed} onClick={() => setReversed(back)}>{label}</button>
                  ))}
                </div>
              </div>
              <CustomModels disabled={disabled} />
              <ModelManagementSection isSessionActive={disabled} stageFilter="asr" direction={`${libraryPair.source}→${libraryPair.target}`} settings={LOCAL_INFERENCE_DEFAULTS} update={noUpdate} pair={libraryPair} />
              <ModelManagementSection isSessionActive={disabled} stageFilter="translation" direction={`${libraryPair.source}→${libraryPair.target}`} settings={LOCAL_INFERENCE_DEFAULTS} update={noUpdate} pair={libraryPair} />
            </div>
          )}

          <div className="kt-lan__rules">
            <div className="kt-lan__label">{t('fork.lan.rulesTitle')}</div>
            <ul>
              <li>{t('fork.lan.rulesTheirs')}</li>
              <li>{t('fork.lan.rulesHere')}</li>
              <li>{t('fork.lan.rulesIdle')}</li>
            </ul>
          </div>

          <details className="kt-details kt-lan__options">
            <summary>{t('fork.lan.options')}</summary>
            <div className="kt-lan__fields">
              <label className="kt-lan__field">
                <span>{t('fork.lan.port')}</span>
                <input type="text" inputMode="numeric" className="text-input" value={portText} onChange={(e) => setPortText(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={commitPort} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} disabled={disabled} />
              </label>
              <label className="kt-lan__field kt-lan__field--wide">
                <span>{t('fork.lan.key')}</span>
                <input type="text" className="text-input" value={keyText} onChange={(e) => setKeyText(e.target.value)} onBlur={() => { void useLanStore.getState().setKey(keyText); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder={t('fork.lan.keyPlaceholder')} spellCheck={false} disabled={disabled} />
              </label>
            </div>
            {firewall.state === 'unknown' && <p className="kt-note">{t('fork.lan.firewall')}</p>}
          </details>
        </div>
      )}

      <LocalServerCard disabled={disabled} />
    </div>
  );
}
