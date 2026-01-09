// bot.js — tele_hunter_fastqr_nowait_ws (ESM)
// MODE: FULL IMAGE ONLY (NO THUMBNAIL)
// RULE: jika foto > MAX_IMAGE_BYTES (default 1MB) => SKIP (tidak download)
// FIX: jsQR butuh RGBA (4 channel). Sekarang worker convert 1/2/3 channel -> RGBA, jadi error binarizer hilang.

import dotenv from "dotenv"; dotenv.config();

console.log("=== tele_hunter_fastqr_nowait_ws vFULL-ONLY-QR-RGBAFIX-1MB ===");

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import input from "input";
import fs from "fs";
import { Worker } from "worker_threads";
import * as ws from "./ws_sender.js";
import { createRequire } from "module";

/* ===== ENV / CONFIG ===== */
const apiId       = Number(process.env.TG_API_ID) || 0;
const apiHash     = process.env.TG_API_HASH || "";
const sessionFile = process.env.SESSION_FILE || "";

const AUTH_DIR     = process.env.AUTH_DIR || process.env.AUH_DIR || "";
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || AUTH_DIR;

const TARGET_LINKS_ID   = process.env.TARGET_LINKS_ID   || "";
const TARGET_LINKS_NAME = process.env.TARGET_LINKS_NAME || "";

// QUIET=1 => minim log, QUIET=0 => log tampil
const QUIET = (process.env.QUIET ?? "1") !== "0";

/* Low-latency knobs */
const PUSH_PRIORITY = (process.env.PUSH_PRIORITY ?? "1") === "1";
const SKIP_FORWARD  = (process.env.SKIP_FORWARD  ?? "0") === "1";
const FORWARD_ASYNC = (process.env.FORWARD_ASYNC ?? "1") === "1";

/* QR tuning */
const MAX_IMAGE_BYTES     = Math.max(200_000, Number(process.env.MAX_IMAGE_BYTES || 1_000_000)); // default 1MB
const LIMIT_PIXELS_PHOTO  = Math.max(1e6, Number(process.env.LIMIT_PIXELS_PHOTO) || 12e6);
const QUICK_DIM           = Math.max(240, Number(process.env.QUICK_DIM) || 640);
const QR_TIMEOUT_MS       = Math.max(250, Number(process.env.QR_TIMEOUT_MS) || 1200);

/* Download concurrency */
const MAX_DL = Math.max(1, Number(process.env.MAX_DL) || 2);

/* Workers */
const PREWARM_WORKERS    = Math.max(1, Number(process.env.PREWARM_WORKERS) || 2);
const MAX_ACTIVE_WORKERS = Math.max(1, Number(process.env.MAX_ACTIVE_WORKERS) || 2);
const MAX_QR_QUEUE       = Math.max(8, Number(process.env.MAX_QR_QUEUE) || 64);

/* Latency log */
const LATENCY_LOG = (process.env.LATENCY_LOG ?? "0") === "1";

/* ===== FS path ===== */
if (!AUTH_DIR) {
  console.error("❌ AUTH_DIR kosong");
  process.exit(1);
}
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

/* ===== HARD CHECK deps ===== */
const require = createRequire(import.meta.url);
try {
  require("sharp");
  require("jsqr");
} catch (e) {
  console.error("❌ DEPENDENCY MISSING:", e?.message || e);
  console.error("👉 Jalankan: npm i sharp jsqr");
  process.exit(1);
}

/* ===== Dedup ===== */
class FixedSetRB {
  constructor(n) {
    this.n = Math.max(8, n | 0);
    this.s = new Set();
    this.r = new Array(this.n);
    this.i = 0;
  }
  has(x) { return this.s.has(x); }
  add(x) {
    if (this.s.has(x)) return;
    const old = this.r[this.i];
    if (old !== undefined) this.s.delete(old);
    this.r[this.i] = x;
    this.s.add(x);
    this.i = (this.i + 1) % this.n;
  }
}
const pushedLRU = new FixedSetRB(4096);
const sentLRU   = new FixedSetRB(4096);

const WS_DEDUP         = (process.env.WS_DEDUP ?? "1") === "1";
const FORWARD_DEDUP    = (process.env.FORWARD_DEDUP ?? "1") === "1";
const WS_DEDUP_QR      = (process.env.WS_DEDUP_QR ?? "0") === "1";
const FORWARD_DEDUP_QR = (process.env.FORWARD_DEDUP_QR ?? "0") === "1";

/* ===== Dialog utils ===== */
function normalizeChatIdRaw(x) {
  if (x === null || x === undefined) return "";
  const t = typeof x;
  if (t === "bigint") return x.toString();
  if (t === "number") return Math.trunc(x).toString();
  if (t === "string") return x;
  if (t === "object") {
    if ("value" in x) return String(x.value);
    if ("id" in x) return String(x.id);
  }
  try { return String(x); } catch { return ""; }
}
function keyifyId(id) {
  const s = String(normalizeChatIdRaw(id) || "");
  if (!s) return "";
  const strip100 = s.startsWith("-100") ? s.slice(4) : s;
  return strip100.startsWith("-") ? strip100.slice(1) : strip100;
}
function sameChatId(a, b) {
  const sa = normalizeChatIdRaw(a);
  const sb = normalizeChatIdRaw(b);
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const strip100 = s => (s.startsWith("-100") ? s.slice(4) : s);
  const stripMinus = s => (s.startsWith("-") ? s.slice(1) : s);
  return stripMinus(strip100(sa)) === stripMinus(strip100(sb));
}
const dialogIndex = new Map();
function indexDialogs(dialogs) {
  for (const d of dialogs) {
    const e = d?.entity;
    if (!e) continue;
    const key = keyifyId(e.id);
    const name = d?.title ?? d?.name ?? e?.title ?? "(Tanpa Nama)";
    dialogIndex.set(key, { name, username: e?.username || "" });
  }
}
async function ensureSourceMetaByChatId(client, chatId) {
  const key = keyifyId(chatId);
  if (dialogIndex.has(key)) return dialogIndex.get(key);
  try {
    const ent = await client.getEntity(chatId);
    const name =
      ent?.title ||
      ent?.firstName ||
      ent?.lastName ||
      ent?.username ||
      "(Tanpa Nama)";
    const meta = { name: String(name || "(Tanpa Nama)"), username: ent?.username || "" };
    dialogIndex.set(key, meta);
    return meta;
  } catch {
    return { name: "", username: "" };
  }
}

/* ===== Filter money-link ===== */
function hasMoneyPattern(text) {
  if (!text) return false;
  const low = String(text).toLowerCase();
  return (
    low.includes("link.dana.id/danakaget") ||
    low.includes("link.dana.id/kaget")     ||
    low.includes("app.shopeepay.co.id/u")  ||
    low.includes("app.u.shopeepay.co.id/u")||
    low.includes("app.gopay.co.id/nf8p")
  );
}

/* ===== Extract URL pertama ===== */
function extractFirstMoneyUrl(text) {
  if (!text) return null;
  const s = String(text);
  const low = s.toLowerCase();

  const candidates = [
    "https://link.dana.id/danakaget",
    "http://link.dana.id/danakaget",
    "https://link.dana.id/kaget",
    "http://link.dana.id/kaget",
    "https://app.shopeepay.co.id/u/",
    "http://app.shopeepay.co.id/u/",
    "https://app.u.shopeepay.co.id/u/",
    "http://app.u.shopeepay.co.id/u/",
    "https://app.gopay.co.id/nf8p",
    "http://app.gopay.co.id/nf8p",
  ];

  let bestIdx = -1;
  for (const pat of candidates) {
    const idx = low.indexOf(pat);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) return null;

  let end = s.length;
  for (let i = bestIdx; i < s.length; i++) {
    if (s.charCodeAt(i) <= 32) { end = i; break; }
  }

  let url = s.slice(bestIdx, end).trim();
  url = url.replace(/[)\]\.,!?]+$/g, "");
  return url || null;
}

/* ===== PUSH & FORWARD ===== */
function formatForwardMessageMinimal(content, meta, origin) {
  const hdr = origin === "QR" ? "QR TERDETEKSI" : "TEKS TERDETEKSI";
  const hasName = (meta?.name || "").trim().length > 0;
  const groupLine = hasName
    ? (meta?.username ? `${meta.name} (@${meta.username})` : `${meta.name}`)
    : (meta?.username ? `(@${meta.username})` : `ID ${meta?.id ?? ""}`);
  return `${hdr}\n${groupLine}\n${content}`;
}

function pushOnlyNow(content, origin = "TEXT") {
  if (!content) return;
  const dedupWs = origin === "QR" ? WS_DEDUP_QR : WS_DEDUP;
  if (dedupWs) {
    if (pushedLRU.has(content)) return;
    pushedLRU.add(content);
  }
  try { ws.sendText(content); } catch {}
}

async function forwardOnly(client, targetEntity, content, metaP, origin = "TEXT") {
  if (!targetEntity || !content) return;
  const dedupFw = origin === "QR" ? FORWARD_DEDUP_QR : FORWARD_DEDUP;
  if (dedupFw) {
    if (sentLRU.has(content)) return;
    sentLRU.add(content);
  }
  try {
    const meta = metaP && typeof metaP.then === "function" ? await metaP : metaP || {};
    const msg = formatForwardMessageMinimal(content, meta, origin);
    await client.sendMessage(targetEntity, { message: msg });
  } catch (e) {
    if (!QUIET) console.error(`[${AUTH_DIR}] ❌ sendMessage:`, e?.message || e);
  }
}

/* ===== QR Worker (RGBA FIX) ===== */
const WORKER_CODE = `
  const { parentPort } = require('worker_threads');
  let sharp, jsQR;

  try { sharp = require('sharp'); } catch(e){ parentPort.postMessage({ __err: 'sharp_require:'+(e&&e.message) }); }
  try { jsQR  = require('jsqr'); }  catch(e){ parentPort.postMessage({ __err: 'jsqr_require:' +(e&&e.message) }); }

  try {
    if (sharp && sharp.concurrency) sharp.concurrency(1);
    if (sharp) sharp.cache(false);
  } catch {}

  function toBuf(x){
    if(!x) return Buffer.alloc(0);
    if(Buffer.isBuffer(x)) return x;
    if(x instanceof ArrayBuffer) return Buffer.from(x);
    if(ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset||0, x.byteLength||0);
    return Buffer.from(x);
  }

  function toRGBA(dataBuf, width, height, channels) {
    const src = new Uint8ClampedArray(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength);

    // jsQR WAJIB RGBA
    if (channels === 4) return { arr: src, w: width, h: height };

    const out = new Uint8ClampedArray(width * height * 4);

    if (channels === 3) {
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        out[j]   = src[i];
        out[j+1] = src[i+1];
        out[j+2] = src[i+2];
        out[j+3] = 255;
      }
      return { arr: out, w: width, h: height };
    }

    if (channels === 2) {
      // grayscale + alpha (ini yang bikin error kalau langsung dikasih ke jsQR)
      for (let i = 0, j = 0; i < src.length; i += 2, j += 4) {
        const g = src[i], a = src[i+1];
        out[j]   = g;
        out[j+1] = g;
        out[j+2] = g;
        out[j+3] = a;
      }
      return { arr: out, w: width, h: height };
    }

    // channels === 1
    for (let i = 0, j = 0; i < src.length; i += 1, j += 4) {
      const g = src[i];
      out[j]   = g;
      out[j+1] = g;
      out[j+2] = g;
      out[j+3] = 255;
    }
    return { arr: out, w: width, h: height };
  }

  async function renderRaw(input, { limitPixels, tgtW, tgtH, threshold }) {
    let p = sharp(input, { limitInputPixels: limitPixels, failOnError: false })
      .rotate()
      .resize(tgtW, tgtH, {
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true
      })
      .grayscale()
      .normalize();

    if (threshold) p = p.threshold(threshold);

    const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
    return { data, info };
  }

  async function decodeOnce(input, opts) {
    const { data, info } = await renderRaw(input, opts);
    if (!data || !data.length || !info || !info.width || !info.height) return null;

    const rgba = toRGBA(data, info.width, info.height, info.channels);

    // attemptBoth = lebih stabil untuk QR terbalik/kontras jelek
    const hit = jsQR(rgba.arr, rgba.w, rgba.h, { inversionAttempts: 'attemptBoth' });
    return (hit && hit.data) ? hit.data : null;
  }

  async function quickDecode(buf, { limitPixels, quickDim }) {
    if (!sharp || !jsQR) throw new Error('deps_not_available');

    const input = toBuf(buf);
    if (!input.length) return null;

    const meta = await sharp(input, { limitInputPixels: limitPixels, failOnError: false }).metadata();
    const w0 = meta.width  || 0;
    const h0 = meta.height || 0;
    if (!w0 || !h0) return null;

    let tgtW = w0, tgtH = h0;
    const maxSide = Math.max(w0, h0);
    if (maxSide > quickDim) {
      const scale = quickDim / maxSide;
      tgtW = Math.max(360, Math.round(w0 * scale));
      tgtH = Math.max(360, Math.round(h0 * scale));
    }

    let out = await decodeOnce(input, { limitPixels, tgtW, tgtH, threshold: null });
    if (out) return out;

    out = await decodeOnce(input, { limitPixels, tgtW, tgtH, threshold: 140 });
    if (out) return out;

    out = await decodeOnce(input, { limitPixels, tgtW, tgtH, threshold: 110 });
    if (out) return out;

    return null;
  }

  parentPort.on('message', async ({ buf, limitPixels, quickDim }) => {
    try {
      const text = await quickDecode(buf, { limitPixels, quickDim });
      parentPort.postMessage({ text: text || null });
    } catch (e) {
      parentPort.postMessage({ text: null, __err: e && e.message });
    }
  });
`;

/* ===== Worker pool + QUEUE (no drop) ===== */
function spawnWorker() {
  const w = new Worker(WORKER_CODE, { eval: true });
  w.on("error", e => { if (!QUIET) console.error("[QR/worker error]", e?.message || e); });
  w.on("exit", code => {
    if (!QUIET) console.log("[QR/worker exit]", code);
    const i = idleWorkers.indexOf(w);
    if (i >= 0) idleWorkers.splice(i, 1);
  });
  return w;
}

let idleWorkers = [];
let activeWorkers = 0;
for (let i = 0; i < PREWARM_WORKERS; i++) idleWorkers.push(spawnWorker());

const qrQueue = [];

function pumpQrQueue() {
  while (idleWorkers.length > 0 && activeWorkers < MAX_ACTIVE_WORKERS && qrQueue.length > 0) {
    const job = qrQueue.shift();
    if (!job || job.settled) continue;

    const w = idleWorkers.pop() || spawnWorker();
    activeWorkers++;

    let timer = null;

    const finish = (msg) => {
      if (job.settled) return;
      job.settled = true;

      try { w.off("message", onMsg); } catch {}
      if (timer) clearTimeout(timer);

      idleWorkers.push(w);
      activeWorkers--;
      job.resolve(msg && msg.text ? msg.text : null);
      pumpQrQueue();
    };

    const onMsg = (m) => {
      if (m && m.__err && !QUIET) console.log("[QR/worker msg err]", m.__err);
      finish(m);
    };

    w.on("message", onMsg);
    timer = setTimeout(() => finish(null), job.timeoutMs);

    const ab = job.buffer.buffer.slice(job.buffer.byteOffset, job.buffer.byteOffset + job.buffer.byteLength);
    try {
      w.postMessage({ buf: ab, limitPixels: LIMIT_PIXELS_PHOTO, quickDim: QUICK_DIM }, [ab]);
    } catch {
      finish(null);
    }
  }
}

function decodeQrFast(buffer, timeoutMs = QR_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) return resolve(null);

    if (qrQueue.length >= MAX_QR_QUEUE) {
      const dropped = qrQueue.shift();
      if (dropped && !dropped.settled) {
        dropped.settled = true;
        try { dropped.resolve(null); } catch {}
      }
    }

    qrQueue.push({ buffer, resolve, timeoutMs, settled: false });
    pumpQrQueue();
  });
}

/* ===== Non-blocking download semaphore ===== */
let dlActive = 0;
function tryAcquireDL() {
  if (dlActive >= MAX_DL) return false;
  dlActive++;
  return true;
}
function releaseDL() {
  if (dlActive > 0) dlActive--;
}

/* ===== Estimate photo size BEFORE download ===== */
function getApproxPhotoBytes(m) {
  try {
    const sizes = m?.media?.photo?.sizes;
    if (!Array.isArray(sizes) || sizes.length === 0) return 0;
    let mx = 0;
    for (const s of sizes) {
      const v = Number(s?.size || 0);
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    return mx;
  } catch {
    return 0;
  }
}

/* ===== FULL downloader (only if <= MAX_IMAGE_BYTES) ===== */
async function downloadPhotoFullIfSmall(client, m) {
  const approx = getApproxPhotoBytes(m);
  if (!approx) {
    if (!QUIET) console.log("[QR] SKIP (no approx size metadata)");
    return null;
  }
  if (approx > MAX_IMAGE_BYTES) {
    if (!QUIET) console.log(`[QR] SKIP > limit (approx ${approx} > ${MAX_IMAGE_BYTES})`);
    return null;
  }

  try {
    const full = await client.downloadMedia(m, { workers: 1 });
    if (!full) return null;
    const b = Buffer.isBuffer(full) ? full : Buffer.from(full);
    if (b.length > MAX_IMAGE_BYTES) {
      if (!QUIET) console.log(`[QR] SKIP after download (real ${b.length} > ${MAX_IMAGE_BYTES})`);
      return null;
    }
    return b;
  } catch (e) {
    if (!QUIET) console.error("[QR] download full fail:", e?.message || e);
    return null;
  }
}

/* ===== Bootstrap TG + WS ===== */
const savedSession =
  fs.existsSync(sessionFile) && fs.lstatSync(sessionFile).isFile()
    ? fs.readFileSync(sessionFile, "utf8")
    : "";
const stringSession = new StringSession(savedSession);

(async () => {
  if (!apiId || !apiHash) {
    console.error("❌ TG_API_ID/TG_API_HASH kosong");
    process.exit(1);
  }

  ws.init();

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 2,
  });

  await client.start({
    phoneNumber: () => input.text("Masukkan nomor telepon: "),
    password: () => input.text("Masukkan password (jika 2FA): "),
    phoneCode: () => input.text("Masukkan kode verifikasi: "),
    onError: (err) => { if (!QUIET) console.error(err); },
  });

  fs.writeFileSync(sessionFile, client.session.save());
  console.log("✅ Login OK");

  const dialogs = await client.getDialogs({ limit: 1000 });
  indexDialogs(dialogs);
  if (!QUIET) console.log(`📚 Dialog terindeks: ${dialogs.length}`);

  function matchByIdStrings(ds, idStr) {
    if (!idStr) return null;
    const raw = String(idStr);
    const withMinus100 = raw.startsWith("-100") ? raw : "-100" + raw;
    for (const d of ds) {
      const e = d?.entity;
      if (!e) continue;
      const eid = String(e.id);
      if (eid === raw || "-100" + eid === raw || eid === withMinus100 || "-100" + eid === withMinus100) return e;
    }
    return null;
  }
  function matchByName(ds, name) {
    const needle = (name || "").toLowerCase().trim();
    if (!needle) return null;
    let exact = null, fuzzy = null;
    for (const d of ds) {
      const title = (d?.title || d?.name || d?.entity?.title || "").toLowerCase();
      if (!title) continue;
      if (!exact && title === needle) exact = d.entity;
      if (!fuzzy && title.includes(needle)) fuzzy = d.entity;
      if (exact) break;
    }
    return exact || fuzzy;
  }

  let targetLinksEntity =
    matchByIdStrings(dialogs, TARGET_LINKS_ID) ||
    matchByName(dialogs, TARGET_LINKS_NAME);

  if (!targetLinksEntity) console.error("⚠️ Target links tidak ditemukan");
  else if (!QUIET) console.log(`✅ Target links: ${targetLinksEntity.id} | ${TARGET_LINKS_NAME || "(by ID)"}`);

  client.addEventHandler(
    (event) => {
      const m = event?.message;
      if (!m) return;

      const recvTs = Date.now();
      const msgTs  = m.date ? m.date * 1000 : recvTs;

      const skipLinksForward =
        targetLinksEntity && sameChatId(m.chatId, targetLinksEntity.id);

      // ===== TEXT =====
      if (!skipLinksForward) {
        const rawText = m.message || m.media?.caption || "";
        if (rawText && hasMoneyPattern(rawText)) {
          const url = extractFirstMoneyUrl(rawText) || rawText;

          if (!QUIET) {
            console.log("[TEXT] match:", rawText.slice(0, 160));
            console.log("[TEXT] URL:", url);
          }

          if (PUSH_PRIORITY) {
            const wsStart = Date.now();
            pushOnlyNow(url, "TEXT");
            const wsTs = Date.now();
            if (LATENCY_LOG) {
              const deltaTg = recvTs - msgTs;
              const wsSend  = wsTs - wsStart;
              const total   = wsTs - msgTs;
              console.log(`[LAT] TEXT chat=${m.chatId} msg=${m.id} ΔTG=${deltaTg}ms ws_send=${wsSend}ms total_to_WS=${total}ms`);
            }
          }

          if (!SKIP_FORWARD && targetLinksEntity) {
            const metaP = ensureSourceMetaByChatId(client, m.chatId);
            if (FORWARD_ASYNC) setImmediate(() => forwardOnly(client, targetLinksEntity, url, metaP, "TEXT"));
            else forwardOnly(client, targetLinksEntity, url, metaP, "TEXT").catch(() => {});
          }
        }
      }

      // ===== QR (FULL ONLY + SKIP > 1MB) =====
      if (skipLinksForward) return;
      const isPhoto = !!(m.media?.photo || m.photo);
      if (!isPhoto) return;

      const approx = getApproxPhotoBytes(m);
      if (!approx) {
        if (!QUIET) console.log("[QR] skip: no approx size metadata");
        return;
      }
      if (approx > MAX_IMAGE_BYTES) {
        if (!QUIET) console.log(`[QR] skip: approx ${approx} > MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES}`);
        return;
      }

      if (!tryAcquireDL()) return;

      setImmediate(async () => {
        let dlStart = 0, dlEnd = 0, decEnd = 0;
        try {
          dlStart = Date.now();
          const buffer = await downloadPhotoFullIfSmall(client, m);
          dlEnd = Date.now();

          if (!buffer || !buffer.length) return;

          const qrText = await decodeQrFast(buffer, QR_TIMEOUT_MS);
          decEnd = Date.now();

          if (!qrText) {
            if (!QUIET) console.log("[QR] decode null");
            return;
          }

          if (!QUIET) console.log("[QR] decoded:", String(qrText).slice(0, 220));

          if (!hasMoneyPattern(qrText)) {
            if (!QUIET) console.log("[QR] decoded but no money-pattern");
            return;
          }

          if (PUSH_PRIORITY) {
            const wsStart = Date.now();
            pushOnlyNow(qrText, "QR");
            const wsTs = Date.now();

            if (LATENCY_LOG) {
              const deltaTg = recvTs - msgTs;
              const tDl     = dlEnd - dlStart;
              const tDec    = decEnd - dlEnd;
              const wsSend  = wsTs - wsStart;
              const total   = wsTs - msgTs;
              console.log(`[LAT] QR   chat=${m.chatId} msg=${m.id} ΔTG=${deltaTg}ms dl=${tDl}ms decode=${tDec}ms ws_send=${wsSend}ms total_to_WS=${total}ms`);
            }
          }

          if (!SKIP_FORWARD && targetLinksEntity) {
            const metaP = ensureSourceMetaByChatId(client, m.chatId);
            if (FORWARD_ASYNC) setImmediate(() => forwardOnly(client, targetLinksEntity, qrText, metaP, "QR"));
            else forwardOnly(client, targetLinksEntity, qrText, metaP, "QR").catch(() => {});
          }
        } catch (e) {
          if (!QUIET) console.error("[QR/full] fail:", e?.message || e);
        } finally {
          releaseDL();
        }
      });
    },
    new NewMessage({ incoming: true })
  );
})().catch((e) => {
  console.error("❌ Fatal:", e?.message || e);
  process.exit(1);
});