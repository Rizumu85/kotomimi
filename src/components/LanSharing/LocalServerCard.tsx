/**
 * Fork: the LocalAI installed on this computer, in the settings: one more
 * source of "this computer's models", beside the ones the app downloaded.
 * One line says whether it is up and how many models it has, with the button
 * that starts or stops it; under it, whether it starts with the app, and the
 * way to LocalAI's own page for installing more. Its models are chosen in the
 * stage cards (`LocalAIAssist`) and lent by the sharing section: neither is
 * repeated here. What it is and does is behind the question mark. Drawn only
 * where a LocalAI is installed: nobody else needs to hear of it.
 *
 * One that something else started is shown as running and left alone — there
 * is then no button to stop it, and a line that says why.
 *
 * While it is up, a disclosure holds its Realtime pipelines, with the
 * recognizer and the translation model each names, each a menu of the models
 * this LocalAI has for that work: what another device gets when it leaves
 * both stages to "another device". The models are listed by readable names
 * made from their ids (`modelLabel`); nothing here knows a model in particular.
 */
import { useEffect, useState } from 'react';
import { CircleHelp, ExternalLink, Loader, Play, Server, Square, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import Tooltip from '../Tooltip/Tooltip';
import { askLocalPipelines, NO_PIPELINES, setLocalPipeline, type LocalPipelines } from '../../lib/lan/localServer';
import { modelLabel } from '../../lib/lan/modelLabel';
import { useLocalServerStore } from '../../stores/localServerStore';
import { openExternalUrl } from '../../utils/openExternalUrl';
import './LocalServerCard.scss';

const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;

export function LocalServerCard({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const status = useLocalServerStore((s) => s.status);
  const autoStart = useLocalServerStore((s) => s.autoStart);
  const [busy, setBusy] = useState(false);
  // Something else may have started or stopped it since the app opened: asked again each time the settings show it.
  useEffect(() => { void useLocalServerStore.getState().refresh(); }, []);

  const up = status.state === 'running' || status.state === 'external';
  // Its pipelines, read each time it comes up: a model installed since changes what the menus offer.
  const [pipes, setPipes] = useState<LocalPipelines>(NO_PIPELINES);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!up) {
      setPipes(NO_PIPELINES);
      return undefined;
    }
    let live = true;
    void askLocalPipelines().then((found) => { if (live) setPipes(found); });
    return () => { live = false; };
  }, [up, status.models.length]);

  if (!status.installed && status.state !== 'external') return null;

  const choose = async (name: string, change: { transcription?: string; llm?: string }) => {
    setSwitching(true);
    try {
      setPipes(await setLocalPipeline(name, change));
    } finally {
      setSwitching(false);
    }
  };
  const starting = status.state === 'starting' || (busy && !up);
  const act = async (action: 'start' | 'stop') => {
    setBusy(true);
    try {
      await useLocalServerStore.getState()[action]();
    } finally {
      setBusy(false);
    }
  };
  const stateText = starting
    ? t('fork.server.starting')
    : status.state === 'running' ? t('fork.server.running', { count: status.models.length })
      : status.state === 'external' ? t('fork.server.external', { count: status.models.length })
        : status.state === 'failed' ? t('fork.server.failed')
          : t('fork.server.stopped');

  return (
    <div className="settings-section kt-stage kt-ls">
      <h2>
        <Server size={15} className="kt-stage__icon" />
        {t('fork.server.title')}
        <Tooltip content={t('fork.server.tooltip')} position="top">{helpIcon}</Tooltip>
      </h2>

      <div className="kt-ls__row">
        <div className={`kt-ls__state kt-ls__state--${starting ? 'starting' : status.state}`} role="status">
          {starting ? <Loader size={13} className="kt-ls__spin" /> : status.state === 'failed' ? <TriangleAlert size={13} /> : <span className="kt-ls__dot" aria-hidden />}
          <span>{stateText}</span>
        </div>
        {status.state !== 'external' && (status.state === 'running' ? (
          <button type="button" className="kt-ls__button" onClick={() => { void act('stop'); }} disabled={disabled || busy}>
            <Square size={12} />{t('fork.server.stop')}
          </button>
        ) : (
          <button type="button" className="kt-ls__button kt-ls__button--primary" onClick={() => { void act('start'); }} disabled={disabled || starting}>
            <Play size={12} />{t('fork.server.start')}
          </button>
        ))}
      </div>

      {status.state === 'external' && <p className="kt-note">{t('fork.server.externalNote')}</p>}

      {status.state === 'failed' && status.tail && (
        <details className="kt-details" open>
          <summary>{t('fork.server.lastWords')}</summary>
          <pre>{status.tail}</pre>
        </details>
      )}

      {status.state !== 'external' && (
        <ToggleSwitch checked={autoStart} onChange={() => useLocalServerStore.getState().setAutoStart(!autoStart)} label={t('fork.server.autoStart')} disabled={disabled} />
      )}

      {up && pipes.pipelines.length > 0 && (
        <details className="kt-details kt-ls__pipes">
          <summary>{t('fork.server.pipelineTitle')}</summary>
          {pipes.pipelines.map((pipe) => (
            <div key={pipe.name} className="kt-ls__pipe">
              {pipes.pipelines.length > 1 && <div className="kt-ls__pipe-name">{modelLabel(pipe.name)}</div>}
              <label className="kt-ls__choice">
                <span>{t('providers.localai.hearStage')}</span>
                <select className="select-dropdown" value={pipe.transcription} onChange={(e) => { void choose(pipe.name, { transcription: e.target.value }); }} disabled={disabled || switching}>
                  {!pipes.recognizers.includes(pipe.transcription) && <option value={pipe.transcription}>{modelLabel(pipe.transcription)}</option>}
                  {pipes.recognizers.map((id) => <option key={id} value={id}>{modelLabel(id)}</option>)}
                </select>
              </label>
              <label className="kt-ls__choice">
                <span>{t('providers.localai.translateStage')}</span>
                <select className="select-dropdown" value={pipe.llm} onChange={(e) => { void choose(pipe.name, { llm: e.target.value }); }} disabled={disabled || switching}>
                  {!pipes.translators.includes(pipe.llm) && <option value={pipe.llm}>{modelLabel(pipe.llm)}</option>}
                  {pipes.translators.map((id) => <option key={id} value={id}>{modelLabel(id)}</option>)}
                </select>
              </label>
            </div>
          ))}
          {switching && <div className="kt-ls__state kt-ls__state--starting"><Loader size={13} className="kt-ls__spin" /><span>{t('fork.server.pipelineSwitching')}</span></div>}
          {!switching && pipes.ok === false && <p className="kt-ls__error">{t('fork.server.pipelineFailed', { message: pipes.error ?? '' })}</p>}
          <p className="kt-note">{t('fork.server.pipelineNote')}</p>
        </details>
      )}

      {up && (
        <button type="button" className="kt-ls__link" onClick={() => openExternalUrl(`http://127.0.0.1:${status.port}/`)}>
          <ExternalLink size={12} />{t('fork.server.openPage')}
        </button>
      )}
    </div>
  );
}
