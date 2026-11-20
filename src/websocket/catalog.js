import { WebSocket } from "ws";

export function broadcastChanged(wss, type) {
  const message = JSON.stringify({
    type,
    changedAt: new Date().toISOString(),
  });
  let delivered = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      delivered += 1;
    }
  }
  console.info(`Broadcast ${type} to ${delivered} connected catalogue client(s).`);
}
