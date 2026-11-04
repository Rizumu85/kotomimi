/**
 * Fork: a sharing Kotomimi's refusal of a session (`src/lib/lan/transcriber.ts`) as a notice the app words in the
 * user's language. Its own words are English, and stood in the status line as they came — "[OpenAI model_not_found]
 * This Kotomimi shares no speech recognition model for "auto"." — where the user had set no "auto" anywhere: that is
 * what "I speak X too" and detecting the other side ask for (the user, 2026-10-29). Null for any other error.
 */
import { AUTO } from '../../lib/provider/languages';

const NO_RECOGNIZER = /shares no speech recognition model for "([^"]+)"/;

export function kotomimiRefusal(error: { code?: string | null; message?: string | null }): { code: string; params?: Record<string, string> } | null {
  // Its recognizer is in use with another model: nothing is missing, it is busy.
  if (error.code === 'recognizer_busy') return { code: 'server_asr_busy' };
  if (error.code !== 'model_not_found') return null;
  const language = NO_RECOGNIZER.exec(error.message ?? '')?.[1];
  if (!language) return null;
  return language === AUTO ? { code: 'server_no_detect' } : { code: 'server_no_asr', params: { source: language } };
}
