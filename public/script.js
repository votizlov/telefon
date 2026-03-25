const desktopApi = window.telefonDesktop || null;
const isDesktopApp = Boolean(desktopApi);
const ioFactory = typeof window.io === 'function' ? window.io : null;

const STORAGE_KEYS = {
    audioMode: 'telefon.audioMode',
    nickname: 'telefon.nickname',
    serverUrl: 'telefon.serverUrl',
    pushToTalkHotkey: 'telefon.pushToTalkHotkey',
};

const AUDIO_MODE_VOICE_ACTIVATED = 'voice-activated';
const AUDIO_MODE_PUSH_TO_TALK = 'push-to-talk';
const VOICE_ACTIVITY_THRESHOLD = 0.035;
const VOICE_ACTIVITY_HOLD_MS = 350;
const DEFAULT_DESKTOP_SERVER_URL = 'https://127.0.0.1:3000';
const DEFAULT_DESKTOP_PUSH_TO_TALK_HOTKEY = 'Alt+Space';

const desktopSettings = isDesktopApp && desktopApi.getSettings ? desktopApi.getSettings() : {};

const yourIdElement = document.getElementById('yourId');
const usersListElement = document.getElementById('users');
const startStreamButton = document.getElementById('startStreamButton');
const muteButton = document.getElementById('muteButton');
const pushToTalkButton = document.getElementById('pushToTalkButton');
const audioStatusElement = document.getElementById('audioStatus');
const settingsHintElement = document.getElementById('settingsHint');
const audioModeInputs = document.querySelectorAll('input[name="audioMode"]');
const nicknameInput = document.getElementById('nicknameInput');
const serverUrlInput = document.getElementById('serverUrlInput');
const pushToTalkHotkeyInput = document.getElementById('pushToTalkHotkeyInput');
const screenSharingSection = document.getElementById('screenSharingSection');
const screenHeaderElement = document.getElementById('screenHeader');
const screenVideoElement = document.getElementById('screenVideo');
const chatInputElement = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');

document.body.classList.toggle('desktop-app', isDesktopApp);

muteButton.disabled = true;
pushToTalkButton.disabled = true;

let socket = null;
let localStream = null;
let monitoringStream = null;
let peerConnections = {};
let remoteAudioElements = {};
let connectedUsers = [];
let speakingUsers = new Set();
let yourId = null;
let isStreaming = false;
let screenStream = null;
let screenPeerConnection = null;
let activeStreamerId = null;
let serverUrl = loadServerUrl();
let nickname = loadNickname();
let audioMode = loadAudioMode();
let pushToTalkHotkey = loadPushToTalkHotkey();
let isMuted = false;
let isPushToTalkActive = false;
let isVoiceDetected = false;
let audioContext = null;
let analyser = null;
let analyserData = null;
let voiceMonitorFrameId = null;
let voiceHoldUntil = 0;
let lastAudioUiState = '';
let mediaInitializationComplete = false;
let lastBroadcastSpeakingState = false;
let isStoppingScreenShare = false;
let removeDesktopPushToTalkListener = () => {};

applyStoredNickname();
applyStoredAudioMode();
applyStoredConnectionSettings();
bindUiEventHandlers();
updateOwnIdentityDisplay();
updateScreenSharingUi();
updateMicrophoneState(true);
connectSocket();
initializeMicrophone();

if (isDesktopApp && desktopApi.onPushToTalkState) {
    removeDesktopPushToTalkListener = desktopApi.onPushToTalkState((isActive) => {
        if (audioMode !== AUDIO_MODE_PUSH_TO_TALK) {
            return;
        }

        isPushToTalkActive = isActive;
        updateMicrophoneState(true);
    });
}

window.addEventListener('beforeunload', () => {
    removeDesktopPushToTalkListener();

    if (socket) {
        socket.disconnect();
    }
});

function readStoredValue(storageKey, desktopKey, fallbackValue) {
    if (isDesktopApp) {
        return Object.prototype.hasOwnProperty.call(desktopSettings, desktopKey)
            ? desktopSettings[desktopKey]
            : fallbackValue;
    }

    try {
        const storedValue = localStorage.getItem(storageKey);
        return storedValue === null ? fallbackValue : storedValue;
    } catch (error) {
        console.error(`Error reading ${storageKey} from local storage.`, error);
        return fallbackValue;
    }
}

function updateStoredValues(patch) {
    if (isDesktopApp && desktopApi.updateSettings) {
        const nextSettings = desktopApi.updateSettings(patch);
        Object.assign(desktopSettings, nextSettings);
        return;
    }

    Object.entries(patch).forEach(([desktopKey, value]) => {
        const storageKey = STORAGE_KEYS[desktopKey];
        if (!storageKey) {
            return;
        }

        try {
            localStorage.setItem(storageKey, value);
        } catch (error) {
            console.error(`Error writing ${storageKey} to local storage.`, error);
        }
    });
}

function getDefaultServerUrl() {
    if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
        return window.location.origin;
    }

    return DEFAULT_DESKTOP_SERVER_URL;
}

function normalizeServerUrl(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return '';
    }

    try {
        const parsedUrl = new URL(trimmedValue);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return '';
        }

        return parsedUrl.toString().replace(/\/+$/, '');
    } catch (error) {
        return '';
    }
}

function loadServerUrl() {
    const storedValue = readStoredValue(STORAGE_KEYS.serverUrl, 'serverUrl', getDefaultServerUrl());
    return normalizeServerUrl(storedValue) || getDefaultServerUrl();
}

function saveServerUrl(value) {
    updateStoredValues({ serverUrl: value });
}

function loadNickname() {
    return String(readStoredValue(STORAGE_KEYS.nickname, 'nickname', '') || '').trim().slice(0, 24);
}

function saveNickname(value) {
    updateStoredValues({ nickname: value });
}

function loadAudioMode() {
    const storedValue = readStoredValue(STORAGE_KEYS.audioMode, 'audioMode', AUDIO_MODE_VOICE_ACTIVATED);
    return storedValue === AUDIO_MODE_PUSH_TO_TALK ? AUDIO_MODE_PUSH_TO_TALK : AUDIO_MODE_VOICE_ACTIVATED;
}

function saveAudioMode(value) {
    updateStoredValues({ audioMode: value });
}

function loadPushToTalkHotkey() {
    if (!isDesktopApp) {
        return String(readStoredValue(STORAGE_KEYS.pushToTalkHotkey, 'pushToTalkHotkey', '') || '');
    }

    return String(readStoredValue(STORAGE_KEYS.pushToTalkHotkey, 'pushToTalkHotkey', DEFAULT_DESKTOP_PUSH_TO_TALK_HOTKEY) || '')
        .trim()
        .slice(0, 64);
}

function savePushToTalkHotkey(value) {
    updateStoredValues({ pushToTalkHotkey: value });
}

function applyStoredNickname() {
    nicknameInput.value = nickname;
}

function applyStoredAudioMode() {
    audioModeInputs.forEach((input) => {
        input.checked = input.value === audioMode;
    });
}

function applyStoredConnectionSettings() {
    serverUrlInput.value = serverUrl;
    pushToTalkHotkeyInput.value = pushToTalkHotkey;
    serverUrlInput.disabled = !isDesktopApp;
    pushToTalkHotkeyInput.disabled = !isDesktopApp;
}

function bindUiEventHandlers() {
    nicknameInput.addEventListener('input', handleNicknameInput);
    serverUrlInput.addEventListener('change', handleServerUrlChange);
    pushToTalkHotkeyInput.addEventListener('keydown', handlePushToTalkHotkeyCapture);
    pushToTalkHotkeyInput.addEventListener('focus', () => pushToTalkHotkeyInput.select());

    audioModeInputs.forEach((input) => {
        input.addEventListener('change', handleAudioModeChange);
    });

    muteButton.addEventListener('click', () => {
        isMuted = !isMuted;
        resumeAudioContextIfNeeded();
        updateMicrophoneState(true);
    });

    pushToTalkButton.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        setPushToTalkActive(true);
    });
    pushToTalkButton.addEventListener('pointerup', () => setPushToTalkActive(false));
    pushToTalkButton.addEventListener('pointerleave', () => setPushToTalkActive(false));
    pushToTalkButton.addEventListener('pointercancel', () => setPushToTalkActive(false));

    if (!isDesktopApp) {
        window.addEventListener('keydown', handleBrowserPushToTalkKeyDown);
        window.addEventListener('keyup', handleBrowserPushToTalkKeyUp);
    }

    window.addEventListener('blur', () => {
        if (!isDesktopApp) {
            setPushToTalkActive(false);
        }
    });
    window.addEventListener('pointerdown', resumeAudioContextIfNeeded);
    window.addEventListener('keydown', resumeAudioContextIfNeeded);

    startStreamButton.addEventListener('click', () => {
        if (!isStreaming) {
            startScreenSharing();
        } else {
            stopScreenSharing();
        }
    });

    sendButton.addEventListener('click', sendChatMessage);
    chatInputElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            sendChatMessage();
        }
    });
}

function handleNicknameInput(event) {
    nickname = event.target.value.trim().slice(0, 24);
    if (event.target.value !== nickname) {
        event.target.value = nickname;
    }

    saveNickname(nickname);
    updateOwnIdentityDisplay();
    renderUserList();
    updateScreenSharingUi();

    emitSocketEvent('setNickname', nickname);
}

function handleServerUrlChange(event) {
    if (!isDesktopApp) {
        event.target.value = serverUrl;
        return;
    }

    const nextServerUrl = normalizeServerUrl(event.target.value);
    if (!nextServerUrl) {
        alert('Enter a valid server URL, for example https://voice.example.com:3000');
        event.target.value = serverUrl;
        return;
    }

    if (nextServerUrl === serverUrl) {
        event.target.value = serverUrl;
        return;
    }

    serverUrl = nextServerUrl;
    saveServerUrl(serverUrl);
    reconnectSocket();
}

function handlePushToTalkHotkeyCapture(event) {
    if (!isDesktopApp) {
        return;
    }

    event.preventDefault();

    if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Escape') {
        pushToTalkHotkey = '';
        pushToTalkHotkeyInput.value = '';
        savePushToTalkHotkey(pushToTalkHotkey);
        isPushToTalkActive = false;
        updateMicrophoneState(true);
        return;
    }

    const capturedHotkey = hotkeyFromKeyboardEvent(event);
    if (!capturedHotkey) {
        return;
    }

    pushToTalkHotkey = capturedHotkey;
    pushToTalkHotkeyInput.value = pushToTalkHotkey;
    savePushToTalkHotkey(pushToTalkHotkey);
    updateMicrophoneState(true);
}

function handleAudioModeChange(event) {
    audioMode = event.target.value;
    saveAudioMode(audioMode);

    if (audioMode !== AUDIO_MODE_PUSH_TO_TALK) {
        isPushToTalkActive = false;
    }

    resumeAudioContextIfNeeded();
    updateMicrophoneState(true);
}

function handleBrowserPushToTalkKeyDown(event) {
    if (event.code !== 'Space' || audioMode !== AUDIO_MODE_PUSH_TO_TALK || event.repeat || isEditableElement(document.activeElement)) {
        return;
    }

    event.preventDefault();
    setPushToTalkActive(true);
}

function handleBrowserPushToTalkKeyUp(event) {
    if (event.code !== 'Space') {
        return;
    }

    if (audioMode === AUDIO_MODE_PUSH_TO_TALK) {
        event.preventDefault();
    }

    setPushToTalkActive(false);
}

function hotkeyFromKeyboardEvent(event) {
    const modifierTokens = [];

    if (event.ctrlKey) {
        modifierTokens.push('Ctrl');
    }
    if (event.altKey) {
        modifierTokens.push('Alt');
    }
    if (event.shiftKey) {
        modifierTokens.push('Shift');
    }
    if (event.metaKey) {
        modifierTokens.push('Meta');
    }

    const key = normalizeHotkeyKey(event.key);
    if (!key) {
        return '';
    }

    return [...modifierTokens, key].join('+');
}

function normalizeHotkeyKey(key) {
    if (typeof key !== 'string') {
        return '';
    }

    const normalizedKey = key.trim();
    if (!normalizedKey) {
        return '';
    }

    if (normalizedKey === ' ') {
        return 'Space';
    }

    if (normalizedKey.length === 1 && /[a-z0-9]/i.test(normalizedKey)) {
        return normalizedKey.toUpperCase();
    }

    const specialKeys = {
        Enter: 'Enter',
        Tab: 'Tab',
        Escape: 'Escape',
        Esc: 'Escape',
        Backspace: 'Backspace',
        Delete: 'Delete',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
    };

    if (specialKeys[normalizedKey]) {
        return specialKeys[normalizedKey];
    }

    if (/^F([1-9]|1[0-2])$/.test(normalizedKey.toUpperCase())) {
        return normalizedKey.toUpperCase();
    }

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(normalizedKey)) {
        return '';
    }

    return '';
}

function isEditableElement(element) {
    if (!element) {
        return false;
    }

    const tagName = element.tagName;
    return element.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function setPushToTalkActive(isActive) {
    if (audioMode !== AUDIO_MODE_PUSH_TO_TALK) {
        return;
    }

    if (isPushToTalkActive === isActive) {
        return;
    }

    isPushToTalkActive = isActive;
    resumeAudioContextIfNeeded();
    updateMicrophoneState(true);
}

function resumeAudioContextIfNeeded() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch((error) => {
            console.error('Error resuming audio context.', error);
        });
    }
}

function initializeMicrophone() {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then((stream) => {
            localStream = stream;
            const [audioTrack] = stream.getAudioTracks();
            muteButton.disabled = false;

            if (audioTrack) {
                monitoringStream = new MediaStream([audioTrack.clone()]);
                initializeVoiceMonitoring(monitoringStream);
            }

            mediaInitializationComplete = true;
            updateMicrophoneState(true);
            syncPeerConnections();
        })
        .catch((error) => {
            console.error('Error accessing media devices.', error);
            audioStatusElement.textContent = 'Microphone access denied.';
            muteButton.disabled = true;
            pushToTalkButton.disabled = true;
            mediaInitializationComplete = true;
            syncPeerConnections();
        });
}

function initializeVoiceMonitoring(stream) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor) {
        console.warn('Web Audio API is unavailable. Voice activated mode will keep the mic open.');
        isVoiceDetected = true;
        return;
    }

    audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    analyserData = new Uint8Array(analyser.fftSize);

    source.connect(analyser);
    monitorVoiceActivity();
}

function monitorVoiceActivity() {
    if (!analyser || !analyserData) {
        return;
    }

    analyser.getByteTimeDomainData(analyserData);

    let total = 0;
    for (let index = 0; index < analyserData.length; index += 1) {
        const sample = (analyserData[index] - 128) / 128;
        total += sample * sample;
    }

    const rms = Math.sqrt(total / analyserData.length);
    const now = performance.now();

    if (rms > VOICE_ACTIVITY_THRESHOLD) {
        voiceHoldUntil = now + VOICE_ACTIVITY_HOLD_MS;
    }

    isVoiceDetected = now <= voiceHoldUntil;
    updateMicrophoneState();
    voiceMonitorFrameId = requestAnimationFrame(monitorVoiceActivity);
}

function getLocalAudioTrack() {
    if (!localStream) {
        return null;
    }

    return localStream.getAudioTracks()[0] || null;
}

function addLocalAudioTrack(peerConnection) {
    const audioTrack = getLocalAudioTrack();

    if (!audioTrack || !localStream) {
        return;
    }

    peerConnection.addTrack(audioTrack, localStream);
}

function getShouldTransmitAudio() {
    const audioTrack = getLocalAudioTrack();
    return Boolean(
        audioTrack
        && !isMuted
        && (
            audioMode === AUDIO_MODE_PUSH_TO_TALK
                ? isPushToTalkActive
                : isVoiceDetected
        )
    );
}

function updateMicrophoneState(forceUiUpdate = false) {
    const audioTrack = getLocalAudioTrack();
    const shouldTransmit = getShouldTransmitAudio();

    if (audioTrack) {
        audioTrack.enabled = shouldTransmit;
    }

    broadcastSpeakingState(shouldTransmit);
    updateSpeakingIndicators();
    updateAudioUi(shouldTransmit, forceUiUpdate);
}

function updateAudioUi(shouldTransmit, force = false) {
    let statusText = 'Initializing microphone...';

    if (!localStream) {
        statusText = muteButton.disabled ? 'Microphone unavailable.' : 'Waiting for microphone access...';
    } else if (isMuted) {
        statusText = 'Microphone muted.';
    } else if (audioMode === AUDIO_MODE_PUSH_TO_TALK) {
        const hotkeyLabel = isDesktopApp
            ? (pushToTalkHotkey || 'the on-screen button')
            : 'Space or the button';
        statusText = shouldTransmit
            ? 'Transmitting while push-to-talk is held.'
            : `Hold ${hotkeyLabel} to talk.`;
    } else {
        statusText = shouldTransmit ? 'Voice detected. Transmitting.' : 'Voice activated mode is waiting for speech.';
    }

    const nextUiState = `${audioMode}:${isMuted}:${isPushToTalkActive}:${shouldTransmit}:${muteButton.disabled}:${pushToTalkHotkey}`;
    if (!force && nextUiState === lastAudioUiState) {
        return;
    }

    lastAudioUiState = nextUiState;
    muteButton.textContent = isMuted ? 'Unmute Mic' : 'Mute Mic';
    muteButton.classList.toggle('active', !isMuted && shouldTransmit);
    pushToTalkButton.classList.toggle('hidden', audioMode !== AUDIO_MODE_PUSH_TO_TALK);
    pushToTalkButton.classList.toggle('active', shouldTransmit && audioMode === AUDIO_MODE_PUSH_TO_TALK);
    pushToTalkButton.textContent = shouldTransmit && audioMode === AUDIO_MODE_PUSH_TO_TALK ? 'Talking...' : 'Hold to Talk';
    pushToTalkButton.disabled = muteButton.disabled || isMuted;
    audioStatusElement.textContent = statusText;
    audioStatusElement.classList.toggle('muted', isMuted || muteButton.disabled);
    audioStatusElement.classList.toggle('transmitting', shouldTransmit && !isMuted);
    settingsHintElement.textContent = audioMode === AUDIO_MODE_PUSH_TO_TALK
        ? getPushToTalkHint()
        : 'Voice activated mode transmits only while the app detects speech.';
}

function getPushToTalkHint() {
    if (isDesktopApp) {
        return pushToTalkHotkey
            ? `Desktop push to talk is active. Hold ${pushToTalkHotkey} or the on-screen button to transmit.`
            : 'Desktop push to talk is active. Configure a hotkey or use the on-screen button to transmit.';
    }

    return 'Push to talk is active. Hold Space or the button above to transmit.';
}

function updateSpeakingIndicators() {
    yourIdElement.classList.toggle('speaking-user', getShouldTransmitAudio());

    usersListElement.querySelectorAll('li').forEach((listItem) => {
        listItem.classList.toggle('speaking-user', speakingUsers.has(listItem.dataset.id));
    });
}

function getUserById(userId) {
    return connectedUsers.find((user) => user.id === userId) || null;
}

function getDisplayName(userId) {
    if (!userId) {
        return '';
    }

    if (userId === yourId) {
        return nickname || userId;
    }

    const user = getUserById(userId);
    return (user && user.nickname) || userId;
}

function updateOwnIdentityDisplay() {
    yourIdElement.textContent = nickname || yourId || 'Connecting...';
    yourIdElement.title = yourId || '';
}

function renderUserList() {
    usersListElement.innerHTML = '';
    connectedUsers.forEach((user) => {
        const listItem = document.createElement('li');
        listItem.dataset.id = user.id;
        listItem.textContent = getDisplayName(user.id);
        listItem.title = user.id;
        listItem.classList.toggle('speaking-user', speakingUsers.has(user.id));
        usersListElement.appendChild(listItem);
    });
}

function connectSocket() {
    if (!ioFactory) {
        audioStatusElement.textContent = 'Socket.IO client failed to load.';
        return;
    }

    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
    }

    socket = ioFactory(serverUrl, {
        secure: serverUrl.startsWith('https://'),
        transports: ['websocket', 'polling'],
    });

    bindSocketEventHandlers(socket);
}

function reconnectSocket() {
    closeAllPeerConnections();
    speakingUsers.clear();
    connectedUsers = [];
    renderUserList();
    updateSpeakingIndicators();

    if (!isStreaming) {
        activeStreamerId = null;
        clearRemoteScreenShare();
        updateScreenSharingUi();
    } else {
        stopScreenSharing();
    }

    connectSocket();
}

function bindSocketEventHandlers(socketInstance) {
    socketInstance.on('connect', handleSocketConnect);
    socketInstance.on('disconnect', handleSocketDisconnect);
    socketInstance.on('userList', handleUserList);
    socketInstance.on('speakingState', handleSpeakingState);
    socketInstance.on('streamState', handleStreamState);
    socketInstance.on('screenShareStopped', handleScreenShareStopped);
    socketInstance.on('signal', handleVoiceSignal);
    socketInstance.on('chatMessage', handleIncomingChatMessage);
    socketInstance.on('screenSignal', handleScreenSignal);
    socketInstance.on('streamDenied', handleStreamDenied);
}

function handleSocketConnect() {
    if (yourId && yourId !== socket.id) {
        closeAllPeerConnections();
    }

    yourId = socket.id;
    connectedUsers = connectedUsers.filter((user) => user.id !== yourId);
    speakingUsers.delete(yourId);
    lastBroadcastSpeakingState = false;
    updateOwnIdentityDisplay();
    updateSpeakingIndicators();
    emitSocketEvent('setNickname', nickname);

    if (mediaInitializationComplete) {
        broadcastSpeakingState(getShouldTransmitAudio());
        syncPeerConnections();
    }
}

function handleSocketDisconnect() {
    closeAllPeerConnections();
    connectedUsers = [];
    speakingUsers.clear();
    renderUserList();
    updateSpeakingIndicators();

    if (!isStreaming) {
        activeStreamerId = null;
        clearRemoteScreenShare();
    }

    updateScreenSharingUi();
}

function handleUserList(users) {
    connectedUsers = Array.isArray(users) ? users.filter((user) => user.id !== yourId) : [];
    speakingUsers = new Set(
        Array.from(speakingUsers).filter((userId) => connectedUsers.some((user) => user.id === userId))
    );
    renderUserList();
    updateOwnIdentityDisplay();
    updateScreenSharingUi();

    if (mediaInitializationComplete) {
        syncPeerConnections();
    }
}

function handleSpeakingState(data) {
    if (!data || !data.userId) {
        return;
    }

    if (data.isSpeaking) {
        speakingUsers.add(data.userId);
    } else {
        speakingUsers.delete(data.userId);
    }

    updateSpeakingIndicators();
}

function handleStreamState(data) {
    activeStreamerId = data && data.isActive ? data.streamerId : null;

    if (!activeStreamerId && !isStreaming) {
        clearRemoteScreenShare();
    }

    updateScreenSharingUi();
}

function handleScreenShareStopped() {
    if (!isStreaming) {
        clearRemoteScreenShare();
    }

    activeStreamerId = null;
    updateScreenSharingUi();
}

function emitSocketEvent(eventName, payload) {
    if (socket && socket.connected) {
        socket.emit(eventName, payload);
    }
}

function broadcastSpeakingState(isSpeaking) {
    if (!socket || !socket.connected || lastBroadcastSpeakingState === isSpeaking) {
        return;
    }

    lastBroadcastSpeakingState = isSpeaking;
    socket.emit('speakingState', isSpeaking);
}

function isOffererFor(remoteUserId) {
    return Boolean(yourId && yourId.localeCompare(remoteUserId) < 0);
}

function syncPeerConnections() {
    if (!yourId) {
        return;
    }

    const activeUsers = new Set(connectedUsers.map((user) => user.id));

    Object.keys(peerConnections).forEach((remoteUserId) => {
        if (!activeUsers.has(remoteUserId)) {
            closePeerConnection(remoteUserId);
        }
    });

    connectedUsers.forEach((user) => {
        const remoteUserId = user.id;
        if (!peerConnections[remoteUserId]) {
            const peerConnection = createPeerConnection(remoteUserId);
            peerConnections[remoteUserId] = peerConnection;

            if (isOffererFor(remoteUserId)) {
                createAndSendOffer(remoteUserId, peerConnection);
            }
        }
    });
}

function createPeerConnection(remoteUserId) {
    const peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    addLocalAudioTrack(peerConnection);

    peerConnection.ontrack = (event) => {
        const remoteAudio = remoteAudioElements[remoteUserId] || new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(() => {});
        remoteAudioElements[remoteUserId] = remoteAudio;
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            emitSocketEvent('signal', {
                target: remoteUserId,
                signal: { candidate: event.candidate },
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            closePeerConnection(remoteUserId);
        }
    };

    return peerConnection;
}

function createAndSendOffer(remoteUserId, peerConnection) {
    peerConnection.createOffer()
        .then((offer) => peerConnection.setLocalDescription(offer))
        .then(() => {
            emitSocketEvent('signal', {
                target: remoteUserId,
                signal: { sdp: peerConnection.localDescription },
            });
        })
        .catch((error) => {
            console.error('Error creating voice offer:', error);
        });
}

function closePeerConnection(remoteUserId) {
    const peerConnection = peerConnections[remoteUserId];
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        delete peerConnections[remoteUserId];
    }

    const remoteAudio = remoteAudioElements[remoteUserId];
    if (remoteAudio) {
        remoteAudio.pause();
        remoteAudio.srcObject = null;
        delete remoteAudioElements[remoteUserId];
    }
}

function closeAllPeerConnections() {
    Object.keys(peerConnections).forEach((remoteUserId) => {
        closePeerConnection(remoteUserId);
    });
}

function handleVoiceSignal(data) {
    const fromId = data.from;
    let peerConnection = peerConnections[fromId];

    if (!peerConnection) {
        peerConnection = createPeerConnection(fromId);
        peerConnections[fromId] = peerConnection;
    }

    if (data.signal.sdp) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp))
            .then(() => {
                if (peerConnection.remoteDescription.type === 'offer') {
                    return peerConnection.createAnswer()
                        .then((answer) => peerConnection.setLocalDescription(answer))
                        .then(() => {
                            emitSocketEvent('signal', {
                                target: fromId,
                                signal: { sdp: peerConnection.localDescription },
                            });
                        });
                }

                return null;
            })
            .catch((error) => {
                console.error('Error handling voice SDP signal:', error);
            });
    } else if (data.signal.candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate))
            .catch((error) => {
                console.error('Error adding ICE candidate:', error);
            });
    }
}

function sendChatMessage() {
    const message = chatInputElement.value.trim();
    if (!message) {
        return;
    }

    emitSocketEvent('chatMessage', {
        from: yourId,
        nickname,
        message,
    });

    addMessageToChatWindow(`Me: ${message}`);
    chatInputElement.value = '';
}

function addMessageToChatWindow(message) {
    const chatWindow = document.getElementById('chatWindow');
    const messageElement = document.createElement('div');
    messageElement.textContent = message;
    chatWindow.appendChild(messageElement);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function handleIncomingChatMessage(data) {
    const author = data.nickname || getDisplayName(data.from);
    addMessageToChatWindow(`${author}: ${data.message}`);
}

function updateScreenSharingUi() {
    const isScreenVisible = isStreaming || Boolean(activeStreamerId);
    screenSharingSection.classList.toggle('hidden', !isScreenVisible);

    if (!isScreenVisible) {
        screenHeaderElement.textContent = 'Screen Sharing';
        return;
    }

    if (isStreaming) {
        screenHeaderElement.textContent = 'Screen Sharing - You';
        return;
    }

    screenHeaderElement.textContent = `Screen Sharing - ${getDisplayName(activeStreamerId)}`;
}

function clearRemoteScreenShare() {
    if (screenPeerConnection) {
        screenPeerConnection.close();
        screenPeerConnection = null;
    }

    screenVideoElement.srcObject = null;
}

function handleLocalScreenShareEnded() {
    if (!screenStream && !isStreaming) {
        return;
    }

    stopScreenSharing({ skipTrackStop: true });
}

function attachScreenShareEndHandlers(stream) {
    if (!stream) {
        return;
    }

    stream.addEventListener('inactive', handleLocalScreenShareEnded, { once: true });
    stream.getTracks().forEach((track) => {
        track.addEventListener('ended', handleLocalScreenShareEnded, { once: true });
    });
}

function startScreenSharing() {
    if (isStreaming) {
        alert('A stream is already in progress.');
        return;
    }

    if (activeStreamerId && activeStreamerId !== yourId) {
        alert('A stream is already in progress.');
        return;
    }

    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        .then((stream) => {
            screenStream = stream;
            isStreaming = true;
            isStoppingScreenShare = false;
            activeStreamerId = yourId;
            startStreamButton.textContent = 'Stop Streaming';
            updateScreenSharingUi();
            attachScreenShareEndHandlers(screenStream);
            screenVideoElement.srcObject = screenStream;

            screenPeerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });

            screenStream.getTracks().forEach((track) => {
                screenPeerConnection.addTrack(track, screenStream);
            });

            screenPeerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    emitSocketEvent('screenSignal', {
                        candidate: event.candidate,
                        from: yourId,
                    });
                }
            };

            screenPeerConnection.onnegotiationneeded = () => {
                screenPeerConnection.createOffer()
                    .then((offer) => screenPeerConnection.setLocalDescription(offer))
                    .then(() => {
                        emitSocketEvent('screenSignal', {
                            description: screenPeerConnection.localDescription,
                            from: yourId,
                        });
                    })
                    .catch((error) => {
                        console.error('Error during screen sharing negotiation:', error);
                    });
            };
        })
        .catch((error) => {
            console.error('Error accessing display media.', error);
        });
}

function stopScreenSharing({ skipTrackStop = false } = {}) {
    if (isStoppingScreenShare) {
        return;
    }

    const currentScreenStream = screenStream;
    const wasStreaming = isStreaming;

    if (!currentScreenStream && !wasStreaming) {
        return;
    }

    isStoppingScreenShare = true;

    if (currentScreenStream && !skipTrackStop) {
        currentScreenStream.getTracks().forEach((track) => {
            if (track.readyState === 'live') {
                track.stop();
            }
        });
    }

    if (wasStreaming) {
        emitSocketEvent('stopScreenShare');
    }

    if (screenPeerConnection) {
        screenPeerConnection.close();
        screenPeerConnection = null;
    }

    screenStream = null;
    isStreaming = false;
    activeStreamerId = null;
    startStreamButton.textContent = 'Start Streaming';
    screenVideoElement.srcObject = null;
    updateScreenSharingUi();
    isStoppingScreenShare = false;
}

function handleScreenSignal(data) {
    if (data.from === yourId) {
        return;
    }

    if (!screenPeerConnection) {
        screenPeerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });

        screenPeerConnection.ontrack = (event) => {
            screenVideoElement.srcObject = event.streams[0];
        };

        screenPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                emitSocketEvent('screenSignal', {
                    candidate: event.candidate,
                    from: yourId,
                });
            }
        };
    }

    if (data.description) {
        const description = data.description;
        if (description.type === 'offer') {
            activeStreamerId = data.from;
            updateScreenSharingUi();
            screenPeerConnection.setRemoteDescription(description)
                .then(() => screenPeerConnection.createAnswer())
                .then((answer) => screenPeerConnection.setLocalDescription(answer))
                .then(() => {
                    emitSocketEvent('screenSignal', {
                        description: screenPeerConnection.localDescription,
                        from: yourId,
                    });
                })
                .catch((error) => {
                    console.error('Error handling screen share offer:', error);
                });
        } else if (description.type === 'answer') {
            screenPeerConnection.setRemoteDescription(description).catch((error) => {
                console.error('Error handling screen share answer:', error);
            });
        }
    } else if (data.candidate) {
        screenPeerConnection.addIceCandidate(data.candidate).catch((error) => {
            console.error('Error handling screen share ICE candidate:', error);
        });
    }
}

function handleStreamDenied(data) {
    alert(data.message);
    stopScreenSharing();
}
