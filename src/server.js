// server.js — WS broadcast server (terima dari sender, sebar ke client HP)
// Run: node -r dotenv/config server.js

import "dotenv/config";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const PORT = Number(process.env.WS_PORT || 8081);
const PUB_KEY = process.env.WS_KEY || "pub123";

// Simpan semua client yang terkoneksi
// Map<ws, { id, role }>
const clients = new Map();

const wss = new WebSocketServer({ port: PORT });

console.log(`[WS] Server listening on port ${PORT}`);

wss.on("connection", (ws, req) => {
  // Parse query ?role=...&key=...&id=...
  const url = new URL(req.url, `ws://${req.headers.host}`);
  const key = url.searchParams.get("key") || "";
  const role = url.searchParams.get("role") || "client";
  const id = url.searchParams.get("id") || randomUUID();

  // Auth sederhana pakai key
  if (key !== PUB_KEY) {
    console.log(`[WS] Rejected conn (bad key) from ${req.socket.remoteAddress}`);
    ws.close(4001, "invalid key");
    return;
  }

  clients.set(ws, { id, role });

  console.log(
    `[WS] Connected: id=${id} role=${role} from=${req.socket.remoteAddress}`
  );

  ws.on("message", (data, isBinary) => {
    const info = clients.get(ws);
    if (!info) return;

    // Jika pesan dari sender → broadcast ke semua client selain sender
    if (info.role === "sender") {
      for (const [other, meta] of clients.entries()) {
        if (other === ws) continue;
        if (meta.role === "sender") continue;
        if (other.readyState !== other.OPEN) continue;
        try {
          other.send(data, { binary: isBinary });
        } catch (e) {
          console.error("[WS] send to client error:", e?.message || e);
        }
      }
    } else {
      // Kalau HP kirim pesan, sementara ini cuma log
      try {
        const text = isBinary ? "<binary>" : data.toString();
        console.log(`[WS] Message from client ${info.id}: ${text.slice(0, 100)}`);
      } catch {}
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Disconnected: id=${id} role=${role}`);
  });

  ws.on("error", (err) => {
    console.log(`[WS] Error from ${id}:`, err?.message || err);
  });
});