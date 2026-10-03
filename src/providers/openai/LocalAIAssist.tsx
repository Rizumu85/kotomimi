import { ServerFinder } from '../../components/LanSharing/ServerFinder';
import type { CredentialAssistProps } from '../../lib/provider/types';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings } from './localai';
import { needsServer } from './localaiDevice';

/**
 * Fork: above the address field, the devices the app found on the local
 * network (`ServerFinder`). A click fills the address, and says whether that
 * device asks for a key so the key's field shows. It searches by itself only
 * while no address is set: a settings panel opened for something else asks
 * the network nothing.
 */
export function LocalAIAssist({ settings, values, fill, update, disabled }: CredentialAssistProps<LocalAISettings>) {
  if (!needsServer(settings)) return null;
  return (
    <ServerFinder
      value={values.endpoint ?? ''}
      auto={!(values.endpoint ?? '').trim()}
      disabled={disabled}
      onPick={(server) => {
        if (server.needsKey !== settings.serverNeedsKey) update({ serverNeedsKey: server.needsKey });
        fill('endpoint', server.address);
      }}
    />
  );
}
