# Telefon

Telefon is a small browser-based voice chat app built with Node.js, Express, Socket.IO, and WebRTC. It provides:

- one shared voice room where all connected users are joined automatically
- a shared text chat
- screen sharing, limited to one active stream at a time
- user-controlled microphone modes with persistent local settings
- local nicknames that are shown to other connected users
- an Electron desktop client with native global push-to-talk support

The server entrypoint is `server.js`. The frontend lives in `public/index.html` and `public/script.js`.

The project now has two runtime modes:

- Linux server: the shared HTTPS + Socket.IO signaling server from `server.js`
- Electron desktop client: a packaged desktop app that loads the frontend locally and connects to the remote Linux server

## How it works

- Express serves the static frontend from the `public/` directory.
- Socket.IO handles presence updates, chat messages, and WebRTC signaling.
- Voice calls and screen sharing use browser WebRTC APIs.
- HTTPS is required because browsers block microphone and screen-capture APIs on insecure origins.
- The Electron client uses `electron/main.js` and `electron/preload.js` to persist desktop settings and receive native global push-to-talk events.

## Current behavior and limits

This app is functional, but it has a few deployment-relevant constraints:

- The client connects to `https://<hostname>:3000` directly from the browser.
- A normal TLS-terminating reverse proxy on port `443` is not enough by itself, because the browser still tries to open Socket.IO/WebRTC signaling on port `3000`.
- TLS certificate files must be present as `key.pem` and `cert.pem` in the project root.
- Only one screen-sharing session is allowed at a time.
- There is no authentication or multiple-room system. All users join the same room.
- STUN is configured, but there is no TURN server, so some users behind strict NAT/firewalls may not connect reliably.
- Voice mode selection is stored in the browser with `localStorage`, so it is per device/browser, not per account.
- Nicknames are stored in the browser with `localStorage`, so they are per device/browser, not per account.
- The Electron desktop client stores its settings with `electron-store` instead of browser `localStorage`.
- Global push-to-talk in the Electron client is implemented with `node-global-key-listener`; according to the project README, Linux support is X11-only and macOS requires Accessibility permission. Source: https://github.com/LaunchMenu/node-global-key-listener

## Requirements

- Linux machine with network access
- Node.js 18+ and npm
- TCP port `3000` reachable by all clients
- A TLS certificate and private key for the hostname clients will open in the browser

## Linux deployment

### 1. Install Node.js

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nodejs npm
node -v
npm -v
```

If your distro packages an older Node version, install a current LTS release instead.

### 2. Copy the project to the server

Example:

```bash
git clone https://github.com/votizlov/telefon.git telefon
cd telefon
npm install --omit=dev
```

### 3. Add TLS certificate files

The server reads these files from the project root:

- `key.pem`
- `cert.pem`

If you already have a certificate for your domain, copy it into place:

```bash
cp /path/to/privkey.pem key.pem
cp /path/to/fullchain.pem cert.pem
```

For local testing only, you can create a self-signed certificate:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -days 365
```

Self-signed certificates will trigger browser security warnings unless the certificate is trusted manually.

### 4. Start the app

```bash
npm start
```

The app listens on port `3000` by default. You can change it with `PORT`, but the current frontend is hardcoded to connect to port `3000`, so clients will still expect that port unless the code is changed.

Example:

```bash
PORT=3000 npm start
```

### 5. Open the firewall

Example with UFW:

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

### 6. Access the app

Open this URL from each client machine:

```text
https://your-server-hostname:3000
```

Use a hostname that matches the certificate. If you use a self-signed certificate, each client browser must accept or trust it first.

## Electron desktop client

The Electron app is a client, not a replacement for the Linux server. It loads the UI from the packaged `public/` files and connects to the server URL configured in the desktop settings panel.

### Install desktop dependencies

```bash
npm install
```

This also copies a vendored Socket.IO browser bundle into `public/vendor/socket.io.min.js` during `postinstall`.

### Run the desktop client in development

Start the Linux/server-side app:

```bash
npm run dev:server
```

In another terminal, start Electron:

```bash
npm run dev:desktop
```

Or run both together:

```bash
npm run dev
```

By default, the desktop client expects the server at `https://127.0.0.1:3000`. You can change the server URL from the bottom-left settings panel inside the Electron app.

### Package the desktop client

Build unpacked output:

```bash
npm run build:desktop
```

Build installable desktop artifacts:

```bash
npm run dist
```

Configured Electron build targets:

- Windows: `nsis`
- Linux: `AppImage`, `deb`
- macOS: `dmg`

### Desktop push-to-talk

- In the Electron app, switch the audio mode to `Push to Talk`.
- Set a desktop hotkey in the bottom-left settings panel.
- That hotkey works even when the Electron window is not focused.
- The web version still only supports browser-focused push-to-talk.

## Run as a systemd service

Create `/etc/systemd/system/telefon.service`:

```ini
[Unit]
Description=Telefon voice chat app
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/telefon
Environment=PORT=3000
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Adjust `User`, `WorkingDirectory`, and `ExecStart` for your server.

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telefon
sudo systemctl status telefon
```

## Update on Linux

To pull the latest changes from GitHub on your Linux server:

```bash
cd /opt/telefon
git pull origin main
npm install --omit=dev
sudo systemctl restart telefon
sudo systemctl status telefon
```

Adjust `/opt/telefon` if you cloned the repo somewhere else.

If you are not using `systemd`, restart the app with whatever process manager you use after `git pull` and `npm install --omit=dev`.

## How to use the app

### Join

1. Open `https://your-server-hostname:3000`.
2. Allow microphone access when the browser asks.
3. Set a nickname in the bottom-left settings area if you want one displayed to other users.

### Join the voice room

1. Have another user open the app too.
2. Each user is connected to the same voice room automatically.
3. Audio should start automatically when the WebRTC mesh finishes connecting.

### Control your microphone

1. Set your nickname in the bottom-left `Voice Settings` section. Other users will see that name instead of your raw socket ID.
2. In the Electron app, set the `Server URL` field to the Linux server you want to join.
3. Use `Mute Mic` to fully mute or unmute your microphone.
4. In the bottom-left `Voice Settings` section, choose `Voice Activated` or `Push to Talk`.
5. `Voice Activated` transmits only when the browser detects speech.
6. In the web client, `Push to Talk` uses `Space` or the on-screen `Hold to Talk` button.
7. In the Electron client, `Push to Talk` can use a configurable global desktop hotkey or the on-screen button.

### Send chat messages

1. Type a message in the chat input.
2. Click `Send`.
3. Your own message appears as `Me: ...`; remote messages show the sender's nickname when available.

### Share your screen

1. Click `Start Streaming`.
2. Choose a screen or window in the browser prompt.
3. The screen-sharing panel appears only while a screen share is active.
4. The local preview appears in the screen area while you are sharing.
5. Other connected users receive the stream automatically.
6. Click `Stop Streaming` to end it.

## Operating notes

- Because there is no login system, anyone who can reach the server can join.
- For internet-facing deployments, use a real domain and a valid certificate.
- If clients can load the page but calls fail, the usual cause is NAT traversal. Add a TURN server if you need reliable cross-network connectivity.
- If screen sharing becomes unavailable after an interrupted session, restart the Node process.

## Development

Install dependencies:

```bash
npm install
```

Run the Linux server locally:

```bash
npm start
```

Run the Electron client:

```bash
npm run dev:desktop
```

Run both together:

```bash
npm run dev
```

Main files:

- `server.js`: HTTPS server, static hosting, Socket.IO events
- `public/script.js`: WebRTC call logic, chat UI, desktop/browser settings logic, screen-sharing logic
- `public/index.html`: app layout
- `public/style.css`: styles
- `electron/main.js`: Electron app lifecycle, desktop settings IPC, global push-to-talk listener
- `electron/preload.js`: secure renderer bridge for desktop settings and push-to-talk state
- `electron/hotkeys.js`: desktop hotkey parsing and matching
