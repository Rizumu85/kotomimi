import { describe, expect, it } from 'vitest';
import en from './en/translation.json';
import zhCN from './zh_CN/translation.json';
import zhTW from './zh_TW/translation.json';

/**
 * Fork: instructions name what to click. The label they quote has to be one
 * the screen shows, in the words it shows it — a person passing them on to
 * a friend cannot guess what was meant.
 */

type Tree = { [key: string]: string | Tree };
const CATALOGS = { en, zh_CN: zhCN, zh_TW: zhTW } as unknown as Record<string, Tree>;
const at = (tree: Tree, path: string): string => {
  const found = path.split('.').reduce<string | Tree | undefined>((node, key) => (typeof node === 'object' ? node[key] : undefined), tree);
  if (typeof found !== 'string') throw new Error(`no string at ${path}`);
  return found;
};
/** Every string of the fork's own: the provider's, the `fork` groups', and the tour's fork copy. */
function forkStrings(tree: Tree): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (node: string | Tree, path: string) => {
    if (typeof node === 'string') out.push([path, node]);
    else for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };
  walk((tree.providers as Tree).localai, 'providers.localai');
  walk(tree.fork, 'fork');
  for (const [step, copy] of Object.entries((tree.tour as Tree).steps as Tree)) {
    if (typeof copy === 'object') for (const [key, value] of Object.entries(copy)) if (step.startsWith('kotomimi') || key.endsWith('_kotomimi')) walk(value, `tour.steps.${step}.${key}`);
  }
  return out;
}

describe("the fork's instructions name what the screen shows", () => {
  it('sends the other device to the block it searches in, by the name that block has', () => {
    for (const [lang, catalog] of Object.entries(CATALOGS)) {
      // The wizard and the settings never draw the provider's own choice (`ProviderPicker`: a provider with an Assist draws its own).
      const neverDrawn = at(catalog, 'providers.localai.choiceServer');
      const block = at(catalog, 'providers.localai.placeServer');
      for (const key of ['fork.lan.tooltip']) {
        expect(at(catalog, key), `${lang} ${key}`).not.toContain(neverDrawn);
        expect(at(catalog, key), `${lang} ${key}`).toContain(block);
      }
    }
  });

  it('names the Provider tab as the tab is named', () => {
    const tab = at(CATALOGS.zh_TW, 'settings.tabs.provider');
    expect(tab).toBe('提供商');
    expect(forkStrings(CATALOGS.zh_TW).filter(([, text]) => text.includes('提供者')).map(([path]) => path)).toEqual([]);
  });
});

describe("the wizard's card for this computer", () => {
  it('requires native downloads instead of promising an automatic online translator', () => {
    for (const [lang, native, download, online] of [['en', 'native model', 'download', 'online translator'], ['zh_CN', '原生模型', '下载', '在线翻译'], ['zh_TW', '原生模型', '下載', '線上翻譯']] as const) {
      for (const key of ['fork.wizard.deviceNotice', 'fork.wizard.deviceDesc']) {
        const copy = at(CATALOGS[lang], key);
        expect(copy, `${lang} ${key}`).toContain(native);
        expect(copy.toLowerCase(), `${lang} ${key}`).toContain(download);
        expect(copy, `${lang} ${key}`).not.toContain(online);
      }
    }
  });
});
