// src/vr/Wrist.tsx
/**
 * Fork: the wrist panel, a window on the desktop that a wrist tool such as
 * XSOverlay carries on a wrist (`electron/vr-overlay.js`); its presses arrive
 * as the tool's clicks. Its first page is what a conversation in VRChat needs
 * at hand: whether each side is heard, the last few lines, the other side's
 * language, and stopping, hiding the strip, VRChat's chatbox, or turning to
 * the second page — the user's own language and this computer's models, each
 * with how it ran in this session, under the headset's frame rate and the
 * card's memory, for trying a model out while playing.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, Eye, EyeOff, MessageSquare, MessageSquareOff, MicOff, Pause, Play, SlidersHorizontal } from 'lucide-react';
import { fill, send } from './bridge';
import type { VrModel, VrPerf, VrState, VrWords } from './types';

const ICON = 18;

function Dots({ state }: { state: VrState }) {
  const { words, heard } = state;
  return (
    <div className="status">
      <span className={`heard${state.muted ? ' is-muted' : ''}`}>
        <span className={`dot dot--me${heard?.speaker ? ' is-on' : ''}`} />
        <span>{words.me}</span>
      </span>
      <span className="heard">
        <span className={`dot dot--them${heard?.participant ? ' is-on' : ''}`} />
        <span>{words.them}</span>
      </span>
      {state.failed && state.phase === 'idle' ? (
        <span className="status__right is-error">{words.stoppedShort}</span>
      ) : state.phase === 'idle' ? (
        <span className="status__right">{words.idle}</span>
      ) : state.muted ? (
        <span className="status__right"><MicOff size={ICON} />{words.muted}</span>
      ) : null}
    </div>
  );
}

function Recent({ state }: { state: VrState }) {
  return (
    <div className="recent">
      {state.lines.slice(-3).map((line) => (line.leg === 'speaker' ? (
        <div key={line.id} className="line line--mine"><span className="line__who">{state.words.me} · </span>{line.source}</div>
      ) : (
        <div key={line.id} className="line">
          {line.translation ? <small>{line.source}</small> : null}
          {line.translation || line.source}
        </div>
      )))}
    </div>
  );
}

function Main({ state, onTune }: { state: VrState; onTune: () => void }) {
  const { words, theirs } = state;
  const [more, setMore] = useState(false);
  const label = (value: string) => theirs.options.find((o) => o.value === value)?.label ?? value;
  const pick = (value: string) => {
    setMore(false);
    if (value !== theirs.value) send({ type: 'theirs', value });
  };
  const running = state.phase !== 'idle';
  return (
    <>
      <Dots state={state} />
      {more ? null : <Recent state={state} />}
      <div className="lang">
        <div className="lang__head">{words.theirs}<b>{label(theirs.value)}</b></div>
        <div className="chips">
          {theirs.quick.map((value) => (
            <button key={value} type="button" className={`chip${value === theirs.value && !more ? ' is-on' : ''}`} onClick={() => pick(value)}>{label(value)}</button>
          ))}
          <button type="button" className={`chip${more ? ' is-open' : ''}`} aria-label={words.more} onClick={() => setMore(!more)}>…</button>
        </div>
        {more ? (
          <div className="more">
            {theirs.options.map((o) => (
              <button key={o.value} type="button" className={`chip${o.value === theirs.value ? ' is-on' : ''}`} onClick={() => pick(o.value)}>{o.label}</button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="actions">
        <button type="button" className="act" onClick={() => send({ type: 'run', on: !running })}>
          {running ? <><Pause size={ICON} />{words.pause}</> : <><Play size={ICON} />{words.resume}</>}
        </button>
        <button type="button" className="act" onClick={() => send({ type: 'strip', on: !state.strip })}>
          {state.strip ? <><EyeOff size={ICON} />{words.hide}</> : <><Eye size={ICON} />{words.show}</>}
        </button>
        <button type="button" className={`act${state.chatbox ? ' is-on' : ''}`} aria-pressed={state.chatbox} onClick={() => send({ type: 'chatbox', on: !state.chatbox })}>
          {state.chatbox ? <MessageSquare size={ICON} /> : <MessageSquareOff size={ICON} />}{words.chatbox}
        </button>
        <button type="button" className="act" onClick={onTune}><SlidersHorizontal size={ICON} />{words.tune}</button>
      </div>
    </>
  );
}

function Rows({ list, value, kind, state }: { list: VrModel[]; value: string; kind: 'hear' | 'translate'; state: VrState }) {
  const { words } = state;
  const loading = state.switching?.kind === kind ? state.switching.label : null;
  return (
    <div className="rows">
      {list.map((m) => {
        const isLoading = m.label === loading;
        const speed = isLoading ? words.loading
          : m.ms === undefined ? words.untried
          : fill(kind === 'hear' ? words.behind : words.perSentence, { s: (m.ms / 1000).toFixed(1) });
        const slow = !isLoading && m.ms !== undefined && m.ms > (kind === 'hear' ? 2500 : 1500);
        return (
          <button key={m.id} type="button" className={`row${isLoading ? ' is-loading' : m.id === value ? ' is-on' : ''}`}
            onClick={() => { if (m.id !== value && !state.switching) send({ type: kind, id: m.id }); }}>
            <span>{m.label}</span>
            <span className={`row__speed${slow ? ' is-slow' : ''}`}>{speed}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The headset's frame rate and the card's memory; a warning when frames are missed. */
function Perf({ perf, words }: { perf: VrPerf | null; words: VrWords }) {
  if (!perf) return null;
  const shown = perf.presents !== undefined ? Math.max(0, perf.presents - (perf.reprojected ?? 0)) : null;
  const dropping = shown !== null && perf.hz > 0 && shown < perf.hz * 0.9;
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return (
    <div className={`perf${dropping ? ' is-warn' : ''}`}>
      {shown !== null ? <span>{fill(words.fps, { fps: Math.round(shown) })}{dropping ? ` · ${words.dropping}` : ''}</span> : null}
      {shown !== null && perf.vramTotal > 0 ? <span className="perf__sep">·</span> : null}
      {perf.vramTotal > 0 ? <span>{fill(words.vram, { used: gb(perf.vramUsed), total: Math.round(perf.vramTotal / 1024 ** 3) })}</span> : null}
    </div>
  );
}

function Tune({ state, perf, onBack }: { state: VrState; perf: VrPerf | null; onBack: () => void }) {
  const { words, mine } = state;
  return (
    <>
      <div className="tune__top">
        <button type="button" className="tune__back" onClick={onBack}><ChevronLeft size={ICON} />{words.back}</button>
        <span className="tune__title">{words.tune}</span>
      </div>
      <div className="group">
        <div className="group__head">{words.mine}</div>
        <div className="chips chips--mine">
          {mine.options.map((o) => (
            <button key={o.value} type="button" className={`chip${o.value === mine.value ? ' is-on' : ''}`}
              onClick={() => { if (o.value !== mine.value) send({ type: 'mine', value: o.value }); }}>{o.label}</button>
          ))}
        </div>
      </div>
      {state.hear.options.length > 0 ? (
        <div className="group"><div className="group__head">{words.hear}</div><Rows list={state.hear.options} value={state.hear.value} kind="hear" state={state} /></div>
      ) : null}
      {state.translate.options.length > 0 ? (
        <div className="group"><div className="group__head">{words.translate}</div><Rows list={state.translate.options} value={state.translate.value} kind="translate" state={state} /></div>
      ) : null}
      <Perf perf={perf} words={words} />
    </>
  );
}

export default function Wrist({ state, perf }: { state: VrState; perf: VrPerf | null }) {
  const [tune, setTune] = useState(false);
  // The window's title: what a wrist tool lists it by.
  useEffect(() => { document.title = state.words.panel; }, [state.words.panel]);
  return (
    <div className="wrist">
      {tune ? <Tune state={state} perf={perf} onBack={() => setTune(false)} /> : <Main state={state} onTune={() => setTune(true)} />}
    </div>
  );
}
