/**
 * Fork: the head of the subtitle's display popover — the looks to start
 * from, and the three values a look sets that are then changed by hand: how
 * dark the panel is, how strong the shadow, and where the text sits
 * (`src/lib/subtitle/look.ts`). A look is a set of values written all at
 * once; nothing here is a mode.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LOOK_ORDER, LOOKS, shadowFor, type Align, type Look } from '../../lib/subtitle/look';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import './SubtitleLook.scss';

const NAMES: Readonly<Record<Look, [key: string, fallback: string]>> = {
  panel: ['fork.subtitle.lookPanel', 'Dark panel'],
  soft: ['fork.subtitle.lookSoft', 'Faint panel'],
  light: ['fork.subtitle.lookLight', 'Light text'],
  dark: ['fork.subtitle.lookDark', 'Dark text'],
};

/** A range that writes when it is let go: every step in between would be a write to disk. */
function Slider({ label, value, shown, onCommit }: { label: string; value: number; shown(value: number): string; onCommit(value: number): void }) {
  const id = useId();
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const commit = () => { if (local !== value) onCommit(local); };
  return (
    <div className="kt-look__slider">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={0} max={100} step={1} value={local} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
      <span className="kt-look__value">{shown(local)}</span>
    </div>
  );
}

export interface SubtitleLookProps {
  bgOpacity: number;
  /** Writes a look's whole set: the panel and the two text colours here, the rest in the look's own store. */
  onLook(look: Look): void;
  onBgOpacity(value: number): void;
}

export function SubtitleLook({ bgOpacity, onLook, onBgOpacity }: SubtitleLookProps) {
  const { t } = useTranslation();
  const look = useSubtitleLookStore((s) => s.look);
  const shadow = useSubtitleLookStore((s) => s.shadow);
  const align = useSubtitleLookStore((s) => s.align);
  const setShadow = useSubtitleLookStore((s) => s.setShadow);
  const setAlign = useSubtitleLookStore((s) => s.setAlign);
  const sides: Array<[Align, string]> = [['left', t('fork.subtitle.alignLeft', 'Left')], ['center', t('fork.subtitle.alignCenter', 'Centre')]];
  return (
    <div className="kt-look">
      <div className="kt-look__title" id="kt-look-title">{t('fork.subtitle.look', 'Look')}</div>
      <div className="kt-look__tiles" role="radiogroup" aria-labelledby="kt-look-title">
        {LOOK_ORDER.map((id) => {
          const preset = LOOKS[id];
          const name = t(NAMES[id][0], NAMES[id][1]);
          return (
            <button key={id} type="button" role="radio" aria-checked={look === id} className={`kt-look__tile${look === id ? ' is-picked' : ''}`} onClick={() => onLook(id)}>
              {/* Half dark, half light: what the look does over either. */}
              <span className="kt-look__scene" aria-hidden="true">
                <span
                  className="kt-look__sample"
                  style={{
                    color: preset.translationTextColor,
                    textShadow: shadowFor(preset.translationTextColor, preset.shadow, preset.edge),
                    background: preset.bgOpacity > 0 ? `rgba(0, 0, 0, ${preset.bgOpacity / 100})` : 'transparent',
                  }}
                >
                  {t('fork.subtitle.lookSample', 'Aa')}
                </span>
              </span>
              <span className="kt-look__name">{name}</span>
            </button>
          );
        })}
      </div>
      <Slider label={t('fork.subtitle.backdrop', 'Panel')} value={bgOpacity} shown={(value) => (value === 0 ? t('fork.subtitle.off', 'Off') : `${value}%`)} onCommit={onBgOpacity} />
      {/* Named for what the chosen look draws: a shadow under a panel, an outline with none. */}
      <Slider label={LOOKS[look].edge === 'outline' ? t('fork.subtitle.outline', 'Outline') : t('fork.subtitle.shadow', 'Shadow')} value={shadow} shown={(value) => (value === 0 ? t('fork.subtitle.off', 'Off') : `${value}%`)} onCommit={(value) => void setShadow(value)} />
      <div className="kt-look__slider">
        <span className="kt-look__label" id="kt-look-align">{t('fork.subtitle.align', 'Alignment')}</span>
        <div className="kt-look__sides" role="radiogroup" aria-labelledby="kt-look-align">
          {sides.map(([side, name]) => (
            <button key={side} type="button" role="radio" aria-checked={align === side} className={align === side ? 'is-picked' : ''} onClick={() => void setAlign(side)}>{name}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
