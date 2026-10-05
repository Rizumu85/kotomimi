// Fork: the model field of an API, and its menu of the service's own models.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiModelPicker, type ApiModelPickerProps } from './ApiModelPicker';
import { API_SERVICES } from './apiServices';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

const LIST = 'providers.localai.modelList';
const SEARCH = 'providers.localai.modelSearch';
const deepseek = API_SERVICES.find((s) => s.id === 'deepseek')!;
const listing = (ids: string[], status = 200) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status });

function draw(patch: Partial<ApiModelPickerProps> = {}, answer: () => Promise<Response> = async () => listing(['deepseek-reasoner', 'deepseek-flash', 'deepseek-chat'])) {
  const fetched = vi.fn(answer);
  vi.stubGlobal('fetch', fetched);
  const onModel = vi.fn();
  const props: ApiModelPickerProps = { id: 't', label: 'model', model: 'deepseek-flash', placeholder: '', baseUrl: deepseek.baseUrl, needsKey: true, apiKey: 'sk-1', known: [], service: deepseek, kind: 'text', onModel, onTyping: vi.fn(), ...patch };
  const view = render(<ApiModelPicker {...props} />);
  return { fetched, onModel, props, view };
}
const names = () => screen.queryAllByRole('option').map((o) => o.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the model field of an API', () => {
  it('asks the service for its models when its button is pressed, and not before', async () => {
    const { fetched } = draw();
    expect(fetched).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LIST }));
    await waitFor(() => expect(names()).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash']));
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${deepseek.baseUrl}/models`);
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-1' });
    // The one in the field is marked as chosen; the name already there narrowed nothing.
    expect(screen.getByRole('option', { name: 'deepseek-flash' }).getAttribute('aria-selected')).toBe('true');
  });

  it('fills the field with the one that is pressed, and closes', async () => {
    const { onModel } = draw();
    fireEvent.click(screen.getByRole('button', { name: LIST }));
    fireEvent.click(await screen.findByRole('option', { name: /deepseek-chat/ }));
    expect(onModel).toHaveBeenLastCalledWith('deepseek-chat');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  const MANY = ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro', 'google/gemini-3.8-flash', 'google/gemini-3.8-flash-lite', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-flash', 'meta/llama-5-70b-versatile', 'x/one', 'x/two', 'x/three'];
  const GEMINI = ['google/gemini-3.8-flash', 'google/gemini-3.8-flash-lite'];
  const openMany = async () => {
    const drawn = draw({ service: undefined, model: '' }, async () => listing(MANY));
    fireEvent.click(screen.getByRole('button', { name: LIST }));
    const search = await screen.findByRole('textbox', { name: SEARCH });
    return { ...drawn, search: search as HTMLInputElement };
  };

  it('has no search for a list short enough to read', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: LIST }));
    await screen.findByRole('listbox');
    expect(screen.queryByRole('textbox', { name: SEARCH })).toBeNull();
  });

  it('has a search above a long list, the caret in it, that leaves the field itself alone', async () => {
    const { onModel, search } = await openMany();
    expect(names()).toHaveLength(MANY.length);
    // The caret is put there once the box is drawn: a moment after it is found.
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: 'gemni flash' } });
    expect(names()).toEqual(GEMINI);
    expect(onModel).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(names()).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('providers.localai.modelListNoMatch');
    // Enter takes the first that is found.
    fireEvent.change(search, { target: { value: 'sonnet' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onModel).toHaveBeenLastCalledWith('anthropic/claude-sonnet-5.5');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is searched through an input method as it is typed, and leaves the input method to itself', async () => {
    const { onModel, search } = await openMany();
    // Composing: the letters, with the input method's marks between the syllables.
    fireEvent.compositionStart(search, { data: '' });
    fireEvent.compositionUpdate(search, { data: "ge'mi" });
    fireEvent.change(search, { target: { value: "ge'mi" } });
    expect(names()).toEqual(GEMINI);
    // Enter while composing is the input method's — it commits the letters: nothing is chosen by it.
    fireEvent.keyDown(search, { key: 'Enter', keyCode: 229 });
    expect(onModel).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.compositionEnd(search, { data: 'gemi' });
    fireEvent.change(search, { target: { value: 'gemi' } });
    expect(search.value).toBe('gemi');
    expect(names()).toEqual(GEMINI);
    // What it commits is what the search holds: its own characters are not rewritten.
    fireEvent.compositionUpdate(search, { data: 'fla' });
    fireEvent.compositionEnd(search, { data: '\u798f\u5566' });
    fireEvent.change(search, { target: { value: 'gemi \u798f\u5566' } });
    expect(search.value).toBe('gemi \u798f\u5566');
    // And Enter, once nothing is being composed, takes the first that is found.
    fireEvent.change(search, { target: { value: 'gemi' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onModel).toHaveBeenLastCalledWith('google/gemini-3.8-flash');
  });

  it('offers what the last check listed until the service answers, and where it does not', async () => {
    draw({ known: ['deepseek-chat'] }, async () => { throw new TypeError('Failed to fetch'); });
    fireEvent.click(screen.getByRole('button', { name: LIST }));
    expect(names()).toEqual(['deepseek-chat']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('providers.localai.modelListUnreachable'));
    expect(names()).toEqual(['deepseek-chat']);
  });

  it('says why there is no list, in a line of its own', async () => {
    const said = async (patch: Partial<ApiModelPickerProps>, answer?: () => Promise<Response>) => {
      cleanup();
      const { fetched } = draw(patch, answer);
      fireEvent.click(screen.getByRole('button', { name: LIST }));
      await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe('providers.localai.modelListAsking'));
      return { text: screen.getByRole('status').textContent, fetched };
    };
    // Nothing is asked without what the asking needs.
    const noKey = await said({ apiKey: ' ' });
    expect(noKey.text).toBe('providers.localai.modelListKeyMissing');
    expect(noKey.fetched).not.toHaveBeenCalled();
    expect((await said({ baseUrl: '', service: undefined })).text).toBe('providers.localai.modelListNoAddress');
    expect((await said({}, async () => listing([], 401))).text).toBe('providers.localai.modelListKeyRefused');
    expect((await said({}, async () => listing([], 404))).text).toBe('providers.localai.modelListNone');
    // A service that wants no key is asked without one.
    const open = await said({ needsKey: false, apiKey: '', model: '' }, async () => listing([]));
    expect(open.text).toBe('providers.localai.modelListNone');
    expect((open.fetched.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toBeUndefined();
  });

  it('is closed by its button, by Escape, and by a press anywhere else', async () => {
    draw();
    const button = screen.getByRole('button', { name: LIST });
    fireEvent.click(button);
    await screen.findByRole('listbox');
    fireEvent.click(button);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(button);
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'model' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(button);
    await screen.findByRole('listbox');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
