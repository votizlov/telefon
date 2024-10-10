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