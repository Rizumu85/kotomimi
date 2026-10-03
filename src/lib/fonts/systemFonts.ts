/**
 * Fork: the fonts installed on this computer, for the font pickers, and
 * whether one of them can write a given script.
 *
 * The list comes from the Local Font Access API where the platform has it
 * (the desktop app does); elsewhere from a short list of well-known families,
 * kept to the ones a drawing test finds installed.
 *
 * Whether a font has a script's glyphs cannot be asked: it is drawn. The
 * sample is painted twice on a small canvas — in the font over a fallback,
 * and in the fallback alone — and a font that changes nothing has none of
 * those glyphs. Width alone would not tell: every font draws a Han character
 * one em wide.
 */
import { cleanFamily } from './fontCss';

interface LocalFontData { family: string }

/** Families tried when the platform cannot list its fonts: the usual ones of Windows, macOS and Linux, for Latin and CJK. */
const WELL_KNOWN = [
  'Segoe UI', 'Arial', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  'Helvetica Neue', 'Helvetica', 'SF Pro Text', 'Avenir Next', 'Menlo', 'Roboto', 'Noto Sans', 'Noto Serif', 'Ubuntu', 'DejaVu Sans',
  'Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei UI', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'DengXian',
  'Yu Gothic UI', 'Yu Gothic', 'Yu Mincho', 'Meiryo', 'Meiryo UI', 'MS Gothic', 'MS Mincho', 'BIZ UDGothic', 'BIZ UDMincho', 'UD Digi Kyokasho N',
  'Malgun Gothic', 'Batang', 'Gulim',
  'PingFang SC', 'PingFang TC', 'Hiragino Sans', 'Hiragino Mincho ProN', 'Hiragino Maru Gothic ProN', 'Apple SD Gothic Neo', 'Songti SC', 'Kaiti SC',
  'Noto Sans CJK SC', 'Noto Sans CJK TC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'Noto Serif CJK SC', 'Noto Serif CJK JP',
  'Source Han Sans SC', 'Source Han Sans JP', 'Source Han Serif SC', 'Source Han Serif JP', 'LXGW WenKai',
];

let listing: Promise<string[]> | null = null;

/** The installed families, each once, in the order a reader looks for a name. Asked once; the answer is kept. */
export function listFontFamilies(): Promise<string[]> {
  listing ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
    let families: string[] = [];
    if (typeof query === 'function') {
      try {
        families = (await query.call(window)).map((font) => font.family);
      } catch {
        // Refused, or not allowed here: the short list below.
      }
    }
    if (families.length === 0) families = WELL_KNOWN.filter((family) => canWrite(family, 'Ag') || canWrite(family, '汉あ한'));
    const unique = [...new Set(families.map(cleanFamily).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  })();
  // A refusal is not kept: opening the picker again asks again.
  listing.then((families) => { if (families.length === 0) listing = null; }, () => { listing = null; });
  return listing;
}

const SIZE = 24;
let canvas: CanvasRenderingContext2D | null | undefined;
const fallbacks = new Map<string, string>();
const verdicts = new Map<string, boolean>();

function context(): CanvasRenderingContext2D | null {
  if (canvas !== undefined) return canvas;
  try {
    const element = document.createElement('canvas');
    element.width = SIZE * 4;
    element.height = SIZE * 2;
    canvas = element.getContext('2d', { willReadFrequently: true });
  } catch {
    canvas = null;
  }
  return canvas;
}

/** The sample as drawn in a font stack: its pixels' alpha, as a string to compare. */
function drawn(ctx: CanvasRenderingContext2D, stack: string, sample: string): string {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.font = `${SIZE}px ${stack}`;
  // The alphabetic baseline sits where it is told, whatever the first font of the stack: any other baseline is
  // placed by that font's own metrics, and a font with none of the sample's glyphs would still move them.
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillText(sample, 2, SIZE * 1.3);
  const { data } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  let out = '';
  for (let i = 3; i < data.length; i += 4) out += String.fromCharCode(data[i]);
  return out;
}

/**
 * Whether `family` has glyphs of its own for `sample`. Drawn over two
 * different fallbacks: a font that is itself one of them still differs from
 * the other. Where nothing can be drawn (no canvas: a test, a worker) every
 * font is taken to write everything, so nothing is hidden.
 */
export function canWrite(family: string, sample: string): boolean {
  const name = cleanFamily(family);
  const key = `${name}\n${sample}`;
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const ctx = context();
  if (!ctx || !name) return true;
  let verdict = false;
  for (const fallback of ['monospace', 'serif']) {
    const fallbackKey = `${fallback}\n${sample}`;
    let alone = fallbacks.get(fallbackKey);
    if (alone === undefined) {
      alone = drawn(ctx, fallback, sample);
      fallbacks.set(fallbackKey, alone);
    }
    if (drawn(ctx, `"${name}", ${fallback}`, sample) !== alone) {
      verdict = true;
      break;
    }
  }
  verdicts.set(key, verdict);
  return verdict;
}
