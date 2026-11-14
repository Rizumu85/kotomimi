# Subtitles

The strip is read at a glance over a game or a meeting, so its frame holds still and only the words move. Measured results: [`docs/fork/measurements.md`](measurements.md).

## Window

`ElectronSubtitleSurface` opens a second native window with `window.open`; `electron/subtitle-window.js` owns its place, size and pinning. The React tree stays in the main page and `SubtitleWindow` portals it across, so there is one session. Sizes go through `observeSize` (`src/components/Subtitle/surfaces/childDocument.ts`): an observer of the main page never hears the child resize.

A first open is at most 880 px wide; the minimum, 340 px (`electron/popover-windows.js`), is what the narrowest toolbar needs. The toolbar frame, fitting and click-through are desktop only.

## Lanes

Subtitle view is the default (`compactMode`); list view is the conversation list. Upstream's bands (`src/lib/subtitle/bands.ts`) stay undrawn.

`buildLanes` gives each side heard one lane, the other side's first. A lane changes only when its own side says the next sentence, so talk never pushes feedback away.

- Pair: the sentence small over its answer large. The other side's lane, or the user's when alone.
- Row: the user's lane under the other side's. Sentence, arrow, answer on one small line; approval is a tick, a correction is the sentence marked in place. Feedback beside a translation has its own line.
- A pair's small line is the answered sentence plus all said since, at most `STREAM_MOST` sentences, ending at the word being heard. When a newer sentence is answered the line restarts at it.
- A row shows its newest sentence at once; "…" means an answer is coming, only on a side answered before.
- A sentence in the reader's language is its own answer (`answersItself`). In a same-language run, speech takes the answer's place.

## What stays fixed

Layout computed from live text jumped every second, so nothing is sized by content.

- Text is always the chosen size. Too long, it loses its oldest whole line (`Slot`, `wholeLinesFrom`).
- Each text but feedback has a fixed slot, written in or not; feedback adds its row when it comes. A silent lane keeps its room.
- Lanes are centred in the box. Small lines stand on the foot of their slot, so a reading grows into kept room and the words stay put.

## Window height

- `lanesHeight` fits the window to font size and lanes, plus the toolbar's room (`BAR_ROOM`). A larger font gives a taller window, same lines.
- `subtitle:fit-height` keeps the bottom edge in place: the strip sits low and grows upward.
- Dragged smaller, spacing gives way (`spacingAt`) down to `TIGHT`, the window's minimum height.
- Dragged taller, the sentence on screen gets more lines (`linesFor`), never earlier sentences. The added height is kept (`kotomimi.subtitle.addedHeight`).
- With no run the window keeps the height the strip will have (`restingHeights`).
- No fitting while fullscreen or locked, or in list view.
- A fractional display scale reads back a size a pixel or two off. `fitGave` counts a read within `FIT_READS_WITHIN` as the size given, so starts and stops do not walk the window.

## Toolbar

The toolbar is the head of the caption box, in its own room above it (`subtitle-app--framed`), so it covers no caption. With no run it stays out, the clock at nought when ready; any other state replaces the clock. `barFit` folds it as the window narrows.

## Click-through

During a run only, the window gives every click to what is under it and the toolbar is not drawn. The way out is the toolbar's own button, shown while the pointer is over the strip.

The main process polls the cursor every 50 ms (`watchPointer`) and takes clicks only over that button. Page enter and leave events flickered, because switching mouse capture fires them.

It is never kept: opening or closing the view and the end of a run clear it, since a window found unclickable is a trap. Escape in the subtitle window leaves subtitle mode too, once the typing field and fullscreen are closed.

## Looks

`src/lib/subtitle/look.ts` has four presets. A preset writes panel, text colours, edge strength and alignment; each can then be changed.

- Edge: with a panel, a soft shadow; without, an outline as in desktop lyrics, which holds letters apart from a desktop. Ink follows the text colour (`isLight`).
- Alignment: panels left, because a growing translation would slide when centred; no panel centred, because a short line at the far left is far from the eyes.
- `hasPanel` goes by actual opacity, not the look. Without a panel there is no hairline between lanes.

Each side shows source, translation, both or off.

## Reading aids

- Slots keep room for aids. `plannedRoom` plans it from the language pair, so the first answer does not raise the window; `useRoom` keeps it while the switch is on.
- Each sentence uses its own language. Romanization sits under stretches split at spaces and between Japanese words (`romanStretches`).
- `romanization` is the master switch; `romanizationOff` turns off ja, ko, ru or uk.

## Sentence by sentence

A recognizer closes a stretch at a pause (1.4 s) or its longest turn (15 s by default). With `translateBySentence` on (the default), a translating leg closes finished sentences as they come. Sound is not cut, only text; off, a stretch is translated whole.

A closed caption cannot be taken back, so right beats early. `cutAt` (`src/providers/openai/sentenceCut.ts`) cuts only:

- at a sentence end (`src/lib/segmentation/sentenceEnd.ts`), never at a comma or a pause: half a Japanese sentence has no verb yet;
- with about two seconds said after it (`PIECE_LEAST_DENSE`, `PIECE_LEAST`), because recognizers rewrite their newest words and end any partial on a full stop;
- with as much before it, so short sentences join the next;
- once the text has stood unchanged for `SETTLE_MS`.

Each piece is a segment of its own (`kotomimi_piece_N`), so answers pair one to one, and has its own language (`pieceLanguage`): its writing's where that settles it, else the stretch's. What is closed stands; `restFrom` finds the rest by the closed text's last letters. A rest with no letters makes no caption.

`cutsSentences` excludes a coached leg, feedback beside translation, paired recognition and a leg with no stage. A recognizer that writes little punctuation (R2T2) stays whole.

## Ending a turn early

`src/providers/openai/nativeAsr.ts` ends a stretch at a 500 ms pause when its text closes a sentence (`endsTurn`, `turnEnd.ts`: words decide, since partials end on a full stop anywhere) or the voice sounds finished (Smart Turn, asked by the detector's worker of the stretch's last 8 s). Others wait out the whole pause. If the speaker goes on (`resume`), a new recognition begins; the detector is not reset, since recognizing the silence after wrote phantom sentences.

## Translation context

A request carries only its sentence, except Hunyuan MT's Chinese form (`wrapAfter` in `src/providers/openai/nativeTranslators.ts`), which adds this side's sentence before: within 15 s, its last 120 characters (`src/providers/openai/pipeline.ts`). Index-Translate is asked alone: given context it sometimes translated the earlier sentence.

## How long a translation stays

`src/lib/subtitle/dwell.ts`, clock in `useHeld`. A pair's answer stays until read, by its length and language, within 1.2 to 2.5 s. A hold only delays the next caption, so it is bounded: with more than one waiting each gets 1.2 s, and three or more behind jumps to the one before the newest. The small line and the row are not held.

## Glossary

Up to 50 hand-kept rows (`src/lib/glossary/glossary.ts`): a word, and what it was misheard as. Qwen3-ASR gets the words (`takesContext`), some cloud providers a list or prompt; Apple Speech gets none. Misheard forms are folded in before translation (`PipelineLeg.complete`) and for display (`Run.glossaryEvent`). `WordFix.tsx` adds a word from a selection in the main list; it holds from the next sentence.

## Limits

- Most translators see no earlier context, and Japanese omits subjects.
- The 15 s turn cuts anywhere.
- A centred line still growing moves sideways.
