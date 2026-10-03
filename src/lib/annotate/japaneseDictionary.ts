/**
 * The dictionary files as the app reads them: Vite emits each as an asset
 * of the build and hands back its URL, so nothing is copied by a script and
 * nothing is fetched from a CDN. About 17 MB on disk, read once, on the
 * first Japanese line a reading aid is asked for.
 */
import type { DictionaryFile } from './japaneseTokenizer';

const URLS = import.meta.glob('/node_modules/@sglkc/kuromoji/dict/*.dat.gz', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The bytes at a URL: `fetch`, and where it refuses the scheme (a packaged app's `file:`), XMLHttpRequest. */
async function bytes(url: string): Promise<ArrayBuffer> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  } catch {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.responseType = 'arraybuffer';
      request.onload = () => (request.response ? resolve(request.response as ArrayBuffer) : reject(new Error(`no data at ${url}`)));
      request.onerror = () => reject(new Error(`could not read ${url}`));
      request.send();
    });
  }
}

/** Gunzipped, unless whatever served the file already did (a dev server may, by its `Content-Encoding`). */
async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return data;
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export const appDictionaryFile: DictionaryFile = async (name) => {
  const entry = Object.entries(URLS).find(([path]) => path.endsWith(`/${name}`));
  if (!entry) throw new Error(`the Japanese dictionary has no file ${name}`);
  return gunzip(await bytes(entry[1]));
};
