// Fork: stage placement, language behavior, and native model rows.
import { directionKey } from '../../lib/local-inference/selection/types';
import type { LegName } from '../../lib/conversation/types';
import type { EngineSlot, LanguagePair } from '../../lib/provider/types';
import { AUTO } from '../../lib/provider/languages';
import { choiceOf, serverBilingual } from './serverRecognizers';
import { KOTOMIMI_HOST, type LocalAIModel } from './localaiModels';
import { appleOffers, isApple, NATIVE_MODELS } from './localaiNative';
import { defaultPairedModel, tellingOf, type Telling } from './hearingPlan';

/** What the model manifest calls a language: its base (`zh-CN` → `zh`). */
export const deviceLanguage = (code: string): string => code.split('-')[0];

/** Where a stage runs: another device on the network, an API anywhere, or this computer. The same three for every stage. */
export const PLACES = ['server', 'api', 'device'] as const;
export type Place = (typeof PLACES)[number];

/**
 * The settings an earlier build's words for the places are read into
 * (`localai.ts` `migratePlaces`). Nothing is written by a load, so the
 * reading would be done again at every start, over whatever was edited
 * since: the first edit made in the stage cards writes these together
 * (`LocalAIAssist`), and from then on they are read as stored.
 */
export const PLACE_FIELDS = ['translateAt', 'translateServerModel', 'translateModel', 'translateNeedsKey', 'coachAt', 'coachServerModel', 'coachBaseUrl', 'coachModel', 'coachNeedsKey'] as const;

export type AsrHere = 'native';

/** Fork: the settings that say where a side is heard, and by what there. */
export const HEARING_FIELDS = ['asrVia', 'asrModel', 'asrApiBaseUrl', 'asrApiModel', 'asrApiNeedsKey', 'asrOther', 'asrOtherModel'] as const;
export interface HearingChoice {
  asrVia: Place;
  asrModel: string;
  asrApiBaseUrl: string;
  asrApiModel: string;
  asrApiNeedsKey: boolean;
  asrOther: string;
  asrOtherModel: string;
}

/**
 * Fork: the settings as one side's hearing reads them. The two sides are heard in one place unless the user's own is
 * given a place of its own (`asrMine`): the speaker's leg then reads that, and everything else — the other side's
 * leg, the translation, the feedback — the settings as they are. Asked by whatever knows its leg (the builder, the
 * check's loop over the legs, the engines' needs, the language rows); the result has no `asrMine`, so asking twice
 * is asking once. One side on a recognizer that takes the whole of a model (a loud room on the other side) no longer
 * holds the other up (the user, 2026-11-15).
 */
export function hearingOf<S extends { asrMine?: HearingChoice | null; asrVia?: Place; asrAlone?: LegName }>(s: S, leg: LegName): S {
  const mine = s.asrMine;
  // Both on this computer are one engine's two rows, as they are with no place apart: read alike, whole.
  if (!mine || (mine.asrVia === 'device' && s.asrVia === 'device')) return s;
  // `asrAlone`: this side is heard without the other, for what would else pick a recognizer for both (`runHearing`).
  return leg === 'speaker' ? { ...s, ...mine, asrMine: null, asrAlone: 'speaker' } : { ...s, asrAlone: 'participant' };
}

/** Where each stage runs. The feedback's place counts only while the speaker is coached. */
export interface StagePlacement {
  /** Fork: the user's own side heard elsewhere than the other side's (`hearingOf`). */
  asrMine?: HearingChoice | null;
  /** Fork: set by `hearingOf` on the settings one side reads, where the other is heard elsewhere; never stored. */
  asrAlone?: LegName;
  asrVia: Place;
  translateAt: Place;
  coach: boolean;
  coachAt: Place;
  /**
   * A device of the hearing stage's own (`host:port`), where it is on "another device" and that is not the one the
   * stages share: a phone that lends its recognition engine. Blank or absent: the shared device.
   */
  asrOther?: string;
  /** The same of the translation and of the feedback: a phone that lends its text models. Blank or absent: the shared device. */
  translateOther?: string;
  coachOther?: string;
  /** On this computer: by whom. Legacy field; native is the only local runtime. */
  asrHere?: AsrHere;
  translateHere?: AsrHere;
  coachHere?: AsrHere;
}

/** The settings a device stage reads: where each stage runs, and the picks. */
export interface DeviceChoices extends StagePlacement {
  /** Fork: the speaker speaks the other side's language too (`speakBoth`): their sentences in it are translated back. */
  speakBoth?: boolean;
  /** Fork: the languages the speaker speaks besides their own (`alsoSpoken`). */
  speakAlso?: readonly string[];
  /** Fork: the other side's languages, and the one lit beside their main one (`theirLitLanguages`). */
  theyAlso?: readonly string[];
  theyLit?: string;
  asrDetectOther?: boolean;
  asrModel?: string;
}

const baseCode = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/** What decides the languages in use: the user's own others, and the other side's lit. */
type Lit = {
  speakAlso?: readonly string[]; speakBoth?: boolean; theyAlso?: readonly string[]; theyLit?: string; asrDetectOther?: boolean;
  /** Where the user's own side is heard, and the model chosen there for each language: what `mineReach` reads. */
  asrVia?: Place; asrMine?: HearingChoice | null; asrAlone?: LegName; asrNativeByLanguage?: Readonly<Record<string, string>>;
  asrNativeModel?: string; asrModel?: string; asrOther?: string; asrOtherModel?: string; asrApiModel?: string;
};

/**
 * Fork: the languages the speaker speaks besides their own ("我也会说", `speakAlso`), as they were picked, their own and
 * any repeat left out — the list the settings show, whatever is in use. An older `speakBoth` — "I speak the other
 * side's language too" — is the pair's target among them.
 */
export function alsoListed(s: { speakAlso?: readonly string[]; speakBoth?: boolean }, pair: { source: string; target: string }): string[] {
  const own = baseCode(pair.source);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of [...(s.speakAlso ?? []), ...(s.speakBoth ? [pair.target] : [])]) {
    const base = baseCode(code);
    if (!base || base === 'auto' || base === own || seen.has(base)) continue;
    seen.add(base);
    out.push(code);
  }
  return out;
}

/**
 * Fork: the languages the other side may speak besides the pair's target ("对方也可能说", `theyAlso`), `auto` for any.
 * An older build's "detect their language" alone (`asrDetectOther`, no list) is any language.
 */
export function theyAlsoSpeak(s: { theyAlso?: readonly string[]; asrDetectOther?: boolean }): string[] {
  if (s.theyAlso?.length) return [...s.theyAlso];
  return s.asrDetectOther ? ['auto'] : [];
}

/**
 * Fork: the other side's languages as their row shows them ("对方说"): their main one — the pair's target — among them,
 * first where an older build kept it apart; each once.
 */
export function theirRow(s: { theyAlso?: readonly string[]; asrDetectOther?: boolean }, target: string): string[] {
  const kept = theyAlsoSpeak(s);
  const all = kept.some((code) => baseCode(code) === baseCode(target)) ? kept : [target, ...kept];
  const seen = new Set<string>();
  return all.filter((code) => { const base = baseCode(code); if (seen.has(base)) return false; seen.add(base); return true; });
}

/**
 * Fork: the user's own row as shown ("我说"): their own language — the pair's source — and the others they speak, in the
 * order kept (`speakAlso` holds the whole row once the row is used; an older build kept only the others, their own first
 * then). Each once.
 */
export function myRow(s: { speakAlso?: readonly string[]; speakBoth?: boolean }, pair: { source: string; target: string }): string[] {
  const own = baseCode(pair.source);
  const kept = s.speakAlso ?? [];
  const listed = alsoListed(s, pair);
  if (!kept.some((code) => baseCode(code) === own)) return [pair.source, ...listed];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of [...kept, ...listed]) {
    const base = baseCode(code);
    if (!base || base === 'auto' || seen.has(base)) continue;
    seen.add(base);
    out.push(base === own ? pair.source : code);
  }
  return out;
}

/** Fork: the other side's languages lit: their main one, and the one lit beside it where it is a language (not "any"). */
export function theirLitLanguages(s: Lit, pair: { source: string; target: string }): string[] {
  const lit = theyLitOf(s, pair.target);
  return lit && lit !== 'auto' ? [pair.target, lit] : [pair.target];
}

/**
 * Fork: the user's other languages in use now: those the other side has lit, so that a long list of what the user can
 * speak does not have them heard, or translated, in every one of it. All of them while "any language" is lit, which
 * may be any.
 */
export function alsoLit(s: Lit, pair: { source: string; target: string }): string[] {
  const listed = alsoListed(s, pair);
  if (theyLitOf(s, pair.target) === 'auto') return listed;
  const lit = theirLitLanguages(s, pair);
  return listed.filter((code) => lit.some((one) => baseCode(one) === baseCode(code)));
}

/**
 * Fork: the recognizer the user chose for their own language on this computer, and the languages it hears, where it
 * is one of a few (X-ASR: Chinese and English). Null: none chosen for it, their side heard elsewhere (whose reach is
 * not known here), or the Mac's recognition, which has its own way with a second language.
 */
export function mineReach(s: Lit, pair: { source: string; target: string }): { model: string; name: string; languages: readonly string[] } | null {
  if (hearingOf(s, 'speaker').asrVia !== 'device') return null;
  const id = s.asrNativeByLanguage?.[baseCode(pair.source)];
  const model = id && !isApple(id) ? NATIVE_MODELS.find((one) => one.id === id) : undefined;
  return model ? { model: model.id, name: model.name.replace(/ GGUF$/, ''), languages: model.languages } : null;
}

/**
 * Fork: of those (`alsoLit`), the ones the user's own recognizer hears (`mineReach`). "我也会说" is what the user can
 * say, kept for good: a recognizer chosen for their own language that does not hear one of them is their choice not
 * to be heard in it for now, and it steps aside quietly — the row shows it unused — where it used to hold the
 * choice up (X-ASR could never be the user's while the other side had Japanese lit; the user, 2026-11-15). Their
 * main language, and the other side's lit ones, are chosen for now: a recognizer that misses one of those is told.
 */
export function alsoSpoken(s: Lit, pair: LanguagePair, models: Listed = [], telling?: Telling): string[] {
  const lit = alsoLit(s, pair);
  const mine = hearingOf(s, 'speaker');
  const place = mine.asrVia ?? 'server';
  const lent = place === 'server' && !!mine.asrOther?.trim();
  const model = place === 'device' ? mine.asrNativeByLanguage?.[baseCode(pair.source)] ?? mine.asrNativeModel
    : lent ? mine.asrOtherModel : place === 'api' ? mine.asrApiModel : mine.asrModel;
  const listed = models as readonly LocalAIModel[];
  const named = !telling && !model && place === 'server' && !lent && listed.length
    ? defaultPairedModel({ leg: 'speaker', told: pair.source, pair, alsoSpoken: lit }, listed) : model;
  const how = telling ?? tellingOf(lent ? 'api' : place, named ?? '', listed);
  if (how.by === 'pairing') {
    const target = baseCode(pair.target);
    // One it has not at all is left unused, as another recognizer's unheard language is; one it has and lacks here is asked for.
    return lit.filter(appleOffers).sort((a, b) => Number(baseCode(b) === target) - Number(baseCode(a) === target)).slice(0, how.most - 1);
  }
  const reach = mineReach(s, pair);
  return reach ? lit.filter((code) => reach.languages.includes(baseCode(code))) : lit;
}

/**
 * Fork: where two of theirs are lit and the user speaks one of them, a sentence of the user's in it goes into the other
 * (`Stages.cross`): its readers have it as said, the others its translation. The user reads it in their own too.
 */
export function crossings(s: Lit, pair: LanguagePair, spoken = alsoSpoken(s, pair)): Array<{ source: string; target: string }> {
  const lit = theirLitLanguages(s, pair);
  if (lit.length < 2) return [];
  return spoken.flatMap((code) => {
    const other = lit.find((one) => baseCode(one) !== baseCode(code));
    return other ? [{ source: code, target: other }] : [];
  });
}

/** Fork: every other language the user speaks in this run goes back into their own (`Stages.back`). */
export const backInto = alsoSpoken;

/** Fork: the other side's second language lit, a language, where the user's speech goes as well (`Stages.into`); else undefined. */
export function alsoInto(s: Lit, pair: { source: string; target: string }): string | undefined {
  const lit = theirLitLanguages(s, pair);
  return lit.length > 1 && baseCode(lit[1]) !== baseCode(pair.source) ? lit[1] : undefined;
}

/**
 * Fork: the one of the other side's languages lit beside the pair's target (`theyLit`), switched by hand: they are
 * heard in either — their language left to be detected (`asrDetectOther`) — and the user's speech is translated into
 * it as well, unless it is `auto`. '' none: they are heard in the pair's target alone. A build that followed them by
 * itself stored detection with no light: the first of their languages, or any.
 */
export function theyLitOf(s: { theyAlso?: readonly string[]; theyLit?: string; asrDetectOther?: boolean }, target?: string): string {
  if (!s.asrDetectOther) return '';
  // Their main language is lit already: the one beside it is another.
  const chosen = theyAlsoSpeak(s).filter((code) => target === undefined || baseCode(code) !== baseCode(target));
  const lit = s.theyLit ?? '';
  return chosen.find((code) => baseCode(code) === baseCode(lit)) ?? chosen[0] ?? 'auto';
}

/**
 * Fork: the one of them the speaker is heard beside now, where only one can be (the Mac's recognition hears two
 * languages at once): the pair's target where they speak it — the other side's language, followed or chosen — else the
 * first they picked. Undefined where they speak none.
 */
export function alsoFirst(s: Lit, pair: { source: string; target: string }, models: Listed = []): string | undefined {
  const also = alsoSpoken(s, pair, models);
  return also.find((code) => baseCode(code) === baseCode(pair.target)) ?? also[0];
}

/**
 * The hearing stage is on a device of its own. Such a device is asked the way an API is — its address, a model, each
 * stretch uploaded, this computer cutting the sentences — though to the person choosing it is "another device", found
 * by the same search (`localai.ts` `settled` reads it as an API from there on).
 */
export const hearsAtOwnDevice = (s: Pick<StagePlacement, 'asrVia' | 'asrOther'>): boolean => s.asrVia === 'server' && (s.asrOther ?? '').trim() !== '';

/** Where the hearing stage runs, as everything but the switch reads it: a device of its own is an API. */
export const hearingPlace = (s: Pick<StagePlacement, 'asrVia' | 'asrOther'>): Place => (hearsAtOwnDevice(s) ? 'api' : s.asrVia);

/**
 * The translation, or the feedback, is on a device of its own: a phone that lends its text models. It is asked by
 * this computer the way this computer's native engine is, at the phone's address (`localai.ts` `buildLocalAI`), and
 * the device the stages share is not asked for it.
 */
export const translatesAtOwnDevice = (s: Pick<StagePlacement, 'translateAt' | 'translateOther'>): boolean => s.translateAt === 'server' && (s.translateOther ?? '').trim() !== '';
export const coachesAtOwnDevice = (s: Pick<StagePlacement, 'coach' | 'coachAt' | 'coachOther'>): boolean => s.coach && s.coachAt === 'server' && (s.coachOther ?? '').trim() !== '';

/** Where the translation runs, as what asks the shared device reads it: a device of its own is no stage of the shared one. */
export const translatePlace = (s: Pick<StagePlacement, 'translateAt' | 'translateOther'>): Place => (translatesAtOwnDevice(s) ? 'api' : s.translateAt);

/** The feedback runs on the device the stages share: the speaker is coached, there, and not on a device of its own. */
export const coachesOnShared = (s: Pick<StagePlacement, 'coach' | 'coachAt' | 'coachOther'>): boolean => coachIs(s, 'server') && !coachesAtOwnDevice(s);

/** The native recognizer hears, or an API it uploads each sentence to: this computer cuts the sentences itself. */
export const cutsSentencesHere = (s: Pick<StagePlacement, 'asrVia' | 'asrHere' | 'asrOther'>): boolean => hearingPlace(s) !== 'server';

/** The native translation engine translates (`nativeTranslators.ts`): none of the app's own models is asked for. */
export const translatesNatively = (s: Pick<StagePlacement, 'translateAt' | 'translateHere'>): boolean => s.translateAt === 'device';

/** The native feedback engine gives the feedback (`nativeCoaches.ts`): none of the app's own models is asked for. */
export const coachesNatively = (s: Pick<StagePlacement, 'coach' | 'coachAt' | 'coachHere'>): boolean => s.coach && s.coachAt === 'device';

/** The native engine hears: none of the app's own models is asked for. */
export const hearsNatively = (s: Pick<StagePlacement, 'asrVia' | 'asrHere'>): boolean => s.asrVia === 'device';

/** What the other device lists, as far as detection asks: its recognizers and the languages each takes. */
type Listed = ReadonlyArray<object>;

/** Whether the selected recognizer advertises "auto"; without a choice, the server may use any detector it lists. */
export const serverDetects = (models: Listed, chosen = ''): boolean => (models as ReadonlyArray<{ id?: string; kind?: string; languages?: readonly string[] }>).some((m) =>
  m.kind === 'asr' && (!chosen.trim() || choiceOf(m.id ?? '') === choiceOf(chosen.trim())) && m.languages?.includes(AUTO) === true);

/**
 * Another Kotomimi lists a recognizer that does not name the language. It is
 * told this leg's own source, transcribes, and the client's writing/text
 * detector names each finished sentence — the same best effort as here.
 */
export const serverSoft = (models: Listed): boolean => (models as ReadonlyArray<{ kind?: string; host?: string }>).some((m) => m.kind === 'asr' && m.host === KOTOMIMI_HOST);

/**
 * The other side's language is left to be detected, and what hears can do
 * that. Anywhere else the choice counts for nothing: the leg is told the
 * pair's language, and the language section says so.
 */
export const detectsOther = (s: { asrDetectOther?: boolean; asrVia: Place; asrHere?: AsrHere; asrOther?: string; asrModel?: string }, models: Listed = []): boolean => s.asrDetectOther === true && canDetectOther(s, models);

/**
 * What hears can tell a language by itself: a native engine's model, an API
 * the sentence is uploaded to, or another Kotomimi that lists a recognizer
 * which does. `models`: what the other device lists.
 *
 * Fork: here this computer hears, a model that does not name the language is
 * no refusal: the sentence's writing, and behind it a small text detector,
 * try (`src/lib/language/identify.ts`). That is a best effort, and the
 * settings say so. Another Kotomimi can also use the client's text detector;
 * other Realtime servers must advertise detection for the selected model.
 */
export function canDetectOther(s: { asrVia: Place; asrHere?: AsrHere; asrOther?: string; asrModel?: string }, models: Listed = []): boolean {
  const place = hearingPlace(s);
  if (place === 'server') return serverDetects(models, s.asrModel) || serverSoft(models);
  // This computer, or an API: the recognizer's language, else the writing, else the detector.
  return true;
}

/**
 * Fork: the speaker speaks the other side's language too (`speakBoth`), and what hears can tell the two apart: their
 * sentences in either are heard, and each translated into the other. Feedback can also answer their foreign speech.
 */
export const speaksBoth = (all: Lit & { coach: boolean; asrVia: Place; asrHere?: AsrHere; asrOther?: string; asrModel?: string; asrMine?: HearingChoice | null }, models: Listed = [], pair?: LanguagePair): boolean => {
  // The speaker's own hearing: theirs where it is apart.
  const s = hearingOf(all, 'speaker');
  const also = pair ? alsoFirst(s, pair, models) : (s.speakAlso?.[0] ?? (s.speakBoth ? 'other' : undefined));
  if (!also) return false;
  return canDetectOther(s, models) || (hearingPlace(s) === 'server' && !!pair && serverBilingual(s.asrModel ?? '', { source: pair.source, target: also }, models as readonly LocalAIModel[]) !== null);
};

/** What a leg hears: the speaker their own language, or — coached — the one they practise, or either (`speaksBoth`); the other side theirs, or whatever it turns out to be. */
export function heardBy(s: Lit & { asrVia: Place; asrHere?: AsrHere; asrOther?: string; asrModel?: string; coach: boolean }, pair: { source: string; target: string }, leg: 'speaker' | 'participant', models: Listed = []): string {
  if (leg === 'speaker') return speaksBoth(s, models, pair) && pair.source.toLowerCase() !== pair.target.toLowerCase() ? AUTO : s.coach ? pair.target : pair.source;
  return detectsOther(s, models) ? AUTO : pair.target;
}

/**
 * Fork: a leg heard in the language it is shown in (Chinese to Chinese — to hear someone more clearly): what is heard
 * is shown as said, and nothing translates it. Not a coached speaker, who is answered with feedback, nor the other
 * side left to be detected, who may speak anything.
 */
export function shownAsSaid(s: { asrDetectOther?: boolean; asrVia: Place; asrHere?: AsrHere; asrOther?: string; coach: boolean }, pair: { source: string; target: string }, leg: 'speaker' | 'participant', models: Listed = []): boolean {
  if (leg === 'speaker' ? s.coach : detectsOther(s, models)) return false;
  return pair.source.toLowerCase() === pair.target.toLowerCase();
}

/** The feedback runs at this place: the speaker is coached, and that is where. */
export const coachIs = (s: Pick<StagePlacement, 'coach' | 'coachAt'>, place: Place): boolean => s.coach && s.coachAt === place;

/** A stage of this run is on the other device: the one the stages share, not a device of a stage's own. */
export function needsServer(s: StagePlacement): boolean {
  return hearingPlace(s) === 'server' || translatePlace(s) === 'server' || coachesOnShared(s);
}

/** One model a run would load on this computer, and whether the run cannot start without it. */
export interface DeviceNeed extends EngineSlot {
  leg: LegName;
  /** The language heard, or the pair translated, in app codes: for a refusal's words. */
  source: string;
  target: string;
  /** False: typed text alone needs it (a coached speaker's translation). */
  required: boolean;
}

/**
 * The device stages a run opens, speaker's first. Without bilingual speech,
 * a coached speaker hears through `target→source`, the participant's slot,
 * and only their typed text needs a translator. Bilingual speech requires
 * translation in both directions alongside the feedback.
 */
export function deviceNeeds(s: DeviceChoices, pair: LanguagePair, legs: readonly LegName[], models: Listed = []): DeviceNeed[] {
  const out: DeviceNeed[] = [];
  const slot = (src: string, tgt: string) => directionKey(deviceLanguage(src), deviceLanguage(tgt));
  for (const leg of legs) {
    const source = leg === 'participant' ? pair.target : pair.source;
    const target = leg === 'participant' ? pair.source : pair.target;
    const coached = s.coach && leg === 'speaker';
    const both = leg === 'speaker' && speaksBoth(s, models, pair) && source.toLowerCase() !== target.toLowerCase();
    if (hearingOf(s, leg).asrVia === 'device') {
      const heard = coached && !both ? target : source;
      const other = coached && !both ? source : target;
      out.push({ leg, dir: slot(heard, other), stage: 'asr', source: heard, target: other, required: true });
    }
    // A leg shown as said (`shownAsSaid`) translates nothing.
    if (s.translateAt === 'device') out.push({ leg, dir: slot(source, target), stage: 'translation', source, target, required: (!coached || both) && source.toLowerCase() !== target.toLowerCase() });
    // Fork: a speaker who speaks both has their sentences in the other side's language translated back: that
    // direction too, the other side's leg's (`Stages.back`), where what hears can tell the two apart.
    // Each language they speak besides their own, where they speak more than the other side's.
    if (s.translateAt === 'device' && both) {
      const spoken = backInto(s, pair, models);
      for (const also of spoken) out.push({ leg, dir: slot(also, source), stage: 'translation', source: also, target: source, required: true });
      // Fork: a sentence in one of two lit languages of theirs goes into the other (`crossings`).
      for (const cross of crossings(s, pair, spoken)) out.push({ leg, dir: slot(cross.source, cross.target), stage: 'translation', source: cross.source, target: cross.target, required: true });
    }
    // Fork: the other side's second language lit: the user's speech goes into it as well (`Stages.into`).
    const into = leg === 'speaker' && !(coached && !both) ? alsoInto(s, pair) : undefined;
    if (s.translateAt === 'device' && into) out.push({ leg, dir: slot(source, into), stage: 'translation', source, target: into, required: true });
  }
  return out;
}
