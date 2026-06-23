const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 8080;

// Serve static UI files
app.use(express.static(path.join(__dirname, 'public')));

// Store sockets
let spotifySocket = null;
const clientSockets = new Set();

// Handle upgrade from HTTP to WS
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/spotify') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, 'spotify');
        });
    } else if (pathname === '/client') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, 'client');
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, request, type) => {
    if (type === 'spotify') {
        console.log('Spotify Extension connected!');
        spotifySocket = ws;

        // Notify all web clients that Spotify is online
        broadcastToClients({ type: 'spotify_online', data: true });

        ws.on('message', (message) => {
            try {
                const parsed = JSON.parse(message);
                if (parsed.type === 'search_results') {
                    console.log('SEARCH RESULTS:', JSON.stringify(parsed.data, null, 2));
                }
                if (parsed.type === 'debug') {
                    console.log('DEBUG:', JSON.stringify(parsed.data, null, 2));
                }
                // Relay everything from Spotify to all Web Clients
                broadcastToClients(parsed);
            } catch (err) {
                console.error('Error parsing message from Spotify:', err);
            }
        });

        ws.on('close', () => {
            console.log('Spotify Extension disconnected!');
            spotifySocket = null;
            broadcastToClients({ type: 'spotify_online', data: false });
        });

        ws.on('error', (err) => {
            console.error('Spotify socket error:', err);
        });

    } else if (type === 'client') {
        console.log('Web Client connected!');
        clientSockets.add(ws);

        // Send current online status of Spotify to the client
        ws.send(JSON.stringify({ type: 'spotify_online', data: spotifySocket !== null }));

        // Request full state from Spotify if it's connected, so new client gets immediate update
        if (spotifySocket && spotifySocket.readyState === WebSocket.OPEN) {
            spotifySocket.send(JSON.stringify({ type: 'request_state' }));
        }

        ws.on('message', (message) => {
            try {
                const parsed = JSON.parse(message);
                // Relay commands from Web Client to Spotify
                if (spotifySocket && spotifySocket.readyState === WebSocket.OPEN) {
                    spotifySocket.send(JSON.stringify(parsed));
                } else {
                    console.log('Command ignored: Spotify is not connected.');
                    ws.send(JSON.stringify({ type: 'error', data: 'Spotify is not connected.' }));
                }
            } catch (err) {
                console.error('Error parsing message from Client:', err);
            }
        });

        ws.on('close', () => {
            console.log('Web Client disconnected.');
            clientSockets.delete(ws);
        });

        ws.on('error', (err) => {
            console.error('Client socket error:', err);
            clientSockets.delete(ws);
        });
    }
});

function broadcastToClients(messageObj) {
    const payload = JSON.stringify(messageObj);
    for (const client of clientSockets) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

// Function to get local IP addresses
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip loopback and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

// Start Server
server.listen(PORT, () => {
    console.log('\n======================================================');
    console.log(`Spotify Web Controller Server is running on port ${PORT}`);
    console.log('======================================================');
    console.log(`Access locally: http://localhost:${PORT}`);
    
    const localIPs = getLocalIPs();
    if (localIPs.length > 0) {
        console.log('\nTo control Spotify from other devices (like your phone):');
        localIPs.forEach(ip => {
            console.log(`👉 http://${ip}:${PORT}`);
        });
    } else {
        console.log('\nNo external network interfaces found. Local-only access.');
    }
    console.log('======================================================\n');
});
