import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Headphones, Cpu } from 'lucide-react';
import { useNavigateToSettings, useSettingsNavigationTarget } from '../../stores/settingsStore';
import AdvancedSettings from './AdvancedSettings/AdvancedSettings';
import PanelBar from './shared/PanelBar';
import type { Tab } from './shared/TabBar';
import './Settings.scss';

interface SettingsProps {
  toggleSettings?: () => void;
  /** External highlight section prop */
  highlightSection?: string | null;
}

const TABS: Tab[] = [
  { id: 'general', labelKey: 'settings.tabs.general', fallback: 'General', icon: SettingsIcon },
  { id: 'audio', labelKey: 'settings.tabs.audio', fallback: 'Audio', icon: Headphones },
  { id: 'provider', labelKey: 'settings.tabs.provider', fallback: 'Provider', icon: Cpu },
];

// Settings unmounts whenever another panel takes its place (MainLayout renders
// panels conditionally), so the active tab lives in sessionStorage like the
// rest of the panelState.* keys.
const TAB_STORAGE_KEY = 'panelState.settingsActiveTab';

function readStoredTab(): string {
  const stored = sessionStorage.getItem(TAB_STORAGE_KEY);
  return stored && TABS.some((tab) => tab.id === stored) ? stored : 'general';
}

const NAVIGATION_TAB_MAP: Record<string, string> = {
  'user-account': 'general',
  'languages': 'general',
  'glossary': 'general',
  'sentence-segmentation': 'general',
  'microphone': 'audio',
  'speaker': 'audio',
  'system-audio': 'audio',
  'participant': 'audio',
  // Engine chips (Task 10) deep-link here to switch to the provider tab
  // using the same route as other settings links.
  // The target IS 'provider' (not a separate 'provider-section' key): the
  // scroll/highlight lookup below builds `${target}-section` as the DOM id,
  // and ProviderPicker's root carries id="provider-section" — so 'provider'
  // is the only target string that resolves to a real element.
  'provider': 'provider',
  'system-instructions': 'provider',
  'voice-settings': 'provider',
  // Speech mode lives at the top of the Audio category.
  'turn-detection': 'audio',
  // A direct link also expands the speech-detection controls in Audio.
  'turn-detection-tuning': 'audio',
  // Fork: what hears each side, from the language section's model names (`LanguagePairSection`).
  'hearing': 'provider',
  'model-management': 'provider',
  'model-asr': 'provider',
  'model-translation': 'provider',
  'model-tts': 'provider',
};

const Settings: React.FC<SettingsProps> = ({ toggleSettings, highlightSection }) => {
  const settingsNavigationTarget = useSettingsNavigationTarget();
  const navigateToSettings = useNavigateToSettings();

  const [activeTab, setActiveTab] = useState(readStoredTab);

  useEffect(() => {
    sessionStorage.setItem(TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  const target = highlightSection || settingsNavigationTarget;

  // Switch to the target category and highlight its section.
  useEffect(() => {
    if (!target) return;
    const targetTab = NAVIGATION_TAB_MAP[target];
    if (targetTab && targetTab !== activeTab) {
      setActiveTab(targetTab);
    }
    // 'provider' is special (Finding 4): it's the engine chips' deep-link
    // target, and the section this would
    // scroll/highlight is id="provider-section" — the WHOLE ProviderPicker,
    // not the slot the chip actually opened. That flash now belongs to
    // EngineSurface's own expanded SlotRow (its one-shot `flashSlot` prop)
    // instead. Switch tabs only, and clear the one-shot target immediately
    // so it can't linger and hijack a later navigation that DOES want the
    // scroll/highlight.
    if (target === 'provider') {
      navigateToSettings(null);
      return;
    }
    // Wait for the tab switch + DOM update before scrolling. Cancel the
    // pending scroll on cleanup so changing targets mid-navigation doesn't
    // fire into an unmounted/stale DOM.
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let highlightedEl: HTMLElement | null = null;
    const scrollTimer = setTimeout(() => {
      const element = document.getElementById(`${target}-section`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        element.classList.add('highlight');
        highlightedEl = element;
        highlightTimer = setTimeout(() => {
          element.classList.remove('highlight');
          highlightedEl = null;
          navigateToSettings(null);
        }, 3000);
      } else {
        // Nothing to highlight (e.g. a pushed page's section) — clear
        // anyway, or the same code's next Fix is a no-op (review Minor 2).
        navigateToSettings(null);
      }
    }, 150);
    return () => {
      clearTimeout(scrollTimer);
      if (highlightTimer) clearTimeout(highlightTimer);
      // The DOM persists across panel hides (<Activity>), so a highlight
      // interrupted mid-animation must be removed here, not just its timer.
      highlightedEl?.classList.remove('highlight');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, navigateToSettings]);

  return (
    <div className="settings-container">
      <PanelBar
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={toggleSettings ?? (() => {})}
      />

      <div className="settings-body">
        <AdvancedSettings toggleSettings={toggleSettings} activeTab={activeTab} />
      </div>
    </div>
  );
};

export default Settings;
