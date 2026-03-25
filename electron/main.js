const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron/main');
const Store = require('electron-store');
const { GlobalKeyboardListener } = require('node-global-key-listener');
const { normalizeHotkey, isHotkeyPressed } = require('./hotkeys');

const DEFAULT_SERVER_URL = process.env.TELEFON_SERVER_URL || 'https://127.0.0.1:3000';
const DEFAULT_PUSH_TO_TALK_HOTKEY = normalizeHotkey(process.env.TELEFON_PTT_HOTKEY || 'Alt+Space') || 'Alt+Space';
const AUDIO_MODES = new Set(['voice-activated', 'push-to-talk']);

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
        audioMode: 'voice-activated',
        pushToTalkHotkey: DEFAULT_PUSH_TO_TALK_HOTKEY,
    },
});

let mainWindow = null;
let keyboardListener = null;
let keyboardListenerReady = null;
let lastPushToTalkState = false;

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
        mainWindow = null;
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

        event.returnValue = getPublicSettings();
    });

    ipcMain.on('desktop:get-info', (event) => {
        event.returnValue = {
            isPackaged: app.isPackaged,
            platform: process.platform,
            version: app.getVersion(),
        };
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

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
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
