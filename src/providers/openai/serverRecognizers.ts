/**
 * Fork: the other device's recognizers, as a person chooses among them.
 *
 * A Kotomimi lists some recognizers once for each language — the Mac's own
 * speech recognition is `apple-speech:ja`, `apple-speech:en`, … — because
 * each is told its language by its name. To the person choosing that is one
 * recognizer, and which of them a leg needs follows from the language the leg
 * hears. So the menu shows such a family once, lists only what hears a
 * language of this run, and the id that is sent is worked out for each leg.
 * Pure.
 */
import { AUTO } from '../../lib/provider/languages';
import { KOTOMIMI_HOST, modelsFor, type LocalAIModel } from './localaiModels';

const base = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0];

/** Two explicitly supported languages of a sharing host's recognizer, in the requested order. */
export function serverBilingual(chosen: string, pair: { source: string; target: string }, models: readonly LocalAIModel[]): { model: string; languages: [string, string] } | null {
  const first = base(pair.source);
  const second = base(pair.target);
  if (!first || !second || first === second || first === AUTO || second === AUTO) return null;
  const eligible = modelsFor(models, 'asr').filter((m) => m.host === KOTOMIMI_HOST && m.bilingual && perLanguage(m.id));
  const families = chosen.trim() ? [choiceOf(chosen.trim())] : [...new Set(eligible.map((m) => choiceOf(m.id)))];
  for (const family of families) {
    const member = (language: string) => eligible.find((m) => choiceOf(m.id) === family && base(perLanguage(m.id)!.language) === language && m.languages?.some((l) => base(l) === language));
    const one = member(first);
    if (one && member(second)) return { model: one.id, languages: [first, second] };
  }
  return null;
}

/** A recognizer the device has one of for each language: its family and that language; null for any other. */
export function perLanguage(id: string): { family: string; language: string } | null {
  const at = id.indexOf(':');
  return at > 0 && at < id.length - 1 ? { family: id.slice(0, at), language: id.slice(at + 1) } : null;
}

/** What a recognizer is chosen by: its family where it has one, its id otherwise. */
export const choiceOf = (id: string): string => perLanguage(id)?.family ?? id;

/**
 * The choices for the menu, in the device's own order: each a recognizer or a
 * family of them. `heard`: the languages this run hears; one left to be
 * detected, or none known, lists everything.
 */
export function recognizerChoices(recognizers: readonly LocalAIModel[], heard: readonly string[]): string[] {
  const languages = heard.includes(AUTO) ? [] : [...new Set(heard.filter(Boolean).map(base))];
  const hears = (model: LocalAIModel): boolean => {
    if (languages.length === 0) return true;
    const one = perLanguage(model.id);
    if (one) return languages.includes(base(one.language));
    return !model.languages?.length || model.languages.some((language) => languages.includes(base(language)));
  };
  const choices: string[] = [];
  for (const model of recognizers) {
    const choice = choiceOf(model.id);
    if (hears(model) && !choices.includes(choice)) choices.push(choice);
  }
  return choices;
}

/**
 * The recognizer a leg asks the device for, from what was chosen: a family's
 * member for the language the leg hears — or none, which leaves the choice to
 * the device, where the family has no such member. Any other choice is asked
 * for as it is.
 */
export function recognizerAsked(chosen: string, heard: string, recognizers: readonly LocalAIModel[]): string {
  if (!chosen) return '';
  const family = choiceOf(chosen);
  const members = recognizers.filter((model) => perLanguage(model.id)?.family === family);
  // Left to be detected: the one chosen where it tells languages apart ("auto" among what it takes), else the device's own choice.
  if (heard === AUTO) return members.length === 0 && recognizers.find((model) => model.id === chosen)?.languages?.includes(AUTO) ? chosen : '';
  if (members.length === 0 && !perLanguage(chosen)) return chosen;
  return members.find((model) => base(perLanguage(model.id)!.language) === base(heard))?.id ?? '';
}
