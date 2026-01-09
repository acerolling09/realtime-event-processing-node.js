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

## 🏗 Architecture

