# Narrative AI Agents

> Autonomous AI-powered trading agents for Solana memecoins � built for the Colosseum Frontier Hackathon 2026.

## What Is This?

Narrative AI is a multi-agent system that autonomously detects emerging narratives and market sentiment across Solana, scores tokens in real time, and executes trades based on quantified signals � without human intervention.

Built by **Bjorn Carrillo** in partnership with Narrative AI.

---

## How It Works

The system runs four specialized agents in parallel:

- **Research Agent** � Monitors pump.fun, Telegram channels, and on-chain activity to detect emerging token narratives
- **Safety Agent** � Scores every token for rug risk, sniper activity, creator history and holder concentration
- **Emotion Radar** � Quantifies market mood (FOMO, panic, greed) per token and across the full market
- **Smart Money Tracker** � Follows known high-performing wallets and detects early entry signals

All agents communicate through a central event bus � no direct agent-to-agent calls.

---

## Key Features

- Real-time pump.fun WebSocket monitoring
- Multi-signal token scoring (safety + momentum + social + smart money)
- Emotion detection (FOMO wave, panic selling, greed peak, euphoria)
- Smart money wallet tracking with win rate analysis
- SQLite performance tracking � every alert measured against real outcomes
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

## Test Results

5 live test sessions on Solana mainnet (v9.6 frozen build):

| Run | Date | Trades | Win Rate | P&L |
|-----|------|--------|----------|-----|
| #1 | 2025-04-01 | 26 | 38% | +74.2% |
| #2 | 2025-04-01 | 25 | 36% | -96.1% |
| #3 | 2026-04-03 | 19 | 21% | -105.3% |
| #4 | 2026-04-04 | 12 | 75% | +270.6% |
| #5 | 2026-04-05 | 212 | 42% | +774.6% |

**Cumulative: 294 trades, 41% win rate, +918.0% P&L across all sessions.**

Full per-bot breakdowns and analysis in [`test-results/daily-runs.md`](test-results/daily-runs.md).

---

## Live On-Chain Trades

Every trade executed by the AI agents is timestamped on the Solana blockchain via SPL Memo instructions, providing immutable, publicly verifiable proof that signals were generated before outcomes were known.

**Top 10 profitable trades** (Run #5 — 8-hour marathon, 2026-04-05):

| # | Bot | Token | P&L | SOL | Hold Time |
|---|-----|-------|-----|-----|-----------|
| 1 | ALPHA | $dicky | +334.7% | +10.04 SOL | 2.1m |
| 2 | DELTA | $RUBIA | +272.4% | +8.17 SOL | 2.1m |
| 3 | ALPHA | $STEVES | +226.5% | +6.80 SOL | 3.9m |
| 4 | ALPHA | $SQID | +192.6% | +5.78 SOL | 2.8m |
| 5 | DELTA | $egg | +127.0% | +3.81 SOL | 0.6m |
| 6 | DELTA | $MANIFEST | +108.2% | +3.25 SOL | 0.5m |
| 7 | ALPHA | $BONUPART | +88.0% | +2.64 SOL | 3.1m |
| 8 | ALPHA | $forward | +66.0% | +1.98 SOL | 2.2m |
| 9 | DELTA | $Dory | +63.4% | +1.90 SOL | 0.6m |
| 10 | BRAVO | $Trell | +59.4% | +1.78 SOL | 0.7m |

**Decoded on-chain memo example** (EXIT trade for $RUBIA):

```
NAI|v1|EXIT|DELTA|RUBIA|DjVmJ...N5Hq|SELL|0.000041|+272.4|+8.17|20260405T201200Z|D-RUBIA-0405-2012
```

| Field | Value | Meaning |
|-------|-------|---------|
| `NAI` | Prefix | Narrative AI identifier |
| `v1` | Version | Memo format version |
| `EXIT` | Action | Trade exit (sell) |
| `DELTA` | Agent | Bot that executed the trade |
| `RUBIA` | Token | Token symbol |
| `DjVmJ...N5Hq` | Address | Truncated contract address |
| `SELL` | Side | Sell order |
| `0.000041` | Price | Exit price in USD |
| `+272.4` | P&L % | Profit/loss percentage |
| `+8.17` | P&L SOL | Profit/loss in SOL |
| `20260405T201200Z` | Timestamp | UTC timestamp (ISO 8601) |
| `D-RUBIA-0405-2012` | Trade ID | Unique trade identifier |

**Wallet:** `HEQ89azr9bL6y5KRkKpwtGGNLZ4JeptzqfS2kZzZr12a` — [View on Solscan](https://solscan.io/account/HEQ89azr9bL6y5KRkKpwtGGNLZ4JeptzqfS2kZzZr12a)

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


