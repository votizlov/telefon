// script.js

const socket = io.connect(window.location.hostname + ':3000', { secure: true });

let localStream;
let peerConnections = {};
let yourId = null;
let isStreaming = false;
let screenStream = null;
let screenPeerConnection = null;

// Get audio stream from the user's microphone
navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then((stream) => {
        localStream = stream;
    })
    .catch((error) => {
        console.error('Error accessing media devices.', error);
    });

// Handle connection
socket.on('connect', () => {
    yourId = socket.id;
    document.getElementById('yourId').textContent = yourId;
});

// Update the list of connected users
socket.on('userList', (users) => {
    const usersList = document.getElementById('users');
    usersList.innerHTML = '';
    users.forEach((userId) => {
        if (userId !== yourId) {
            const li = document.createElement('li');
            li.textContent = userId;
            li.dataset.id = userId;
            li.onclick = selectUser;
            usersList.appendChild(li);
        }
    });
});

function selectUser(event) {
    const selectedUserId = event.target.dataset.id;
    document.querySelectorAll('#users li').forEach((li) => {
        li.classList.remove('selected');
    });
    event.target.classList.add('selected');
    document.getElementById('callButton').dataset.target = selectedUserId;
}

document.getElementById('callButton').onclick = () => {
    const targetId = document.getElementById('callButton').dataset.target;
    if (targetId) {
        callUser(targetId);
    } else {
        alert('Please select a user to call.');
    }
};

function callUser(targetId) {
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
        ]
    };
    const peerConnection = new RTCPeerConnection(configuration);

    // Add the local stream to the connection
    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play();
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                target: targetId,
                signal: { 'candidate': event.candidate },
            });
        }
    };

    // Create an offer
    peerConnection.createOffer()
        .then((offer) => {
            return peerConnection.setLocalDescription(offer);
        })
        .then(() => {
            // Send the offer to the target user
            socket.emit('signal', {
                target: targetId,
                signal: { 'sdp': peerConnection.localDescription },
            });
        });

    // Save the peer connection
    peerConnections[targetId] = peerConnection;
}

// Handle incoming signals
socket.on('signal', (data) => {
    const fromId = data.from;
    let peerConnection = peerConnections[fromId];

    if (!peerConnection) {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
            ]
        };
        peerConnection = new RTCPeerConnection(configuration);

        // Add the local stream to the connection
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });

        // Handle incoming tracks
        peerConnection.ontrack = (event) => {
            const remoteAudio = new Audio();
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.play();
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', {
                    target: fromId,
                    signal: { 'candidate': event.candidate },
                });
            }
        };

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
document.getElementById('startStreamButton').onclick = () => {
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
            document.getElementById('startStreamButton').textContent = 'Stop Streaming';

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
    document.getElementById('startStreamButton').textContent = 'Start Streaming';
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