#!/usr/bin/env node
/**
 * Fork: turns one logo picture into every icon file the app ships.
 *
 *   node scripts/fork-make-icons.cjs <logo.png> [--keep-background]
 *
 * The picture is a drawing on a plain light background (what an image model
 * hands back when asked for a logo). The background is taken out — flooded
 * from the picture's edges, so light areas inside the drawing stay — the
 * drawing is cropped to its own bounds, centred on a transparent square with
 * a small margin, and written at every size each platform asks for:
 *
 *   assets/icon.ico      Windows executable, installer, window and taskbar
 *   assets/icon.icns     macOS application
 *   assets/icon.png      Linux packages, the About dialog
 *   public/favicon.ico, public/logo192.png, public/logo512.png
 *   src/assets/kotomimi.png   the mark inside the app
 *
 * `--keep-background` skips the removal, for a picture that is already
 * transparent or is meant to fill its square.
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const [input, ...flags] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/fork-make-icons.cjs <logo.png> [--keep-background]');
  process.exit(1);
}

/** How dark a pixel is, 0 (white) to 1 (black). */
const darkness = (r, g, b) => 1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255;
/** Lighter than this, and reachable from the picture's edge: background, or the soft edge of the drawing's outline against it. */
const OUTLINE = 0.55;

/**
 * The background made transparent. A flood from the four edges passes through
 * every pixel lighter than the outline; what it reaches gets the outline's
 * colour and an alpha by how dark it was, so the anti-aliased rim of the
 * outline fades out instead of keeping a white halo.
 */
function removeBackground(data, width, height) {
  const reached = new Uint8Array(width * height);
  const stack = [];
  const visit = (x, y) => {
    const i = y * width + x;
    if (reached[i]) return;
    const p = i * 4;
    if (data[p + 3] > 0 && darkness(data[p], data[p + 1], data[p + 2]) >= OUTLINE) return;
    reached[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x += 1) { visit(x, 0); visit(x, height - 1); }
  for (let y = 0; y < height; y += 1) { visit(0, y); visit(width - 1, y); }
  while (stack.length > 0) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) visit(x - 1, y);
    if (x < width - 1) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y < height - 1) visit(x, y + 1);
  }
  // The outline's colour: the average of the dark pixels that border what the flood reached.
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (reached[i] || !(reached[i - 1] || reached[i + 1] || reached[i - width] || reached[i + width])) continue;
      const p = i * 4;
      r += data[p]; g += data[p + 1]; b += data[p + 2]; n += 1;
    }
  }
  const outline = n > 0 ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
  const outlineDarkness = Math.max(darkness(...outline), OUTLINE);
  for (let i = 0; i < width * height; i += 1) {
    if (!reached[i]) continue;
    const p = i * 4;
    const alpha = Math.min(1, darkness(data[p], data[p + 1], data[p + 2]) / outlineDarkness);
    // Faint tints of the background are background: only the rim of the outline keeps any ink.
    data[p + 3] = alpha < 0.08 ? 0 : Math.round(alpha * data[p + 3]);
    data[p] = outline[0]; data[p + 1] = outline[1]; data[p + 2] = outline[2];
  }
  return { outline, cleared: reached.reduce((sum, v) => sum + v, 0) };
}

/** An .ico of these PNGs: 256 px as PNG, the smaller ones as 32-bit bitmaps, which every Windows tool reads. */
async function ico(master, sizes) {
  const entries = [];
  for (const size of sizes) {
    const image = master.clone().resize(size, size, { kernel: 'lanczos3' });
    if (size >= 256) {
      entries.push({ size, data: await image.png({ compressionLevel: 9 }).toBuffer() });
      continue;
    }
    const raw = await image.raw().toBuffer();
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8); // colour rows and mask rows
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = ((size - 1 - y) * size + x) * 4; // bottom-up
        const to = (y * size + x) * 4;
        pixels[to] = raw[from + 2]; pixels[to + 1] = raw[from + 1]; pixels[to + 2] = raw[from]; pixels[to + 3] = raw[from + 3];
      }
    }
    const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: the alpha channel decides
    entries.push({ size, data: Buffer.concat([header, pixels, mask]) });
  }
  const directory = Buffer.alloc(6 + 16 * entries.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + 16 * index;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

/** An .icns of PNG entries, 16 pt to 512 pt at 1x and 2x. */
async function icns(master) {
  const types = [['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
  const chunks = [];
  for (const [type, size] of types) {
    const data = await master.clone().resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

(async () => {
  const source = sharp(path.resolve(input)).ensureAlpha();
  const { data, info } = await source.raw().toBuffer({ resolveWithObject: true });
  if (!flags.includes('--keep-background')) {
    const { outline, cleared } = removeBackground(data, info.width, info.height);
    console.log(`background removed: ${Math.round((cleared / (info.width * info.height)) * 100)}% of the picture; outline colour rgb(${outline.join(', ')})`);
  }
  // The drawing alone, then centred on a square with a 1% margin each side — only enough that the outline's soft edge is not clipped.
  // An icon is shown at 16 to 48 px with the system's own padding around it: none of that little size is spent on air.
  const drawing = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
  const side = Math.max(drawing.info.width, drawing.info.height);
  const canvas = Math.round(side / 0.98);
  const master = sharp(await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: drawing.data, gravity: 'centre' }]).png().toBuffer()).resize(1024, 1024, { kernel: 'lanczos3' });
  const masterPng = sharp(await master.png().toBuffer());

  const png = (size) => masterPng.clone().resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
  const out = {
    'assets/icon.png': await png(512),
    'assets/icon.ico': await ico(masterPng, [256, 128, 64, 48, 32, 24, 16]),
    'assets/icon.icns': await icns(masterPng),
    'public/favicon.ico': await ico(masterPng, [64, 32, 24, 16]),
    'public/logo192.png': await png(192),
    'public/logo512.png': await png(512),
    'src/assets/kotomimi.png': await png(256),
  };
  for (const [file, bytes] of Object.entries(out)) {
    fs.writeFileSync(path.join(root, file), bytes);
    console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
