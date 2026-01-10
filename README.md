# Realtime Telegram Event Processing with WebSocket (Node.js)

A high-performance Node.js system for capturing, processing, and delivering **time-sensitive Telegram events** (text & QR-based payment links) in **near real-time** using WebSocket instead of traditional HTTP polling.

---

## 🚀 Overview

This project is designed to solve a real-world problem:

> **How to detect and deliver critical Telegram events as fast as possible with minimal latency and overhead.**

Instead of forwarding messages directly inside Telegram, this system:
- **Processes messages locally**
- **Extracts high-value data (payment links, QR codes)**
- **Pushes results instantly to downstream applications via WebSocket**

This makes it suitable for:
- Realtime notification systems
- Event-driven backends
- Latency-sensitive automation

---

## 🧠 Key Design Decisions

### Why WebSocket (not REST / HTTP)?
- Persistent connection (no handshake per message)
- Lower latency for burst events
- Backpressure-aware buffering
- Suitable for realtime pipelines, not request/response flows

This system treats Telegram messages as **events**, not API requests.

---

## Architecture 🏗

```text
Telegram
│
▼
Telegram Client (Node.js)
│
├─ Text pattern detection
├─ QR code extraction (image → RGBA → jsQR)
│
▼
WebSocket Sender (Ultra-fast)
│
▼
WebSocket Server
│
▼
Mobile / Client Apps (Realtime)


## ⚙️ Core Features

- ✅ Realtime Telegram listener (GramJS)
- ✅ Smart text pattern detection (Dana, ShopeePay, GoPay)
- ✅ **QR decoding from images** (worker threads, non-blocking)
- ✅ Image size guard (skip > 1MB)
- ✅ RGBA image normalization (jsQR compatibility fix)
- ✅ WebSocket push with:
  - auto reconnect
  - exponential backoff
  - queue & drop strategy
- ✅ Optional Telegram forwarding
- ✅ Deduplication layer (LRU-based)

---

## 🧪 Performance Considerations

- Worker thread pool for QR decoding
- Sharp configured for low memory footprint
- Download concurrency limiter
- Non-blocking event handling
- Optional latency logging (ms-level)

---

## 🛠 Tech Stack

- Node.js (ESM)
- GramJS (Telegram MTProto)
- WebSocket (`ws`)
- Sharp (image processing)
- jsQR (QR decoding)
- Worker Threads
- dotenv

---

## 📂 Environment Setup

Create `.env` from example:

```bash
cp src/env.example .env
