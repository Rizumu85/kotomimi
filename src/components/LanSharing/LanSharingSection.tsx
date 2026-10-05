/**
 * Fork: the settings of "share this computer's models on the local network".
 *
 * One idea holds the page together: this computer has models — the ones the
 * app downloaded, and the ones of a LocalAI installed here — its own stages
 * choose among them in their cards, and sharing lends the same models to the
 * other devices. So this section is one switch and, while it is on, what is
 * to be seen at a glance: that it is sharing and how many use it, the name
 * and address another device finds it by, and whatever stands in the way (a
 * firewall, a port that is taken, no recognizer to lend). What is lent, the
 * port and the access key are each one disclosure away; how sharing works is
 * behind the question mark, for whoever asks.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleHelp, Copy, GraduationCap, Languages, Loader, Mic, Share2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CustomModels } from '../CustomModels/CustomModels';
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
import { useLanStore, validLanPort, lanKeyOf } from '../../stores/lanStore';
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
  const coaches = shared.filter((m) => m.kind === 'feedback');
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
  const lentCount = recognizers.length + translators.length + coaches.length + theirs.recognizers.length + theirs.translators.length;
  // Looked, and nothing here hears: another device would find nothing to listen with.
  const deaf = initialized && recognizers.length === 0 && theirs.recognizers.length === 0;
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
              {/* What another device finds it by: its name in the search, and the address for a search that cannot reach it. */}
              {status.addresses.length > 0 ? (
                <div className="kt-lan__where">
                  {status.name && <span className="kt-lan__name">{status.name}</span>}
                  <Address value={`${status.addresses[0]}:${status.port}`} />
                </div>
              ) : <p className="kt-note">{t('fork.lan.noNetwork')}</p>}
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
            </>
          )}
          {deaf && (
            <div className="kt-lan__status kt-lan__status--error">
              <TriangleAlert size={14} />
              <span>{t('fork.lan.noRecognizer')}</span>
            </div>
          )}

          <details className="kt-details kt-lan__more">
            <summary>{t('fork.lan.models', { count: lentCount })}</summary>
            <div className="kt-lan__models">
              {recognizers.map((m) => <span key={m.id} className="kt-lan__model"><Mic size={12} />{nameOf(m.id)}</span>)}
              {translators.map((m) => <span key={m.id} className="kt-lan__model"><Languages size={12} />{nameOf(m.id)}</span>)}
              {coaches.map((m) => <span key={m.id} className="kt-lan__model"><GraduationCap size={12} />{nameOf(m.id)}</span>)}
              {theirs.recognizers.map((id) => <span key={`localai:${id}`} className="kt-lan__model kt-lan__model--theirs" title={t('fork.lan.fromLocalAI', { id })}><Mic size={12} />{modelLabel(id)}</span>)}
              {theirs.translators.map((id) => <span key={`localai:${id}`} className="kt-lan__model kt-lan__model--theirs" title={t('fork.lan.fromLocalAI', { id })}><Languages size={12} />{modelLabel(id)}</span>)}
            </div>
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
          </details>

          <details className="kt-details kt-lan__more">
            <summary>{t('fork.lan.options')}</summary>
            <div className="kt-lan__fields">
              <label className="kt-lan__field">
                <span>{t('fork.lan.port')}</span>
                <input type="text" inputMode="numeric" className="text-input" value={portText} onChange={(e) => setPortText(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={commitPort} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} disabled={disabled} />
              </label>
              <label className="kt-lan__field kt-lan__field--wide">
                <span>{t('fork.lan.key')}</span>
                <input type="text" className="text-input" value={keyText} onChange={(e) => setKeyText(lanKeyOf(e.target.value))} onBlur={() => { void useLanStore.getState().setKey(keyText); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder={t('fork.lan.keyPlaceholder')} spellCheck={false} disabled={disabled} />
              </label>
            </div>
            {/* A computer on several networks (a VPN, a virtual switch) has an address on each: the others, for a device on one of those. */}
            {status.state === 'on' && status.addresses.length > 1 && (
              <>
                <div className="kt-lan__label">{t('fork.lan.otherAddresses')}</div>
                {status.addresses.slice(1).map((address) => <Address key={address} value={`${address}:${status.port}`} />)}
              </>
            )}
            {firewall.state === 'unknown' && <p className="kt-note">{t('fork.lan.firewall')}</p>}
          </details>
        </div>
      )}
    </div>
  );
}
