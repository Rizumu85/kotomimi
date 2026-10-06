import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import {
  useSubtitleBgOpacity,
  useSubtitleBgColor,
  useSubtitleSourceTextColor,
  useSubtitleTranslationTextColor,
  useSubtitleNewItemHighlightEnabled,
  useSetSubtitleBgOpacity,
  useSetSubtitleBgColor,
  useSetSubtitleSourceTextColor,
  useSetSubtitleTranslationTextColor,
  useSetSubtitleNewItemHighlightEnabled,
  SUBTITLE_DEFAULT_BG_COLOR,
  SUBTITLE_DEFAULT_SOURCE_TEXT_COLOR,
  SUBTITLE_DEFAULT_TRANSLATION_TEXT_COLOR,
} from '../../stores/subtitleStore';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import ColorPicker from './ColorPicker';
import {
  useConversationDisplayBgColor,
  useConversationDisplaySourceTextColor,
  useConversationDisplayTranslationTextColor,
  useSetConversationDisplayBgColor,
  useSetConversationDisplaySourceTextColor,
  useSetConversationDisplayTranslationTextColor,
  CONVERSATION_DISPLAY_DEFAULT_BG_COLOR,
  CONVERSATION_DISPLAY_DEFAULT_SOURCE_TEXT_COLOR,
  CONVERSATION_DISPLAY_DEFAULT_TRANSLATION_TEXT_COLOR,
} from '../../stores/conversationDisplayStore';
import { ReadingAidToggles } from '../Annotated/ReadingAidToggles';
import { LOOKS, type Look } from '../../lib/subtitle/look';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import { SubtitleLook } from './SubtitleLook';
import './DisplaySettingsPopover.scss';

const BG_PRESETS = ['#000000', '#1a1a1a', '#0d2032', '#0f2419', '#FFFFFF', '#2a2a2a'];
const SOURCE_PRESETS = [
  '#FFFFFF', '#E8E8E8', '#FFD27D', '#FFAA66', '#9aa0a6', '#FF6B6B',
  '#000000', '#003B6F', '#1B5E20',
];
const TRANSLATION_PRESETS = [
  '#6CC5FF', '#10a37f', '#FFFFFF', '#A8E6CF', '#FFB86C', '#BD93F9',
  '#000000', '#003B6F', '#7B1FA2',
];

const PICKER_DEBOUNCE_MS = 150;

type Source = 'subtitle' | 'conversation';

export interface DisplaySettingsPopoverProps {
  source: Source;
}

interface InnerBindings {
  bgOpacity: number | undefined;
  bgColor: string;
  sourceTextColor: string;
  translationTextColor: string;
  // newItemHighlightEnabled is subtitle-only. Conversation-mode bindings
  // leave it undefined so the toggle row is suppressed.
  newItemHighlightEnabled: boolean | undefined;
  setBgOpacity: ((n: number) => Promise<void>) | undefined;
  setBgColor: (s: string) => Promise<void>;
  setSourceTextColor: (s: string) => Promise<void>;
  setTranslationTextColor: (s: string) => Promise<void>;
  setNewItemHighlightEnabled: ((b: boolean) => Promise<void>) | undefined;
  defaultBgColor: string;
  defaultSourceTextColor: string;
  defaultTranslationTextColor: string;
}

const DisplaySettingsPopover: React.FC<DisplaySettingsPopoverProps> = ({ source }) =>
  source === 'subtitle' ? <SubtitleBoundPopover /> : <ConversationBoundPopover />;

export default DisplaySettingsPopover;

// ──────────── Source-bound wrappers ────────────
// Each wrapper subscribes ONLY to its own store. This keeps the rules
// of hooks satisfied: hooks are always called in the same order within
// a given wrapper component.

const SubtitleBoundPopover: React.FC = () => {
  const bindings: InnerBindings = {
    bgOpacity: useSubtitleBgOpacity(),
    bgColor: useSubtitleBgColor(),
    sourceTextColor: useSubtitleSourceTextColor(),
    translationTextColor: useSubtitleTranslationTextColor(),
    newItemHighlightEnabled: useSubtitleNewItemHighlightEnabled(),
    setBgOpacity: useSetSubtitleBgOpacity(),
    setBgColor: useSetSubtitleBgColor(),
    setSourceTextColor: useSetSubtitleSourceTextColor(),
    setTranslationTextColor: useSetSubtitleTranslationTextColor(),
    setNewItemHighlightEnabled: useSetSubtitleNewItemHighlightEnabled(),
    defaultBgColor: SUBTITLE_DEFAULT_BG_COLOR,
    defaultSourceTextColor: SUBTITLE_DEFAULT_SOURCE_TEXT_COLOR,
    defaultTranslationTextColor: SUBTITLE_DEFAULT_TRANSLATION_TEXT_COLOR,
  };
  return <DisplaySettingsPopoverInner bindings={bindings} />;
};

const ConversationBoundPopover: React.FC = () => {
  const bindings: InnerBindings = {
    bgOpacity: undefined,
    bgColor: useConversationDisplayBgColor(),
    sourceTextColor: useConversationDisplaySourceTextColor(),
    translationTextColor: useConversationDisplayTranslationTextColor(),
    newItemHighlightEnabled: undefined,
    setBgOpacity: undefined,
    setBgColor: useSetConversationDisplayBgColor(),
    setSourceTextColor: useSetConversationDisplaySourceTextColor(),
    setTranslationTextColor: useSetConversationDisplayTranslationTextColor(),
    setNewItemHighlightEnabled: undefined,
    defaultBgColor: CONVERSATION_DISPLAY_DEFAULT_BG_COLOR,
    defaultSourceTextColor: CONVERSATION_DISPLAY_DEFAULT_SOURCE_TEXT_COLOR,
    defaultTranslationTextColor: CONVERSATION_DISPLAY_DEFAULT_TRANSLATION_TEXT_COLOR,
  };
  return <DisplaySettingsPopoverInner bindings={bindings} />;
};

// ──────────── Pure presentational inner ────────────

const DisplaySettingsPopoverInner: React.FC<{ bindings: InnerBindings }> = ({ bindings }) => {
  const { t } = useTranslation();
  const includeOpacity =
    bindings.bgOpacity !== undefined && bindings.setBgOpacity !== undefined;
  const includeHighlightToggle =
    bindings.newItemHighlightEnabled !== undefined &&
    bindings.setNewItemHighlightEnabled !== undefined;

  // Which row (if any) has its custom picker expanded. Held here rather than
  // per-row so opening one collapses the others — three stacked pickers would
  // make the popover taller than most of the surfaces it floats over.
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const togglePicker = useCallback(
    (key: string) => setOpenPicker((cur) => (cur === key ? null : key)),
    [],
  );

  // Note: role="dialog" + accessible name are intentionally NOT set on this
  // root. They live on the floating wrapper in SubtitleBar / MainPanel via
  // @floating-ui/react's useRole, which also wires aria-haspopup / aria-
  // expanded / aria-controls on the trigger. Keeping the role on a single
  // level avoids duplicate dialog announcements.
  // Fork: the subtitle's popover opens on its looks (`SubtitleLook`); the colour most often changed stays in sight
  // under them, and the other two fold away. The panel's popover, which has no looks, is as upstream drew it.
  const [moreColors, setMoreColors] = useState(false);
  const applyLook = useCallback((look: Look) => {
    const preset = LOOKS[look];
    const store = useSubtitleLookStore.getState();
    void store.setLook(look);
    void store.setShadow(preset.shadow);
    void store.setAlign(preset.align);
    void bindings.setBgOpacity?.(preset.bgOpacity);
    void bindings.setBgColor(preset.bgColor);
    void bindings.setSourceTextColor(preset.sourceTextColor);
    void bindings.setTranslationTextColor(preset.translationTextColor);
  }, [bindings]);
  const bgRow = (
    <ColorRow
      labelKey="subtitle.settings.bgColor"
      labelDefault="Display background"
      defaultColor={bindings.defaultBgColor}
      presets={BG_PRESETS}
      value={bindings.bgColor}
      onChange={bindings.setBgColor}
      pickerOpen={openPicker === 'bg'}
      onTogglePicker={() => togglePicker('bg')}
    />
  );
  const sourceRow = (
    <ColorRow
      labelKey="subtitle.settings.sourceColor"
      labelDefault="Source text"
      defaultColor={bindings.defaultSourceTextColor}
      presets={SOURCE_PRESETS}
      value={bindings.sourceTextColor}
      onChange={bindings.setSourceTextColor}
      pickerOpen={openPicker === 'source'}
      onTogglePicker={() => togglePicker('source')}
    />
  );
  const translationRow = (
    <ColorRow
      labelKey="subtitle.settings.translationColor"
      labelDefault="Translation text"
      defaultColor={bindings.defaultTranslationTextColor}
      presets={TRANSLATION_PRESETS}
      value={bindings.translationTextColor}
      onChange={bindings.setTranslationTextColor}
      pickerOpen={openPicker === 'translation'}
      onTogglePicker={() => togglePicker('translation')}
    />
  );

  return (
    <div className="display-settings-popover">
      {includeOpacity ? (
        <>
          <SubtitleLook bgOpacity={bindings.bgOpacity!} onLook={applyLook} onBgOpacity={(value) => void bindings.setBgOpacity!(value)} />
          {translationRow}
          <div className="kt-more-colors">
            <button type="button" aria-expanded={moreColors} onClick={() => setMoreColors((open) => !open)}>
              <span>{t('fork.subtitle.moreColors', 'More colours (source text, panel)')}</span>
              {moreColors ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {moreColors && <div className="kt-more-colors__body">{sourceRow}{bgRow}</div>}
          </div>
        </>
      ) : (
        <>
          {bgRow}
          {sourceRow}
          {translationRow}
        </>
      )}
      {includeHighlightToggle && (
        <div className="field">
          <ToggleSwitch
            checked={bindings.newItemHighlightEnabled!}
            onChange={() =>
              void bindings.setNewItemHighlightEnabled!(
                !bindings.newItemHighlightEnabled,
              )
            }
            label={t(
              'subtitle.settings.newItemHighlight',
              'Highlight newly-arrived text',
            )}
          />
        </div>
      )}
      {/* Fork: furigana and romanization, the same pair on every surface. */}
      <ReadingAidToggles />
    </div>
  );
};

// ──────────── Reusable row with presets + custom chip ────────────

interface ColorRowProps {
  labelKey: string;
  labelDefault: string;
  defaultColor: string;
  presets: readonly string[];
  value: string;
  onChange: (s: string) => Promise<void>;
  /** Whether this row's free-choice picker is expanded. */
  pickerOpen: boolean;
  onTogglePicker: () => void;
}

const ColorRow: React.FC<ColorRowProps> = ({
  labelKey,
  labelDefault,
  defaultColor,
  presets,
  value,
  onChange,
  pickerOpen,
  onTogglePicker,
}) => {
  const { t } = useTranslation();
  const valueLower = value.toLowerCase();

  // First chip is always this surface's default. Drop any duplicate of the
  // default that appears later in the shared preset list.
  const orderedPresets = useMemo(() => {
    const defaultLower = defaultColor.toLowerCase();
    const rest = presets.filter((p) => p.toLowerCase() !== defaultLower);
    return [defaultColor, ...rest] as const;
  }, [defaultColor, presets]);

  const isCustom = !orderedPresets.some((p) => p.toLowerCase() === valueLower);

  // Debounce the high-frequency change events emitted while the user
  // drags inside the picker.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingPickerWrite = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }, []);
  const onPickerChange = useCallback(
    (next: string) => {
      cancelPendingPickerWrite();
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        onChange(next);
      }, PICKER_DEBOUNCE_MS);
    },
    [onChange, cancelPendingPickerWrite],
  );
  useEffect(() => cancelPendingPickerWrite, [cancelPendingPickerWrite]);

  // A preset must supersede a picker write that is still in flight. The picker
  // is inline now, so both controls are on screen together and "drag, then
  // click a preset" is an ordinary sequence — without this the debounce fires
  // afterwards and silently reverts the preset.
  const onPresetClick = useCallback(
    (c: string) => {
      cancelPendingPickerWrite();
      onChange(c);
    },
    [onChange, cancelPendingPickerWrite],
  );

  return (
    <div className="field">
      <label>{t(labelKey, labelDefault)}</label>
      <div className="palette">
        {orderedPresets.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            className={`swatch ${valueLower === c.toLowerCase() ? 'selected' : ''}`}
            style={{ background: c }}
            onClick={() => onPresetClick(c)}
          />
        ))}
        <button
          type="button"
          className={`swatch custom ${isCustom ? 'selected' : ''}`}
          style={{ background: value }}
          title={t('subtitle.settings.customColor', 'Custom color')}
          aria-label={t('subtitle.settings.customColor', 'Custom color')}
          aria-expanded={pickerOpen}
          onClick={onTogglePicker}
        >
          <Plus size={10} />
        </button>
      </div>
      {pickerOpen && <ColorPicker value={value} onChange={onPickerChange} />}
    </div>
  );
};
