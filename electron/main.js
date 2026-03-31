const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, screen } = require('electron/main');
const Store = require('electron-store');
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
        overlayUnlocked: false,
        overlayPosition: null,
        audioMode: 'voice-activated',
        pushToTalkHotkey: DEFAULT_PUSH_TO_TALK_HOTKEY,
    },
});

let mainWindow = null;
let overlayWindow = null;
let keyboardListener = null;
let keyboardListenerReady = null;
let windowsInputListenerProcess = null;
let windowsInputListenerBuffer = '';
let windowsInputDownState = {};
let lastPushToTalkState = false;
let isQuitting = false;
let overlayState = {
    enabled: Boolean(settingsStore.get('overlayEnabled')),
    unlocked: Boolean(settingsStore.get('overlayUnlocked')),
    users: [],
};
let overlayDragState = null;

function resolveKeyboardServerPath() {
    if (process.platform !== 'win32') {
        return '';
    }

    const packagedPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'node-global-key-listener',
        'bin',
        'WinKeyServer.exe'
    );
    const developmentPath = path.join(
        __dirname,
        '..',
        'node_modules',
        'node-global-key-listener',
        'bin',
        'WinKeyServer.exe'
    );

    if (fs.existsSync(packagedPath)) {
        return packagedPath;
    }

    if (fs.existsSync(developmentPath)) {
        return developmentPath;
    }

    console.error('Global keyboard listener helper executable was not found.', {
        packagedPath,
        developmentPath,
        isPackaged: app.isPackaged,
    });
    return '';
}

function resolveWindowsInputListenerScriptPath() {
    const packagedPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'scripts',
        'win-global-input-listener.ps1'
    );
    const developmentPath = path.join(
        __dirname,
        '..',
        'scripts',
        'win-global-input-listener.ps1'
    );

    if (fs.existsSync(packagedPath)) {
        return packagedPath;
    }

    if (fs.existsSync(developmentPath)) {
        return developmentPath;
    }

    console.error('Windows global input listener script was not found.', {
        packagedPath,
        developmentPath,
        isPackaged: app.isPackaged,
    });
    return '';
}

function getKeyboardListenerConfig() {
    const keyboardListenerConfig = {
        windows: {
            onError(errorCode) {
                console.error('Global keyboard listener exited.', { errorCode });
            },
            onInfo(message) {
                const trimmedMessage = String(message || '').trim();
                if (trimmedMessage) {
                    console.info('Global keyboard listener:', trimmedMessage);
                }
            },
        },
    };

    const serverPath = resolveKeyboardServerPath();
    if (serverPath) {
        keyboardListenerConfig.windows.serverPath = serverPath;
    }

    return keyboardListenerConfig;
}

function getCurrentPushToTalkHotkey() {
    return getPublicSettings().pushToTalkHotkey;
}

function sendCurrentPushToTalkState(downState) {
    const hotkey = getCurrentPushToTalkHotkey();
    sendPushToTalkState(Boolean(hotkey) && isHotkeyPressed(downState, hotkey));
}

function updateWindowsInputDownState(eventState, keyName) {
    if (!keyName) {
        return;
    }

    windowsInputDownState[keyName] = eventState === 'DOWN';
    sendCurrentPushToTalkState(windowsInputDownState);
}

function handleWindowsInputListenerStdout(chunk) {
    windowsInputListenerBuffer += chunk.toString();
    const lines = windowsInputListenerBuffer.split(/\r?\n/);
    windowsInputListenerBuffer = lines.pop() || '';

    lines.forEach((line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            return;
        }

        const [eventState, keyName] = trimmedLine.split('|');
        if ((eventState !== 'DOWN' && eventState !== 'UP') || !keyName) {
            console.warn('Ignoring malformed Windows input listener event.', trimmedLine);
            return;
        }

        updateWindowsInputDownState(eventState, keyName.trim().toUpperCase());
    });
}

function stopWindowsInputListener() {
    if (!windowsInputListenerProcess) {
        return;
    }

    windowsInputListenerProcess.removeAllListeners();
    if (windowsInputListenerProcess.stdout) {
        windowsInputListenerProcess.stdout.removeAllListeners();
    }
    if (windowsInputListenerProcess.stderr) {
        windowsInputListenerProcess.stderr.removeAllListeners();
    }
    windowsInputListenerProcess.kill();
    windowsInputListenerProcess = null;
}

function ensureWindowsInputListener() {
    if (windowsInputListenerProcess) {
        return Promise.resolve();
    }

    const scriptPath = resolveWindowsInputListenerScriptPath();
    if (!scriptPath) {
        return Promise.resolve();
    }

    windowsInputListenerBuffer = '';
    windowsInputDownState = {};
    windowsInputListenerProcess = spawn(
        'powershell.exe',
        [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }
    );

    windowsInputListenerProcess.stdout.on('data', handleWindowsInputListenerStdout);
    windowsInputListenerProcess.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
            console.error('Windows global input listener error:', message);
        }
    });
    windowsInputListenerProcess.on('close', (code) => {
        windowsInputListenerProcess = null;
        windowsInputListenerBuffer = '';
        windowsInputDownState = {};
        sendPushToTalkState(false);

        if (!isQuitting) {
            console.error('Windows global input listener exited unexpectedly.', { code });
            setTimeout(() => {
                ensureWindowsInputListener().catch((error) => {
                    console.error('Failed to restart the Windows global input listener.', error);
                });
            }, 1000);
        }
    });
    windowsInputListenerProcess.on('error', (error) => {
        console.error('Failed to start the Windows global input listener.', error);
    });

    return Promise.resolve();
}

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
        overlayUnlocked: Boolean(settingsStore.get('overlayUnlocked')),
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

    if (Object.prototype.hasOwnProperty.call(patch, 'overlayUnlocked')) {
        nextSettings.overlayUnlocked = Boolean(patch.overlayUnlocked);
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
    if (process.platform === 'win32') {
        return ensureWindowsInputListener();
    }

    if (keyboardListener) {
        return keyboardListenerReady;
    }

    const { GlobalKeyboardListener } = require('node-global-key-listener');
    keyboardListener = new GlobalKeyboardListener(getKeyboardListenerConfig());
    keyboardListenerReady = keyboardListener.addListener((_event, downState) => {
        sendCurrentPushToTalkState(downState);
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
        unlocked: Object.prototype.hasOwnProperty.call(nextState, 'unlocked')
            ? Boolean(nextState.unlocked)
            : Boolean(settingsStore.get('overlayUnlocked')),
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

function sanitizeOverlayPosition(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }

    return {
        x: Math.round(x),
        y: Math.round(y),
    };
}

function getStoredOverlayPosition() {
    return sanitizeOverlayPosition(settingsStore.get('overlayPosition'));
}

function getOverlaySize(display) {
    const { width, height } = display.workArea;

    return {
        width: Math.min(OVERLAY_WIDTH, Math.max(1, width - (OVERLAY_EDGE_OFFSET * 2))),
        height: Math.min(getOverlayHeight(overlayState.users.length), Math.max(1, height - (OVERLAY_EDGE_OFFSET * 2))),
    };
}

function getDefaultOverlayPosition(display, size) {
    const { x, y, height } = display.workArea;

    return {
        x: x + OVERLAY_EDGE_OFFSET,
        y: y + Math.max(OVERLAY_EDGE_OFFSET, Math.round(height * OVERLAY_TOP_RATIO)),
    };
}

function getCurrentOverlayPosition() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return null;
    }

    const { x, y } = overlayWindow.getBounds();
    return sanitizeOverlayPosition({ x, y });
}

function getOverlayDisplay(position) {
    if (position) {
        return screen.getDisplayNearestPoint({
            x: Math.round(position.x),
            y: Math.round(position.y),
        });
    }

    return screen.getPrimaryDisplay();
}

function clampOverlayPosition(position, size, display) {
    const { x, y, width, height } = display.workArea;
    const maxX = Math.max(x, x + width - size.width);
    const maxY = Math.max(y, y + height - size.height);

    return {
        x: Math.min(Math.max(position.x, x), maxX),
        y: Math.min(Math.max(position.y, y), maxY),
    };
}

function getOverlayBounds(position = null) {
    const anchorPosition = sanitizeOverlayPosition(position)
        || getStoredOverlayPosition()
        || getCurrentOverlayPosition();
    const display = getOverlayDisplay(anchorPosition);
    const size = getOverlaySize(display);
    const nextPosition = clampOverlayPosition(
        anchorPosition || getDefaultOverlayPosition(display, size),
        size,
        display
    );

    return {
        x: nextPosition.x,
        y: nextPosition.y,
        width: size.width,
        height: size.height,
    };
}

function saveOverlayPosition(bounds) {
    const nextPosition = sanitizeOverlayPosition(bounds);
    if (!nextPosition) {
        return;
    }

    settingsStore.set('overlayPosition', nextPosition);
}

function syncOverlayWindowInteractivity() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    if (Boolean(settingsStore.get('overlayUnlocked'))) {
        overlayWindow.setIgnoreMouseEvents(false);
        return;
    }

    overlayDragState = null;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

function sendOverlayState() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    overlayWindow.webContents.send('overlay:state', overlayState);
}

function sanitizeOverlayDragPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const screenX = Number(payload.screenX);
    const screenY = Number(payload.screenY);
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        return null;
    }

    return {
        screenX: Math.round(screenX),
        screenY: Math.round(screenY),
    };
}

function startOverlayDrag(payload) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !Boolean(settingsStore.get('overlayUnlocked'))) {
        return;
    }

    const pointerPosition = sanitizeOverlayDragPayload(payload);
    if (!pointerPosition) {
        return;
    }

    overlayDragState = {
        startCursorX: pointerPosition.screenX,
        startCursorY: pointerPosition.screenY,
        startBounds: overlayWindow.getBounds(),
    };
}

function updateOverlayDrag(payload) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayDragState) {
        return;
    }

    const pointerPosition = sanitizeOverlayDragPayload(payload);
    if (!pointerPosition) {
        return;
    }

    const nextBounds = getOverlayBounds({
        x: overlayDragState.startBounds.x + (pointerPosition.screenX - overlayDragState.startCursorX),
        y: overlayDragState.startBounds.y + (pointerPosition.screenY - overlayDragState.startCursorY),
    });
    overlayWindow.setBounds(nextBounds);
}

function endOverlayDrag(payload) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayDragState) {
        overlayDragState = null;
        return;
    }

    updateOverlayDrag(payload);
    saveOverlayPosition(overlayWindow.getBounds());
    overlayDragState = null;
}

function syncOverlayWindowVisibility() {
    const shouldShow = Boolean(settingsStore.get('overlayEnabled')) && overlayState.users.length > 0;

    if (!shouldShow) {
        overlayDragState = null;
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
    syncOverlayWindowInteractivity();
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
    syncOverlayWindowInteractivity();
    overlayWindow.loadFile(path.join(__dirname, '..', 'public', 'overlay.html'));
    overlayWindow.webContents.on('did-finish-load', () => {
        sendOverlayState();
        syncOverlayWindowVisibility();
    });
    overlayWindow.on('closed', () => {
        overlayDragState = null;
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
        if (Object.prototype.hasOwnProperty.call(nextSettings, 'pushToTalkHotkey') && process.platform === 'win32') {
            sendCurrentPushToTalkState(windowsInputDownState);
        }

        if (Object.prototype.hasOwnProperty.call(nextSettings, 'overlayEnabled')) {
            overlayState.enabled = nextSettings.overlayEnabled;
            syncOverlayWindowVisibility();
        }

        if (Object.prototype.hasOwnProperty.call(nextSettings, 'overlayUnlocked')) {
            overlayState.unlocked = nextSettings.overlayUnlocked;
            syncOverlayWindowInteractivity();
            sendOverlayState();
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
        sendOverlayState();
        syncOverlayWindowVisibility();
    });

    ipcMain.on('overlay:drag-start', (_event, payload) => {
        startOverlayDrag(payload);
    });

    ipcMain.on('overlay:drag-move', (_event, payload) => {
        updateOverlayDrag(payload);
    });

    ipcMain.on('overlay:drag-end', (_event, payload) => {
        endOverlayDrag(payload);
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
    isQuitting = true;
    if (keyboardListener) {
        keyboardListener.kill();
    }
    stopWindowsInputListener();
});
