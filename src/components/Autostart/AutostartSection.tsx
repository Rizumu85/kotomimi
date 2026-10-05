/**
 * Fork: starting with the computer, in the background — one switch, off
 * unless turned on, with what it does said under it. The main process keeps
 * the answer (`electron/autostart.js`): it is Windows' own list of what
 * starts at sign-in, not a setting of the app's. Shown only where it is
 * offered — an installed Windows app.
 */
import { useEffect, useState } from 'react';
import { Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import './AutostartSection.scss';

interface Autostart { supported: boolean; enabled: boolean }
const NONE: Autostart = { supported: false, enabled: false };

interface ElectronApi { invoke(channel: string, data?: unknown): Promise<unknown> }
const electron = (): ElectronApi | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { electron?: ElectronApi }).electron);

/** The main process's answer, held to its shape. Never rejects. */
export async function askAutostart(action: 'get' | 'set', enabled?: boolean): Promise<Autostart> {
  try {
    const answer = (await electron()?.invoke(`autostart:${action}`, action === 'set' ? { enabled } : undefined)) as Partial<Autostart> | null | undefined;
    return answer && typeof answer === 'object' ? { supported: answer.supported === true, enabled: answer.enabled === true } : NONE;
  } catch {
    return NONE;
  }
}

export function AutostartSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<Autostart>(NONE);
  useEffect(() => {
    let live = true;
    void askAutostart('get').then((answer) => { if (live) setState(answer); });
    return () => { live = false; };
  }, []);
  if (!state.supported) return null;
  return (
    <div className="config-section" id="autostart-section">
      <h3>
        <Power size={18} />
        <span>{t('fork.autostart.title')}</span>
      </h3>
      <ToggleSwitch checked={state.enabled} onChange={() => { void askAutostart('set', !state.enabled).then(setState); }} label={t('fork.autostart.toggle')} />
      <p className="kt-autostart__note">{t('fork.autostart.note')}</p>
    </div>
  );
}
