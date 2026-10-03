/**
 * Fork: the fonts, in Settings. The app's own font; the font of Latin
 * letters and the romanization line; and, language by language, the font of
 * conversation text and of the readings above it. The languages of the
 * current pair are always listed, since those are the ones on screen; any
 * other can be added. Under each language a line of its script is drawn as a
 * conversation row would draw it — marked the same way, so the very rules
 * that reach the rows reach it — which is the preview.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { CircleHelp, Type, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { languageNameFor } from '../Settings/engine/languageName';
import Tooltip from '../Tooltip/Tooltip';
import { fontLanguage, scriptSample, TEXT_MARK } from '../../lib/fonts/fontCss';
import { useFontStore } from '../../stores/fontStore';
import { useProviderStore } from '../../stores/providerStore';
import { FontPicker } from './FontPicker';
import '../Annotated/AnnotatedText.scss';
import './Fonts.scss';

/** The languages offered for a font of their own, most likely first. */
const OFFERED = ['ja', 'zh', 'zh-tw', 'ko', 'en', 'ru', 'fr', 'de', 'es', 'pt', 'it', 'vi', 'th', 'ar', 'hi', 'id', 'tr', 'uk', 'pl', 'nl', 'el', 'he'];

/** Languages whose text gets readings above it: the ones a reading font means something for. */
const WITH_READINGS = new Set(['ja']);

/** A language of the pair as the fonts key it: its base, but Traditional Chinese, which is drawn in its own fonts. */
function keyOf(code: string | undefined): string {
  const tag = fontLanguage(code);
  if (!tag) return '';
  return tag === 'zh-tw' || tag === 'zh-hant' ? 'zh-tw' : tag.split('-')[0];
}

/** `ja` → 日本語 in the UI language; a tag with a region is shown with it. */
function nameOf(key: string): string {
  const [base, region] = key.split('-');
  return languageNameFor(region ? `${base}-${region.toUpperCase()}` : base);
}

interface Sample { parts: ReadonlyArray<string | readonly [string, string]>; roman?: string }

/** A sentence per script, with readings and a romanization where the app would add them. */
const SAMPLES: Readonly<Record<string, Sample>> = {
  ja: { parts: [['今日', 'きょう'], 'はいい', ['天気', 'てんき'], 'ですね。Kotomimi 2026'], roman: 'kyō wa ii tenki desu ne' },
  zh: { parts: ['今天天气真好，我们出去走走吧。Kotomimi 2026'] },
  'zh-tw': { parts: ['今天天氣真好，我們出去走走吧。Kotomimi 2026'] },
  ko: { parts: ['오늘 날씨가 참 좋네요. Kotomimi 2026'], roman: 'oneul nalssiga cham jonneyo' },
  ru: { parts: ['Сегодня хорошая погода. Kotomimi 2026'], roman: 'Segodnya khoroshaya pogoda' },
  uk: { parts: ['Сьогодні гарна погода. Kotomimi 2026'] },
  el: { parts: ['Σήμερα ο καιρός είναι καλός. Kotomimi 2026'] },
  ar: { parts: ['الطقس جميل اليوم. Kotomimi 2026'] },
  he: { parts: ['מזג האוויר יפה היום. Kotomimi 2026'] },
  th: { parts: ['วันนี้อากาศดีมาก Kotomimi 2026'] },
  hi: { parts: ['आज मौसम बहुत अच्छा है। Kotomimi 2026'] },
};
const LATIN_SAMPLE: Sample = { parts: ['The quick brown fox jumps over the lazy dog. 0123456789'] };

/** A sample line, in the markup of a conversation row with its reading aids. */
function Preview({ language }: { language: string }) {
  const sample = SAMPLES[language] ?? SAMPLES[language.split('-')[0]] ?? LATIN_SAMPLE;
  return (
    <div className="kt-fonts__preview" {...{ [TEXT_MARK]: '' }} lang={language}>
      <span className="annot">
        <span className="annot-line">
          <span className="annot-text">
            {sample.parts.map((part, i) => (typeof part === 'string' ? <span key={i}>{part}</span> : <ruby key={i}>{part[0]}<rt>{part[1]}</rt></ruby>))}
          </span>
          {sample.roman && <span className="annot-roman">{sample.roman}</span>}
        </span>
      </span>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="kt-fonts__row">
      <div className="kt-fonts__label">
        <span>{label}</span>
        {hint && <span className="kt-fonts__hint">{hint}</span>}
      </div>
      <div className="kt-fonts__control">{children}</div>
    </div>
  );
}

export function FontSection() {
  const { t } = useTranslation();
  const ui = useFontStore((s) => s.ui);
  const latin = useFontStore((s) => s.latin);
  const text = useFontStore((s) => s.text);
  const ruby = useFontStore((s) => s.ruby);
  const { setUi, setLatin, setText, setRuby, clearLanguage } = useFontStore.getState();
  // The pair on screen: its two languages are listed whether or not they have a font yet.
  const pair = useProviderStore((s) => (s.selected ? s.entries[s.selected]?.pair : undefined));
  const [added, setAdded] = useState<string[]>([]);

  const languages = useMemo(() => {
    const ordered = [keyOf(pair?.source), keyOf(pair?.target), ...Object.keys(text), ...Object.keys(ruby), ...added].filter(Boolean);
    return [...new Set(ordered)];
  }, [pair?.source, pair?.target, text, ruby, added]);
  const ofPair = new Set([keyOf(pair?.source), keyOf(pair?.target)]);
  const addable = OFFERED.filter((key) => !languages.includes(key));

  const remove = (language: string) => {
    clearLanguage(language);
    setAdded((list) => list.filter((key) => key !== language));
  };

  return (
    <div className="config-section kt-fonts" id="fonts-section">
      <h3>
        <Type size={18} />
        <span>{t('fork.fonts.title')}</span>
        <Tooltip content={t('fork.fonts.tooltip')} position="top">
          <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '4px' }} />
        </Tooltip>
      </h3>

      <Row label={t('fork.fonts.ui')} hint={t('fork.fonts.uiHint')}>
        <FontPicker value={ui} onChange={setUi} label={t('fork.fonts.ui')} sample="Ag" />
      </Row>
      <Row label={t('fork.fonts.latin')} hint={t('fork.fonts.latinHint')}>
        <FontPicker value={latin} onChange={setLatin} label={t('fork.fonts.latin')} sample="Ag" />
      </Row>

      <div className="kt-fonts__subhead">{t('fork.fonts.languages')}</div>
      {languages.map((language) => {
        const name = nameOf(language);
        const hasChoice = Boolean(text[language] || ruby[language]);
        return (
          <div className="kt-fonts__language" key={language}>
            <div className="kt-fonts__language-head">
              <span className="kt-fonts__language-name">{name}</span>
              {(hasChoice || !ofPair.has(language)) && (
                <button type="button" className="kt-fonts__remove" aria-label={t('fork.fonts.remove', { language: name })} title={t('fork.fonts.remove', { language: name })} onClick={() => remove(language)}>
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="kt-fonts__pickers">
              <label className="kt-fonts__picker">
                <span>{t('fork.fonts.text')}</span>
                <FontPicker value={text[language] ?? ''} onChange={(family) => setText(language, family)} label={`${name} · ${t('fork.fonts.text')}`} sample={scriptSample(language)} />
              </label>
              {WITH_READINGS.has(language.split('-')[0]) && (
                <label className="kt-fonts__picker">
                  <span>{t('fork.fonts.reading')}</span>
                  <FontPicker value={ruby[language] ?? ''} onChange={(family) => setRuby(language, family)} label={`${name} · ${t('fork.fonts.reading')}`} sample={scriptSample(language)} />
                </label>
              )}
            </div>
            <Preview language={language} />
          </div>
        );
      })}

      {addable.length > 0 && (
        <select
          className="select-dropdown kt-fonts__add"
          aria-label={t('fork.fonts.add')}
          value=""
          onChange={(e) => { if (e.target.value) setAdded((list) => [...list, e.target.value]); }}
        >
          <option value="">{t('fork.fonts.add')}</option>
          {addable.map((key) => <option key={key} value={key}>{nameOf(key)}</option>)}
        </select>
      )}
    </div>
  );
}
