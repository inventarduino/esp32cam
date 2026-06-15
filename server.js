const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// State
let latestFrame = null;
let cameraWs = null;
let cameraStatus = {
  framesize: 8,
  quality: 10,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hmirror: 0,
  vflip: 0,
  awb: 1,
  agc: 1,
  aec: 1,
  special_effect: 0,
  wb_mode: 0,
  led_intensity: 0
};

// Set of active HTTP stream clients
const streamClients = new Set();

// Handle upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws/camera') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket Server Events
wss.on('connection', (ws) => {
  console.log('Camera connected via WebSocket');
  cameraWs = ws;

  // Send the current cached status to the camera on connection
  ws.send(JSON.stringify({ action: 'sync', status: cameraStatus }));

  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      // It's a JPEG frame
      latestFrame = message;
      // Broadcast to all active stream clients
      broadcastFrame(message);
    } else {
      // It's a text message (status report)
      try {
        const text = message.toString();
        const data = JSON.parse(text);
        if (data.type === 'status') {
          cameraStatus = { ...cameraStatus, ...data.status };
          console.log('Camera status updated:', cameraStatus);
        }
      } catch (err) {
        console.error('Error parsing camera message:', err);
      }
    }
  });

  ws.on('close', () => {
    console.log('Camera disconnected');
    if (cameraWs === ws) {
      cameraWs = null;
    }
  });

  ws.on('error', (err) => {
    console.error('Camera socket error:', err);
  });
});

// Broadcast JPEG frame to all HTTP MJPEG stream clients
function broadcastFrame(frameBuffer) {
  const boundary = 'frame';
  const header = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`;
  const footer = '\r\n';

  for (const client of streamClients) {
    try {
      client.res.write(header);
      client.res.write(frameBuffer);
      client.res.write(footer);
    } catch (err) {
      // Connection might have closed
      streamClients.delete(client);
    }
  }
}

// Enable CORS so the Android app or web apps can hit status/control easily
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/status', (req, res) => {
  res.json(cameraStatus);
});

app.get('/control', (req, res) => {
  const { var: variable, val: valueStr } = req.query;
  if (!variable || !valueStr) {
    return res.status(400).send('Missing var or val query parameters');
  }

  const value = parseInt(valueStr, 10);
  if (isNaN(value)) {
    return res.status(400).send('Invalid val parameter');
  }

  // Update cached status locally
  if (cameraStatus.hasOwnProperty(variable)) {
    cameraStatus[variable] = value;
  }

  // Forward command to ESP32-CAM via WebSocket if connected
  if (cameraWs && cameraWs.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({ action: 'control', var: variable, val: value });
    cameraWs.send(payload);
    console.log(`Forwarded control: ${variable} = ${value}`);
    res.send('OK');
  } else {
    console.log(`Camera offline. Cached control locally: ${variable} = ${value}`);
    // Respond OK even if offline so the Android UI updates its state, but notify
    res.send('Cached (Camera Offline)');
  }
});

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-age=0, post-check=0, pre-check=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Connection', 'close');

  const client = { res };
  streamClients.add(client);

  // Send latest frame immediately if we have one so the screen isn't blank
  if (latestFrame) {
    const boundary = 'frame';
    const header = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`;
    res.write(header);
    res.write(latestFrame);
    res.write('\r\n');
  }

  req.on('close', () => {
    streamClients.delete(client);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
