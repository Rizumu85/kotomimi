import { useEffect, useState } from 'react';
import { useLanStore } from '../../stores/lanStore';

/** This computer's memory in MB (undefined while waiting, null if unknown), and its live LAN lending switch. */
export function useNativeRecommendationInputs(): { memoryMB: number | null | undefined; lending: boolean } {
  const [memoryMB, setMemoryMB] = useState<number | null | undefined>(undefined);
  const lending = useLanStore((s) => s.enabled);
  useEffect(() => {
    let mounted = true;
    const api = (window as unknown as { electron?: { invoke(channel: string): Promise<unknown> } }).electron;
    void (async () => {
      try {
        const value = await api?.invoke('model-memory:get');
        if (mounted) setMemoryMB(typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
      } catch {
        // A browser or an older preload has no hardware answer; the default recommendation still applies.
        if (mounted) setMemoryMB(null);
      }
    })();
    return () => { mounted = false; };
  }, []);
  return { memoryMB, lending };
}
