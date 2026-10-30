/** Settings for lending this computer's native models over the local network. */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleHelp, Copy, GraduationCap, Languages, Loader, Mic, Share2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import Tooltip from '../Tooltip/Tooltip';
import { appLanModels } from '../../lib/lan/appModels';
import { useLanStore, validLanPort, lanKeyOf } from '../../stores/lanStore';
import { NativeEngineCard, nativeStoreOf, type NativeCardModel, type NativeKind } from '../../providers/openai/NativeEngineCard';
import { NATIVE_MODELS } from '../../providers/openai/localaiNative';
import { NATIVE_TRANSLATORS } from '../../providers/openai/nativeTranslators';
import { NATIVE_COACHES } from '../../providers/openai/nativeCoaches';
import './LanSharingSection.scss';

const LIBRARY: Record<NativeKind, readonly NativeCardModel[]> = { asr: NATIVE_MODELS, translation: NATIVE_TRANSLATORS, coach: NATIVE_COACHES };

/** Sharing lends every downloaded model; it does not change the local session's selection. */
function SharedLibrary({ kind, disabled }: { kind: NativeKind; disabled: boolean }) {
  const { t } = useTranslation();
  const status = nativeStoreOf(kind)((s) => s.status);
  const models = LIBRARY[kind].filter((m) => status.supported && status.models[m.id] && (!m.retired || status.models[m.id].state !== 'absent'));
  if (!models.length) return null;
  const label = kind === 'asr' ? 'hearStage' : kind === 'translation' ? 'translateStage' : 'coachStage';
  return <section><h3>{t(`providers.localai.${label}`)}</h3>{models.map((model) => <NativeEngineCard key={model.id} kind={kind} model={model} selected={false} disabled={disabled} />)}</section>;
}


const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;

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

export function LanSharingSection({ disabled = false }: { disabled?: boolean }) {
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
  useEffect(() => setPortText(String(port)), [port]);
  useEffect(() => setKeyText(key), [key]);

  const asr = nativeStoreOf('asr')((s) => s.status);
  const translation = nativeStoreOf('translation')((s) => s.status);
  const coach = nativeStoreOf('coach')((s) => s.status);
  const asked = nativeStoreOf('asr')((s) => s.asked);
  const shared = useMemo(() => (enabled ? appLanModels.shared() : []), [enabled, asr, translation, coach]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (id: string) => Object.values(LIBRARY).flat().find((m) => m.id === id)?.name ?? id;
  const recognizers = shared.filter((m) => m.kind === 'asr');
  const translators = shared.filter((m) => m.kind === 'translate');
  const coaches = shared.filter((m) => m.kind === 'feedback');
  const lentCount = recognizers.length + translators.length + coaches.length;
  // Looked, and nothing here hears: another device would find nothing to listen with.
  const deaf = asked && recognizers.length === 0;

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
            </div>
            <button type="button" className="kt-lan__link" aria-expanded={managing} onClick={() => setManaging(!managing)}>
              {managing ? t('fork.lan.hideLibrary') : t('fork.lan.showLibrary')}
            </button>
            {managing && (
              <div className="kt-lan__library">
                {(['asr', 'translation', 'coach'] as const).map((kind) => <SharedLibrary key={kind} kind={kind} disabled={disabled} />)}
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
