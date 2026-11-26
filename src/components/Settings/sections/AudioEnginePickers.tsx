/**
 * Fork: two experimental choices beside the diagnostic log, for comparing on a computer where something runs slowly:
 * which audio.cpp build runs recognition and the voice (left to the app, CUDA or Vulkan), and the voice's speed mode
 * (left to the app, always or never). Offered on Windows with an NVIDIA card that can run the CUDA build: elsewhere
 * there is only one build and no speed mode. Not while a session runs: a change starts the engines again.
 */
import { useEffect, useState } from 'react';
import { Cpu, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';

type Build = 'auto' | 'cuda' | 'vulkan';
type Fast = 'auto' | 'on' | 'off';
interface AudioEngineState { cudaCapable: boolean; build: Build; fast: Fast; using: 'cuda' | 'vulkan' }

const electron = () => (window as unknown as { electron?: { invoke(channel: string, data?: unknown): Promise<unknown> } }).electron;

export function AudioEnginePickers({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AudioEngineState | null>(null);
  /** A change being made: the engines start again, and nothing else is asked meanwhile. */
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    void electron()?.invoke('audio-engine:get').then((got) => { if (!gone) setState((got as AudioEngineState | null) ?? null); }).catch(() => undefined);
    return () => { gone = true; };
  }, []);
  if (!state?.cudaCapable) return null;
  const change = (next: { build?: Build; fast?: Fast }) => {
    setBusy(true);
    void electron()?.invoke('audio-engine:set', next)
      .then((got) => { if (got) setState(got as AudioEngineState); })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const builds: Record<Build, string> = {
    auto: t('fork.engine.auto', 'Engine chosen automatically'),
    cuda: t('fork.engine.cuda', 'CUDA engine'),
    vulkan: t('fork.engine.vulkan', 'Vulkan engine'),
  };
  const fasts: Record<Fast, string> = {
    auto: t('fork.engine.fastAuto', 'Voice speed-up when there is room'),
    on: t('fork.engine.fastOn', 'Voice always sped up'),
    off: t('fork.engine.fastOff', 'Voice never sped up'),
  };
  return (
    <>
      <Tooltip content={t('fork.engine.tooltip', 'Experimental: which engine runs recognition and the voice. Automatic uses CUDA on this graphics card. A change restarts the engines, and the first switch downloads the other one.')} position="top">
        <label className="help-link help-link--picker">
          <Cpu size={13} />
          <select className="help-link__select" aria-label={t('fork.engine.label', 'Engine')} value={state.build} disabled={disabled || busy} onChange={(e) => change({ build: e.target.value as Build })}>
            {(Object.keys(builds) as Build[]).map((one) => <option key={one} value={one}>{builds[one]}</option>)}
          </select>
        </label>
      </Tooltip>
      {state.using === 'cuda' && (
        <Tooltip content={t('fork.engine.fastTooltip', 'Experimental: the voice is faster sped up, but takes about 1 GB more video memory. Automatic turns it on only when the card has room.')} position="top">
          <label className="help-link help-link--picker">
            <Zap size={13} />
            <select className="help-link__select" aria-label={t('fork.engine.fastLabel', 'Voice speed-up')} value={state.fast} disabled={disabled || busy} onChange={(e) => change({ fast: e.target.value as Fast })}>
              {(Object.keys(fasts) as Fast[]).map((one) => <option key={one} value={one}>{fasts[one]}</option>)}
            </select>
          </label>
        </Tooltip>
      )}
    </>
  );
}
