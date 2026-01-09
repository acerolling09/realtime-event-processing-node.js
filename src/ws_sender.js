// ws_sender.js — Ultra-fast WebSocket sender (ESM) — ENV dibaca di init()
import WebSocket from 'ws';
import { randomUUID } from 'crypto';

let sock = null, urlIdx = 0, hbTimer = null, backoffPow = 0;
const q = [];
const instanceId = randomUUID();

// state yang diisi saat init()
let WS_URLS = [];
let WS_KEY = 'pub123';
let WS_ROLE = 'sender';
let WS_CONNECT_TIMEOUT = 4000;
let WS_RETRY_MS_BASE = 700;
let WS_PING_MS = 9000;
let WS_MAX_QUEUE = 512;
let WS_MAX_BUFFERED = 65536;
let WS_DROP_WHEN_BUSY = true;
let WS_MAX_PAYLOAD = 16384;

function withQuery(u, obj) {
  try {
    const url = new URL(u);
    for (const [k, v] of Object.entries(obj)) url.searchParams.set(k, String(v));
    return url.toString();
  } catch { return u; }
}

function pickUrl() {
  if (!WS_URLS.length) return '';
  const base = WS_URLS[urlIdx % WS_URLS.length];
  urlIdx = (urlIdx + 1) % WS_URLS.length;
  return withQuery(base, { role: WS_ROLE, key: WS_KEY, id: instanceId });
}

function clearHB(){ if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
function startHB(){ clearHB(); if (WS_PING_MS >= 1000) hbTimer = setInterval(()=>{ try{ if(sock && sock.readyState===WebSocket.OPEN) sock.ping(); }catch{} }, WS_PING_MS); }
function canSend(){ return sock && sock.readyState===WebSocket.OPEN && (!WS_MAX_BUFFERED || sock.bufferedAmount<=WS_MAX_BUFFERED); }
function flushQueue(){ if(!canSend()) return; while(q.length && canSend()){ const m=q.shift(); try{ sock.send(m); }catch{ q.unshift(m); break; } } }
function scheduleReconnect(){
  const delay = Math.min(12000, WS_RETRY_MS_BASE * Math.pow(1.8, Math.min(8, backoffPow))) + Math.floor(Math.random()*250);
  backoffPow++; setTimeout(connect, delay);
}

function connect(){
  const target = pickUrl();
  if(!target){ console.error('[ws_sender] WS_URLS kosong'); return; }
  const kill = setTimeout(()=>{ try{ sock?.terminate(); }catch{} }, WS_CONNECT_TIMEOUT);
  const ws = new WebSocket(target, { perMessageDeflate:false, handshakeTimeout:WS_CONNECT_TIMEOUT, maxPayload:WS_MAX_PAYLOAD });

  ws.on('open', ()=>{
    clearTimeout(kill); backoffPow=0; sock=ws;
    try{ sock._socket?.setNoDelay(true); }catch{}
    startHB(); flushQueue();
    try{ sock.send(JSON.stringify({t:'hello', role:WS_ROLE, id:instanceId, ts:Date.now()})); }catch{}
  });
  ws.on('close', ()=>{ clearTimeout(kill); clearHB(); sock=null; scheduleReconnect(); });
  ws.on('error', ()=>{ clearTimeout(kill); /* diamkan */ });
  ws.on('pong', ()=>{});
}

function enqueue(s){ if(q.length>=WS_MAX_QUEUE){ if(WS_DROP_WHEN_BUSY) q.shift(); else return; } q.push(s); }
function pushText(text){
  const s=String(text||'').trim(); if(!s) return;
  if(canSend()){ try{ sock.send(s); return; }catch{} }
  enqueue(s); connect();
}

/* ===== API ===== */
export function init(){
  // ENV baru dibaca saat init → tidak tergantung urutan import
  const RAW = (process.env.WS_URLS || process.env.WS_PUSH_URL || process.env.WS_URL || '').trim();
  WS_URLS = RAW.split(',').map(s => s.trim()).filter(Boolean);
  WS_KEY  = process.env.WS_KEY || process.env.PUB_KEY || 'pub123';
  WS_ROLE = process.env.WS_ROLE || 'sender';

  WS_CONNECT_TIMEOUT = Number(process.env.WS_CONNECT_TIMEOUT || 4000);
  WS_RETRY_MS_BASE   = Number(process.env.WS_RETRY_MS_BASE  || 700);
  WS_PING_MS         = Number(process.env.WS_PING_MS        || 9000);
  WS_MAX_QUEUE       = Math.max(16, Number(process.env.WS_MAX_QUEUE || 512));
  WS_MAX_BUFFERED    = Math.max(0,  Number(process.env.WS_MAX_BUFFERED || 65536));
  WS_DROP_WHEN_BUSY  = (process.env.WS_DROP_WHEN_BUSY || '1') === '1';
  WS_MAX_PAYLOAD     = Math.max(1024, Number(process.env.WS_MAX_PAYLOAD || 16384)); // ← FIX: kurung tutup lengkap

  connect();
}

export function sendText(text){ pushText(text); }
export default { init, sendText };