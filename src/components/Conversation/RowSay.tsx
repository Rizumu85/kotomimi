import { useTranslation } from 'react-i18next';
import { Loader, Square, Volume2 } from 'lucide-react';
import { useLineVoiceStore } from '../../stores/lineVoiceStore';

/**
 * Fork: "say this line", on a line of the conversation — to hear how it is pronounced. The row knows its words and
 * their language; the voice is the stage's own (`src/app/lineVoice.ts`), heard by the user alone. Pressed again
 * while its line is on, it stops it.
 */
export function RowSay({ id, text, language, blocked = null }: { id: string; text: string; language: string; /** Why no line can be said now, where none can. */ blocked?: string | null }) {
  const { t } = useTranslation();
  const phase = useLineVoiceStore((s) => (s.line === id ? s.phase : s.failed === id ? 'failed' : 'idle'));
  const on = phase === 'loading' || phase === 'playing';
  const label = blocked ?? (on ? t('fork.voice.stopLine', 'Stop') : phase === 'failed' ? t('fork.voice.lineFailed', 'This line could not be read aloud') : t('fork.voice.sayLine', 'Read this line aloud'));
  const press = async () => {
    // Loaded on the press: the list is drawn in places (previews, tests) that never build the app's playback.
    const { sayLine, stopLine } = await import('../../app/lineVoice');
    if (on) stopLine();
    else void sayLine(id, text, language);
  };
  return (
    <button type="button" className={`row-play-btn row-say-btn is-${phase}`} onClick={() => { void press(); }} aria-label={label} title={label} aria-pressed={on} disabled={blocked !== null && !on}>
      {phase === 'loading' ? <Loader size={10} className="row-say-btn__spin" /> : phase === 'playing' ? <Square size={9} fill="currentColor" /> : <Volume2 size={11} />}
    </button>
  );
}
