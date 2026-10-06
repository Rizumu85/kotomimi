import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SideMeIcon, SideOtherIcon } from '../Icons/SideIcons';
import type { DisplayMode } from '../../stores/settingsStore';
import './DisplayModeButton.scss';

export type DisplayScope = 'speaker' | 'participant';

interface DisplayModeButtonProps {
  scope: DisplayScope;
  value: DisplayMode;
  onChange: (next: DisplayMode) => void;
}

// One accidental click from the default lands on translation-only — still the
// thing the user came for — never on source-only, which reads as "translation
// stopped working". none is three clicks away and one click from recovery.
const CYCLE: Record<DisplayMode, DisplayMode> = {
  both: 'translation',
  translation: 'source',
  source: 'none',
  none: 'both',
};

const DisplayModeButton: React.FC<DisplayModeButtonProps> = ({ scope, value, onChange }) => {
  const { t } = useTranslation();

  const scopeLabel = t(
    scope === 'speaker' ? 'mainPanel.displayMode.speaker' : 'mainPanel.displayMode.participant',
    scope === 'speaker' ? 'Me' : 'Other'
  );
  const modeLabel = useMemo(() => {
    if (value === 'both') return t('mainPanel.displayMode.both', 'Both');
    if (value === 'source') return t('mainPanel.displayMode.source', 'Src');
    if (value === 'none') return t('mainPanel.displayMode.none', 'Off');
    return t('mainPanel.displayMode.translation', 'Trans');
  }, [value, t]);

  // The legend is assembled from per-mode keys rather than one enumerated
  // string, so a locale that has translated three modes does not keep showing
  // a three-line legend after the fourth mode lands.
  const title = [
    t('mainPanel.displayMode.title', '{{scope}} — click to change\nNow showing: {{mode}}', { scope: scopeLabel, mode: modeLabel }),
    '• ' + t('mainPanel.displayMode.legendSource', 'Src: only the original speech'),
    '• ' + t('mainPanel.displayMode.legendTranslation', 'Trans: only the translation'),
    '• ' + t('mainPanel.displayMode.legendBoth', 'Both: both lines'),
    '• ' + t('mainPanel.displayMode.legendNone', 'Off: hide this side'),
  ].join('\n');
  const ariaLabel = t(
    'mainPanel.displayMode.ariaLabel',
    '{{scope}}: {{mode}} — click to change',
    { scope: scopeLabel, mode: modeLabel },
  );

  const handleClick = useCallback(() => {
    onChange(CYCLE[value]);
  }, [onChange, value]);

  const Icon = scope === 'speaker' ? SideMeIcon : SideOtherIcon;

  return (
    <button
      type="button"
      className="display-mode-btn"
      data-scope={scope}
      data-mode={value}
      onClick={handleClick}
      title={title}
      aria-label={ariaLabel}
    >
      <Icon size={14} mode={value} />
      {/* Fork: whose side it is, in words: two buttons that both read "Both" — or one that reads "Off" — said nothing of which was which. */}
      <span className="display-mode-label">{scopeLabel} · {modeLabel}</span>
    </button>
  );
};

export default DisplayModeButton;
