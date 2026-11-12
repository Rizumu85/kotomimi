// One selection policy for the recognition menus, library and their write boundary.
import type { LegName } from '../../lib/conversation/types';
import type { LanguagePair } from '../../lib/provider/types';
import type { LocalAISettings } from './localai';
import { alsoSpoken, heardBy, theirLitLanguages, theyLitOf } from './localaiDevice';
import { NATIVE_MODELS, hearingPick, isApple, isAutoLanguage, nativeDownloaded, nativeEngineOf, nativeHears, nativePicked, type NativeModel, type NativePick } from './localaiNative';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';

const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];
const here = (id: string) => nativeDownloaded(useNativeEngineStore.getState().status, id);

export interface NativeChoiceRow {
  key: LegName;
  /** The persisted key, distinct even when both rows detect their language. */
  selection: string;
  languages: readonly string[];
  detecting: boolean;
  unbounded: boolean;
  model: NativeModel | null;
}

/** Pass the active legs, not every possible leg. No catalogue filtering happens here. */
export function nativeChoiceRows(s: LocalAISettings, pair: LanguagePair, legs: readonly LegName[], has = here): NativeChoiceRow[] {
  const extra = alsoSpoken(s, pair);
  const fallback = hearingPick(s, pair, { detecting: s.asrDetectOther, both: extra.length > 0, bestEffort: s.asrDetectOther || extra.length > 0 }, has);
  return legs.map((key) => {
    const heard = heardBy(s, pair, key);
    const detecting = isAutoLanguage(heard);
    const own = key === 'speaker' ? pair.source : pair.target;
    const selection = key === 'participant' && s.asrDetectOther ? 'auto' : base(own);
    const named = s.asrNativeByLanguage[selection];
    const known = NATIVE_MODELS.find((m) => m.id === named);
    const languages = detecting ? (key === 'speaker' ? [own, ...extra] : theirLitLanguages(s, pair)) : [heard];
    const pick: NativePick = known ? { model: known.id, byLanguage: { ...s.asrNativeByLanguage, auto: known.id }, bestEffort: !known.detects && !isApple(known.id) } : fallback;
    if (known && isApple(known.id) && detecting) pick.either = { own, others: languages.slice(1) };
    return {
      key, selection, languages: [...new Set(languages.filter((code) => !isAutoLanguage(code)).map(base))], detecting,
      unbounded: detecting && (isAutoLanguage(own) || key === 'participant' && theyLitOf(s, pair.target) === 'auto'),
      model: nativePicked(pick, heard, has),
    };
  });
}

export type NativeRowChoice = { ok: true; moves: LegName[] } | { ok: false; unheard: string };

/** Best effort relaxes language identification only. Every named language still has to be heard. */
export function nativeRowChoice(rows: readonly NativeChoiceRow[], key: LegName, id: string, has = here): NativeRowChoice {
  const chosen = NATIVE_MODELS.find((m) => m.id === id);
  const row = rows.find((one) => one.key === key);
  if (!chosen || !row) return { ok: false, unheard: row?.languages[0] ?? 'auto' };
  const affected = rows.filter((one) => one.selection === row.selection || !isApple(id) && one.model && !isApple(one.model.id) && nativeEngineOf(one.model.id) === nativeEngineOf(id));
  for (const one of [row, ...affected.filter((other) => other !== row)]) {
    if (isApple(id)) {
      if (one.unbounded) return { ok: false, unheard: 'auto' };
      const unheard = one.languages.find((code, index) => index === 0 ? !nativeHears(chosen, code) : !NATIVE_MODELS.some((m) => m.id === `apple-speech:${code}`) || !has(`apple-speech:${code}`));
      if (unheard) return { ok: false, unheard };
    } else {
      const unheard = one.languages.find((code) => !nativeHears(chosen, code));
      if (unheard) return { ok: false, unheard };
    }
  }
  return { ok: true, moves: affected.filter((one) => one.key !== key && one.model?.id !== id).map((one) => one.key) };
}

export type NativeChoicePatch = Pick<LocalAISettings, 'asrHere' | 'asrNativeModel' | 'asrNativeByLanguage'>;

/** Re-evaluate at the write boundary (including download completion); a refused choice changes nothing. */
export function chooseNativeRow(s: LocalAISettings, rows: readonly NativeChoiceRow[], key: LegName, id: string, has = here): NativeChoicePatch | null {
  const choice = nativeRowChoice(rows, key, id, has);
  if (!choice.ok) return null;
  const byLanguage = { ...s.asrNativeByLanguage };
  for (const row of rows) {
    const model = row.key === key || choice.moves.includes(row.key) ? id : row.model?.id;
    if (model) byLanguage[row.selection] = model;
    // The speaker's detector is also the fallback when no participant owns the auto key.
    if (model && row.key === 'speaker' && row.detecting && !rows.some((one) => one.selection === 'auto')) byLanguage.auto = model;
  }
  return { asrHere: 'native', asrNativeModel: id, asrNativeByLanguage: byLanguage };
}

/**
 * One repair for an old conflicting selection. Prefer a model already selected; otherwise use an offered model.
 * Null means no conflict, or no single choice can hear the required languages. The caller owns the repair button.
 */
export function nativeChoiceFix(s: LocalAISettings, rows: readonly NativeChoiceRow[], offered: readonly string[], has = here): { row: LegName; model: string; patch: NativeChoicePatch } | null {
  const conflicts = (current: readonly NativeChoiceRow[]) => current.some((row) => row.model && !isApple(row.model.id) && current.some((other) => other.model && other.model.id !== row.model!.id && !isApple(other.model.id) && nativeEngineOf(other.model.id) === nativeEngineOf(row.model!.id)));
  if (!conflicts(rows)) return null;
  const candidates = [...new Set([...rows.flatMap((row) => row.model ? [row.model.id] : []), ...offered])].filter((id) => offered.includes(id));
  for (const model of candidates) {
    for (const row of rows) {
      const patch = chooseNativeRow(s, rows, row.key, model, has);
      if (!patch) continue;
      const choice = nativeRowChoice(rows, row.key, model, has);
      if (choice.ok && !conflicts(rows.map((one) => one.key === row.key || choice.moves.includes(one.key) ? { ...one, model: NATIVE_MODELS.find((m) => m.id === model)! } : one))) return { row: row.key, model, patch };
    }
  }
  return null;
}
