// Fork: the language menus' own list, with pins.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageOption } from '../../lib/provider/types';
import { MOST_PINS, normalizePins, useLanguagePinStore } from '../../stores/languagePinStore';
import { languageRows, useLanguageMenu } from './LanguageMenu';

vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
// The store writes its pins through this, imported when first used: nothing is stored in a test.
const persisted = vi.fn();
vi.mock('../../services/persistSetting', () => ({ persistSetting: (...args: unknown[]) => persisted(...args) }));

const option = (value: string): LanguageOption => ({ value } as LanguageOption);
const ALL = ['auto', 'en', 'ja', 'ko', 'zh-CN', 'es', 'ru'].map(option);
const NAMES: Record<string, string> = { auto: '自动检测', en: '英语', ja: '日语', ko: '韩语', 'zh-CN': '简体中文', es: '西班牙语', ru: '俄语' };
const label = (code: string) => NAMES[code] ?? code;

beforeEach(() => {
  useLanguagePinStore.setState({ pins: [] });
  persisted.mockClear();
});

describe('the rows of a language menu', () => {
  it('lists what the app suggests first, then every other language, each once', () => {
    const rows = languageRows(ALL, [option('ja'), option('zh-CN')], [], label);
    expect(rows.map((r) => [r.code, r.group])).toEqual([['ja', 'suggested'], ['zh-CN', 'suggested'], ['auto', 'all'], ['en', 'all'], ['ko', 'all'], ['es', 'all'], ['ru', 'all']]);
  });

  it('puts the pinned ones above everything, in the order they were pinned, and only those this menu offers', () => {
    const rows = languageRows(ALL, [option('ja'), option('zh-CN')], ['ru', 'th', 'ja'], label);
    expect(rows.slice(0, 3).map((r) => [r.code, r.group, r.pinned])).toEqual([['ru', 'pinned', true], ['ja', 'pinned', true], ['zh-CN', 'suggested', false]]);
    expect(rows.filter((r) => r.code === 'ja')).toHaveLength(1);
    expect(rows.some((r) => r.code === 'th')).toBe(false);
  });

  it('finds a language by its name here, its English name, or its code', () => {
    expect(languageRows(ALL, [], [], label, '韩').map((r) => r.code)).toEqual(['ko']);
    expect(languageRows(ALL, [], [], label, 'span').map((r) => r.code)).toEqual(['es']);
    expect(languageRows(ALL, [], ['ru'], label, 'ru').map((r) => [r.code, r.pinned])).toEqual([['ru', true]]);
    expect(languageRows(ALL, [], [], label, 'zzz')).toEqual([]);
  });
});

describe('the pinned languages', () => {
  it('are kept in the order pinned, let go by the same press, and stored', async () => {
    useLanguagePinStore.getState().toggle('ko');
    useLanguagePinStore.getState().toggle('es');
    expect(useLanguagePinStore.getState().pins).toEqual(['ko', 'es']);
    useLanguagePinStore.getState().toggle('ko');
    expect(useLanguagePinStore.getState().pins).toEqual(['es']);
    await vi.waitFor(() => expect(persisted).toHaveBeenLastCalledWith('settings.common.pinnedLanguages', ['es']));
  });

  it('are read back held to their shape: codes, each once, and not too many', () => {
    expect(normalizePins(['ja', 'ja', 3, '', 'ko'])).toEqual(['ja', 'ko']);
    expect(normalizePins('ja')).toEqual([]);
    expect(normalizePins(Array.from({ length: 40 }, (_, i) => `l${i}`))).toHaveLength(MOST_PINS);
  });
});

function Menu({ value, onPick, disabled }: { value: string; onPick(code: string): void; disabled?: boolean }) {
  const menu = useLanguageMenu({ ordered: ALL, suggested: [option('ja')], value, onPick, label, disabled });
  return (
    <>
      <select aria-label="source" value={value} onChange={(e) => onPick(e.target.value)} disabled={disabled} {...menu.selectProps}>
        {ALL.map((o) => <option key={o.value} value={o.value}>{label(o.value)}</option>)}
      </select>
      {menu.list}
    </>
  );
}

describe('a language select with the menu', () => {
  it('opens the app\'s own list when pressed, and picks the language pressed there', () => {
    const onPick = vi.fn();
    render(<Menu value="ja" onPick={onPick} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.mouseDown(screen.getByLabelText('source'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option', { selected: true }).map((o) => o.textContent)).toContain('日语');
    fireEvent.click(screen.getByRole('option', { name: /韩语/ }));
    expect(onPick).toHaveBeenCalledWith('ko');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('still changes by the select itself: what sets its value is heard as before', () => {
    const onPick = vi.fn();
    render(<Menu value="ja" onPick={onPick} />);
    fireEvent.change(screen.getByLabelText('source'), { target: { value: 'en' } });
    expect(onPick).toHaveBeenCalledWith('en');
  });

  it('pins a language from its row without choosing it, and lists it first from then on', () => {
    const onPick = vi.fn();
    render(<Menu value="ja" onPick={onPick} />);
    fireEvent.mouseDown(screen.getByLabelText('source'));
    fireEvent.click(within(screen.getByRole('option', { name: /韩语/ })).getByRole('button'));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(useLanguagePinStore.getState().pins).toEqual(['ko']);
    expect(screen.getAllByRole('option')[0].textContent).toBe('韩语');
    expect(within(screen.getAllByRole('option')[0]).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens by the keys a select opens by, and picks with Enter', () => {
    const onPick = vi.fn();
    render(<Menu value="ja" onPick={onPick} />);
    fireEvent.keyDown(screen.getByLabelText('source'), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    // Opens on the current choice — the first row, as the app suggests it; one down is the next.
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('auto');
  });

  it('narrows as letters are typed', () => {
    render(<Menu value="ja" onPick={vi.fn()} />);
    fireEvent.mouseDown(screen.getByLabelText('source'));
    fireEvent.change(screen.getByLabelText('fork.languageMenu.search'), { target: { value: '俄' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['俄语']);
  });

  it('does not open while the select is disabled', () => {
    render(<Menu value="ja" onPick={vi.fn()} disabled />);
    fireEvent.mouseDown(screen.getByLabelText('source'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a pin made elsewhere at once', () => {
    render(<Menu value="ja" onPick={vi.fn()} />);
    fireEvent.mouseDown(screen.getByLabelText('source'));
    act(() => useLanguagePinStore.getState().toggle('ru'));
    expect(screen.getAllByRole('option')[0].textContent).toBe('俄语');
  });
});
