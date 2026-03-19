const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('Connected to realtime server');
});

ws.on('message', (data) => {
  try {
    const parsed = JSON.parse(data.toString());
    console.log('EVENT:', parsed);
  } catch {
    console.log('RAW:', data.toString());
  }
});

ws.on('close', () => {
  console.log('Disconnected');
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
});
