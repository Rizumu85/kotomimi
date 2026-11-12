import { ChevronRight, Mic, Plus, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Hearer, LanguageOption } from '../../lib/provider/types';
import { addMine, addTheirs, isLit, pressMine, pressTheirs, removeMine, removeTheirs, type MyNext, type TheirNext } from '../../lib/language/theirLanguages';
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

/** Fork: the user's languages beside their own, as the section is handed them (`MoreLanguages`, its `set` bound). */
export interface SideLanguages {
  hearer?: Hearer;
  chosen: readonly string[];
  offered: readonly string[] | null;
  most: number | null;
  any: boolean;
  set(chosen: string[]): void;
  /** Those of `chosen` in use now (the ones the other side has lit); absent, all of them. */
  using?: readonly string[];
}

/**
 * Fork: the other side's languages ("对方说"), switched by hand (`theirLanguages.ts`): their row, the main one and the
 * one lit beside it, whether two can be lit at once, whether "any language" is offered, and what a change writes —
 * the pair's target and the provider's settings together.
 */
/**
 * Fork: a side whose recognizer on this computer does not hear one of its languages in use (`nativeLanguageGap`):
 * those languages, what hears the side now, and the model that would hear them all, put to use on a press. Shown only
 * while it is so: nothing switches by itself.
 */
export interface HearingGap {
  /** Language codes; `auto`: the side is left to be detected and its recognizer cannot. */
  codes: readonly string[];
  by: string;
  to: string;
  fix(): void;
}

export interface TheirSide {
  hearer?: Hearer;
  gap?: HearingGap;
  main: string;
  row: readonly string[];
  lit: string;
  two: boolean;
  any: boolean;
  apply(next: TheirNext): void;
}

/**
 * Fork: the user's own row ("我说", `MyLanguages`): their own language and the others they speak, those in use now (lit
 * for the other side), whether what hears them takes more than their own, and what a change writes — the pair's source
 * and the provider's settings together.
 */
export interface MySide {
  hearer?: Hearer;
  gap?: HearingGap;
  main: string;
  row: readonly string[];
  using: readonly string[];
  more: boolean;
  apply(next: MyNext): void;
}

const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0];
const unheard = (gap: HearingGap | undefined, code: string) => !!gap && gap.codes.some((one) => baseCode(one) === baseCode(code));

/** Under a row whose recognizer misses some of its languages: which, and the one press that puts it right. */
function GapNote({ gap, name, disabled }: { gap: HearingGap; name(code: string): string; disabled?: boolean }) {
  const { t } = useTranslation();
  const named = gap.codes.filter((code) => code !== 'auto');
  return (
    <div className="language-hearing__gap" role="status">
      <TriangleAlert size={13} aria-hidden />
      <span>{named.length ? t('fork.gap.cannot', { model: gap.by, languages: named.map(name).join('、') }) : t('fork.gap.noDetect', { model: gap.by })}</span>
      <button type="button" className="language-hearing__gap-fix" onClick={gap.fix} disabled={disabled}>{t('fork.gap.switch', { model: gap.to })}</button>
    </div>
  );
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
  onOpenHearing?(): void;
  disabled?: boolean;
}

/** "我也会说": the user's languages beside their own, each with ×; the ones the other side has not lit are dimmed. */
function Row({ label, side, leaveOut, ordered, suggested, name, showHearer, onOpenHearing, disabled }: RowProps) {
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
          const idle = side.using !== undefined && !side.using.some((one) => baseOf(one) === baseOf(code));
          return (
            <span key={code} className={`language-chip${idle ? ' is-idle' : ''}`}>
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

interface MyRowProps {
  side: MySide;
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  name(code: string): string;
  showHearer: boolean;
  onOpenHearing?(): void;
  disabled?: boolean;
}

/**
 * "我说": the user's own language filled, pressing another makes it theirs (`pressMine`); the others they speak beside
 * it tinted while the other side has them lit, so in use, and dimmed while not. "+" lists every language, the row's checked first.
 * Where what hears them takes their own alone, one picked there becomes it.
 */
function MyRow({ side, ordered, suggested, name, showHearer, onOpenHearing, disabled }: MyRowProps) {
  const { t } = useTranslation();
  const now = { main: side.main, row: side.row };
  const inRow = (code: string) => side.row.some((one) => baseOf(one) === baseOf(code));
  const offered = (o: LanguageOption) => o.value !== ANY_LANGUAGE && (!inRow(o.value) || side.row.includes(o.value));
  const menu = useLanguageMenu({
    ordered: ordered.filter(offered),
    suggested: suggested.filter(offered),
    value: '',
    checked: side.row,
    onPick: (code) => {
      if (inRow(code)) { const next = removeMine(now, code); if (next) side.apply(next); return; }
      const added = addMine(now, code);
      side.apply(side.more ? added : { ...added, main: code });
    },
    label: name,
    disabled,
  });
  const label = t('fork.languageMenu.iSay');
  return (
    <div className="language-hearing__row" role="group" aria-label={label}>
      <div className="language-hearing__head">
        <span className="language-hearing__label">{label}</span>
        {showHearer && side.hearer && <HearerButton hearer={side.hearer} onOpen={onOpenHearing} />}
      </div>
      <div className="language-hearing__chips">
        {side.row.map((code) => {
          const own = baseOf(code) === baseOf(side.main);
          const idle = !own && !side.using.some((one) => baseOf(one) === baseOf(code));
          return (
            <button
              key={code}
              type="button"
              className={`language-chip language-chip--switch${own ? ' is-lit' : idle ? ' is-idle' : ' is-used'}${unheard(side.gap, code) ? ' is-unheard' : ''}`}
              aria-pressed={own}
              onClick={() => { const next = pressMine(now, code); if (next) side.apply(next); }}
              disabled={disabled}
            >
              {name(code)}
            </button>
          );
        })}
        {/* With the user's own language alone, "+" says what it adds: a row with nothing else in it explains nothing. */}
        {side.row.length <= 1 ? (
          <button type="button" className="language-chip__add language-chip__add--named" disabled={disabled} aria-haspopup="listbox" {...menu.selectProps}>
            <Plus size={14} aria-hidden />
            <span>{t('fork.languageMenu.alsoSpeak')}</span>
          </button>
        ) : (
          <button type="button" className="language-chip__add" disabled={disabled} aria-label={t('fork.languageMenu.addLanguage')} title={t('fork.languageMenu.addLanguage')} aria-haspopup="listbox" {...menu.selectProps}>
            <Plus size={15} aria-hidden />
          </button>
        )}
        {menu.list}
      </div>
      {side.gap && <GapNote gap={side.gap} name={name} disabled={disabled} />}
    </div>
  );
}

interface TheirRowProps {
  side: TheirSide;
  own: string;
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  name(code: string): string;
  showHearer: boolean;
  onOpenHearing?(): void;
  disabled?: boolean;
}

/**
 * "对方说": every language of theirs a chip, pressed to light it or put it out (`pressTheirs`); "+" lists every
 * language, the row's checked first — pressing one adds it lit, or takes a checked one out.
 */
function TheirRow({ side, own, ordered, suggested, name, showHearer, onOpenHearing, disabled }: TheirRowProps) {
  const { t } = useTranslation();
  const now = { main: side.main, row: side.row, lit: side.lit, two: side.two };
  const inRow = (code: string) => side.row.some((one) => baseOf(one) === baseOf(code));
  // Every language but the user's own; of one in the row, only the form it is there in.
  const theirs = (o: LanguageOption) => baseOf(o.value) !== baseOf(own) && o.value !== ANY_LANGUAGE && (!inRow(o.value) || side.row.includes(o.value));
  const menu = useLanguageMenu({
    ordered: ordered.filter(theirs),
    suggested: suggested.filter(theirs),
    value: '',
    checked: side.row,
    onPick: (code) => {
      const next = inRow(code) ? removeTheirs(now, code) : addTheirs(now, code);
      if (next) side.apply(next);
    },
    label: name,
    disabled,
    ...(side.any ? { first: { code: ANY_LANGUAGE, name: t('fork.languageMenu.anyLanguage') } } : {}),
  });
  const nameOf = (code: string) => (code === ANY_LANGUAGE ? t('fork.languageMenu.anyLanguage') : name(code));
  const label = t('fork.languageMenu.theySay');
  return (
    <div className="language-hearing__row" role="group" aria-label={label}>
      <div className="language-hearing__head">
        <span className="language-hearing__label">{label}</span>
        {showHearer && side.hearer && <HearerButton hearer={side.hearer} onOpen={onOpenHearing} />}
      </div>
      <div className="language-hearing__chips">
        {side.row.map((code) => {
          const lit = isLit(now, code);
          return (
            <button
              key={code}
              type="button"
              className={`language-chip language-chip--switch${lit ? ' is-lit' : ''}${lit && unheard(side.gap, code) ? ' is-unheard' : ''}`}
              aria-pressed={lit}
              onClick={() => { const next = pressTheirs(now, code); if (next) side.apply(next); }}
              disabled={disabled}
            >
              {nameOf(code)}
            </button>
          );
        })}
        <button type="button" className="language-chip__add" disabled={disabled} aria-label={t('fork.languageMenu.addLanguage')} title={t('fork.languageMenu.addLanguage')} aria-haspopup="listbox" {...menu.selectProps}>
          <Plus size={15} aria-hidden />
        </button>
        {menu.list}
      </div>
      {side.gap && <GapNote gap={side.gap} name={nameOf} disabled={disabled} />}
    </div>
  );
}

export interface LanguageHearingProps {
  /** The user's own language. */
  own: string;
  ordered: readonly LanguageOption[];
  suggested: readonly LanguageOption[];
  label(code: string): string;
  /** "我也会说": the languages the user speaks beside their own. Absent: the user is not heard. */
  mine?: SideLanguages;
  /** "我说": the user's own row, in place of `mine` and of the pair's select. */
  myRow?: MySide;
  /** The user's own language's list (the pair's sources), for `myRow`'s "+". */
  myOrdered?: readonly LanguageOption[];
  mySuggested?: readonly LanguageOption[];
  /** "对方说": the other side's languages, switched by hand. Absent: the pair's select holds theirs. */
  theirs?: TheirSide;
  /** The two sides are heard by the same: it is named once, in the section's heading, not here. */
  sameHearer: boolean;
  onOpenHearing?(): void;
  disabled?: boolean;
}

/**
 * Fork: under the user's language, a labelled row a side: the languages the user speaks beside their own, those not in
 * use now dimmed, and the other side's, one or two lit by pressing them (heard, and the user's speech translated into
 * each). Where the two are heard by different recognizers, each names its own; pressing a name opens its settings.
 */
export function LanguageHearing({ own, ordered, suggested, label, mine, myRow, myOrdered, mySuggested, theirs, sameHearer, onOpenHearing, disabled }: LanguageHearingProps) {
  const { t } = useTranslation();
  const shows = (side?: SideLanguages) => !myRow && !!side && (side.most !== 0 || side.chosen.length > 0);
  const hearerOnly = !myRow && !sameHearer && !!mine?.hearer && !shows(mine);
  const rows = [
    myRow && <MyRow key="me" side={myRow} ordered={myOrdered ?? ordered} suggested={mySuggested ?? suggested} name={label} showHearer={!sameHearer} onOpenHearing={onOpenHearing} disabled={disabled} />,
    shows(mine) && <Row key="mine" label={t('fork.languageMenu.alsoSpeak')} side={mine!} leaveOut={[own]} ordered={ordered} suggested={suggested} name={label} showHearer={!sameHearer} onOpenHearing={onOpenHearing} disabled={disabled} />,
    hearerOnly && (
      <div key="mine-hearer" className="language-hearing__head language-hearing__row">
        <span className="language-hearing__label">{t('fork.languageMenu.hearsMe')}</span>
        <HearerButton hearer={mine!.hearer!} onOpen={onOpenHearing} />
      </div>
    ),
    theirs && <TheirRow key="theirs" side={theirs} own={own} ordered={ordered} suggested={suggested} name={label} showHearer={!sameHearer} onOpenHearing={onOpenHearing} disabled={disabled} />,
  ].filter(Boolean);
  if (rows.length === 0) return null;
  return <div className="language-hearing">{rows}</div>;
}

export { HearerButton };
