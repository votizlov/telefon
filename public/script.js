// script.js

const socket = io.connect(window.location.hostname + ':3000', { secure: true });

let localStream;
let peerConnections = {};
let yourId = null;

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
        li.style.fontWeight = 'normal';
    });
    event.target.style.fontWeight = 'bold';
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