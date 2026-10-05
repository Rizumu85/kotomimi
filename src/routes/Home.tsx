import React, { useEffect } from 'react';
import MainLayout from '../components/MainLayout/MainLayout';
import { UserProfileProvider } from '../contexts/UserProfileContext';
import { TourProvider } from '../components/Tour/TourProvider';
import useAudioStore from '../stores/audioStore';
import { useLoadSettings } from '../stores/settingsStore';
import { useSubtitleStore } from '../stores/subtitleStore';
import { useAnnotationStore } from '../stores/annotationStore';
import { useLanStore } from '../stores/lanStore';
import { useNativeCoachStore, useNativeEngineStore, useNativeTranslatorStore } from '../stores/nativeEngineStore';
import { useLanguagePinStore } from '../stores/languagePinStore';
import { useLocalServerStore } from '../stores/localServerStore';
import { useFontStore } from '../stores/fontStore';
import { useConversationDisplayStore } from '../stores/conversationDisplayStore';
import { useSetupStore } from '../stores/setupStore';
import { SettingsInitializer } from '../components/SettingsInitializer/SettingsInitializer';
import AuthOverlay from '../components/Auth/AuthOverlay';
import { AppSessionRoot } from '../app/AppSessionRoot';
import { loadSessionStores } from '../app/loadStores';
import { startedInBackground } from '../components/Autostart/AutostartSection';
import { primeNativeOnce } from '../providers/openai/localai';
import { watchWindowShape } from '../lib/windowShape';
import { watchDevices } from '../lib/audio/deviceWatch';

export function Home() {
  const loadSettings = useLoadSettings();

  // Refresh audio devices and load settings when component mounts
  useEffect(() => {
    console.info('[Home] Refreshing audio devices');
    useAudioStore.getState().refreshDevices();

    console.info('[Home] Loading settings');
    // Hydrate settingsStore, subtitleStore, conversationDisplayStore, and setup in parallel from persisted storage.
    Promise.all([
      loadSettings(),
      useSubtitleStore.getState().hydrate(),
      useConversationDisplayStore.getState().hydrate(),
      useAnnotationStore.getState().hydrate(),
      useFontStore.getState().hydrate(),
      useSetupStore.getState().hydrate(),
    ]).catch((err) => {
      console.warn('[Home] Settings/subtitle/conversationDisplay/setup hydration error:', err);
    });

    // The app session's stores: the stored provider selected and loaded, the
    // turn mode migrated, the routing switches, the punctuation pack — read by
    // the session from the first Start.
    void loadSessionStores();

    // Fork: sharing this computer's models, left on, starts again with the app. On its own: it waits for the model scan, which nothing else here should.
    void useLanStore.getState().hydrate();
    // Fork: a LocalAI installed on this computer — whether it is up, and started with the app when that was asked for.
    void useLocalServerStore.getState().hydrate();
    // Fork: the native recognition engine — whether its model is downloaded, and whether it is up.
    void useNativeEngineStore.getState().hydrate();
    void useNativeTranslatorStore.getState().hydrate();
    void useNativeCoachStore.getState().hydrate();
    // Fork: the engines are loaded when a session begins, and let go after it. A start in the background at sign-in
    // loads them once ahead of time, so that the long first load after the computer starts is not waited for.
    void startedInBackground().then((hidden) => { if (hidden) primeNativeOnce(); });
    // Fork: the languages pinned to the top of the language menus.
    void useLanguagePinStore.getState().hydrate();
    // Follow the OS's devices from here on (spec 2026-10-04): plugging,
    // unplugging, a Bluetooth reconnect, a repaired virtual device.
    const unwatchDevices = watchDevices({
      // A `devicechange` also tries the devices marked unusable again; the poll does not.
      sync: (reason) => useAudioStore.getState().syncDevices({ retryUnusable: reason === 'change' }),
      // While waiting for any microphone or while off the user's own: keep
      // looking. Linux announces a USB device but not a Bluetooth or PipeWire
      // one coming back, so without this it would never switch back or leave
      // waiting. Each beat is only a device listing, so polling can run for as
      // long as needed. A selection still on a device marked unusable counts
      // too: after a failed open, a sync whose listing failed or came back
      // incomplete leaves it there, and without another devicechange only the
      // poll would ever move it on.
      shouldPoll: () => {
        const audio = useAudioStore.getState();
        const selected = audio.selectedInputDevice;
        return selected === null
          || (audio.savedInputDeviceId !== null && selected.deviceId !== audio.savedInputDeviceId)
          || audio.unusableInputIds.includes(selected.deviceId);
      },
    });
    // Fork: on Windows the page rounds the window's corners itself, and squares them while it fills the screen.
    const unwatchShape = watchWindowShape();
    return () => {
      unwatchDevices();
      unwatchShape();
    };
  }, []); // Empty dependency array - only run once on mount

  return (
    <UserProfileProvider>
      <TourProvider>
        {/* The app session's page wiring; inside UserProfileProvider, which it reads. */}
        <AppSessionRoot />
        <SettingsInitializer />
        <MainLayout />
        {/* Over the app, not instead of it: MainLayout and every provider above
            it stay mounted while the user signs in, so a running translation
            session survives the round trip. */}
        <AuthOverlay />
      </TourProvider>
    </UserProfileProvider>
  );
}
