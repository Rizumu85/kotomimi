import { ChevronRight, Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AnyProvider } from '../../lib/provider/types';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSelectedProvider } from './useSelectedProvider';
import './ProviderPointer.scss';

/**
 * Fork: on the Advanced layout's General page, where the provider block used
 * to be drawn a second time. The same picker, key fields and stage rows on two
 * pages left a person asking which of the two counted. They are now on the
 * Provider page alone — where the tour and every deep link already lead — and
 * this page keeps one line: which provider is chosen, and a way there.
 * The Simple layout has no Provider page, and still draws the block itself.
 */
export function ProviderPointer({ providers }: { providers: readonly AnyProvider[] }) {
  const { t } = useTranslation();
  const selection = useSelectedProvider(providers);
  if (!selection) return null;
  const { provider } = selection;
  const name = t(`providers.${provider.i18nKey ?? provider.id}.name`, provider.id);
  return (
    <div className="config-section kt-provider-pointer">
      <h3>
        <Cpu size={18} />
        <span>{t('simpleSettings.provider')}</span>
      </h3>
      <button type="button" className="kt-provider-pointer__row" onClick={() => useSettingsStore.getState().navigateToSettings('provider')}>
        <span className="kt-provider-pointer__icon"><provider.icon size={20} /></span>
        <span className="kt-provider-pointer__text">
          <span className="kt-provider-pointer__name">{name}</span>
          <span className="kt-provider-pointer__hint">{t('fork.provider.pointer')}</span>
        </span>
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}
