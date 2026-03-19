import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';

const clients = new Set<WebSocket>();

export function initWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  console.log('[ws] WebSocket server attached');
}

export function broadcast(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
