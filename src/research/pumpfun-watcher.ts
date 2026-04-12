// ── PumpFun Watcher ────────────────────────────────────
// Real-time WebSocket connection to pump.fun via PumpPortal.
// Detects every new token the instant it's created on pump.fun.
// Emits token:new events for the sniper detector to analyze.

import WebSocket from 'ws';
import { bus, log, config } from '../core/index.js';
import type { Agent, AgentMeta, NewTokenEvent, EarlyMomentumEvent } from '../core/types.js';

// Raw message from PumpPortal WebSocket
interface PumpPortalCreateMsg {
  txType: 'create';
  mint: string;
  name: string;
  symbol: string;
  bondingCurveKey: string;
  traderPublicKey: string;
  initialBuy: number;           // tokens bought by creator
  marketCapSol: number;
  vSolInBondingCurve: number;
  signature: string;
}

interface PumpPortalTradeMsg {
  txType: 'buy' | 'sell';
  mint: string;
  name: string;
  symbol: string;
  solAmount: number;
  marketCapSol: number;
  traderPublicKey: string;
  bondingCurveKey: string;
  signature: string;
}

interface PumpPortalMigrationMsg {
  txType?: string;
  mint: string;
  bondingCurveKey?: string;
  [key: string]: unknown;
}

type PumpPortalMsg = PumpPortalCreateMsg | PumpPortalTradeMsg | PumpPortalMigrationMsg;

export class PumpFunWatcher implements Agent {
  meta: AgentMeta = {
    name: 'PumpFun Watcher',
    squad: 'research',
    version: '1.0.0',
  };

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private running = false;

  // Stats
  private stats = {
    tokensDetected: 0,
    tradesTracked: 0,
    migrationsDetected: 0,
    lastTokenAt: 0,
    connected: false,
  };

  // Track tokens we're watching trades for (recently created)
  private watchedTokens: Map<string, {
    symbol: string;
    createdAt: number;
    trades: number;
    buyCount: number;
    sellCount: number;
    totalBuySOL: number;
    uniqueBuyers: Set<string>;
    largestBuySOL: number;
    lastEmittedAt: number;        // last time we emitted early_momentum
    latestMarketCapSOL: number;   // most recent MC from trade events
  }> = new Map();
  private static readonly MAX_WATCHED = 100;
  private static readonly WATCH_DURATION = 10 * 60_000; // watch trades for 10 min after creation
  private static readonly MOMENTUM_EMIT_INTERVAL = 8_000; // emit momentum updates every 8s max
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Dedup: prevent emitting duplicate token:new events for the same mint
  private seenMints: Set<string> = new Set();
  private static readonly MAX_SEEN_MINTS = 2000;

  // Serial deployer tracking: creator → recent mints
  private creatorMints: Map<string, { count: number; firstSeen: number }> = new Map();
  private static readonly SERIAL_DEPLOYER_WINDOW = 10 * 60_000; // 10 min window
  private static readonly SERIAL_DEPLOYER_THRESHOLD = 3; // 3+ tokens in window = serial deployer

  async start(): Promise<void> {
    this.running = true;
    log.info(`[${this.meta.name}] Starting — connecting to PumpPortal WebSocket`);
    this.connect();

    // Periodic cleanup of old watched tokens
    this.cleanupInterval = setInterval(() => this.cleanupWatched(), 60_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.ws) {
      // Add noop error handler before terminating to prevent unhandled error events
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      // terminate() is safer than close() — forces immediate shutdown without handshake
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.watchedTokens.clear();
    this.seenMints.clear();
    this.creatorMints.clear();
    log.info(`[${this.meta.name}] Stopped — ${this.stats.tokensDetected} tokens detected total`);
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(config.pumpfun.wsUrl);

      this.ws.on('open', () => {
        this.stats.connected = true;
        this.reconnectAttempts = 0;
        log.info(`[${this.meta.name}] Connected to PumpPortal WebSocket`);

        // Subscribe to new token creation events
        this.send({ method: 'subscribeNewToken' });

        // Subscribe to migration/graduation events
        this.send({ method: 'subscribeMigration' });

        bus.emit('ops:alert', {
          level: 'info',
          message: `PumpFun Watcher connected — streaming new tokens in real-time`,
        });
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as PumpPortalMsg;
          this.handleMessage(msg);
        } catch {
          // Ignore unparseable messages (heartbeats, etc.)
        }
      });

      this.ws.on('close', (code, reason) => {
        this.stats.connected = false;
        log.warn(`[${this.meta.name}] WebSocket closed (code=${code})`);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        log.error(`[${this.meta.name}] WebSocket error`, err);
        // Close handler will trigger reconnect
      });

    } catch (err) {
      log.error(`[${this.meta.name}] Failed to create WebSocket`, err);
      this.scheduleReconnect();
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: PumpPortalMsg): void {
    const txType = 'txType' in msg ? msg.txType : undefined;

    switch (txType) {
      case 'create':
        this.onNewToken(msg as PumpPortalCreateMsg);
        break;
      case 'buy':
      case 'sell':
        this.onTrade(msg as PumpPortalTradeMsg);
        break;
      default:
        // Migration/graduation events: have mint but no recognized txType
        if ('mint' in msg && msg.mint) {
          this.onMigration(msg as PumpPortalMigrationMsg);
        }
        break;
    }
  }

  private onNewToken(msg: PumpPortalCreateMsg): void {
    // ── Dedup: skip if we've already seen this mint ──
    if (this.seenMints.has(msg.mint)) {
      log.debug(`[${this.meta.name}] Duplicate create for $${msg.symbol} (${msg.mint.slice(0, 8)}...) — skipping`);
      return;
    }
    this.seenMints.add(msg.mint);

    // Cap seen mints to prevent unbounded growth
    if (this.seenMints.size > PumpFunWatcher.MAX_SEEN_MINTS) {
      const entries = Array.from(this.seenMints);
      this.seenMints = new Set(entries.slice(entries.length - 1500));
    }

    this.stats.tokensDetected++;
    this.stats.lastTokenAt = Date.now();

    // Calculate creator's initial buy in SOL
    // Virtual SOL starts at 30, so real SOL in curve = vSolInBondingCurve - 30
    const initialBuySOL = Math.max(0, (msg.vSolInBondingCurve ?? 30) - 30);

    // Quick filter: skip if creator initial buy is suspiciously large
    if (initialBuySOL > config.pumpfun.maxInitialBuySOL) {
      log.debug(
        `[${this.meta.name}] Skipping $${msg.symbol} — initial buy ${initialBuySOL.toFixed(1)} SOL > max ${config.pumpfun.maxInitialBuySOL}`
      );
      return;
    }

    // ── Serial deployer detection ──
    const creator = msg.traderPublicKey;
    const now = Date.now();
    const creatorInfo = this.creatorMints.get(creator);
    let isSerialDeployer = false;

    if (creatorInfo) {
      if (now - creatorInfo.firstSeen < PumpFunWatcher.SERIAL_DEPLOYER_WINDOW) {
        creatorInfo.count++;
        if (creatorInfo.count >= PumpFunWatcher.SERIAL_DEPLOYER_THRESHOLD) {
          isSerialDeployer = true;
          log.warn(
            `[${this.meta.name}] Serial deployer: ${creator.slice(0, 8)}... created ${creatorInfo.count} tokens in ${Math.round((now - creatorInfo.firstSeen) / 1000)}s — skipping $${msg.symbol}`
          );
          return;
        }
      } else {
        // Window expired, reset
        this.creatorMints.set(creator, { count: 1, firstSeen: now });
      }
    } else {
      this.creatorMints.set(creator, { count: 1, firstSeen: now });
    }

    // Cap creator tracking map
    if (this.creatorMints.size > 1000) {
      const cutoff = now - PumpFunWatcher.SERIAL_DEPLOYER_WINDOW;
      for (const [addr, info] of this.creatorMints) {
        if (info.firstSeen < cutoff) this.creatorMints.delete(addr);
      }
    }

    const event: NewTokenEvent = {
      mint: msg.mint,
      name: msg.name,
      symbol: msg.symbol,
      creator,
      bondingCurveKey: msg.bondingCurveKey,
      initialBuySOL,
      marketCapSOL: msg.marketCapSol,
      signature: msg.signature,
      timestamp: Date.now(),
    };

    // Emit for sniper detector to analyze
    bus.emit('token:new', event);

    // Start watching trades on this token for early momentum detection
    this.watchToken(msg.mint, msg.symbol);

    log.info(
      `[${this.meta.name}] NEW TOKEN: $${msg.symbol} (${msg.name}) — ` +
      `MC: ${msg.marketCapSol.toFixed(1)} SOL, Creator: ${creator.slice(0, 8)}...`
    );
  }

  private onTrade(msg: PumpPortalTradeMsg): void {
    const watched = this.watchedTokens.get(msg.mint);
    if (!watched) return; // Not tracking this token

    watched.trades++;
    this.stats.tradesTracked++;

    // Track latest MC from every trade (buy or sell)
    if (msg.marketCapSol > 0) watched.latestMarketCapSOL = msg.marketCapSol;

    if (msg.txType === 'buy') {
      watched.buyCount++;
      const solAmt = msg.solAmount ?? 0;
      watched.totalBuySOL += solAmt;
      watched.uniqueBuyers.add(msg.traderPublicKey);
      if (solAmt > watched.largestBuySOL) watched.largestBuySOL = solAmt;
    } else if (msg.txType === 'sell') {
      watched.sellCount++;
    }

    // Emit early momentum signal periodically (not on every trade — too noisy)
    const now = Date.now();
    const shouldEmit =
      (watched.buyCount >= 3 && now - watched.lastEmittedAt >= PumpFunWatcher.MOMENTUM_EMIT_INTERVAL) ||
      (watched.totalBuySOL >= 5 && now - watched.lastEmittedAt >= PumpFunWatcher.MOMENTUM_EMIT_INTERVAL) ||
      (watched.uniqueBuyers.size >= 5 && watched.lastEmittedAt === 0); // first emit when 5 unique buyers

    if (shouldEmit) {
      watched.lastEmittedAt = now;
      const event: EarlyMomentumEvent = {
        mint: msg.mint,
        symbol: watched.symbol,
        buyCount: watched.buyCount,
        sellCount: watched.sellCount,
        totalBuySOL: watched.totalBuySOL,
        uniqueBuyers: watched.uniqueBuyers.size,
        largestBuySOL: watched.largestBuySOL,
        timeSinceCreationMs: now - watched.createdAt,
        latestMarketCapSOL: watched.latestMarketCapSOL,
      };
      bus.emit('token:early_momentum', event);

      log.debug(
        `[${this.meta.name}] $${watched.symbol} momentum: ${watched.buyCount} buys, ` +
        `${watched.totalBuySOL.toFixed(1)} SOL vol, ${watched.uniqueBuyers.size} unique buyers`
      );
    }
  }

  private onMigration(msg: PumpPortalMigrationMsg): void {
    this.stats.migrationsDetected++;

    const watched = this.watchedTokens.get(msg.mint);
    const symbol = watched?.symbol || msg.mint.slice(0, 8);

    log.info(
      `[${this.meta.name}] GRADUATION: $${symbol} migrated to PumpSwap!`
    );

    bus.emit('ops:alert', {
      level: 'info',
      message: `$${symbol} graduated to PumpSwap!`,
    });

    // Stop watching — it's on PumpSwap now
    this.watchedTokens.delete(msg.mint);
  }

  /** Subscribe to trades for a recently created token */
  private watchToken(mint: string, symbol: string): void {
    // Cap watched tokens to prevent memory bloat
    if (this.watchedTokens.size >= PumpFunWatcher.MAX_WATCHED) {
      // Evict oldest
      const oldest = [...this.watchedTokens.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) {
        this.unwatchToken(oldest[0]);
      }
    }

    this.watchedTokens.set(mint, {
      symbol, createdAt: Date.now(), trades: 0,
      buyCount: 0, sellCount: 0, totalBuySOL: 0,
      uniqueBuyers: new Set(), largestBuySOL: 0, lastEmittedAt: 0,
      latestMarketCapSOL: 0,
    });
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  private unwatchToken(mint: string): void {
    this.watchedTokens.delete(mint);
    this.send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  private cleanupWatched(): void {
    const cutoff = Date.now() - PumpFunWatcher.WATCH_DURATION;
    for (const [mint, info] of this.watchedTokens) {
      if (info.createdAt < cutoff) {
        this.unwatchToken(mint);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error(`[${this.meta.name}] Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      bus.emit('ops:alert', {
        level: 'critical',
        message: `PumpFun Watcher disconnected after ${this.maxReconnectAttempts} reconnect attempts`,
      });
      return;
    }

    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    log.info(`[${this.meta.name}] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {});
        try { this.ws.terminate(); } catch { /* ignore */ }
        this.ws = null;
      }
      this.connect();
    }, delay);
  }

  /** Get current stats for health monitoring */
  getStats() {
    return {
      ...this.stats,
      watchedTokens: this.watchedTokens.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}


