import { ChevronRight, Mic, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Hearer, LanguageOption } from '../../lib/provider/types';
import { useLanguageMenu } from './LanguageMenu';
import './LanguageHearing.scss';

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];
/** "Any language", among a side's languages (`MoreLanguages.chosen`). */
export const ANY_LANGUAGE = 'auto';

/**
 * Fork: the languages a row may add — those in the provider's list that what hears can tell apart (`offered`, by base
 * code; null: every one), less the ones it leaves out (the user's own, a side's main one) — one to a language, its
 * plain code where the list has it.
 */
export function offeredLanguages(ordered: readonly LanguageOption[], leaveOut: readonly string[], offered: readonly string[] | null): string[] {
  const out = new Set(leaveOut.map(baseOf));
  const seen = new Map<string, string>();
  for (const { value } of ordered) {
    const base = baseOf(value);
    if (!base || base === ANY_LANGUAGE || out.has(base) || (offered && !offered.some((code) => baseOf(code) === base))) continue;
    const had = seen.get(base);
    if (had === undefined || (baseOf(had) !== had && value === base)) seen.set(base, value);
  }
  return [...seen.values()];
}

/** Fork: one side's languages beside its main one, as the section is handed them (`MoreLanguages`, its `set` bound). */
export interface SideLanguages {
  hearer?: Hearer;
  chosen: readonly string[];
  offered: readonly string[] | null;
  most: number | null;
  any: boolean;
  set(chosen: string[]): void;
}

function HearerButton({ hearer, onOpen }: { hearer: Hearer; onOpen?(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="language-hearing__hearer" onClick={onOpen} title={t('fork.languageMenu.hearingBy', { name: hearer.name })} aria-label={t('fork.languageMenu.hearingBy', { name: hearer.name })}>
      <Mic size={13} aria-hidden />
      <span>{hearer.name}</span>
      <ChevronRight size={13} aria-hidden />
    </button>
  );
}

interface RowProps {
  label: string;
  side: SideLanguages;
  leaveOut: readonly string[];
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  name(code: string): string;
  /** Named here where the two sides are not heard by the same. */
  showHearer: boolean;
  followed?: string;
  onOpenHearing?(): void;
  disabled?: boolean;
}

function Row({ label, side, leaveOut, ordered, suggested, name, showHearer, followed, onOpenHearing, disabled }: RowProps) {
  const { t } = useTranslation();
  const pool = offeredLanguages(ordered, [...leaveOut, ...side.chosen], side.offered);
  const any = side.chosen.includes(ANY_LANGUAGE);
  const room = side.most === null || side.chosen.length < side.most;
  const canAdd = !any && room && (pool.length > 0 || side.any);
  const poolBases = new Set(pool.map(baseOf));
  const menu = useLanguageMenu({
    ordered: ordered.filter((o) => poolBases.has(baseOf(o.value))),
    suggested: suggested.filter((o) => poolBases.has(baseOf(o.value))),
    value: '',
    onPick: (code) => side.set(code === ANY_LANGUAGE ? [ANY_LANGUAGE] : [...side.chosen, code]),
    label: name,
    disabled,
    ...(side.any ? { first: { code: ANY_LANGUAGE, name: t('fork.languageMenu.anyLanguage') } } : {}),
  });
  const nameOf = (code: string) => (code === ANY_LANGUAGE ? t('fork.languageMenu.anyLanguage') : name(code));
  return (
    <div className="language-hearing__row" role="group" aria-label={label}>
      <div className="language-hearing__head">
        <span className="language-hearing__label">{label}</span>
        {showHearer && side.hearer && <HearerButton hearer={side.hearer} onOpen={onOpenHearing} />}
      </div>
      <div className="language-hearing__chips">
        {side.chosen.map((code) => {
          const live = !!followed && baseOf(code) === baseOf(followed);
          return (
            <span key={code} className={`language-chip${live ? ' is-live' : ''}`}>
              {nameOf(code)}
              <button type="button" className="language-chip__remove" onClick={() => side.set(side.chosen.filter((one) => one !== code))} aria-label={t('fork.languageMenu.removeLanguage', { name: nameOf(code) })} disabled={disabled}>
                <X size={12} aria-hidden />
              </button>
            </span>
          );
        })}
        {canAdd && (
          <button type="button" className="language-chip__add" disabled={disabled} aria-label={t('fork.languageMenu.addLanguage')} title={t('fork.languageMenu.addLanguage')} aria-haspopup="listbox" {...menu.selectProps}>
            <Plus size={15} aria-hidden />
          </button>
        )}
        {menu.list}
      </div>
    </div>
  );
}

export interface LanguageHearingProps {
  /** The pair: the user's own language and the other side's main one. */
  own: string;
  theirs: string;
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  label(code: string): string;
  /** "我也会说": the languages the user speaks beside their own. Absent: the user is not heard. */
  mine?: SideLanguages;
  /** "对方也可能说": the languages the other side may speak beside their main one. Absent: they are not heard. */
  theirsMore?: SideLanguages;
  /** The language the user's speech follows the other side into now, in a session (`follow.ts`). */
  followed?: string;
  /** The two sides are heard by the same: it is named once, in the section's heading, not here. */
  sameHearer: boolean;
  onOpenHearing?(): void;
  disabled?: boolean;
}

/**
 * Fork: under the language pair, a labelled row a side for the languages it may speak beside its main one — the
 * user's, several at once, and the other side's, followed in a session — each with "+" while what hears it can take
 * more. A side that can take none has no row; where the two are heard by different recognizers, each names its own,
 * a side that has no row on one of its own ("听我", "听对方"). Pressing a name opens its settings.
 */
export function LanguageHearing({ own, theirs, ordered, suggested, label, mine, theirsMore, followed, sameHearer, onOpenHearing, disabled }: LanguageHearingProps) {
  const { t } = useTranslation();
  const shows = (side?: SideLanguages) => !!side && (side.most !== 0 || side.chosen.length > 0);
  const hearerOnly = (side?: SideLanguages) => !sameHearer && !!side?.hearer && !shows(side);
  const rows = [
    shows(mine) && <Row key="mine" label={t('fork.languageMenu.alsoSpeak')} side={mine!} leaveOut={[own]} ordered={ordered} suggested={suggested} name={label} showHearer={!sameHearer} onOpenHearing={onOpenHearing} disabled={disabled} />,
    hearerOnly(mine) && (
      <div key="mine-hearer" className="language-hearing__head language-hearing__row">
        <span className="language-hearing__label">{t('fork.languageMenu.hearsMe')}</span>
        <HearerButton hearer={mine!.hearer!} onOpen={onOpenHearing} />
      </div>
    ),
    shows(theirsMore) && <Row key="theirs" label={t('fork.languageMenu.theyMaySpeak')} side={theirsMore!} leaveOut={[own, theirs]} ordered={ordered} suggested={suggested} name={label} showHearer={!sameHearer} followed={followed} onOpenHearing={onOpenHearing} disabled={disabled} />,
    hearerOnly(theirsMore) && (
      <div key="theirs-hearer" className="language-hearing__head language-hearing__row">
        <span className="language-hearing__label">{t('fork.languageMenu.hearsThem')}</span>
        <HearerButton hearer={theirsMore!.hearer!} onOpen={onOpenHearing} />
      </div>
    ),
  ].filter(Boolean);
  if (rows.length === 0) return null;
  return <div className="language-hearing">{rows}</div>;
}

export { HearerButton };
