const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron/main');
const Store = require('electron-store');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const { normalizeHotkey, isHotkeyPressed } = require('./hotkeys');

const DEFAULT_SERVER_URL = process.env.TELEFON_SERVER_URL || 'https://127.0.0.1:3000';
const DEFAULT_PUSH_TO_TALK_HOTKEY = normalizeHotkey(process.env.TELEFON_PTT_HOTKEY || 'Alt+Space') || 'Alt+Space';
const AUDIO_MODES = new Set(['voice-activated', 'push-to-talk']);
const OVERLAY_WIDTH = 260;
const OVERLAY_MIN_HEIGHT = 72;
const OVERLAY_MAX_HEIGHT = 520;
const OVERLAY_ITEM_HEIGHT = 44;
const OVERLAY_PADDING = 16;
const OVERLAY_EDGE_OFFSET = 16;
const OVERLAY_TOP_RATIO = 0.22;

// Local development commonly uses a self-signed certificate for https://127.0.0.1:3000.
// Electron's renderer-initiated network traffic does not consistently flow through the
// certificate-error handler below, so allow invalid certs only for unpackaged development.
if (!process.argv.includes('--app-is-packaged')) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
}

const settingsStore = new Store({
    name: 'telefon-settings',
    defaults: {
        serverUrl: DEFAULT_SERVER_URL,
        nickname: '',
        overlayEnabled: true,
        audioMode: 'voice-activated',
        pushToTalkHotkey: DEFAULT_PUSH_TO_TALK_HOTKEY,
    },
});

let mainWindow = null;
let overlayWindow = null;
let keyboardListener = null;
let keyboardListenerReady = null;
let lastPushToTalkState = false;
let overlayState = {
    enabled: true,
    users: [],
};

function normalizeServerUrl(value) {
    if (typeof value !== 'string') {
        return DEFAULT_SERVER_URL;
    }

    const normalizedValue = value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(normalizedValue)) {
        return DEFAULT_SERVER_URL;
    }

    return normalizedValue;
}

function getPublicSettings() {
    return {
        serverUrl: normalizeServerUrl(settingsStore.get('serverUrl')),
        nickname: String(settingsStore.get('nickname') || '').trim().slice(0, 24),
        overlayEnabled: Boolean(settingsStore.get('overlayEnabled')),
        audioMode: AUDIO_MODES.has(settingsStore.get('audioMode')) ? settingsStore.get('audioMode') : 'voice-activated',
        pushToTalkHotkey: normalizeHotkey(settingsStore.get('pushToTalkHotkey')) || '',
    };
}

function sanitizeSettingsPatch(patch) {
    if (!patch || typeof patch !== 'object') {
        return {};
    }

    const nextSettings = {};

    if (Object.prototype.hasOwnProperty.call(patch, 'serverUrl')) {
        nextSettings.serverUrl = normalizeServerUrl(patch.serverUrl);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'nickname')) {
        nextSettings.nickname = String(patch.nickname || '').trim().slice(0, 24);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'overlayEnabled')) {
        nextSettings.overlayEnabled = Boolean(patch.overlayEnabled);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'audioMode')) {
        nextSettings.audioMode = AUDIO_MODES.has(patch.audioMode) ? patch.audioMode : 'voice-activated';
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'pushToTalkHotkey')) {
        nextSettings.pushToTalkHotkey = normalizeHotkey(patch.pushToTalkHotkey);
    }

    return nextSettings;
}

function sendPushToTalkState(isActive) {
    if (!mainWindow || mainWindow.isDestroyed() || lastPushToTalkState === isActive) {
        return;
    }

    lastPushToTalkState = isActive;
    mainWindow.webContents.send('ptt:state', { isActive });
}

function ensureKeyboardListener() {
    if (keyboardListener) {
        return keyboardListenerReady;
    }

    keyboardListener = new GlobalKeyboardListener();
    keyboardListenerReady = keyboardListener.addListener((_event, downState) => {
        const hotkey = getPublicSettings().pushToTalkHotkey;
        sendPushToTalkState(Boolean(hotkey) && isHotkeyPressed(downState, hotkey));
    }).catch((error) => {
        console.error('Failed to start the global keyboard listener.', error);
    });
    return keyboardListenerReady;
}

function sanitizeOverlayState(payload) {
    const nextState = payload && typeof payload === 'object' ? payload : {};
    const users = Array.isArray(nextState.users) ? nextState.users : [];

    return {
        enabled: Object.prototype.hasOwnProperty.call(nextState, 'enabled')
            ? Boolean(nextState.enabled)
            : Boolean(settingsStore.get('overlayEnabled')),
        users: users
            .map((user) => ({
                id: String((user && user.id) || '').trim(),
                nickname: String((user && user.nickname) || '').trim().slice(0, 24),
                isSpeaking: Boolean(user && user.isSpeaking),
            }))
            .filter((user) => user.id && user.nickname),
    };
}

function getOverlayHeight(userCount) {
    const computedHeight = (userCount * OVERLAY_ITEM_HEIGHT) + (OVERLAY_PADDING * 2);
    return Math.max(OVERLAY_MIN_HEIGHT, Math.min(OVERLAY_MAX_HEIGHT, computedHeight));
}

function getOverlayBounds() {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const overlayHeight = getOverlayHeight(overlayState.users.length);

    return {
        x: x + OVERLAY_EDGE_OFFSET,
        y: y + Math.max(OVERLAY_EDGE_OFFSET, Math.round(height * OVERLAY_TOP_RATIO)),
        width: Math.min(OVERLAY_WIDTH, width - (OVERLAY_EDGE_OFFSET * 2)),
        height: Math.min(overlayHeight, height - (OVERLAY_EDGE_OFFSET * 2)),
    };
}

function sendOverlayState() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    overlayWindow.webContents.send('overlay:state', overlayState);
}

function syncOverlayWindowVisibility() {
    const shouldShow = Boolean(settingsStore.get('overlayEnabled')) && overlayState.users.length > 0;

    if (!shouldShow) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
        }
        return;
    }

    if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow();
        return;
    }

    overlayWindow.setBounds(getOverlayBounds());
    sendOverlayState();
    if (!overlayWindow.isVisible()) {
        overlayWindow.showInactive();
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 920,
        minWidth: 1100,
        minHeight: 760,
        autoHideMenuBar: true,
        backgroundColor: '#202225',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

    mainWindow.on('closed', () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.close();
        }
        overlayWindow = null;
        mainWindow = null;
    });
}

function createOverlayWindow() {
    overlayWindow = new BrowserWindow({
        ...getOverlayBounds(),
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        movable: false,
        focusable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'overlay-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadFile(path.join(__dirname, '..', 'public', 'overlay.html'));
    overlayWindow.webContents.on('did-finish-load', () => {
        sendOverlayState();
        syncOverlayWindowVisibility();
    });
    overlayWindow.on('closed', () => {
        overlayWindow = null;
    });
}

function registerIpcHandlers() {
    ipcMain.on('settings:get', (event) => {
        event.returnValue = getPublicSettings();
    });

    ipcMain.on('settings:update', (event, patch) => {
        const nextSettings = sanitizeSettingsPatch(patch);
        Object.entries(nextSettings).forEach(([key, value]) => {
            settingsStore.set(key, value);
        });

        if (Object.prototype.hasOwnProperty.call(nextSettings, 'pushToTalkHotkey') && !nextSettings.pushToTalkHotkey) {
            sendPushToTalkState(false);
        }

        if (Object.prototype.hasOwnProperty.call(nextSettings, 'overlayEnabled')) {
            overlayState.enabled = nextSettings.overlayEnabled;
            syncOverlayWindowVisibility();
        }

        event.returnValue = getPublicSettings();
    });

    ipcMain.on('desktop:get-info', (event) => {
        event.returnValue = {
            isPackaged: app.isPackaged,
            platform: process.platform,
            version: app.getVersion(),
        };
    });

    ipcMain.on('overlay:get-state', (event) => {
        event.returnValue = overlayState;
    });

    ipcMain.on('overlay:update-state', (_event, payload) => {
        overlayState = sanitizeOverlayState(payload);
        syncOverlayWindowVisibility();
    });
}

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    const isLocalDevelopmentUrl = !app.isPackaged && /^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);

    if (isLocalDevelopmentUrl) {
        event.preventDefault();
        callback(true);
        return;
    }

    callback(false);
});

app.whenReady().then(() => {
    registerIpcHandlers();
    ensureKeyboardListener();
    createMainWindow();
    if (Boolean(settingsStore.get('overlayEnabled'))) {
        createOverlayWindow();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
            if (Boolean(settingsStore.get('overlayEnabled'))) {
                createOverlayWindow();
            }
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (keyboardListener) {
        keyboardListener.kill();
    }
});
