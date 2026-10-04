/**
 * Fork: the key a built-in provider keeps, for a stage that uses the same
 * service through the API place (`apiServices.ts` `keyOf`). Read from the
 * settings as that provider stores it; nothing is written there.
 */
import { ServiceFactory } from '../../services/ServiceFactory';

export async function savedKeyOf(prefix: string): Promise<string> {
  try {
    const key = await ServiceFactory.getSettingsService().getSetting<string>(`settings.${prefix}.apiKey`, '');
    return typeof key === 'string' ? key.trim() : '';
  } catch {
    return '';
  }
}
