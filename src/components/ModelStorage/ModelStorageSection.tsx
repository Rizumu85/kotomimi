/**
 * Fork: where the downloaded models are kept (`src/lib/native/modelStorage.ts`). The folder, what the models take
 * and the room left on its drive; another folder chosen, what moves and the room there, then the move as it goes.
 * Shown where this computer runs models of its own.
 */
import { useEffect, useRef } from 'react';
import { ArrowRight, CircleCheck, CircleHelp, FolderOpen, HardDrive, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Tooltip from '../Tooltip/Tooltip';
import { shortPath, sizeText, useModelStorageStore, type StorageDrive } from '../../lib/native/modelStorage';
import { useLanStore } from '../../stores/lanStore';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import './ModelStorageSection.scss';

/** Below this much room, the drive's remainder is said in the warning colour. */
const LOW_BYTES = 5 * 1024 ** 3;

/** A drive as a person names it: "D 盘", or the computer itself where it has no name to give. */
export function driveLabel(t: TFunction, drive: StorageDrive | undefined): string {
  const name = drive?.name?.replace(/:$/, '');
  return name ? t('fork.storage.drive', { name }) : t('fork.storage.thisComputer');
}

/** The drive, drawn: the models in the accent, the rest of what is used in grey, the room left empty. */
function DriveBar({ used, drive, low }: { used: number; drive: StorageDrive; low: boolean }) {
  if (!drive.totalBytes || drive.freeBytes === null) return null;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / drive.totalBytes!) * 100))}%`;
  return (
    <div className="kt-storage__bar" aria-hidden="true">
      <i className={low ? 'is-low' : ''} style={{ width: pct(drive.totalBytes - drive.freeBytes) }} />
      <i className="is-models" style={{ width: pct(used) }} />
    </div>
  );
}

const etaText = (t: TFunction, p: { copied: number; total: number; startedAt: number }): string => {
  const elapsed = (Date.now() - p.startedAt) / 1000;
  if (p.copied <= 0 || elapsed < 2) return '';
  const left = ((p.total - p.copied) / p.copied) * elapsed;
  return left < 60 ? t('fork.storage.etaSoon') : t('fork.storage.etaMinutes', { count: Math.round(left / 60) });
};

export function ModelStorageSection({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const { status, plan, progress, failed, freed, focus } = useModelStorageStore();
  const store = useModelStorageStore.getState;
  const sharing = useLanStore((s) => s.enabled);
  const engines = [useNativeEngineStore((s) => s.status), useNativeTranslatorStore((s) => s.status), useNativeCoachStore((s) => s.status)];
  const supported = engines.some((s) => s.supported);
  // What the models take changes with every download and delete: asked again as they settle.
  const settled = engines.map((s) => Object.values(s.models).map((m) => m.state).join()).join('|');
  useEffect(() => { void store().refresh(true); }, [settled, store]);
  useEffect(() => {
    const again = () => { void store().refresh(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [store]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) root.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [focus]);

  if (!status || status.fixed || !supported) return null;

  // Nothing moves under a running session or a device using this computer's models: their engines would stop.
  const blocked = disabled ? t('fork.storage.busySession') : sharing ? t('fork.storage.busySharing') : '';
  const here = driveLabel(t, status.drive);
  const low = status.drive.freeBytes !== null && status.drive.freeBytes < LOW_BYTES;
  const change = (label: string) => (
    <Tooltip content={blocked} position="top" suppressed={!blocked}>
      <button type="button" className="kt-storage__btn" onClick={() => { void store().choose(); }} disabled={Boolean(blocked)}>{label}</button>
    </Tooltip>
  );

  let body;
  if (progress) {
    const pct = progress.total > 0 ? Math.min(100, (progress.copied / progress.total) * 100) : 0;
    body = (
      <div className="kt-storage__move">
        <div className="kt-storage__route"><span>{here}</span><ArrowRight size={14} /><span className="is-to" title={plan?.target}>{plan?.target}</span></div>
        <div className="kt-storage__bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i className="is-models" style={{ width: `${pct}%` }} /></div>
        <div className="kt-storage__actions">
          <span className="kt-storage__grow">{t('fork.storage.moving', { done: sizeText(progress.copied), total: sizeText(progress.total) })}{etaText(t, progress) ? ` · ${etaText(t, progress)}` : ''}</span>
          <button type="button" className="kt-storage__btn" onClick={() => store().cancel()}>{t('fork.storage.cancel')}</button>
        </div>
      </div>
    );
  } else if (plan) {
    const there = driveLabel(t, plan.drive);
    const why = plan.error ? t(`fork.storage.errors.${plan.error}`, { drive: there }) : failed ? t(`fork.storage.errors.${failed}`, { drive: there }) : '';
    body = (
      <div className="kt-storage__move">
        <div className="kt-storage__route"><span>{here}</span><ArrowRight size={14} /><span className="is-to" title={plan.target}>{plan.target}</span></div>
        {!plan.sameDrive && (
          <div className="kt-storage__meter">
            <DriveBar used={plan.needBytes} drive={plan.drive} low={plan.error === 'no_space'} />
            <div className="kt-storage__legend">
              <span>{t('fork.storage.toMove')} <b>{sizeText(plan.needBytes)}</b></span>
              {plan.drive.freeBytes !== null && <span className={plan.error === 'no_space' ? 'is-warn' : ''}>{t('fork.storage.free', { drive: there, size: sizeText(plan.drive.freeBytes) })}</span>}
            </div>
          </div>
        )}
        {why && <p className="kt-storage__note is-warn" role="alert"><TriangleAlert size={14} />{why}</p>}
        <div className="kt-storage__actions">
          <button type="button" className="kt-storage__btn" onClick={() => store().dismiss()}>{t('fork.storage.cancel')}</button>
          {plan.error
            ? change(t('fork.storage.chooseAgain'))
            : <button type="button" className="kt-storage__btn is-primary" onClick={() => { void store().move(); }} disabled={Boolean(blocked)}>{t('fork.storage.move')}</button>}
        </div>
      </div>
    );
  } else if (status.missing) {
    body = (
      <>
        <div className="kt-storage__where is-warn"><span className="kt-storage__path" title={status.root}>{shortPath(status.root)}</span></div>
        <p className="kt-storage__note is-warn" role="alert"><TriangleAlert size={14} />{t('fork.storage.missing')}</p>
        <div className="kt-storage__actions">
          <button type="button" className="kt-storage__btn" onClick={() => { void store().reset(); }} disabled={Boolean(blocked)}>{t('fork.storage.useDefault')}</button>
          {change(t('fork.storage.chooseAgain'))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="kt-storage__where">
          <span className="kt-storage__path" title={status.root}>{shortPath(status.root)}</span>
          <button type="button" className="kt-storage__open" onClick={() => store().open()} aria-label={t('fork.storage.open')} title={t('fork.storage.open')}><FolderOpen size={14} /></button>
        </div>
        <div className="kt-storage__meter">
          <DriveBar used={status.usedBytes} drive={status.drive} low={low} />
          <div className="kt-storage__legend">
            <span>{t('fork.storage.models')} <b>{sizeText(status.usedBytes)}</b></span>
            {status.drive.freeBytes !== null && <span className={low ? 'is-warn' : ''}>{t('fork.storage.free', { drive: here, size: sizeText(status.drive.freeBytes) })}</span>}
          </div>
        </div>
        {failed === 'stopped' || failed === 'move_failed' || failed === 'copy_failed' || failed === 'downloading' || failed === 'busy'
          ? <p className="kt-storage__note is-warn" role="status"><TriangleAlert size={14} />{t(`fork.storage.errors.${failed}`)}</p>
          : freed && <p className="kt-storage__note" role="status"><CircleCheck size={14} />{t('fork.storage.freed', { drive: driveLabel(t, freed.drive), size: sizeText(freed.bytes) })}</p>}
      </>
    );
  }

  return (
    <div className="settings-section kt-stage kt-storage" ref={root}>
      <h2>
        <HardDrive size={15} className="kt-stage__icon" />
        {t('fork.storage.title')}
        <Tooltip content={t('fork.storage.tooltip')} position="top"><CircleHelp size={14} className="tooltip-trigger" style={{ marginLeft: 8 }} /></Tooltip>
        {!plan && !progress && !status.missing && <span className="kt-storage__head">{change(t('fork.storage.change'))}</span>}
      </h2>
      <div className="kt-storage__body">{body}</div>
    </div>
  );
}
