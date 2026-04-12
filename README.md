# Narrative AI Agents

> Autonomous AI-powered trading agents for Solana memecoins — built for the Colosseum Frontier Hackathon 2026.

## What Is This?

Narrative AI is a multi-agent system that autonomously detects emerging narratives and market sentiment across Solana, scores tokens in real time, and executes trades based on quantified signals — without human intervention.

Built by **Bjorn Carrillo** in partnership with Narrative AI.

---

## How It Works

The system runs four specialized agents in parallel:

- **Research Agent** — Monitors pump.fun, Telegram channels, and on-chain activity to detect emerging token narratives
- **Safety Agent** — Scores every token for rug risk, sniper activity, creator history and holder concentration
- **Emotion Radar** — Quantifies market mood (FOMO, panic, greed) per token and across the full market
- **Smart Money Tracker** — Follows known high-performing wallets and detects early entry signals

All agents communicate through a central event bus — no direct agent-to-agent calls.

---

## Key Features

- Real-time pump.fun WebSocket monitoring
- Multi-signal token scoring (safety + momentum + social + smart money)
- Emotion detection (FOMO wave, panic selling, greed peak, euphoria)
- Smart money wallet tracking with win rate analysis
- SQLite performance tracking — every alert measured against real outcomes
- Paper trading mode for safe testing
- Live Solana transaction proof via Solscan

---

## Tech Stack

- TypeScript / Node.js
- Solana Web3 / Helius RPC
- Jupiter API (trade execution)
- SQLite (better-sqlite3)
- Telegram Bot API
- pump.fun WebSocket

---

## Architecture

```text
pump.fun WebSocket
      |
      v
PumpFun Watcher --> token:new
      |
      v
Safety Agent --> token:safety
      |
      v
Token Analyzer --> token:scored
      |
      v
Trading Agent --> executes trade
      |
      v
Performance Tracker --> measures outcome
```

---

## Live Proof

This system was tested live on Solana mainnet.

**Verified transaction on Solscan:**
[View live transaction](https://solscan.io/tx/5Jhc2Li9e7Ra1qDpjAZX3JZc53nMzY4yXAhgeLxzVAhwZHQ7R9ARECZuRmxFiDHbq1wpG1UdeXfnmaKqKznZf8HZ)

---

## Author

**Bjorn Carrillo**
Built independently using Claude AI as development assistant.
GitHub: [@bjorncarrillo87-hash](https://github.com/bjorncarrillo87-hash)

---

## License

Copyright 2026 Bjorn Carrillo. All Rights Reserved.
Shared for Colosseum Frontier Hackathon evaluation purposes only.


