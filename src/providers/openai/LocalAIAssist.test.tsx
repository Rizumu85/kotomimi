import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocalAIAssist } from './LocalAIAssist';
import { LOCALAI_DEFAULTS, type LocalAISettings } from './localai';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
// The search of the network is the finder's own test: here only whether it is drawn.
vi.mock('../../components/LanSharing/ServerFinder', () => ({
  ServerFinder: ({ onPick }: { onPick(server: unknown): void }) => (
    <button type="button" onClick={() => onPick({ address: '192.168.1.9:8790', kind: 'kotomimi', name: 'DESK', product: '', models: 2, needsKey: true, self: false })}>finder</button>
  ),
}));

function draw(settings: Partial<LocalAISettings>) {
  const update = vi.fn();
  const fill = vi.fn();
  render(<LocalAIAssist settings={{ ...LOCALAI_DEFAULTS, ...settings }} values={{ endpoint: '' }} fill={fill} update={update} />);
  const places = (stage: string) => [...screen.getByRole('group', { name: stage }).querySelectorAll('button')];
  return { update, fill, hear: () => places('providers.localai.hearStage'), translate: () => places('providers.localai.translateStage') };
}

const pressed = (buttons: Element[]) => buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;

describe('where each stage runs, under the provider', () => {
  it('is a row per stage, each with its own places: two choices, not one switch', () => {
    const { hear, translate, update } = draw({ asrVia: 'server', translateVia: 'server' });
    expect(hear().map((b) => b.textContent)).toEqual(['providers.localai.placeServer', 'providers.localai.placeDevice']);
    expect(translate().map((b) => b.textContent)).toEqual(['providers.localai.placeServer', 'providers.localai.viaModel', 'providers.localai.placeDevice']);
    expect(pressed(hear())).toBe('providers.localai.placeServer');
    // The translation moves by itself: recognition stays where it is.
    fireEvent.click(translate()[2]);
    expect(update).toHaveBeenCalledWith({ translateVia: 'device' });
    fireEvent.click(hear()[1]);
    expect(update).toHaveBeenLastCalledWith({ asrVia: 'device' });
  });

  it('offers the other device\'s pipeline for the translation only while it also hears', () => {
    const { translate } = draw({ asrVia: 'device', translateVia: 'server' });
    expect(translate().map((b) => b.textContent)).toEqual(['providers.localai.viaModel', 'providers.localai.placeDevice']);
    // What then answers: this computer's own model (`translateViaOf`).
    expect(pressed(translate())).toBe('providers.localai.placeDevice');
  });

  it('says what is still to choose when an API model translates and none is named', () => {
    draw({ asrVia: 'device', translateVia: 'model', translateModel: '' });
    expect(screen.getByText('providers.localai.modelTodo')).toBeTruthy();
  });

  it('shows the devices found only while a stage is on another device, and a pick fills the address and asks for its key', () => {
    const here = draw({ asrVia: 'device', translateVia: 'device' });
    expect(screen.queryByText('finder')).toBeNull();
    here.update.mockClear();
    const there = draw({ asrVia: 'server', translateVia: 'server', serverNeedsKey: false });
    fireEvent.click(screen.getByText('finder'));
    expect(there.update).toHaveBeenCalledWith({ serverNeedsKey: true });
    expect(there.fill).toHaveBeenCalledWith('endpoint', '192.168.1.9:8790');
  });
});
