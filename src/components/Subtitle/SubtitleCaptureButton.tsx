/**
 * Fork: at the foot of the subtitle's settings, the way to report a layout that went wrong: the last minute of what
 * the subtitle showed, saved to a file and shown in the file manager (`saveSubtitleCapture`), to send to the
 * developer, who replays it exactly (`src/components/dev/SubtitleReplay.tsx`). Nothing leaves the computer by itself.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, FileDown, Loader } from 'lucide-react';
import { saveSubtitleCapture } from '../../app/subtitleCapture';

type State = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; error: string };

export function SubtitleCaptureButton() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'idle' });
  useEffect(() => {
    if (state.kind !== 'saved') return undefined;
    const timer = setTimeout(() => setState({ kind: 'idle' }), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  const save = async () => {
    setState({ kind: 'saving' });
    const result = await saveSubtitleCapture();
    setState(result.ok ? { kind: 'saved' } : { kind: 'failed', error: result.error });
  };
  return (
    <div className="subtitle-capture">
      <button type="button" className="subtitle-capture__btn" onClick={() => void save()} disabled={state.kind === 'saving'} title={t('fork.capture.hint')}>
        {state.kind === 'saving' ? <Loader size={13} className="subtitle-capture__spin" /> : state.kind === 'saved' ? <CircleCheck size={13} /> : <FileDown size={13} />}
        <span>{state.kind === 'saved' ? t('fork.capture.saved') : t('fork.capture.save')}</span>
      </button>
      {state.kind === 'failed' && <span className="subtitle-capture__error" role="status">{t('fork.capture.failed')}</span>}
    </div>
  );
}
