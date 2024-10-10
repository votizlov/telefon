// server.js

const express = require('express');
const fs = require('fs');
const https = require('https');
const socketIO = require('socket.io');

// SSL Certificates
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// Create Express app
const app = express();
const server = https.createServer(options, app);
const io = socketIO(server);

// Serve static files from 'public' directory
app.use(express.static('public'));

// List of connected users
let users = [];

// Variable to track if a stream is active
let isStreamingActive = false;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    users.push(socket.id);
    io.emit('userList', users);
	
	// Handle chat messages
    socket.on('chatMessage', (data) => {
        // Broadcast message to all clients except the sender
        socket.broadcast.emit('chatMessage', data);
    });

    // Relay signals between users
    socket.on('signal', (data) => {
        console.log('Signal from', socket.id, 'to', data.target);
        io.to(data.target).emit('signal', {
            signal: data.signal,
            from: socket.id,
        });
    });
	
	// Handle screen sharing signals
    socket.on('screenSignal', (data) => {
        // If an offer is received and a stream is already active, deny the request
        if (data.description && data.description.type === 'offer') {
            if (isStreamingActive) {
                // Notify the sender that streaming is denied
                socket.emit('streamDenied', { message: 'A stream is already in progress.' });
                return;
            } else {
                isStreamingActive = true;
            }
        }

        // If the streamer disconnects or stops streaming
        if (data.description && data.description.type === 'answer') {
            // Streaming is accepted
        }

        // Relay the screen signal to all clients except the sender
        socket.broadcast.emit('screenSignal', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        users = users.filter((id) => id !== socket.id);
        io.emit('userList', users);
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Secure server is running on port ${PORT}`);
});