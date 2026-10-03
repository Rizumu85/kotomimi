import type { ReactNode } from 'react';
import { Languages, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ServerFinder } from '../../components/LanSharing/ServerFinder';
import type { CredentialAssistProps } from '../../lib/provider/types';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { AsrVia, LocalAISettings, TranslateVia } from './localai';
import { needsServer, translateViaOf } from './localaiDevice';
import './LocalAIAssist.scss';

/** One stage and the places it can run: a row of the settings' own segmented buttons. */
function StageRow<T extends string>({ icon, label, value, options, onChange, disabled }: { icon: ReactNode; label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange(value: T): void; disabled?: boolean }) {
  return (
    <div className="kt-places__row">
      <span className="kt-places__stage">{icon}{label}</span>
      <div className="segmented-control" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" className={`segmented-option ${option.value === value ? 'active' : ''}`.trim()} aria-pressed={option.value === value} onClick={() => { if (option.value !== value) onChange(option.value); }} disabled={disabled}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Fork: under the provider, where each stage runs — recognition and
 * translation each on its own row, with the same three places: another
 * device, an API, this computer. Two rows, so it reads as two choices to mix
 * and not as one switch; and the one spot these are chosen in — the
 * provider's own page says where each runs and holds what that place needs,
 * but asks nothing a second time.
 *
 * Then, while a stage is on another device, the devices the app found on the
 * local network (`ServerFinder`): a click fills the address, and says whether
 * that device asks for a key so the key's field shows. It searches by itself
 * only while no address is set: a settings panel opened for something else
 * asks the network nothing.
 */
export function LocalAIAssist({ settings, values, fill, update, disabled }: CredentialAssistProps<LocalAISettings>) {
  const { t } = useTranslation();
  const other = t('providers.localai.placeServer');
  const api = t('providers.localai.viaModel');
  const here = t('providers.localai.placeDevice');
  const via = translateViaOf(settings);
  const hearOptions: ReadonlyArray<{ value: AsrVia; label: string }> = [{ value: 'server', label: other }, { value: 'api', label: api }, { value: 'device', label: here }];
  const translateOptions: ReadonlyArray<{ value: TranslateVia; label: string }> = [
    // Only what hears on the other device has a session there for its pipeline to answer in.
    ...(settings.asrVia === 'server' ? [{ value: 'server' as const, label: other }] : []),
    { value: 'model', label: api },
    { value: 'device', label: here },
  ];
  const asrTodo = settings.asrVia === 'api' && (!settings.asrApiBaseUrl.trim() || !settings.asrApiModel.trim());
  const translateTodo = via === 'model' && !settings.translateModel.trim();
  return (
    <>
      <div className="credential-choice-group kt-places">
        <span className="kt-places__hint">{t('providers.localai.mixHint')}</span>
        <StageRow icon={<Mic size={13} />} label={t('providers.localai.hearStage')} value={settings.asrVia} options={hearOptions} onChange={(asrVia) => update({ asrVia })} disabled={disabled} />
        <StageRow icon={<Languages size={13} />} label={t('providers.localai.translateStage')} value={via} options={translateOptions} onChange={(translateVia) => update({ translateVia })} disabled={disabled} />
        {asrTodo && <span className="kt-places__todo">{t('providers.localai.asrTodo')}</span>}
        {translateTodo && <span className="kt-places__todo">{t('providers.localai.modelTodo')}</span>}
      </div>
      {needsServer(settings) && (
        <ServerFinder
          value={values.endpoint ?? ''}
          auto={!(values.endpoint ?? '').trim()}
          disabled={disabled}
          onPick={(server) => {
            if (server.needsKey !== settings.serverNeedsKey) update({ serverNeedsKey: server.needsKey });
            fill('endpoint', server.address);
          }}
        />
      )}
    </>
  );
}
