/**
 * Fork: the voice rows of a model that speaks in the user's own voice: what they offer while there is none, how one
 * is added (read aloud, or imported), chosen, handed on and removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CLIP_RATE, readAloud } from '../../lib/voice/clip';
import { useVoiceLibraryStore, type LibraryVoice } from '../../stores/voiceLibraryStore';
import { VOICE_DEFAULTS, type VoiceChoice } from './localaiVoice';
import { VoiceRows } from './VoiceRows';

const recorded = vi.hoisted(() => ({ pcm: new Int16Array(0), stops: 0, cancels: 0, deviceId: undefined as string | undefined, fails: false, opening: null as Promise<void> | null }));
vi.mock('../../lib/voice/recordClip', () => ({
  recordClip: async (deviceId?: string) => {
    if (recorded.fails) throw new Error('denied');
    if (recorded.opening) await recorded.opening;
    recorded.deviceId = deviceId;
    return { level: () => 0.4, stop: async () => { recorded.stops += 1; return recorded.pcm; }, cancel: () => { recorded.cancels += 1; } };
  },
  fileClip: async () => recorded.pcm,
  FILE_MOST_BYTES: 30 * 1024 * 1024,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, options?: unknown) => (options && typeof options === 'object' && 'name' in options ? `${key}:${(options as { name: string }).name}` : key), i18n: { language: 'en' } }),
}));

const BASE = 'qwen3-tts-1.7b-base-q8';
const MINE: VoiceChoice = { ...VOICE_DEFAULTS, on: true, at: 'device', nativeModel: BASE };
const voice = (id: string, name: string, language = 'zh', more: string[] = []): LibraryVoice => ({ id, name, text: 'x', language, seconds: 5, createdAt: 1, languages: [language, ...more] });
/** `seconds` of a voice: a tone loud enough to be one. */
const spoken = (seconds: number) => Int16Array.from({ length: Math.round(seconds * CLIP_RATE) }, (_one, i) => Math.round(9000 * Math.sin(i / 12)));

const library = { add: vi.fn(), addPack: vi.fn(), remove: vi.fn(async () => {}), removeTake: vi.fn(async () => {}), rename: vi.fn(async () => {}), export: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
beforeEach(() => {
  for (const one of Object.values(library)) one.mockClear();
  recorded.pcm = spoken(9);
  recorded.stops = 0;
  recorded.cancels = 0;
  recorded.fails = false;
  recorded.opening = null;
  useVoiceLibraryStore.setState({ voices: [], asked: true, ...library });
});
afterEach(cleanup);

function draw(choice: VoiceChoice = MINE, languages = ['ja', 'en'], disabled = false) {
  const onChange = vi.fn();
  render(<VoiceRows choice={choice} languages={languages} ownLanguage="zh-CN" placeName="Qwen3-TTS 1.7B Base" onChange={onChange} disabled={disabled} />);
  return { onChange };
}

describe('the voices of a model that speaks in the user’s own', () => {
  it('offers only the way to add one while there is none', () => {
    draw();
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.getByRole('button', { name: 'fork.voice.addVoice' })).toBeTruthy();
  });

  it('asks the library what there is, once, where nothing has yet', () => {
    useVoiceLibraryStore.setState({ asked: false });
    draw();
    expect(library.refresh).toHaveBeenCalledTimes(1);
  });

  it('offers the user’s voices for each language, the one for every language where none is its own', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音'), voice('bbb222', '朋友')] });
    const chosen = { ...MINE, voices: { [BASE]: { '*': 'aaa111', en: 'bbb222' } } };
    const { onChange } = draw(chosen);
    const [japanese, english] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect([...japanese.options].map((option) => option.textContent)).toEqual(['我的声音', '朋友']);
    expect([japanese.value, english.value]).toEqual(['aaa111', 'bbb222']);
    fireEvent.change(japanese, { target: { value: 'bbb222' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'aaa111', en: 'bbb222', ja: 'bbb222' } } }));
  });

  it('is the choice itself: one voice reads with no menu and no mark, and one that is not chosen yet offers its mark', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    const first = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    // The one voice there is, chosen: nothing to choose among.
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(first.onChange).not.toHaveBeenCalled();
    cleanup();
    // One that was removed is no voice chosen: the voice there is can be taken with one press.
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { ja: 'gone00' } } });
    const mark = screen.getByRole('radio', { name: 'fork.voice.useVoice:我的声音' });
    expect(mark.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(mark);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'aaa111' } } }));
  });

  it('marks the one of several that reads, and changes it with a press: every language at once', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音'), voice('bbb222', '朋友')] });
    // One language read: the marks are all the choice there is.
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111', en: 'bbb222' } } }, ['ja']);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    const [mine, friend] = screen.getAllByRole('radio');
    expect([mine.getAttribute('aria-checked'), friend.getAttribute('aria-checked')]).toEqual(['true', 'false']);
    expect((mine.closest('.kt-myvoices__voice') as HTMLElement).className).toContain('is-chosen');
    fireEvent.click(mine);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(friend);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'bbb222' } } }));
  });

  it('samples each voice in itself, whichever is chosen', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音'), voice('bbb222', '朋友')] });
    draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } }, ['ja']);
    expect(screen.getAllByRole('button', { name: 'fork.voice.sample' })).toHaveLength(2);
  });

  it('saves one as a file, and removes one with every use of it', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    library.remove.mockImplementationOnce(async () => { useVoiceLibraryStore.setState({ voices: [] }); });
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111', ja: 'aaa111' } } });
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.exportVoice:我的声音' }));
    expect(library.export).toHaveBeenCalledWith('aaa111');
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.removeVoice:我的声音' }));
    expect(library.remove).toHaveBeenCalledWith('aaa111');
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: {} } })));
  });

  it('is called by another name where its name is pressed and typed over: kept on Enter or on leaving, not on Escape', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    const press = () => fireEvent.click(screen.getByRole('button', { name: 'fork.voice.renameVoice:我的声音' }));
    const typing = () => screen.getByRole('textbox', { name: 'fork.voice.voiceName' }) as HTMLInputElement;
    press();
    expect(typing().value).toBe('我的声音');
    fireEvent.change(typing(), { target: { value: '  平时的声音 ' } });
    fireEvent.keyDown(typing(), { key: 'Enter' });
    expect(library.rename).toHaveBeenCalledWith('aaa111', '平时的声音');
    expect(screen.queryByRole('textbox', { name: 'fork.voice.voiceName' })).toBeNull();
    // Left with another name typed: kept too.
    press();
    fireEvent.change(typing(), { target: { value: '唱歌的声音' } });
    fireEvent.blur(typing());
    expect(library.rename).toHaveBeenLastCalledWith('aaa111', '唱歌的声音');
    // Escape, a blank name, or the same name: nothing is asked.
    library.rename.mockClear();
    press();
    fireEvent.change(typing(), { target: { value: '别的' } });
    fireEvent.keyDown(typing(), { key: 'Escape' });
    press();
    fireEvent.change(typing(), { target: { value: '   ' } });
    fireEvent.keyDown(typing(), { key: 'Enter' });
    press();
    fireEvent.keyDown(typing(), { key: 'Enter' });
    expect(library.rename).not.toHaveBeenCalled();
  });

  it('takes in a voice someone handed over as a file, with one press, and says so of a file that is no voice', async () => {
    library.addPack.mockImplementationOnce(async () => { useVoiceLibraryStore.setState({ voices: [voice('fff666', '朋友')] }); return { ok: true, voice: voice('fff666', '朋友') }; });
    const { onChange } = draw();
    expect(screen.getByRole('button', { name: 'fork.voice.importVoice' })).toBeTruthy();
    const picker = document.querySelector('input[type="file"][accept=".kotovoice"]') as HTMLInputElement;
    const file = (name: string) => Object.assign(new File(['{}'], name), { arrayBuffer: async () => new ArrayBuffer(2) });
    await act(async () => { fireEvent.change(picker, { target: { files: [file('朋友.kotovoice')] } }); });
    await waitFor(() => expect(library.addPack).toHaveBeenCalledTimes(1));
    // The first voice there is reads every language.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'fff666' } } })));
    library.addPack.mockResolvedValueOnce({ ok: false, code: 'voice_unreadable' });
    await act(async () => { fireEvent.change(picker, { target: { files: [file('别的.kotovoice')] } }); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('fork.voice.clipUnreadable'));
  });

  it('has a voice that is left read in place of the one removed', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音'), voice('bbb222', '朋友')] });
    library.remove.mockImplementationOnce(async () => { useVoiceLibraryStore.setState({ voices: [voice('bbb222', '朋友')] }); });
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } }, ['ja']);
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.removeVoice:我的声音' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'bbb222' } } })));
  });

  it('keeps one chosen that could not be removed', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.removeVoice:我的声音' }));
    await waitFor(() => expect(library.remove).toHaveBeenCalledWith('aaa111'));
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds and removes none while a session runs, though a language’s voice can still be chosen', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音'), voice('bbb222', '朋友')] });
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } }, ['ja', 'en'], true);
    expect((screen.getByRole('button', { name: 'fork.voice.addVoice' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'fork.voice.removeVoice:朋友' }) as HTMLButtonElement).disabled).toBe(true);
    // The run goes on in the voice chosen: by its mark, or for one language by that language's menu.
    for (const menu of screen.getAllByRole('combobox')) expect((menu as HTMLSelectElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'fork.voice.useVoice:朋友' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'bbb222' } } }));
  });
});

describe('adding a voice', () => {
  const open = (choice?: VoiceChoice) => {
    const drawn = draw(choice);
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.addVoice' }));
    return { ...drawn, dialog: within(screen.getByRole('dialog')) };
  };

  it('shows a sentence in the user’s own language to read aloud, and keeps the reading with those words', async () => {
    const added = voice('ccc333', 'fork.voice.myVoice');
    library.add.mockResolvedValue({ ok: true, voice: added });
    const { dialog, onChange } = open();
    expect(dialog.getByText(readAloud('zh-CN').text)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    expect(library.add).toHaveBeenCalledTimes(1);
    const kept = library.add.mock.calls[0][0] as { name: string; text: string; language: string; wav: Uint8Array };
    expect(kept).toMatchObject({ name: 'fork.voice.myVoice', text: readAloud('zh-CN').text, language: 'zh' });
    expect(String.fromCharCode(...kept.wav.subarray(0, 4))).toBe('RIFF');
    // The first voice added reads every language, and the dialog is gone.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'ccc333' } } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps no reading that is too short or silent, and says why', async () => {
    recorded.pcm = spoken(1);
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(dialog.getByRole('status').textContent).toBe('fork.voice.clipTooShort'));
    expect(dialog.queryByRole('button', { name: 'fork.voice.saveVoice' })).toBeNull();
  });

  it('says so where the microphone cannot be opened', async () => {
    recorded.fails = true;
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('status').textContent).toBe('fork.voice.micDenied'));
  });

  it('takes a recording from a file, with its words where they are typed, by the file’s name', async () => {
    library.add.mockResolvedValue({ ok: true, voice: voice('ddd444', 'training-clip') });
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.wayImport' }));
    const picker = screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(picker, { target: { files: [new File(['sound'], 'training-clip.wav', { type: 'audio/wav' })] } }); });
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    expect((dialog.getByRole('textbox', { name: 'fork.voice.voiceName' }) as HTMLInputElement).value).toBe('training-clip');
    fireEvent.change(dialog.getByRole('textbox', { name: 'fork.voice.clipWords' }), { target: { value: ' 今天天气真好。 ' } });
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    // Its language is the user's own unless another is chosen for it.
    expect(library.add.mock.calls[0][0]).toMatchObject({ name: 'training-clip', text: '今天天气真好。', language: 'zh' });
  });

  it('will not keep a long recording with words typed for it, and keeps it without', async () => {
    recorded.pcm = spoken(18);
    library.add.mockResolvedValue({ ok: true, voice: voice('eee555', 'long') });
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.wayImport' }));
    await act(async () => { fireEvent.change(screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['sound'], 'long.mp3')] } }); });
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    fireEvent.change(dialog.getByRole('textbox', { name: 'fork.voice.clipWords' }), { target: { value: '很长的一段话' } });
    expect(dialog.getByRole('status').textContent).toBe('fork.voice.clipTooLong');
    expect((dialog.getByRole('button', { name: 'fork.voice.saveVoice' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByRole('textbox', { name: 'fork.voice.clipWords' }), { target: { value: '' } });
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    expect(library.add.mock.calls[0][0]).toMatchObject({ text: '' });
  });

  it('offers the languages the model speaks for a new voice, and shows the long sentence of the one chosen', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    library.add.mockResolvedValue({ ok: true, voice: voice('jjj999', 'fork.voice.myVoice', 'ja') });
    const { dialog, onChange } = open({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    const picker = dialog.getByRole('combobox', { name: 'fork.voice.clipLanguage' }) as HTMLSelectElement;
    expect(picker.value).toBe('zh');
    expect([...picker.options].map((option) => option.value)).toEqual(expect.arrayContaining(['zh', 'ja', 'en', 'ko']));
    fireEvent.change(picker, { target: { value: 'ja' } });
    expect(dialog.getByText(readAloud('ja').text)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    const kept = library.add.mock.calls[0][0] as Record<string, unknown>;
    expect(kept).toMatchObject({ name: 'fork.voice.myVoice', text: readAloud('ja').text, language: 'ja' });
    expect(kept).not.toHaveProperty('to');
    // Another voice: chosen where it is wanted, by hand.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a recording for each language read in one sitting, and saves them as one voice', async () => {
    const made = voice('ccc333', 'fork.voice.myVoice');
    library.add.mockResolvedValueOnce({ ok: true, voice: made }).mockResolvedValueOnce({ ok: true, voice: voice('ccc333', 'fork.voice.myVoice', 'zh', ['ja']) });
    const { dialog, onChange } = open();
    const read = async () => {
      fireEvent.click(dialog.getByRole('button', { name: /fork\.voice\.record(Again)?$/ }));
      await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
      fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
      await waitFor(() => expect(dialog.queryByRole('button', { name: 'fork.voice.stopRecording' })).toBeNull());
    };
    const picker = () => dialog.getByRole('combobox', { name: 'fork.voice.clipLanguage' }) as HTMLSelectElement;
    await read();
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    // Another language: the one made stays, and what is read now is the short sentence.
    fireEvent.change(picker(), { target: { value: 'ja' } });
    expect(dialog.getByText(readAloud('ja', 'short').text)).toBeTruthy();
    expect(document.querySelectorAll('.kt-addvoice__take')).toHaveLength(1);
    await read();
    await waitFor(() => expect(document.querySelectorAll('.kt-addvoice__take')).toHaveLength(2));
    // Gone back to, the first is still the voice's own: its long sentence, to be read again.
    fireEvent.click(document.querySelector('.kt-addvoice__take button') as HTMLElement);
    expect(picker().value).toBe('zh');
    expect(dialog.getByText(readAloud('zh').text)).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'fork.voice.recordAgain' })).toBeTruthy();
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    expect(library.add).toHaveBeenCalledTimes(2);
    const [own, more] = library.add.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(own).toMatchObject({ name: 'fork.voice.myVoice', language: 'zh', text: readAloud('zh').text });
    expect(own).not.toHaveProperty('to');
    expect(more).toMatchObject({ language: 'ja', text: readAloud('ja', 'short').text, to: 'ccc333' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'ccc333' } } }));
  });

  it('takes one away from what was made, and keeps nothing until something is', async () => {
    const { dialog } = open();
    expect(dialog.queryByRole('button', { name: 'fork.voice.saveVoice' })).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(document.querySelectorAll('.kt-addvoice__take')).toHaveLength(1));
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.removeTake:fork.voice.myVoice' }));
    expect(document.querySelectorAll('.kt-addvoice__take')).toHaveLength(0);
    expect(dialog.queryByRole('button', { name: 'fork.voice.saveVoice' })).toBeNull();
    expect(dialog.getByRole('button', { name: 'fork.voice.record' })).toBeTruthy();
  });

  it('adds to a voice a recording in another language: a short sentence in a language the run reads, kept as that voice\'s', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    library.add.mockResolvedValue({ ok: true, voice: voice('aaa111', '我的声音', 'zh', ['ja']) });
    // Shorter than a voice's first recording may be: it is only spoken on from.
    recorded.pcm = spoken(4);
    const { onChange } = draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.addTake:我的声音' }));
    const dialog = within(screen.getByRole('dialog'));
    // The run reads Japanese and English, and the voice has neither: the first is offered.
    expect((dialog.getByRole('combobox', { name: 'fork.voice.clipLanguage' }) as HTMLSelectElement).value).toBe('ja');
    expect(dialog.getByText(readAloud('ja', 'short').text)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    // It is that voice's: no name is asked.
    expect(dialog.queryByRole('textbox', { name: 'fork.voice.voiceName' })).toBeNull();
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    expect(library.add.mock.calls[0][0]).toMatchObject({ text: readAloud('ja', 'short').text, language: 'ja', to: 'aaa111' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The voice is the same one: nothing chosen changes.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('takes an imported recording more only with its words', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    library.add.mockResolvedValue({ ok: true, voice: voice('aaa111', '我的声音', 'zh', ['ja']) });
    draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.addTake:我的声音' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.wayImport' }));
    await act(async () => { fireEvent.change(screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['sound'], 'japanese.mp3')] } }); });
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    expect((dialog.getByRole('button', { name: 'fork.voice.saveVoice' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByRole('textbox', { name: 'fork.voice.clipWordsNeeded' }), { target: { value: '今日はいい天気ですね。' } });
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    expect(library.add.mock.calls[0][0]).toMatchObject({ text: '今日はいい天気ですね。', language: 'ja', to: 'aaa111' });
  });

  it('shows the languages a voice has a recording in, and takes one away but for the first', () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音', 'zh', ['ja'])] });
    draw({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    const chip = screen.getByRole('button', { name: 'fork.voice.renameVoice:我的声音' }).closest('.kt-myvoices__voice') as HTMLElement;
    expect([...chip.querySelectorAll('.kt-myvoices__lang')].map((one) => one.tagName)).toEqual(['SPAN', 'BUTTON']);
    fireEvent.click(screen.getByRole('button', { name: 'fork.voice.removeTake:我的声音' }));
    expect(library.removeTake).toHaveBeenCalledWith('aaa111', 'ja');
  });

  it('leaves a second recording in the first one\'s language to be chosen by hand', async () => {
    useVoiceLibraryStore.setState({ voices: [voice('aaa111', '我的声音')] });
    library.add.mockResolvedValue({ ok: true, voice: voice('kkk000', '朋友') });
    const { dialog, onChange } = open({ ...MINE, voices: { [BASE]: { '*': 'aaa111' } } });
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.stopRecording' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })).toBeTruthy());
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.saveVoice' })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds a voice someone handed over as it is', async () => {
    library.addPack.mockResolvedValue({ ok: true, voice: voice('fff666', '朋友') });
    const { dialog, onChange } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.wayImport' }));
    await act(async () => { fireEvent.change(screen.getByRole('dialog').querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [Object.assign(new File(['{}'], '朋友.kotovoice'), { arrayBuffer: async () => new ArrayBuffer(2) })] } }); });
    await waitFor(() => expect(library.addPack).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ voices: { [BASE]: { '*': 'fff666' } } }));
  });

  it('lets go a microphone that opens only after it was closed', async () => {
    let opened = () => {};
    recorded.opening = new Promise<void>((resolve) => { opened = resolve; });
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    fireEvent.click(screen.getByRole('dialog').querySelector('.close-button') as HTMLElement);
    expect(recorded.cancels).toBe(0);
    await act(async () => { opened(); await recorded.opening; });
    await waitFor(() => expect(recorded.cancels).toBe(1));
  });

  it('holds no microphone once it is closed', async () => {
    const { dialog } = open();
    fireEvent.click(dialog.getByRole('button', { name: 'fork.voice.record' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'fork.voice.stopRecording' })).toBeTruthy());
    fireEvent.click(screen.getByRole('dialog').querySelector('.close-button') as HTMLElement);
    await waitFor(() => expect(recorded.cancels).toBe(1));
  });
});
