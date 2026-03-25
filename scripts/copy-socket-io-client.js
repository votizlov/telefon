const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
const targetDirectory = path.join(__dirname, '..', 'public', 'vendor');
const targetPath = path.join(targetDirectory, 'socket.io.min.js');

if (!fs.existsSync(sourcePath)) {
    throw new Error(`Socket.IO client bundle not found at ${sourcePath}`);
}

fs.mkdirSync(targetDirectory, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
console.log(`Copied Socket.IO client bundle to ${targetPath}`);
