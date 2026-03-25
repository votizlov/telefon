// script.js

const socket = io.connect(window.location.hostname + ':3000', { secure: true });
const AUDIO_MODE_STORAGE_KEY = 'telefon.audioMode';
const AUDIO_MODE_VOICE_ACTIVATED = 'voice-activated';
const AUDIO_MODE_PUSH_TO_TALK = 'push-to-talk';
const VOICE_ACTIVITY_THRESHOLD = 0.035;
const VOICE_ACTIVITY_HOLD_MS = 350;

const yourIdElement = document.getElementById('yourId');
const usersListElement = document.getElementById('users');
const startStreamButton = document.getElementById('startStreamButton');
const muteButton = document.getElementById('muteButton');
const pushToTalkButton = document.getElementById('pushToTalkButton');
const audioStatusElement = document.getElementById('audioStatus');
const settingsHintElement = document.getElementById('settingsHint');
const audioModeInputs = document.querySelectorAll('input[name="audioMode"]');

muteButton.disabled = true;
pushToTalkButton.disabled = true;

let localStream;
let monitoringStream;
let peerConnections = {};
let remoteAudioElements = {};
let connectedUsers = [];
let speakingUsers = new Set();
let yourId = null;
let isStreaming = false;
let screenStream = null;
let screenPeerConnection = null;
let audioMode = loadAudioMode();
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

applyStoredAudioMode();
bindAudioControls();
updateMicrophoneState(true);

// Get audio stream from the user's microphone
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

// Handle connection
socket.on('connect', () => {
    if (yourId && yourId !== socket.id) {
        closeAllPeerConnections();
    }

    yourId = socket.id;
    connectedUsers = connectedUsers.filter((userId) => userId !== yourId);
    speakingUsers.delete(yourId);
    lastBroadcastSpeakingState = false;
    yourIdElement.textContent = yourId;
    updateSpeakingIndicators();
    if (mediaInitializationComplete) {
        broadcastSpeakingState(getShouldTransmitAudio());
        syncPeerConnections();
    }
});

// Update the list of connected users
socket.on('userList', (users) => {
    connectedUsers = users.filter((userId) => userId !== yourId);
    speakingUsers = new Set(
        Array.from(speakingUsers).filter((userId) => connectedUsers.includes(userId))
    );
    renderUserList();

    if (mediaInitializationComplete) {
        syncPeerConnections();
    }
});

socket.on('speakingState', (data) => {
    if (!data || !data.userId) {
        return;
    }

    if (data.isSpeaking) {
        speakingUsers.add(data.userId);
    } else {
        speakingUsers.delete(data.userId);
    }

    updateSpeakingIndicators();
});

function renderUserList() {
    usersListElement.innerHTML = '';
    connectedUsers.forEach((userId) => {
        const li = document.createElement('li');
        li.dataset.id = userId;
        li.textContent = userId;
        li.classList.toggle('speaking-user', speakingUsers.has(userId));
        usersListElement.appendChild(li);
    });
}

function loadAudioMode() {
    try {
        const storedValue = localStorage.getItem(AUDIO_MODE_STORAGE_KEY);
        if (storedValue === AUDIO_MODE_PUSH_TO_TALK || storedValue === AUDIO_MODE_VOICE_ACTIVATED) {
            return storedValue;
        }
    } catch (error) {
        console.error('Error reading audio mode from local storage.', error);
    }

    return AUDIO_MODE_VOICE_ACTIVATED;
}

function saveAudioMode(mode) {
    try {
        localStorage.setItem(AUDIO_MODE_STORAGE_KEY, mode);
    } catch (error) {
        console.error('Error saving audio mode to local storage.', error);
    }
}

function applyStoredAudioMode() {
    audioModeInputs.forEach((input) => {
        input.checked = input.value === audioMode;
    });
}

function bindAudioControls() {
    audioModeInputs.forEach((input) => {
        input.addEventListener('change', (event) => {
            audioMode = event.target.value;
            saveAudioMode(audioMode);

            if (audioMode !== AUDIO_MODE_PUSH_TO_TALK) {
                isPushToTalkActive = false;
            }

            resumeAudioContextIfNeeded();
            updateMicrophoneState(true);
        });
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

    window.addEventListener('keydown', (event) => {
        if (event.code !== 'Space' || audioMode !== AUDIO_MODE_PUSH_TO_TALK || event.repeat || isEditableElement(document.activeElement)) {
            return;
        }

        event.preventDefault();
        setPushToTalkActive(true);
    });

    window.addEventListener('keyup', (event) => {
        if (event.code !== 'Space') {
            return;
        }

        if (audioMode === AUDIO_MODE_PUSH_TO_TALK) {
            event.preventDefault();
        }

        setPushToTalkActive(false);
    });

    window.addEventListener('blur', () => setPushToTalkActive(false));
    window.addEventListener('pointerdown', resumeAudioContextIfNeeded);
    window.addEventListener('keydown', resumeAudioContextIfNeeded);
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
    for (let i = 0; i < analyserData.length; i += 1) {
        const sample = (analyserData[i] - 128) / 128;
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

function broadcastSpeakingState(isSpeaking) {
    if (!socket.connected || lastBroadcastSpeakingState === isSpeaking) {
        return;
    }

    lastBroadcastSpeakingState = isSpeaking;
    socket.emit('speakingState', isSpeaking);
}

function updateSpeakingIndicators() {
    yourIdElement.classList.toggle('speaking-user', getShouldTransmitAudio());

    usersListElement.querySelectorAll('li').forEach((li) => {
        li.classList.toggle('speaking-user', speakingUsers.has(li.dataset.id));
    });
}

function updateAudioUi(shouldTransmit, force = false) {
    let statusText = 'Initializing microphone...';

    if (!localStream) {
        statusText = muteButton.disabled ? 'Microphone unavailable.' : 'Waiting for microphone access...';
    } else if (isMuted) {
        statusText = 'Microphone muted.';
    } else if (audioMode === AUDIO_MODE_PUSH_TO_TALK) {
        statusText = shouldTransmit ? 'Transmitting while push-to-talk is held.' : 'Hold Space or the button to talk.';
    } else {
        statusText = shouldTransmit ? 'Voice detected. Transmitting.' : 'Voice activated mode is waiting for speech.';
    }

    const nextUiState = `${audioMode}:${isMuted}:${isPushToTalkActive}:${shouldTransmit}:${muteButton.disabled}`;
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
        ? 'Push to talk is active. Hold Space or the button above to transmit.'
        : 'Voice activated mode transmits only while the app detects speech.';
}

function isOffererFor(remoteUserId) {
    return yourId && yourId.localeCompare(remoteUserId) < 0;
}

function syncPeerConnections() {
    if (!yourId) {
        return;
    }

    const activeUsers = new Set(connectedUsers);

    Object.keys(peerConnections).forEach((remoteUserId) => {
        if (!activeUsers.has(remoteUserId)) {
            closePeerConnection(remoteUserId);
        }
    });

    connectedUsers.forEach((remoteUserId) => {
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
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
        ]
    };
    const peerConnection = new RTCPeerConnection(configuration);

    // Add the local stream to the connection
    addLocalAudioTrack(peerConnection);

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        const remoteAudio = remoteAudioElements[remoteUserId] || new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play();
        remoteAudioElements[remoteUserId] = remoteAudio;
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                target: remoteUserId,
                signal: { 'candidate': event.candidate },
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
        .then((offer) => {
            return peerConnection.setLocalDescription(offer);
        })
        .then(() => {
            socket.emit('signal', {
                target: remoteUserId,
                signal: { 'sdp': peerConnection.localDescription },
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

// Handle incoming signals
socket.on('signal', (data) => {
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
                    peerConnection.createAnswer()
                        .then((answer) => {
                            return peerConnection.setLocalDescription(answer);
                        })
                        .then(() => {
                            socket.emit('signal', {
                                target: fromId,
                                signal: { 'sdp': peerConnection.localDescription },
                            });
                        });
                }
            });
    } else if (data.signal.candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
    }
});

// Add event listener for send button
document.getElementById('sendButton').onclick = () => {
    const messageInput = document.getElementById('chatInput');
    const message = messageInput.value.trim();
    if (message !== '') {
        // Send message to server
        socket.emit('chatMessage', {
            from: yourId,
            message: message,
        });
        // Add message to chat window
        addMessageToChatWindow(`Me: ${message}`);
        messageInput.value = '';
    }
};

// Function to add message to chat window
function addMessageToChatWindow(message) {
    const chatWindow = document.getElementById('chatWindow');
    const messageElement = document.createElement('div');
    messageElement.textContent = message;
    chatWindow.appendChild(messageElement);
    // Scroll to the bottom
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

// Listen for incoming chat messages
socket.on('chatMessage', (data) => {
    // Display message in chat window
    addMessageToChatWindow(`${data.from}: ${data.message}`);
});

// Add event listener to the Start Streaming button
startStreamButton.onclick = () => {
    if (!isStreaming) {
        startScreenSharing();
    } else {
        stopScreenSharing();
    }
};

function startScreenSharing() {
    if (isStreaming) {
        alert('A stream is already in progress.');
        return;
    }

    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        .then((stream) => {
            screenStream = stream;
            isStreaming = true;
            startStreamButton.textContent = 'Stop Streaming';

            // Display the local screen stream
            const screenVideo = document.getElementById('screenVideo');
            screenVideo.srcObject = screenStream;

            // Set up peer connection for screen sharing
            const configuration = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    // Add TURN servers if available
                ]
            };
            screenPeerConnection = new RTCPeerConnection(configuration);

            // Add screen stream tracks to the peer connection
            screenStream.getTracks().forEach((track) => {
                screenPeerConnection.addTrack(track, screenStream);
            });

            // Handle ICE candidates
            screenPeerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('screenSignal', {
                        candidate: event.candidate,
                        from: yourId,
                    });
                }
            };

            // Handle negotiation needed event
            screenPeerConnection.onnegotiationneeded = () => {
                screenPeerConnection.createOffer()
                    .then((offer) => screenPeerConnection.setLocalDescription(offer))
                    .then(() => {
                        socket.emit('screenSignal', {
                            description: screenPeerConnection.localDescription,
                            from: yourId,
                        });
                    })
                    .catch((error) => {
                        console.error('Error during screen sharing negotiation:', error);
                    });
            };

            // Handle screen stream ending
            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenSharing();
            };

        })
        .catch((error) => {
            console.error('Error accessing display media.', error);
        });
}

function stopScreenSharing() {
    if (screenStream) {
        screenStream.getTracks().forEach((track) => track.stop());
    }
    if (screenPeerConnection) {
        screenPeerConnection.close();
        screenPeerConnection = null;
    }
    isStreaming = false;
    startStreamButton.textContent = 'Start Streaming';
    document.getElementById('screenVideo').srcObject = null;
}

// Listen for incoming screen signals
socket.on('screenSignal', async (data) => {
    if (data.from === yourId) {
        // Ignore signals from self
        return;
    }

    if (!screenPeerConnection) {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                // Add TURN servers if available
            ]
        };
        screenPeerConnection = new RTCPeerConnection(configuration);

        // Handle remote track
        screenPeerConnection.ontrack = (event) => {
            const screenVideo = document.getElementById('screenVideo');
            screenVideo.srcObject = event.streams[0];
        };

        // Handle ICE candidates
        screenPeerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('screenSignal', {
                    candidate: event.candidate,
                    from: yourId,
                });
            }
        };
    }

    try {
        if (data.description) {
            const description = data.description;
            if (description.type === 'offer') {
                await screenPeerConnection.setRemoteDescription(description);
                const answer = await screenPeerConnection.createAnswer();
                await screenPeerConnection.setLocalDescription(answer);
                socket.emit('screenSignal', {
                    description: screenPeerConnection.localDescription,
                    from: yourId,
                });
            } else if (description.type === 'answer') {
                await screenPeerConnection.setRemoteDescription(description);
            }
        } else if (data.candidate) {
            await screenPeerConnection.addIceCandidate(data.candidate);
        }
    } catch (error) {
        console.error('Error handling screen signal:', error);
    }
});

// Handle stream denied message
socket.on('streamDenied', (data) => {
    alert(data.message);
    stopScreenSharing();
});
