/**
 * Fork: where the downloaded models are kept (`ModelStorageSection`, `modelStorage.ts`), as the page shows it and
 * asks the main process (`electron/model-storage.js`), which these tests stand in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelStorageSection } from './ModelStorageSection';
import { useModelStorageStore, type StorageStatus, type StoragePlan } from '../../lib/native/modelStorage';
import { useLanStore } from '../../stores/lanStore';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { NO_NATIVE_ENGINE } from '../../lib/native/nativeEngine';

// The catalog's keys stand for its strings, with what they are given.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));

const GB = 1024 ** 3;
const HERE: StorageStatus = { root: 'C:\\Users\\Me\\AppData\\Roaming\\Kotomimi', isDefault: true, missing: false, usedBytes: 11 * GB, drive: { name: 'C:', freeBytes: 3.2 * GB, totalBytes: 100 * GB }, fixed: false, moving: false };
const PLAN: StoragePlan = { target: 'D:\\Kotomimi', needBytes: 11 * GB, drive: { name: 'D:', freeBytes: 820 * GB, totalBytes: 2000 * GB }, sameDrive: false };

const asked: Array<[string, unknown]> = [];
let answers: Record<string, unknown>;
let progress: ((p: unknown) => void) | null;

beforeEach(() => {
  asked.length = 0;
  progress = null;
  answers = { 'model-storage:status': HERE, 'model-storage:choose': PLAN };
  (window as unknown as { electron: unknown }).electron = {
    invoke: vi.fn(async (channel: string, data?: unknown) => { asked.push([channel, data]); return answers[channel]; }),
    receive: (channel: string, listener: (p: unknown) => void) => { if (channel === 'model-storage:progress') progress = listener; },
    removeListener: () => { progress = null; },
  };
  useModelStorageStore.setState({ status: null, askedAt: 0, plan: null, progress: null, failed: null, freed: null, focus: 0 });
  useNativeEngineStore.setState({ status: { ...NO_NATIVE_ENGINE, supported: true }, asked: true });
  useLanStore.setState({ enabled: false });
});
afterEach(() => { delete (window as unknown as { electron?: unknown }).electron; });

describe('where the models are kept', () => {
  it('is the folder, what the models take and the room left, a drive nearly full in the warning colour', async () => {
    const { container } = render(<ModelStorageSection />);
    await screen.findByTitle(HERE.root);
    expect(container.querySelector('.kt-storage__legend')?.textContent).toContain('11.0 GB');
    const free = screen.getByText(/fork\.storage\.free/);
    expect(free.textContent).toContain('3.2 GB');
    expect(free.className).toContain('is-warn');
    // The folder is a place, not a field to type in.
    expect(container.querySelector('input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'fork.storage.open' }));
    expect(asked.map(([c]) => c)).toContain('model-storage:open');
  });

  it('is not shown on a computer that runs no models of its own, or by a run that names its own folder', async () => {
    useNativeEngineStore.setState({ status: { ...NO_NATIVE_ENGINE, supported: false }, asked: true });
    const none = render(<ModelStorageSection />);
    await waitFor(() => expect(useModelStorageStore.getState().status).not.toBeNull());
    expect(none.container.querySelector('.kt-storage')).toBeNull();
    none.unmount();
    useNativeEngineStore.setState({ status: { ...NO_NATIVE_ENGINE, supported: true }, asked: true });
    answers['model-storage:status'] = { ...HERE, fixed: true };
    useModelStorageStore.setState({ status: null, askedAt: 0 });
    const fixed = render(<ModelStorageSection />);
    await waitFor(() => expect(useModelStorageStore.getState().status?.fixed).toBe(true));
    expect(fixed.container.querySelector('.kt-storage')).toBeNull();
  });
});

describe('another folder', () => {
  it('chosen, says what moves and the room there; moved, says the room freed where they were', async () => {
    render(<ModelStorageSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'fork.storage.change' }));
    await screen.findByText(PLAN.target);
    expect(screen.getByText(/fork\.storage\.free/).textContent).toContain('820.0 GB');
    answers['model-storage:move'] = { status: { ...HERE, root: PLAN.target, isDefault: false, drive: PLAN.drive } };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'fork.storage.move' })); });
    expect(asked).toContainEqual(['model-storage:move', { target: PLAN.target }]);
    await screen.findByText(PLAN.target);
    expect(screen.getByText(/fork\.storage\.freed/).textContent).toContain('"size":"11.0 GB"');
  });

  it('without room, cannot be moved to, and another can be chosen', async () => {
    answers['model-storage:choose'] = { ...PLAN, error: 'no_space', drive: { name: 'D:', freeBytes: 2 * GB, totalBytes: 100 * GB } };
    render(<ModelStorageSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'fork.storage.change' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'fork.storage.move' })).toBeNull();
    expect(screen.getByRole('button', { name: 'fork.storage.chooseAgain' })).toBeTruthy();
  });

  it('shows the move as it goes, and can be stopped, the models left where they were', async () => {
    render(<ModelStorageSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'fork.storage.change' }));
    await screen.findByText(PLAN.target);
    let finish: (v: unknown) => void = () => {};
    (window as unknown as { electron: { invoke: ReturnType<typeof vi.fn> } }).electron.invoke.mockImplementation(async (channel: string, data?: unknown) => {
      asked.push([channel, data]);
      if (channel === 'model-storage:move') return new Promise((resolve) => { finish = resolve; });
      return answers[channel];
    });
    fireEvent.click(screen.getByRole('button', { name: 'fork.storage.move' }));
    await waitFor(() => expect(progress).not.toBeNull());
    act(() => progress?.({ copied: 4.2 * GB, total: 11 * GB }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('38');
    fireEvent.click(screen.getByRole('button', { name: 'fork.storage.cancel' }));
    expect(asked.map(([c]) => c)).toContain('model-storage:cancel');
    await act(async () => { finish({ error: 'stopped' }); });
    expect(await screen.findByText('fork.storage.errors.stopped')).toBeTruthy();
    expect(screen.getByTitle(HERE.root)).toBeTruthy();
  });

  it('cannot be chosen during a session, or while this computer shares its models', async () => {
    const { rerender } = render(<ModelStorageSection disabled />);
    expect((await screen.findByRole('button', { name: 'fork.storage.change' })).hasAttribute('disabled')).toBe(true);
    rerender(<ModelStorageSection />);
    expect(screen.getByRole('button', { name: 'fork.storage.change' }).hasAttribute('disabled')).toBe(false);
    act(() => useLanStore.setState({ enabled: true }));
    expect(screen.getByRole('button', { name: 'fork.storage.change' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('a chosen folder that is gone', () => {
  it('says so, and offers the default folder or another', async () => {
    answers['model-storage:status'] = { ...HERE, root: 'E:\\Kotomimi', isDefault: false, missing: true, usedBytes: 0 };
    answers['model-storage:reset'] = HERE;
    render(<ModelStorageSection />);
    expect(await screen.findByText('fork.storage.missing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'fork.storage.change' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'fork.storage.useDefault' })); });
    expect(await screen.findByTitle(HERE.root)).toBeTruthy();
  });
});

describe('a model card on a drive without room for it', () => {
  it('says how much room is left instead of offering the download, and opens another folder', async () => {
    const { NativeEngineCard } = await import('../../providers/openai/NativeEngineCard');
    useNativeEngineStore.setState({ status: { ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', models: { big: { state: 'absent', received: 0, total: 2 * GB } } }, asked: true });
    answers['model-storage:status'] = { ...HERE, drive: { name: 'C:', freeBytes: 0.8 * GB, totalBytes: 100 * GB } };
    render(<NativeEngineCard kind="asr" model={{ id: 'big', name: 'Big', bytes: 2 * GB, languages: ['ja'] }} selected={false} />);
    const why = await screen.findByText(/fork\.storage\.noRoom/);
    expect(why.textContent).toContain('"size":"0.8 GB"');
    expect(screen.queryByTitle(/^models.download/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'fork.storage.changePlace' }));
    await waitFor(() => expect(asked.map(([c]) => c)).toContain('model-storage:choose'));
  });

  it('offers the download where there is room', async () => {
    const { NativeEngineCard } = await import('../../providers/openai/NativeEngineCard');
    useNativeEngineStore.setState({ status: { ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', models: { big: { state: 'absent', received: 0, total: 2 * GB } } }, asked: true });
    answers['model-storage:status'] = { ...HERE, drive: { name: 'D:', freeBytes: 800 * GB, totalBytes: 2000 * GB } };
    render(<NativeEngineCard kind="asr" model={{ id: 'big', name: 'Big', bytes: 2 * GB, languages: ['ja'] }} selected={false} />);
    await waitFor(() => expect(useModelStorageStore.getState().status).not.toBeNull());
    expect(screen.queryByText(/fork\.storage\.noRoom/)).toBeNull();
    expect(screen.getByTitle(/^models.download/)).toBeTruthy();
  });
});
