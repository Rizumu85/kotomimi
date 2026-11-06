import { Check, ChevronRight, Mic } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Hearer, LanguageOption } from '../../lib/provider/types';
import { useLanguageMenu } from './LanguageMenu';
import './LanguageHearing.scss';

const baseOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/** A row shows every language it offers up to this many; past it, as many as fit on one line and the rest behind "+N". */
const ALL_UP_TO = 4;
/** The most a row of many shows before "+N", where they fit. */
const SHOWN = 4;

/**
 * Fork: the languages a row offers — those in the provider's list that what hears can tell apart (`offered`, by base
 * code; null: every one), the user's own left out — one to a language, its plain code where the list has it.
 */
export function offeredLanguages(ordered: readonly LanguageOption[], own: string, offered: readonly string[] | null): string[] {
  const seen = new Map<string, string>();
  for (const { value } of ordered) {
    const base = baseOf(value);
    if (!base || base === baseOf(own) || (offered && !offered.some((code) => baseOf(code) === base))) continue;
    const had = seen.get(base);
    if (had === undefined || (baseOf(had) !== had && value === base)) seen.set(base, value);
  }
  return [...seen.values()];
}

/**
 * Fork: the few a row shows of `pool`: the ones it must (chosen, started with, followed), then the suggested, then
 * the rest in order — all of them where there are few — and how many are left behind "+N".
 */
export function shownLanguages(pool: readonly string[], keep: readonly string[], suggested: readonly string[], most = SHOWN): { shown: string[]; rest: number } {
  if (pool.length <= ALL_UP_TO) return { shown: [...pool], rest: 0 };
  const byBase = new Map(pool.map((code) => [baseOf(code), code]));
  const shown: string[] = [];
  const add = (code: string) => {
    const found = byBase.get(baseOf(code));
    if (found && !shown.includes(found)) shown.push(found);
  };
  keep.forEach(add);
  for (const code of [...suggested, ...pool]) {
    if (shown.length >= most) break;
    add(code);
  }
  return { shown, rest: pool.length - shown.length };
}

interface HearingRowProps {
  label: string;
  hearer?: Hearer;
  pool: readonly string[];
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  isOn(code: string): boolean;
  isLive?(code: string): boolean;
  keep: readonly string[];
  pick(code: string): void;
  name(code: string): string;
  onOpenHearing?(): void;
  disabled?: boolean;
  /** Chips that select one at a time are drawn as the choice; those that each turn on and off, with a check. */
  many: boolean;
}

function HearingRow({ label, hearer, pool, ordered, suggested, isOn, isLive, keep, pick, name, onOpenHearing, disabled, many }: HearingRowProps) {
  const { t } = useTranslation();
  // As many as fit on one line: fewer, one at a time, while the chips wrap; all again when the row's width changes.
  const [most, setMost] = useState(SHOWN);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const { shown, rest } = shownLanguages(pool, keep, suggested.map((o) => o.value), most);
  useLayoutEffect(() => {
    const box = chipsRef.current;
    if (!box || rest === 0) return;
    const chips = [...box.children] as HTMLElement[];
    const top = chips[0]?.offsetTop ?? 0;
    const wrapped = chips.some((chip) => chip.offsetTop > top + 2);
    if (wrapped && shown.length > 1 && most > 1) setMost(Math.min(most, shown.length) - 1);
  });
  useEffect(() => {
    const box = chipsRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    let width = box.clientWidth;
    const watch = new ResizeObserver(() => {
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      setMost(SHOWN);
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, []);
  const poolBases = new Set(pool.map(baseOf));
  const menu = useLanguageMenu({
    ordered: ordered.filter((o) => poolBases.has(baseOf(o.value))),
    suggested: suggested.filter((o) => poolBases.has(baseOf(o.value))),
    value: many ? '' : (pool.find(isOn) ?? ''),
    onPick: pick,
    label: name,
    disabled,
  });
  return (
    <div className="language-hearing__row" role="group" aria-label={label}>
      <div className="language-hearing__head">
        <span className="language-hearing__label">{label}</span>
        {hearer && (
          <button type="button" className="language-hearing__hearer" onClick={onOpenHearing} title={t('fork.languageMenu.hearingBy', { name: hearer.name })} aria-label={t('fork.languageMenu.hearingBy', { name: hearer.name })}>
            <Mic size={13} aria-hidden />
            <span>{hearer.name}</span>
            <ChevronRight size={13} aria-hidden />
          </button>
        )}
      </div>
      <div className="language-hearing__chips" ref={chipsRef}>
        {shown.map((code) => {
          const on = isOn(code);
          const live = isLive?.(code) ?? false;
          return (
            <button
              key={code}
              type="button"
              className={`language-chip${on ? (many ? ' is-on' : ' is-chosen') : ''}${live ? ' is-live' : ''}`}
              aria-pressed={on}
              onClick={() => pick(code)}
              disabled={disabled}
            >
              {many && on && <Check size={13} aria-hidden />}
              {name(code)}
            </button>
          );
        })}
        {rest > 0 && (
          <button type="button" className="language-chip language-chip--more" disabled={disabled} aria-label={t('fork.languageMenu.moreLanguages', { count: rest })} aria-haspopup="listbox" {...menu.selectProps}>
            +{rest}
          </button>
        )}
        {menu.list}
      </div>
    </div>
  );
}

export interface LanguageHearingProps {
  /** The user's own language: never offered. */
  own: string;
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  label(code: string): string;
  /** "我也会说": the languages the user speaks besides their own, several at once. Absent: not offered. */
  mine?: { hearer?: Hearer; chosen: readonly string[]; offered: readonly string[] | null; available: boolean; set(chosen: string[]): void };
  /**
   * "对方可能说", while the other side's language is detected: the language the user's speech goes into at first
   * (`start`, the pair's), and the one it follows into now (`followed`). Absent: their language is chosen.
   */
  theirs?: { hearer?: Hearer; start: string; followed?: string; onStart(code: string): void };
  onOpenHearing?(): void;
  disabled?: boolean;
  /** Said under the rows only where something is wrong (a recognizer that guesses the language). */
  note?: ReactNode;
}

/**
 * Fork: under the language pair, what hears each side and the languages it can tell apart, as chips: the user's own
 * other languages, picked several at once, and the other side's, the one started with and the one followed now. The
 * hearer is named once where it is the same for both; pressing it opens its settings.
 */
export function LanguageHearing({ own, ordered, suggested, label, mine, theirs, onOpenHearing, disabled, note }: LanguageHearingProps) {
  const { t } = useTranslation();
  if (!mine && !theirs) return null;
  const sameHearer = !!mine?.hearer && !!theirs?.hearer && mine.hearer.name === theirs.hearer.name;
  const has = (list: readonly string[], code: string) => list.some((one) => baseOf(one) === baseOf(code));
  return (
    <div className="language-hearing">
      {mine && (
        <HearingRow
          label={t('fork.languageMenu.alsoSpeak')}
          hearer={mine.hearer}
          pool={offeredLanguages(ordered, own, mine.offered)}
          ordered={ordered}
          suggested={suggested}
          isOn={(code) => has(mine.chosen, code)}
          keep={mine.chosen}
          pick={(code) => mine.set(has(mine.chosen, code) ? mine.chosen.filter((one) => baseOf(one) !== baseOf(code)) : [...mine.chosen, code])}
          name={label}
          onOpenHearing={onOpenHearing}
          disabled={disabled || (!mine.available && mine.chosen.length === 0)}
          many
        />
      )}
      {theirs && (
        <HearingRow
          label={t('fork.languageMenu.theyMaySpeak')}
          hearer={sameHearer ? undefined : theirs.hearer}
          pool={offeredLanguages(ordered, own, theirs.hearer?.languages ?? null)}
          ordered={ordered}
          suggested={suggested}
          isOn={(code) => baseOf(code) === baseOf(theirs.start)}
          isLive={(code) => !!theirs.followed && baseOf(code) === baseOf(theirs.followed)}
          keep={[theirs.start, ...(theirs.followed ? [theirs.followed] : [])]}
          pick={(code) => { if (baseOf(code) !== baseOf(theirs.start)) theirs.onStart(code); }}
          name={label}
          onOpenHearing={onOpenHearing}
          disabled={disabled}
          many={false}
        />
      )}
      {note}
    </div>
  );
}
