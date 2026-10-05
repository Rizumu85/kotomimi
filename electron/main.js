const { app, BrowserWindow, ipcMain, Menu, dialog, shell, session, systemPreferences, desktopCapturer } = require('electron');
const path = require('path');
const { betterAuthAdapter, PACKAGED_ORIGIN } = require('./better-auth-adapter');
const { setupSubtitleHandlers } = require('./subtitle-window.js');
const { setupCaptionDoubleClick } = require('./window-caption-dblclick.js');
const { setupCaptionContextMenu } = require('./window-caption-menu.js');
const { setupPopoverWindowHandlers } = require('./popover-windows.js');
const { setupTranscriptSaveHandler } = require('./transcript-save.js');
const { createCloseHandshake } = require('./close-handshake.js');
const { createWsHeaderRules } = require('./ws-header-rules.js');
const { startLanServer } = require('./lan-server');
const { createUpstream } = require('./lan-upstream');
const { keepMaximizeHonest, pageShift } = require('./window-maximize');
const { firewallStatus, allowThroughFirewall } = require('./lan-firewall');
const { discoverServers } = require('./lan-discover');
const { createLocalServer } = require('./local-server');
const { createNativeEngine, LLAMA, TRANSLATORS, COACHES, LLAMA_RUNTIME, modelHears: nativeModelHears } = require('./native-engine');
const { joinEngines } = require('./native-engines');
const { createAutostart } = require('./autostart');
const { createAppleSpeech } = require('./apple-speech');
const { applyLinuxGpuFlags } = require('./linux-gpu-flags');
const { acquireSingleInstanceLock, createFocusRelay } = require('./single-instance');

// Let the Windows sandbox read our own install folder before Electron checks it
// and aborts (issue #352; electron/electron#54382). Runs ahead of the Squirrel
// hooks so install and update runs grant it too.
if (process.platform === 'win32') {
  require('./sandbox-recovery').grantInstallDirSandboxRead(process.execPath);
}

// Handle Squirrel events for Windows
if (process.platform === 'win32') {
  const handleSquirrelEvent = require('./squirrel-events');
  if (handleSquirrelEvent()) {
    // Squirrel event handled and app will exit, don't do anything else
    process.exit(0);
  }
}

const { UpdateManager } = require('./update-manager');
const { NativeHostManager } = require('./native-host-manager');
const nativeHost = new NativeHostManager();

// Config utility no longer needed - using localStorage in renderer process

// Platform-specific audio utilities
let audioUtils;
if (process.platform === 'linux') {
  audioUtils = require('./pulseaudio-utils');
} else if (process.platform === 'win32') {
  audioUtils = require('./windows-audio-utils');
} else if (process.platform === 'darwin') {
  audioUtils = require('./macos-audio-utils');
} else {
  // For other platforms, provide stub implementations
  audioUtils = {
    createVirtualAudioDevices: async () => {
      console.log('[Sokuji] [Main] Virtual audio devices not supported on this platform');
      return false;
    },
    removeVirtualAudioDevices: () => {
      console.log('[Sokuji] [Main] Virtual audio device cleanup not needed on this platform');
    },
    cleanupOrphanedDevices: async () => {
      console.log('[Sokuji] [Main] No orphaned devices to clean on this platform');
      return true;
    }
  };
}

const {
  createVirtualAudioDevices,
  removeVirtualAudioDevices,
  cleanupOrphanedDevices,
  // System audio capture functions (stubs on all platforms, capture uses electron-audio-loopback)
  listSystemAudioSources,
  connectSystemAudioSource,
  disconnectSystemAudioSource,
  supportsSystemAudioCapture
} = audioUtils;

// Initialize electron-audio-loopback for system audio capture on all platforms
// MUST be called before app is ready
// Supports Windows, macOS, and Linux (via PulseaudioLoopbackForScreenShare Chromium flag)
{
  const { initMain } = require('electron-audio-loopback');
  initMain();
  console.log('[Sokuji] [Main] electron-audio-loopback initialized for', process.platform);
}

// Set application name for PulseAudio
// Fork: Kotomimi is its own application — its own name, and so its own profile directory and
// single-instance lock. It can be installed beside upstream Sokuji, and run while it runs.
app.setName('kotomimi');
app.commandLine.appendSwitch('application-name', 'kotomimi');
app.commandLine.appendSwitch('jack-name', 'kotomimi');

// Fork: a development run can keep a profile of its own and be driven over the DevTools protocol,
// so working on the app never touches the installed one's settings, or fights it for the
// single-instance lock. Never in a packaged build.
/** An unpackaged run loads the page from the dev server — unless it was asked to load the built files (`KOTOMIMI_LOAD_BUILD=1`), for a machine where the dev server will not stay up. */
const loadsDevServer = () => (import.meta.env.MODE === 'development' || !app.isPackaged) && !(process.env.KOTOMIMI_LOAD_BUILD === '1' && !app.isPackaged);
if (!app.isPackaged) {
  if (process.env.KOTOMIMI_PROFILE) app.setPath('userData', process.env.KOTOMIMI_PROFILE);
  if (process.env.KOTOMIMI_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.KOTOMIMI_DEBUG_PORT);
}

/**
 * Fork: a first launch adopts upstream Sokuji's settings, so a user who moves over starts where
 * they were. Settings and saved keys live in the page's localStorage, and the sign-in in one file
 * beside it; both are copied once, and only into a profile that has none of its own. Downloaded
 * models are not copied — they are gigabytes — and are downloaded again when wanted. Not done
 * under `--user-data-dir`: a profile named on the command line is a test's, and stays empty.
 */
(function adoptUpstreamProfile() {
  try {
    if (app.commandLine.hasSwitch('user-data-dir') || (!app.isPackaged && process.env.KOTOMIMI_PROFILE)) return;
    const fs = require('fs');
    const mine = app.getPath('userData');
    const theirs = path.join(app.getPath('appData'), 'sokuji');
    const marker = path.join(mine, 'adopted-from-sokuji');
    if (fs.existsSync(marker) || fs.existsSync(path.join(mine, 'Local Storage')) || !fs.existsSync(path.join(theirs, 'Local Storage'))) return;
    fs.mkdirSync(mine, { recursive: true });
    // The store's LOCK is the running app's own; a copy of it would be a lock no one holds.
    fs.cpSync(path.join(theirs, 'Local Storage'), path.join(mine, 'Local Storage'), { recursive: true, filter: (source) => path.basename(source) !== 'LOCK' });
    if (fs.existsSync(path.join(theirs, '_better_auth'))) fs.copyFileSync(path.join(theirs, '_better_auth'), path.join(mine, '_better_auth'));
    fs.writeFileSync(marker, new Date().toISOString());
    console.log('[Kotomimi] [Main] Adopted the settings of an existing Sokuji profile');
  } catch (error) {
    console.warn('[Kotomimi] [Main] Could not adopt an existing Sokuji profile:', error.message);
  }
})();

// Single instance. Sokuji was only ever single-instance on macOS, and that was
// Launch Services refusing to start a second copy of the .app bundle rather
// than anything we did -- on Windows and Linux every Start-menu click started
// another process that then fought the first one over the PulseAudio modules
// and the sidecar's file locks. Claimed here because the lock lives under
// userData (so it must follow app.setName above) and because the Squirrel
// install/uninstall helpers, which legitimately run while the app is open,
// have already exited by this point.
let isDuplicateInstance = false;
// Holds a focus request that lands before createWindow() has run -- see
// createFocusRelay for why that is the common case rather than the rare one.
const focusRelay = createFocusRelay(() => mainWindow);
if (!acquireSingleInstanceLock(app, {
  onSecondInstance: () => {
    console.log('[Sokuji] [Main] Second launch detected; focusing the existing window');
    focusRelay.onSecondInstance();
  },
})) {
  isDuplicateInstance = true;
  console.log('[Sokuji] [Main] Another instance is already running; focusing it and exiting');
  // app.quit(), not app.exit(): app.exit() before the message loop is up takes
  // Chromium's early exit() path, which aborts -- measured on Linux, a duplicate
  // launch died with SIGABRT and dumped core every time.
  //
  // quit() is clean but not immediate, and it emits before-quit/will-quit, where
  // cleanupAndExit() is wired up. That teardown must NOT run here:
  // removeVirtualAudioDevices() ends in cleanupModulesByName(), which unloads
  // every sokuji_* PulseAudio module regardless of who created it, so quitting
  // this process would tear down the audio of the instance we just handed over
  // to. The isDuplicateInstance guards in cleanupAndExit() and in whenReady()
  // below are what make that safe -- they are load-bearing, not decorative.
  app.quit();
}

// Enable WebGPU for ONNX Runtime acceleration
app.commandLine.appendSwitch('enable-unsafe-webgpu');
// Enable required Chromium features (Vulkan for a hardware WebGPU adapter,
// SharedArrayBuffer for the audio ring buffer) as a single comma-separated
// list -- multiple appendSwitch calls for the same flag would override each
// other. Vulkan is dropped on Wayland, where it would otherwise leave the
// window permanently unmapped and the app invisible (issue #389).
const appliedGpuFlags = applyLinuxGpuFlags(app);
console.log('[Sokuji] [Main] GPU flags:', JSON.stringify(appliedGpuFlags));

// Keep the renderer (and its local-inference Web Worker) running at full speed when
// the Sokuji window is minimized/hidden/occluded — the common case while the user is
// in a video call with Sokuji translating in the background. Without these, Chromium
// backgrounds the hidden renderer and throttles its timers, which stalls the WASM
// inference loop (its setTimeout-based yields get clamped). See issue #263.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Windows sandbox crash self-healing (issue #352). On win32 only: apply the
// persistent --no-sandbox fallback (if a prior recovery set it) BEFORE app is
// ready, and register the passive GPU-crash detector. Recovery mode itself runs
// in whenReady (below), before the transparent main window is created.
const sandboxRecovery = process.platform === 'win32' ? require('./sandbox-recovery') : null;

// Closing the window or quitting mid-session ends the session first, so its
// final lines are captured and auto-saved like any other Stop.
// Both handlers answer the main window's page only: a popover child window is
// another webContents with the same preload, and must not approve a close.
const closeHandshake = createCloseHandshake({ quitApp: () => app.quit() });
ipcMain.handle('app:close-ready', (event) => {
  if (event.sender !== mainWindow?.webContents) return;
  closeHandshake.ready();
});
// Only a running or tearing-down session holds a close: anything else (the
// setup wizard, a loading page) has nothing to save and may never answer.
ipcMain.handle('app:session-busy', (event, busy) => {
  if (event.sender !== mainWindow?.webContents) return;
  closeHandshake.setSessionBusy(busy === true);
});

// sandbox-recovery relaunches via app.exit(), which skips before-quit/will-quit,
// so it must run the sidecar teardown itself or the native sidecar orphans and
// keeps its Windows file locks. (removeVirtualAudioDevices is a Linux-only no-op.)
const sandboxRecoveryOptions = { deps: { beforeExit: () => { try { nativeHost.stop(); } catch (_) {} } } };
if (sandboxRecovery) {
  sandboxRecovery.applyNoSandboxFlag(app, sandboxRecoveryOptions);
  sandboxRecovery.registerCrashDetection(app, sandboxRecoveryOptions);
}

// Keep a global reference of the window object to prevent garbage collection
let mainWindow;

// Most recently computed virtual-audio-device status, forwarded to the
// renderer over the 'audio-status' channel once it's ready to receive it.
let lastAudioStatus = null;

/**
 * Figure out *why* virtual audio device setup failed so the renderer can show
 * an actionable message instead of a generic failure.
 * @returns {Promise<{ok: boolean, platform: string, reason: string | null, message: string | null}>}
 */
async function buildAudioStatus(devicesCreated) {
  if (devicesCreated) {
    return { ok: true, platform: process.platform, reason: null, message: null };
  }

  if (process.platform === 'linux') {
    const { isPactlInstalled } = audioUtils;
    const pactlInstalled = isPactlInstalled ? await isPactlInstalled() : true;
    if (!pactlInstalled) {
      return {
        ok: false,
        platform: 'linux',
        reason: 'pactl-missing',
        message: 'pactl (PulseAudio command-line tools) not found. Install it with: sudo apt install pulseaudio-utils'
      };
    }
    return {
      ok: false,
      platform: 'linux',
      reason: 'pulseaudio-unavailable',
      message: 'Could not create virtual audio devices. Make sure PulseAudio or PipeWire is running.'
    };
  }

  if (process.platform === 'darwin' && audioUtils.virtualDeviceProblem?.() === 'not-loaded') {
    return {
      ok: false,
      platform: 'darwin',
      reason: 'mac-driver-not-loaded',
      message: 'SokujiVirtualAudio is installed, but macOS has not loaded it'
    };
  }

  // Fork: on Windows the device is VB-CABLE's, and what is wrong is that it is not installed.
  if (process.platform === 'win32') {
    return { ok: false, platform: 'win32', reason: 'vbcable-missing', message: 'VB-CABLE is not installed' };
  }

  return { ok: false, platform: process.platform, reason: 'other', message: 'Failed to create virtual audio devices' };
}

function sendAudioStatus(status) {
  lastAudioStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('audio-status', status);
  }
}

// Create application menu
function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const menuTemplate = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        {
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: `About ${app.getName()}`,
              message: 'Kotomimi - Real-time AI Translation',
              detail: `Version: ${app.getVersion()}\n\nAI-powered real-time translation application\n\nKotomimi is a fork of Sokuji (AGPL-3.0).\nSokuji © 2026 Kizuna AI Lab`,
              buttons: ['OK'],
              icon: path.join(__dirname, '../assets/icon.png')
            });
          }
        },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // File menu
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [])
      ]
    },

    // Help menu
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [{
          label: `About ${app.getName()}`,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: `About ${app.getName()}`,
              message: 'Kotomimi - Real-time AI Translation',
              detail: `Version: ${app.getVersion()}\n\nAI-powered real-time translation application\n\nKotomimi is a fork of Sokuji (AGPL-3.0).\nSokuji © 2026 Kizuna AI Lab`,
              buttons: ['OK'],
              icon: path.join(__dirname, '../assets/icon.png')
            });
          }
        },
        { type: 'separator' }]),
        {
          label: 'Check for Updates...',
          click: () => {
            if (global.updateManager) {
              global.updateManager.checkForUpdates();
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Official Website',
          click: async () => {
            await shell.openExternal('https://sokuji.kizuna.ai/');
          }
        },
        {
          label: 'Source Code',
          click: async () => {
            await shell.openExternal('https://github.com/Rizumu85/kotomimi');
          }
        },
        {
          label: 'Report Issue',
          click: async () => {
            await shell.openExternal('https://github.com/Rizumu85/kotomimi/issues');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  // Determine the correct icon path based on platform
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../assets/icon.ico')
    : path.join(__dirname, '../assets/icon.png');

  // Create the browser window
  const isDev = loadsDevServer();

  // Build custom User Agent to identify Electron app
  // Use standard OS names so PostHog's regex-based $os detection works
  const electronVersion = process.versions.electron;
  const appVersion = app.getVersion();
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform;
  const customUserAgent = `Sokuji/${appVersion} Electron/${electronVersion} (${osName})`;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Kotomimi',
    icon: iconPath,
    frame: false,
    transparent: true,
    hasShadow: true,
    // Fork: a start with the computer stays out of sight until the app is opened.
    show: !autostart.startedHidden,
    backgroundColor: '#00000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Disable web security in development to allow CORS requests
      webSecurity: !isDev,
      // Don't throttle timers/rendering when the window is hidden/occluded, so
      // local-inference (WASM) keeps running at full speed in the background. (#263)
      backgroundThrottling: false
    }
  });

  // A second launch during the ~half second between claiming the lock and
  // getting here left its focus request waiting; honour it now.
  focusRelay.windowCreated();

  // Fork, Windows only: on a display scaled by a fraction Electron loses track of this window being maximized, and it
  // could not be restored (electron/window-maximize.js). Before anything below asks the window whether it is.
  // The change itself is played by the page (`windowShift` below), the system's animation being lost with the frame.
  keepMaximizeHonest(mainWindow, (bounds) => require('electron').screen.getDisplayMatching(bounds).workArea, process.platform, windowShift.shift);
  setupSubtitleHandlers(mainWindow);
  // Windows only: frame:false + transparent:true above costs the window its
  // WS_CAPTION style, and with it the native double-click-to-maximize on the
  // custom title bar. Linux and macOS keep it for free — see the module.
  setupCaptionDoubleClick(mainWindow);
  // Linux only: right-clicking the drag-region title bar would show GNOME's
  // window menu, whose "Take Screenshot" wedges mutter's input grab on X11
  // and freezes the whole session — see the module for the measured details.
  // An Electron-drawn Minimize/Maximize/Close menu takes its place.
  setupCaptionContextMenu(mainWindow);
  setupPopoverWindowHandlers(mainWindow);
  // Fork: the person is here — what a start in the background left for later begins now.
  mainWindow.on('show', () => autostart.wake());
  closeHandshake.attachWindow(mainWindow);
  mainWindow.on('close', (event) => closeHandshake.onWindowClose(event));

  // Set custom User Agent for the window
  mainWindow.webContents.setUserAgent(customUserAgent);
  console.log('[Sokuji] [Main] Custom User Agent set:', customUserAgent);

  // Load the app
  console.log('[Sokuji] [Main] Development mode:', isDev, 'MODE:', import.meta.env.MODE, 'isPackaged:', app.isPackaged);
  
  // Track window load time
  const loadStartTime = Date.now();
  
  // Add performance tracking for page load
  mainWindow.webContents.on('did-finish-load', () => {
    const loadEndTime = Date.now();
    console.log(`[Sokuji] [Main] Page loaded in ${loadEndTime - loadStartTime}ms`);

    // Forward the virtual-audio-device status computed during startup, now
    // that the renderer is actually able to receive it.
    if (lastAudioStatus) {
      sendAudioStatus(lastAudioStatus);
    }
  });
  
  mainWindow.webContents.on('dom-ready', () => {
    const domReadyTime = Date.now();
    console.log(`[Sokuji] [Main] DOM ready in ${domReadyTime - loadStartTime}ms`);
  });
  
  if (isDev) {
    console.log(`[Sokuji] [Main] Loading from http://localhost:5173 at ${loadStartTime}`);
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const indexPath = path.join(app.getAppPath(), 'build/index.html');
    console.log('[Sokuji] [Main] Loading from:', indexPath);
    mainWindow.loadFile(indexPath);
  }

  // Open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Emitted when the window is closed
  mainWindow.on('closed', function () {
    // On macOS closing the window does not quit the app; the before-quit
    // listener below runs the cleanup when it actually quits. (This used to
    // register a second before-quit listener per close, which would run the
    // cleanup while the close handshake holds a quit.)
    if (process.platform !== 'darwin') {
      cleanupAndExit();
    }
    mainWindow = null;
  });
}

// Create window when Electron is ready
app.whenReady().then(async () => {
  if (isDuplicateInstance) return;
  // Windows sandbox recovery (issue #352): if a prior run left a crash marker,
  // scan ACLs and show the native recovery dialog BEFORE creating the (transparent)
  // main window. May relaunch or exit; if so, do not proceed to createWindow().
  if (sandboxRecovery && !sandboxRecovery.handleRecoveryMode(app, dialog, sandboxRecoveryOptions)) {
    return;
  }

  const isDev = loadsDevServer();

  // Initialize Better Auth adapter
  try {
    const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8787';
    const origin = isDev ? 'http://localhost:5173' : PACKAGED_ORIGIN;

    console.log(`[Sokuji] [Main] Initializing Better Auth adapter with backend: ${backendUrl}, origin: ${origin}`);

    betterAuthAdapter({
      backendUrl,
      origin
    });
    console.log('[Sokuji] [Main] Better Auth adapter initialized');
  } catch (error) {
    console.error('[Sokuji] [Main] Error initializing Better Auth adapter:', error);
  }

  // Initialize WebSocket header injection (must be before any WebSocket connections)
  initWebSocketHeaderInjection();

  // Clean up any orphaned devices
  try {
    await cleanupOrphanedDevices();
    console.log('[Sokuji] [Main] Orphaned devices cleaned up successfully');
  } catch (error) {
    console.error('[Sokuji] [Main] Error cleaning up orphaned devices:', error);
  }

  // Start virtual audio devices before creating the window
  try {
    // Fork, Windows: only looked for at start, never installed. Upstream asks to download and install VB-CABLE here,
    // before there is a window: a dialog in English, then a download with no progress and no time limit that reads as
    // "nothing happened" — for a driver that only a translation spoken into a meeting needs, which the fork's own
    // provider never does. The banner offers the install to whoever needs it (`create-virtual-speaker`, below).
    const devicesCreated = process.platform === 'win32' ? await audioUtils.isVBCableInstalled() : await createVirtualAudioDevices();
    lastAudioStatus = await buildAudioStatus(devicesCreated);
    if (!devicesCreated) {
      console.error('[Sokuji] [Main] Virtual audio device status:', lastAudioStatus.reason, '-', lastAudioStatus.message);
    }
    if (devicesCreated) {
      console.log('[Sokuji] [Main] Virtual audio devices created successfully');
      
      // Connect the virtual speaker to the default output device
      // try {
      //   // Use default device info
      //   const defaultDeviceInfo = {
      //     deviceId: 'default',
      //     label: 'Default'
      //   };
      //
      //   // Connect virtual speaker to default output
      //   const connected = await connectVirtualSpeakerToOutput(defaultDeviceInfo);
      //   if (connected) {
      //     console.log('[Sokuji] [Main] Successfully connected virtual speaker to default output device');
      //   } else {
      //     console.error('[Sokuji] [Main] Failed to connect virtual speaker to default output device');
      //   }
      // } catch (connectionError) {
      //   console.error('[Sokuji] [Main] Error connecting virtual speaker to default output:', connectionError);
      // }
    } else {
      console.error('[Sokuji] [Main] Failed to create virtual audio devices');
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error creating virtual audio devices:', error);
    lastAudioStatus = { ok: false, platform: process.platform, reason: 'other', message: error?.message || 'Failed to create virtual audio devices' };
  }

  // Create the application menu
  createApplicationMenu();

  // Request microphone permission on macOS before creating window. Under the
  // Hardened Runtime this prompt (and the renderer's getUserMedia) is denied
  // with no dialog at all unless the bundle carries the audio-input
  // entitlement -- see electron/entitlements.mac.plist (#458).
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[Sokuji] [Main] Microphone permission status:', micStatus);

    if (micStatus === 'not-determined') {
      // Fork: asked, not waited for. The question stays on screen until someone answers it, and the window used to
      // wait with it: a computer that only lends its models — nobody at its screen, the app reopened after an
      // update, which macOS takes for a new app and asks again — never opened its window, and so never started
      // the LocalAI it runs. The microphone is not needed until a session starts; the answer can come when it comes.
      void systemPreferences.askForMediaAccess('microphone').then(
        (granted) => console.log('[Sokuji] [Main] Microphone permission granted:', granted),
        (error) => console.warn('[Sokuji] [Main] Microphone permission could not be asked:', error?.message),
      );
    } else if (micStatus === 'denied') {
      console.warn('[Sokuji] [Main] Microphone permission denied - please enable in System Preferences > Privacy & Security > Microphone');
    }
  }

  // Session-end auto-save writes straight into Downloads (no Save As dialog).
  // The sender check reads mainWindow at call time: it does not exist yet,
  // and it can be recreated.
  setupTranscriptSaveHandler({
    ipcMain,
    getDownloadsDir: () => app.getPath('downloads'),
    isTrustedSender: (sender) => sender === mainWindow?.webContents,
  });

  createWindow();

  // Initialize auto-update manager. An install ends a running session first:
  // the updater quits the app itself, and holding that quit for the session
  // keeps this instance alive while the new one starts.
  global.updateManager = new UpdateManager(mainWindow, {
    beforeInstall: (fn) => closeHandshake.endSessionThen(fn),
  });
  // Fork: no check at startup. The fork has published no release yet, and a check with nothing to find reports an error
  // on every launch. "Check for updates" in Help still asks, and asks the fork's releases alone (update-manager.js).

  // electron-audio-loopback handles setDisplayMediaRequestHandler automatically via initMain()
});

// Ensure cleanup happens before app exits
const cleanupAndExit = () => {
  if (isDuplicateInstance) return;
  console.log('[Sokuji] [Main] Cleaning up virtual audio devices before exit...');
  removeVirtualAudioDevices();
  nativeHost.stop();
  console.log('[Sokuji] [Main] Virtual audio devices cleaned up successfully');
};

// Create a more robust exit handler that ensures cleanup happens
const handleExit = (signal) => {
  console.log(`[Sokuji] [Main] Received ${signal} signal. Ensuring cleanup before exit...`);
  
  // Perform cleanup synchronously
  cleanupAndExit();
  
  // Exit with appropriate code
  const exitCode = signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
  process.exit(exitCode);
};

// Register cleanup with before-quit — but not while the close handshake holds
// the quit for the renderer to end its session: cleanup stops the native host
// and removes the virtual audio devices that session may still be using.
app.on('before-quit', (event) => {
  if (!closeHandshake.onBeforeQuit(event)) return;
  cleanupAndExit();
});

// Register our exit handler for various signals
process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[Sokuji] [Main] Uncaught exception:', error);
  handleExit('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Sokuji] [Main] Unhandled rejection at:', promise, 'reason:', reason);
  handleExit('unhandledRejection');
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  // On macOS, recreate the window when the dock icon is clicked
  if (mainWindow === null) {
    createWindow();
    // Update the manager's window reference so IPC messages reach the new renderer
    if (global.updateManager) {
      global.updateManager.setMainWindow(mainWindow);
    }
  }
});

// Clean up loopback when app is about to quit
app.on('will-quit', cleanupAndExit);

// IPC handler for app version
nativeHost.registerIpc(ipcMain);

// ---- Self-contained sidecar bundle install/status (distribution spec) ----
// SKU detection + bundle download live in the main process because the sidecar
// (which the bundle provides) is not yet running. Progress is pushed to the
// renderer on 'sidecar-bundle-progress', mirroring the model-download UX.
const { detectSku: _detectSku } = require('./sidecar-sku');
const { resolvePython: _resolveSidecarPython } = require('./native-host-manager');
const sidecarBundle = require('./sidecar-bundle');
const _currentSku = () =>
  _detectSku(process.platform, { arch: process.arch });
ipcMain.handle('sidecar-bundle:status', () => {
  const sku = _currentSku();
  // Dev machines that lived through the slice-5 sku rename (linux-nvidia/
  // win-nvidia/win-directml/mac -> linux-x64/linux-arm64/win-x64/mac-arm64/
  // mac-x64) keep every old sku's multi-GB bundle tree forever, since install/
  // remove only ever touch the CURRENT sku's dir. Prune once here, at the
  // first bundle-resolution call the renderer makes each launch; never throws.
  // `installing: _bundleInstalling` (fix round 1): a renderer reload (Ctrl+R /
  // View menu reload, not dev-gated) resets the renderer's own in-memory
  // "install in progress" guard while main's install promise keeps running —
  // the remounted settings panel's status query must not race a live install's
  // `.tmp` extraction target with this prune.
  if (sku !== null) {
    sidecarBundle.pruneStaleSkuDirs(
      path.dirname(sidecarBundle.bundleInstallDir(app.getPath('userData'), sku)), sku,
      { installing: _bundleInstalling });
  }
  if (sku === null) {
    // Even without a bundle SKU (ARM windows) a dev checkout
    // with a venv keeps the whole native lane usable — report it so the UI
    // shows the dev note + unlocked model area instead of a dead end.
    let devVenvPresent = false;
    try { devVenvPresent = require('fs').existsSync(_resolveSidecarPython()); } catch { /* keep false */ }
    return { ok: true, sku: null, state: 'unsupported', installed: false,
             installedVersion: null, requiredVersion: null,
             stagedBytes: 0, devVenvPresent };
  }
  let requiredVersion = null;
  try { requiredVersion = sidecarBundle.requiredSidecarVersion(); }
  catch { /* tree without the field — no version gate */ }
  const st = sidecarBundle.bundleStatus(app.getPath('userData'), sku);
  // Strict matching (spec S2): an installed bundle at any other version is a
  // 'mismatch' — the renderer presents it as "engine update required".
  const state = !st.installed ? 'absent'
    : (requiredVersion === null || st.version === requiredVersion) ? 'ready' : 'mismatch';
  let devVenvPresent = false;
  try { devVenvPresent = require('fs').existsSync(_resolveSidecarPython()); } catch { /* keep false */ }
  return {
    ok: true, sku, state,
    installed: st.installed, installedVersion: st.version, requiredVersion,
    stagedBytes: requiredVersion === null ? 0
      : sidecarBundle.stagedBytes(app.getPath('userData'), sku, requiredVersion),
    devVenvPresent,
  };
});
// Best-effort manifest peek so the engine card can show exact sizes pre-install.
ipcMain.handle('sidecar-bundle:manifest', async () => {
  const sku = _currentSku();
  if (sku === null) return { ok: false, error: 'unsupported platform' };
  try {
    const version = sidecarBundle.requiredSidecarVersion();
    const r = await fetch(`${sidecarBundle.bundleBaseUrl(version)}/manifest.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const entry = sidecarBundle.pickBundle(await r.json(), sku);
    if (!entry) throw new Error(`no bundle for sku ${sku}`);
    return { ok: true, size: entry.size ?? null, installedSize: entry.installedSize ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
// In-flight guard + cancellation. Cancel aborts the network stream but KEEPS
// the staging files — re-invoking install resumes from the staged bytes (S7).
let _bundleInstalling = false;
let _bundleAbort = null;
ipcMain.handle('sidecar-bundle:install', async (event) => {
  const sku = _currentSku();
  if (sku === null) return { ok: false, sku: null, error: 'no sidecar bundle for this platform' };
  if (_bundleInstalling) return { ok: false, sku, error: 'bundle install already in progress' };
  _bundleInstalling = true;
  _bundleAbort = new AbortController();
  try {
    const r = await sidecarBundle.installBundle({
      sku,
      version: sidecarBundle.requiredSidecarVersion(),
      userDataDir: app.getPath('userData'),
      signal: _bundleAbort.signal,
      stopSidecar: () => nativeHost.stop(),
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('sidecar-bundle-progress', { sku, ...p });
      },
    });
    return { ok: true, sku, ...r };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, sku, cancelled: true };
    return { ok: false, sku, error: e instanceof Error ? e.message : String(e) };
  } finally {
    _bundleInstalling = false;
    _bundleAbort = null;
  }
});
ipcMain.handle('sidecar-bundle:cancel', () => {
  _bundleAbort?.abort();
  return { ok: true };
});
ipcMain.handle('sidecar-bundle:remove', () => {
  const sku = _currentSku();
  if (sku === null) return { ok: false, error: 'unsupported platform' };
  nativeHost.stop();  // release file locks before deleting (Windows)
  sidecarBundle.removeBundle(app.getPath('userData'), sku);
  return { ok: true };
});

ipcMain.handle('get-app-version', () => app.getVersion());

// IPC handler for the renderer to pull the current virtual-audio-device status.
// The renderer's listener for the 'audio-status' push isn't guaranteed to be
// registered yet when 'did-finish-load' fires (React mounts asynchronously),
// so relying on the push alone can silently drop the event. The renderer
// pulls this once right after it subscribes, to cover that race.
ipcMain.handle('get-audio-status', () => lastAudioStatus);

// ---- Window controls for the custom title bar ----
ipcMain.handle('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
// Fork: maximize and restore, played by the page before the bounds change (electron/window-maximize.js).
const windowShift = pageShift((move) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  mainWindow.webContents.send('window:shift', move);
  return true;
}, { put: (bounds) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds(bounds); } });
ipcMain.handle('window:shift-place', (_event, bounds) => { windowShift.place(bounds); });
ipcMain.handle('window:shift-ready', () => { windowShift.ready(); });
ipcMain.handle('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC handlers for audio functionality
ipcMain.handle('check-audio-system', async () => {
  try {
    let audioSystemAvailable = false;
    let systemType = 'none';

    if (process.platform === 'linux') {
      const { isPulseAudioAvailable } = audioUtils;
      audioSystemAvailable = await isPulseAudioAvailable();
      systemType = audioSystemAvailable ? 'pulseaudio' : 'none';
    } else if (process.platform === 'win32') {
      const { isWindowsAudioAvailable } = audioUtils;
      audioSystemAvailable = await isWindowsAudioAvailable();
      // On Windows, VB-CABLE detection happens in the renderer process
      // We just report that Windows audio is available
      systemType = audioSystemAvailable ? 'windows' : 'none';
    } else if (process.platform === 'darwin') {
      const { isMacOSAudioAvailable } = audioUtils;
      audioSystemAvailable = await isMacOSAudioAvailable();
      // On macOS, Sokuji Virtual Audio driver is installed by PKG installer
      systemType = audioSystemAvailable ? 'coreaudio' : 'none';
    }

    return {
      audioSystemAvailable,
      systemType,
      platform: process.platform,
      note: process.platform === 'win32' ? 'VB-CABLE detection happens in renderer process' :
            process.platform === 'darwin' ? 'Sokuji Virtual Audio driver installed by PKG installer' : null
    };
  } catch (error) {
    console.error('[Sokuji] [Main] Error checking audio system status:', error);
    return {
      audioSystemAvailable: false,
      systemType: 'none',
      platform: process.platform,
      error: error.message
    };
  }
});

// Handler for VB-CABLE detection (called from renderer process)
ipcMain.handle('check-vbcable', async () => {
  try {
    // On Windows, actual VB-CABLE detection happens in the renderer process
    // This handler is here for consistency and future extensibility
    if (process.platform === 'win32') {
      return {
        platform: 'windows',
        detectionMethod: 'renderer',
        message: 'VB-CABLE detection should be done via MediaDevices API in renderer'
      };
    } else {
      return {
        platform: process.platform,
        detectionMethod: 'none',
        message: 'VB-CABLE is Windows-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error in VB-CABLE check:', error);
    return {
      error: error.message
    };
  }
});

// Handler for VB-CABLE installation (called from renderer process)
ipcMain.handle('install-vbcable', async () => {
  try {
    if (process.platform === 'win32') {
      console.log('[Sokuji] [Main] VB-CABLE installation requested from renderer');
      const installer = require('./vb-cable-installer');
      const result = await installer.ensureVBCableInstalled();
      return {
        success: result,
        platform: 'windows'
      };
    } else {
      return {
        success: false,
        platform: process.platform,
        message: 'VB-CABLE is Windows-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error installing VB-CABLE:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Handler for Sokuji Virtual Audio detection (called from renderer process)
ipcMain.handle('check-sokuji-audio', async () => {
  try {
    if (process.platform === 'darwin') {
      const { isSokujiVirtualAudioInstalled } = audioUtils;
      const installed = await isSokujiVirtualAudioInstalled();
      return {
        installed,
        platform: 'macos',
        driverName: 'Sokuji Virtual Audio'
      };
    } else {
      return {
        installed: false,
        platform: process.platform,
        message: 'Sokuji Virtual Audio is macOS-specific'
      };
    }
  } catch (error) {
    console.error('[Sokuji] [Main] Error in Sokuji Virtual Audio check:', error);
    return {
      installed: false,
      error: error.message
    };
  }
});

// Configuration now handled directly in renderer process via localStorage

// Handler to open a directory in the file explorer
ipcMain.handle('open-directory', (event, dirPath) => {
  try {
    // Open the directory using the default file explorer
    const { shell } = require('electron');
    shell.openPath(dirPath);
    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Error opening directory:', error);
    return { success: false, error: error.message };
  }
});

// Handler to open external URL in system default browser
ipcMain.handle('open-external', async (event, url) => {
  try {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Error opening external URL:', error);
    return { success: false, error: error.message };
  }
});




// Handler to create virtual audio devices (used for manual retry from the renderer)
ipcMain.handle('create-virtual-speaker', async () => {
  try {
    const result = await createVirtualAudioDevices();
    const status = await buildAudioStatus(result);
    sendAudioStatus(status);
    return {
      success: result,
      message: result ? 'Virtual audio devices created successfully' : status.message
    };
  } catch (error) {
    console.error('[Sokuji] [Main] Error creating virtual audio devices:', error);
    sendAudioStatus({ ok: false, platform: process.platform, reason: 'other', message: error?.message || 'Failed to create virtual audio devices' });
    return {
      success: false,
      error: error?.message || 'Failed to create virtual audio devices'
    };
  }
});

// macOS: re-sign an installed-but-unloaded driver behind the administrator
// prompt (macos-audio-utils.js repairVirtualDevice), then report the result the
// way a retry does. The renderer supplies the dialog text in the UI language.
ipcMain.handle('repair-virtual-audio', async (_event, data) => {
  if (process.platform !== 'darwin' || !audioUtils.repairVirtualDevice) {
    return { ok: false, cancelled: false, error: 'Only the macOS driver can be repaired' };
  }
  const prompt = typeof data?.prompt === 'string' && data.prompt ? data.prompt.slice(0, 300) : 'Sokuji wants to repair its virtual microphone.';
  const result = await audioUtils.repairVirtualDevice({ prompt });
  // The repair's last probe found the device (and put its gain back to unity),
  // so the status follows from that same check: a second one could disagree
  // with the result returned here.
  if (result.ok) sendAudioStatus(await buildAudioStatus(true));
  return result;
});

// System audio capture IPC handlers (Linux only)
ipcMain.handle('supports-system-audio-capture', async () => {
  if (supportsSystemAudioCapture) {
    return await supportsSystemAudioCapture();
  }
  return false;
});

ipcMain.handle('list-system-audio-sources', async () => {
  if (listSystemAudioSources) {
    return await listSystemAudioSources();
  }
  return [];
});

ipcMain.handle('connect-system-audio-source', async (event, sinkName) => {
  if (connectSystemAudioSource) {
    return await connectSystemAudioSource(sinkName);
  }
  return { success: false, error: 'System audio capture not supported on this platform' };
});

ipcMain.handle('disconnect-system-audio-source', async () => {
  if (disconnectSystemAudioSource) {
    return await disconnectSystemAudioSource();
  }
  return { success: false };
});

// Per-application audio capture (Windows only, issue #335).
// The helper writes PCM to its stdout; we forward each chunk straight to the
// renderer that asked for it. 24 kHz mono s16 is ~48 KB/s, so plain IPC is
// ample and avoids putting a listening socket on the machine.
ipcMain.handle('start-app-audio-capture', async (event, deviceId) => {
  // Linux does not come through here: its tap is a PipeWire link and the
  // renderer records the resulting monitor device with getUserMedia.
  const helperModule = process.platform === 'win32' ? './windows-audio-utils'
    : process.platform === 'darwin' ? './macos-audio-utils'
    : null;
  if (!helperModule) {
    return { ok: false, error: 'Per-application capture helper is not available on this platform' };
  }
  try {
    const { startCapture } = require(helperModule);
    const wc = event.sender;
    const ok = startCapture(
      deviceId,
      // A Buffer does not survive the context-bridge as-is; a Uint8Array view does.
      (pcm) => { if (!wc.isDestroyed()) wc.send('app-audio:pcm', new Uint8Array(pcm)); },
      (evt) => { if (!wc.isDestroyed()) wc.send('app-audio:event', evt); }
    );
    return ok ? { ok: true } : { ok: false, error: 'Capture helper unavailable' };
  } catch (error) {
    console.error('[Sokuji] [Main] Failed to start application audio capture:', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('stop-app-audio-capture', async () => {
  const helperModule = process.platform === 'win32' ? './windows-audio-utils'
    : process.platform === 'darwin' ? './macos-audio-utils'
    : null;
  if (!helperModule) return { ok: true };
  try {
    const { stopCapture } = require(helperModule);
    stopCapture();
  } catch (error) {
    console.warn('[Sokuji] [Main] Failed to stop application audio capture:', error);
  }
  return { ok: true };
});

// Linux loopback audio: fix PipeWire monitor source volume
// PipeWire stores an independent monitorVolumes property per sink that can be very low.
// After getDisplayMedia() creates the loopback stream, we force the monitor source to 100%.
ipcMain.handle('fix-monitor-volume', async () => {
  if (process.platform !== 'linux') return { ok: true, skipped: true };

  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('pactl', ['get-default-sink'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const defaultSink = stdout.trim();
    const monitorName = defaultSink + '.monitor';
    await execFileAsync('pactl', ['set-source-volume', monitorName, '100%'], {
      timeout: 2000,
    });
    console.log(`[Sokuji] [Main] Fixed monitor volume for ${monitorName}`);
    return { ok: true, monitor: monitorName };
  } catch (err) {
    console.error('[Sokuji] [Main] Failed to fix monitor volume:', err.message);
    return { ok: false, error: err.message };
  }
});

// ── Combined Request Header Injection ─────────────────────────────────────────
// Electron only allows ONE onBeforeSendHeaders listener per session, so this
// single handler covers both:
//   1. Better Auth: cookie/origin injection for backend API requests
//   2. WebSocket: custom header injection for provider WebSocket upgrades
//
// The renderer registers host-specific WebSocket header rules via IPC before
// opening a WebSocket connection. This replaces the previous per-provider IPC
// bridges (Volcengine, Edge TTS) that proxied every frame through main process.

// The rules by host and path, one-shot (electron/ws-header-rules.js). A rule
// may remove a header the browser always adds: OpenAI's Live WebSocket answers
// 403 to any upgrade carrying `Origin`.
const wsHeaderRules = createWsHeaderRules();

function initWebSocketHeaderInjection() {
  // Retrieve Better Auth config (stored by better-auth-adapter.js)
  const authConfig = betterAuthAdapter._sendHeadersConfig;

  // Pre-parse auth URL matchers for safe origin+path comparison
  const authMatchers = authConfig
    ? authConfig.filterPatterns.map((pattern) => {
        const base = pattern.replace(/\/\*$/, '');
        const parsed = new URL(base);
        return { origin: parsed.origin, pathname: parsed.pathname.replace(/\/$/, '') || '' };
      })
    : [];

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const { requestHeaders } = details;

      // ── Better Auth: inject cookies and origin for backend requests ──
      if (authConfig && authMatchers.length > 0) {
        let isAuthRequest = false;
        try {
          const reqUrl = new URL(details.url);
          isAuthRequest = authMatchers.some(({ origin, pathname }) =>
            reqUrl.origin === origin &&
            (pathname === '' || reqUrl.pathname === pathname || reqUrl.pathname.startsWith(pathname + '/'))
          );
        } catch {
          // Malformed URL — not an auth request
        }
        if (isAuthRequest) {
          if (authConfig.origin) {
            const cleanOrigin = authConfig.origin.endsWith('/')
              ? authConfig.origin.slice(0, -1)
              : authConfig.origin;
            requestHeaders['Origin'] = cleanOrigin.toLowerCase();
            requestHeaders['Referer'] = cleanOrigin.toLowerCase();
          }
          authConfig.injectCookies(requestHeaders);
        }
      }

      // ── WebSocket: inject custom headers for provider connections ────
      // One-shot: the rule the upgrade's host and path match is consumed by
      // it, so it only applies to the intended upgrade handshake.
      if (details.resourceType === 'webSocket') {
        wsHeaderRules.take(details.url, requestHeaders);
      }

      // Bing Translator (HTTP): inject browser-like identity so the unofficial
      // www.bing.com/translator and /ttranslatev3 endpoints accept requests from
      // Electron. Must be applied unconditionally — the Bing client runs inside
      // a Web Worker and fetch() from there cannot set Origin/Referer itself.
      if (
        details.resourceType !== 'webSocket'
        && typeof details.url === 'string'
        && (
          details.url.startsWith('https://www.bing.com/translator')
          || details.url.startsWith('https://www.bing.com/ttranslatev3')
        )
      ) {
        requestHeaders['User-Agent'] =
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        requestHeaders['Origin'] = 'https://www.bing.com';
        requestHeaders['Referer'] = 'https://www.bing.com/translator';
        requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
      }

      callback({ requestHeaders });
    }
  );

  console.log('[Sokuji] [Main] Combined header injection initialized');
}

// IPC: renderer registers headers for a host, and optionally a path, before opening a WebSocket
ipcMain.handle('ws-headers-set', (event, args) => {
  const result = wsHeaderRules.set(args);
  if (result.success) {
    // Header names only, never a value: a value may be a credential.
    const { host, path, headers, removeHeaders } = args;
    const removed = Array.isArray(removeHeaders) && removeHeaders.length > 0 ? ` (removing: ${removeHeaders.join(', ')})` : '';
    console.log(`[Sokuji] [Main] WS headers registered for ${host}${path || ''}: ${Object.keys(headers).join(', ')}${removed}`);
  }
  return result;
});

// IPC: renderer clears the headers for a host, and optionally a path, after disconnecting
ipcMain.handle('ws-headers-clear', (event, args) => {
  const result = wsHeaderRules.clear(args);
  if (result.success) console.log(`[Sokuji] [Main] WS headers cleared for ${args.host}${args.path || ''}`);
  return result;
});

// Fork: sharing this computer's models on the local network (electron/lan-server.js). This process
// holds the listening socket; the page, where the models run, answers everything that comes in.
let lanServer = null;
const toPage = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const stopLanServer = async () => {
  const running = lanServer;
  lanServer = null;
  if (running) await running.close();
};

ipcMain.handle('lan:start', async (event, args) => {
  await stopLanServer();
  const port = Number(args?.port);
  try {
    // A LocalAI on this computer is shared through the same door (electron/lan-upstream.js): asked each time, so one started later joins by itself.
    const local = getLocalServer();
    // A request that names no model is the app's own to answer, though the LocalAI could, where the app has a native
    // engine's model for it: the Mac's recognition for the language, the downloaded recognizer, a native translator.
    const ownFirst = async (ask) => {
      const base = String(ask?.language ?? '').trim().toLowerCase().split(/[-_]/)[0];
      const has = (status, fits) => status.engine === 'ready' && Object.entries(status.models).some(([id, model]) => model.state === 'downloaded' && fits(id));
      if (ask?.kind === 'asr') return has(await getNativeEngine().status(), (id) => (id.includes(':') ? id.endsWith(`:${base}`) : nativeModelHears(id, base)));
      return has(await getNativeTranslator().status(), () => true);
    };
    const upstream = createUpstream({ port: local.port, pipelines: () => local.pipelines(), setPipeline: (name, change, options) => local.setPipeline(name, change, options), ownFirst });
    lanServer = await startLanServer({ port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8790, key: String(args?.key ?? ''), upstream }, {
      request: (request) => toPage('lan:request', request),
      socketOpen: (socket) => toPage('lan:socket-open', socket),
      socketMessage: (message) => toPage('lan:socket-message', message),
      socketClose: (socket) => toPage('lan:socket-close', socket),
      socketProxied: (socket) => toPage('lan:socket-proxied', socket),
    });
    console.log(`[Kotomimi] [Main] Sharing models on port ${lanServer.port}`);
    return { ok: true, port: lanServer.port, addresses: lanServer.addresses, name: lanServer.name };
  } catch (error) {
    console.warn('[Kotomimi] [Main] Could not start sharing:', error.message);
    return { ok: false, code: error.code ?? null, message: error.message };
  }
});

ipcMain.handle('lan:stop', async () => {
  await stopLanServer();
  return { ok: true };
});

ipcMain.handle('lan:reply', (event, args) => lanServer?.reply(args?.id, args ?? {}) ?? false);
ipcMain.handle('lan:send', (event, args) => lanServer?.send(args?.id, args?.data ?? '') ?? false);
ipcMain.handle('lan:close-socket', (event, args) => { lanServer?.closeSocket(args?.id, args?.code, args?.reason); return true; });

// Fork: a LocalAI installed on this computer, run by the app (electron/local-server.js): started and stopped from the
// settings, its output kept in the app's log folder, and stopped with the app. One something else started is left alone.
let localServer = null;
const getLocalServer = () => {
  if (localServer) return localServer;
  let out = null;
  const log = (text) => {
    try {
      out ??= require('fs').createWriteStream(path.join(app.getPath('logs'), 'localai.log'), { flags: 'a' });
      out.write(text);
    } catch { /* its output is a convenience: never a reason to fail */ }
  };
  // An unpackaged run can be pointed at another home (`KOTOMIMI_LOCALAI_HOME`): a stand-in installation to try this against.
  const home = !app.isPackaged && process.env.KOTOMIMI_LOCALAI_HOME ? { home: process.env.KOTOMIMI_LOCALAI_HOME } : {};
  localServer = createLocalServer({ ...home, log, onChange: (status) => toPage('local-server:status', status) });
  return localServer;
};
ipcMain.handle('local-server:get', () => getLocalServer().refresh());
ipcMain.handle('local-server:start', () => getLocalServer().start());
ipcMain.handle('local-server:stop', () => getLocalServer().stop());
ipcMain.handle('local-server:pipelines', () => getLocalServer().pipelines());
ipcMain.handle('local-server:set-pipeline', (event, args) => getLocalServer().setPipeline(String(args?.name ?? ''), { transcription: args?.transcription, llm: args?.llm }));
// The one this app started goes with it: asked to stop, not waited for.
app.on('will-quit', () => { void localServer?.stop(); });

// Fork: the native recognition engine (electron/native-engine.js): a runtime and its models, fetched into the app's
// own folder and run on this computer alone. Fetched over the system's own network stack (`net.fetch`: its proxy
// settings included), its output kept in the app's log folder, and stopped with the app.
// Fork: starting with the computer, in the background (electron/autostart.js). Such a start shows no window — a
// second launch shows the one it made — and leaves the engine's loading for a quiet minute, or for the window's showing.
const autostart = createAutostart({ app, exists: (file) => require('fs').existsSync(file) });
// `startedHidden`: this start was the computer's own, so the page loads the engines once ahead of time (`primeNativeOnce`).
ipcMain.handle('autostart:get', () => ({ ...autostart.get(), startedHidden: autostart.startedHidden }));
ipcMain.handle('autostart:set', (event, args) => autostart.set(args?.enabled === true));

let nativeEngine = null;
const getNativeEngine = () => {
  if (nativeEngine) return nativeEngine;
  let out = null;
  const log = (text) => {
    try {
      out ??= require('fs').createWriteStream(path.join(app.getPath('logs'), 'native-engine.log'), { flags: 'a' });
      out.write(text);
    } catch { /* its output is a convenience: never a reason to fail */ }
  };
  const toStatus = (status) => toPage('native-engine:status', status);
  const toStream = (event) => toPage('native-engine:stream', event);
  const { net } = require('electron');
  const downloaded = (tell) => createNativeEngine({
    // An unpackaged run can keep it elsewhere (`KOTOMIMI_NATIVE_DIR`): gigabytes a test profile need not fetch again.
    dir: !app.isPackaged && process.env.KOTOMIMI_NATIVE_DIR ? process.env.KOTOMIMI_NATIVE_DIR : path.join(app.getPath('userData'), 'native-engine'),
    fetch: (url, init) => net.fetch(url, init),
    // An unpackaged run can keep what the engine was given to hear (`KOTOMIMI_NATIVE_DUMP`), to measure with.
    dumpDir: !app.isPackaged && process.env.KOTOMIMI_NATIVE_DUMP ? process.env.KOTOMIMI_NATIVE_DUMP : null,
    log,
    ...tell,
  });
  // On a Mac the first native recognizer is the system's own (electron/apple-speech.js), through the helper the app
  // ships beside its other one; the runtime the app downloads stands behind it, for the languages the system does
  // not hear. The two answer as one (electron/native-engines.js), so everything below this line is the same.
  if (process.platform === 'darwin') {
    const inBundle = path.join('resources', 'bin', 'darwin-arm64', 'Kotomimi Speech Helper.app', 'Contents', 'MacOS', 'speech-helper');
    const helper = [process.resourcesPath ? path.join(process.resourcesPath, inBundle) : null, path.join(__dirname, '..', inBundle)]
      .find((candidate) => candidate && require('fs').existsSync(candidate)) ?? null;
    nativeEngine = joinEngines([(tell) => createAppleSpeech({ helper, log, ...tell }), downloaded], { onChange: toStatus, onStream: toStream });
    return nativeEngine;
  }
  nativeEngine = downloaded({ onChange: toStatus, onStream: toStream });
  return nativeEngine;
};
ipcMain.handle('native-engine:get', () => getNativeEngine().status());
ipcMain.handle('native-engine:download', (event, args) => getNativeEngine().download(String(args?.id ?? '')));
ipcMain.handle('native-engine:cancel', (event, args) => getNativeEngine().cancel(String(args?.id ?? '')));
ipcMain.handle('native-engine:remove', (event, args) => getNativeEngine().remove(String(args?.id ?? '')));
ipcMain.handle('native-engine:start', async (event, args) => {
  await autostart.quiet;
  return getNativeEngine().start(String(args?.id ?? ''));
});
ipcMain.handle('native-engine:stop', () => getNativeEngine().stop());
ipcMain.handle('native-engine:stream-open', (event, args) => getNativeEngine().openStream({ language: args?.language, sampleRate: args?.sampleRate, model: typeof args?.model === 'string' ? args.model : undefined }));
ipcMain.handle('native-engine:stream-audio', (event, args) => getNativeEngine().writeStream(args?.id, args?.pcm));
ipcMain.handle('native-engine:stream-end', (event, args) => getNativeEngine().endStream(args?.id));
ipcMain.handle('native-engine:stream-abort', (event, args) => getNativeEngine().abortStream(args?.id));
app.on('will-quit', () => { void nativeEngine?.stop(); });

// Fork: the native translation engine — the same manager with llama.cpp's server and the translation models, in a
// folder of its own. It is asked over the chat wire by the page itself: only its state crosses here.
let nativeTranslator = null;
const getNativeTranslator = () => {
  if (nativeTranslator) return nativeTranslator;
  let out = null;
  const log = (text) => {
    try {
      out ??= require('fs').createWriteStream(path.join(app.getPath('logs'), 'native-translator.log'), { flags: 'a' });
      out.write(text);
    } catch { /* its output is a convenience: never a reason to fail */ }
  };
  const { net } = require('electron');
  nativeTranslator = createNativeEngine({
    // As the recognition engine's folder: an unpackaged run can keep it elsewhere (`KOTOMIMI_NATIVE_DIR`, beside it).
    dir: !app.isPackaged && process.env.KOTOMIMI_NATIVE_DIR ? `${process.env.KOTOMIMI_NATIVE_DIR}-translator` : path.join(app.getPath('userData'), 'native-translator'),
    catalog: { engine: LLAMA, models: TRANSLATORS },
    runtime: LLAMA_RUNTIME,
    fetch: (url, init) => net.fetch(url, init),
    log,
    onChange: (status) => toPage('native-translator:status', status),
  });
  return nativeTranslator;
};
ipcMain.handle('native-translator:get', () => getNativeTranslator().status());
ipcMain.handle('native-translator:download', (event, args) => getNativeTranslator().download(String(args?.id ?? '')));
ipcMain.handle('native-translator:cancel', (event, args) => getNativeTranslator().cancel(String(args?.id ?? '')));
ipcMain.handle('native-translator:remove', (event, args) => getNativeTranslator().remove(String(args?.id ?? '')));
ipcMain.handle('native-translator:start', async (event, args) => {
  await autostart.quiet;
  return getNativeTranslator().start(String(args?.id ?? ''));
});
ipcMain.handle('native-translator:stop', () => getNativeTranslator().stop());
app.on('will-quit', () => { void nativeTranslator?.stop(); });

// Fork: the native feedback engine — the same server once more, with a small chat model that checks the grammar of
// what the speaker says. A process of its own: the translation engine runs one model, and both are needed in one run.
let nativeCoach = null;
const getNativeCoach = () => {
  if (nativeCoach) return nativeCoach;
  let out = null;
  const log = (text) => {
    try {
      out ??= require('fs').createWriteStream(path.join(app.getPath('logs'), 'native-coach.log'), { flags: 'a' });
      out.write(text);
    } catch { /* its output is a convenience: never a reason to fail */ }
  };
  const { net } = require('electron');
  nativeCoach = createNativeEngine({
    dir: !app.isPackaged && process.env.KOTOMIMI_NATIVE_DIR ? `${process.env.KOTOMIMI_NATIVE_DIR}-coach` : path.join(app.getPath('userData'), 'native-coach'),
    catalog: { engine: LLAMA, models: COACHES },
    runtime: LLAMA_RUNTIME,
    fetch: (url, init) => net.fetch(url, init),
    log,
    onChange: (status) => toPage('native-coach:status', status),
  });
  return nativeCoach;
};
ipcMain.handle('native-coach:get', () => getNativeCoach().status());
ipcMain.handle('native-coach:download', (event, args) => getNativeCoach().download(String(args?.id ?? '')));
ipcMain.handle('native-coach:cancel', (event, args) => getNativeCoach().cancel(String(args?.id ?? '')));
ipcMain.handle('native-coach:remove', (event, args) => getNativeCoach().remove(String(args?.id ?? '')));
ipcMain.handle('native-coach:start', async (event, args) => {
  await autostart.quiet;
  return getNativeCoach().start(String(args?.id ?? ''));
});
ipcMain.handle('native-coach:stop', () => getNativeCoach().stop());
app.on('will-quit', () => { void nativeCoach?.stop(); });

// Fork: the devices of the local network whose models this app can use (electron/lan-discover.js) —
// asked for when the person is choosing one. One search at a time: a second asker waits for the first's answer.
let lanSearch = null;
ipcMain.handle('lan:discover', () => {
  lanSearch ??= discoverServers({ ownPorts: lanServer ? [lanServer.port] : [] })
    .catch((error) => { console.warn('[Kotomimi] [Main] The search of the local network failed:', error.message); return []; })
    .finally(() => { lanSearch = null; });
  return lanSearch;
});

// Fork: whether Windows' firewall lets another device reach the port being shared, and — at the user's
// click, and with the consent Windows then asks for — a rule that does (electron/lan-firewall.js).
// The port is the one this process listens on, never one the page names.
const NO_FIREWALL_ANSWER = { state: 'unknown', public: false };
ipcMain.handle('lan:firewall-status', () => (lanServer ? firewallStatus(lanServer.port) : NO_FIREWALL_ANSWER));
ipcMain.handle('lan:firewall-allow', async () => {
  if (!lanServer) return NO_FIREWALL_ANSWER;
  const answer = await allowThroughFirewall(lanServer.port);
  console.log(`[Kotomimi] [Main] Firewall, port ${lanServer?.port}: ${answer.state}`);
  return answer;
});

// Screen recording permission check for macOS system audio capture
// This only checks the permission status, does NOT trigger any permission dialogs
// The renderer should call getDisplayMedia() to trigger the system dialog when needed
// Open the exact macOS privacy pane a denied capture needs. The anchor names
// are the ones System Settings itself advertises (verified against
// SecurityPrivacyExtension.appex): Privacy_AudioCapture is "System Audio
// Recording Only" and Privacy_ScreenCapture is "Screen Recording".
const PRIVACY_PANES = {
  'audio-capture': 'Privacy_AudioCapture',
  'screen-recording': 'Privacy_ScreenCapture',
};

/**
 * The name macOS shows for this process in the privacy lists.
 *
 * In a packaged build that is "Sokuji", but `npm run dev` runs Electron's own
 * bundle (com.github.Electron), so the user has to grant the permission to
 * "Electron". Telling them to look for "Sokuji" there sends them hunting for an
 * entry that does not exist.
 */
ipcMain.handle('get-tcc-display-name', async () => {
  if (process.platform !== 'darwin') return { name: app.getName(), isDev: false };
  // app.getName() is overridden to 'sokuji' at startup, so read the bundle the
  // OS actually launched instead of what the app calls itself.
  const exe = app.getPath('exe');
  const isDev = exe.includes('node_modules/electron/dist/');
  return { name: isDev ? 'Electron' : app.getName(), isDev };
});

ipcMain.handle('open-privacy-settings', async (event, pane) => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Privacy panes are macOS-only' };
  }
  const anchor = PRIVACY_PANES[pane];
  if (!anchor) {
    return { ok: false, error: `Unknown privacy pane: ${pane}` };
  }
  try {
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
    return { ok: true };
  } catch (error) {
    console.error('[Sokuji] [Main] Failed to open privacy settings:', error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('check-screen-recording-permission', async () => {
  if (process.platform !== 'darwin') {
    // Windows doesn't need screen recording permission for loopback audio
    return { status: 'granted', platform: process.platform };
  }

  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    console.log('[Sokuji] [Main] Screen recording permission status:', status);
    // Just return the raw status - don't try to trigger permission here
    // Calling desktopCapturer.getSources() would change 'not-determined' to 'denied'
    return { status, platform: 'darwin' };
  } catch (error) {
    console.error('[Sokuji] [Main] Error checking screen recording permission:', error);
    return { status: 'unknown', platform: 'darwin', error: error.message };
  }
});

