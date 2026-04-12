// ── Paper Trader (Scalping Bot — Phase 1) ───────────────
// Configurable paper trader with Fibonacci retracement entry.
// V9.6: Removed trailing/breakeven stops (broken with 2s price checks — prices
// crash 50-80% between checks, trailing exits at -73% counted as "wins").
// Reverted to flat SL. Kept SL slippage simulation for realism.

import axios from 'axios';
import { bus, log } from '../core/index.js';
import { getDb } from '../core/db.js';
import { getMemoService } from '../services/solana-memo-service.js';
import { buildEntryMemo, buildExitMemo, generateTradeId } from '../services/memo-builders.js';
import type { ScoredToken, EarlyMomentumEvent } from '../core/types.js';

// SOL price for PumpPortal MC → USD conversion (paper-trader's own cache)
let solPriceUSD = 150;
let solPriceUpdatedAt = 0;
const SOL_PRICE_TTL = 5 * 60_000;

// ── Strategy configuration (passed in by StrategyRouter) ──
export interface StrategyConfig {
  name: string;                // e.g. 'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'
  label: string;               // e.g. 'BREAKOUT', 'PUMP_PHASE', 'TRENDING', 'NARRATIVE'
  takeProfitPct: number;       // TP percentage
  stopLossPct: number;         // SL percentage
  minScore: number;            // minimum overallScore to enter
  maxPositions: number;        // max concurrent positions for THIS bot
  sizeSOL: number;             // SOL per trade (paper)
  timeoutMinutes: number;      // close after N minutes
}

// Defaults shared across all strategies
const SHARED = {
  cooldownPerTokenMs: 60 * 60_000,      // 1 hour cooldown per token
  priceCheckIntervalMs: 2_000,           // 2s — SL was still blowing -21%/-31% at 3s
  stalePriceCloseMs: 45_000,             // safety close if no price for 45s (was 60s)
  maxTokenAgeMinutes: 60,               // only trade tokens < 1 hour old (first pump retrace only)
  // Fibonacci retracement entry
  fibWatchMaxMs: 8 * 60_000,            // watch for pullback up to 8 min
  fibEntryLow: 0.382,                   // enter between 0.382 and 0.500 retracement
  fibEntryHigh: 0.500,                  // 0.618 is first touch (too shallow), real reversals at 0.382-0.500
  fibCheckIntervalMs: 3_000,            // check Fib watchlist every 3s
  // v9.6: SL slippage simulation — in real trading, selling into a dump gets worse fills
  // TP has no slippage (selling into demand). SL adds extra penalty to be realistic.
  slSlippagePct: 3,                     // SL exits apply 3% additional slippage to exit price
};

interface PaperPosition {
  id: number;
  mint: string;
  symbol: string;
  entryPrice: number;
  entryMcUSD: number;
  sizeSOL: number;
  entryTime: number;
  score: number;
  chartPattern: string;
  // Tracking
  highestPrice: number;
  lowestPrice: number;
  lastCheckedPrice: number;
  lastCheckedAt: number;
  memoTradeId?: string;    // memo timestamp trade ID (v9.7)
}

// Token waiting for Fibonacci pullback before entry
interface FibWatch {
  mint: string;
  symbol: string;
  score: number;
  chartPattern: string;
  signalPrice: number;         // price at signal time (the "peak")
  signalMcUSD: number;
  // We estimate the pre-pump low as signalPrice * 0.7 (tokens typically pump 30-50%+ before detection)
  estimatedLow: number;
  watchedAt: number;
}

export class PaperTrader {
  readonly config: StrategyConfig;

  private running = false;
  private positions: Map<string, PaperPosition> = new Map();
  private fibWatchlist: Map<string, FibWatch> = new Map();
  private recentTrades: Map<string, number> = new Map();
  private priceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private fibCheckInterval: ReturnType<typeof setInterval> | null = null;
  private solPriceInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // PumpPortal price fallback — DexScreener has no data for tokens < 5-10 min old
  private pumpPriceCache: Map<string, { price: number; at: number }> = new Map();
  private onEarlyMomentum = (e: EarlyMomentumEvent) => {
    if (e.latestMarketCapSOL > 0) {
      const priceUSD = (e.latestMarketCapSOL * solPriceUSD) / 1_000_000_000;
      if (priceUSD > 0) this.pumpPriceCache.set(e.mint, { price: priceUSD, at: Date.now() });
    }
  };

  // Stats
  stats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    totalPnlPct: 0,
    totalPnlSOL: 0,
    fibEntriesConverted: 0,
    fibEntriesExpired: 0,
  };

  constructor(config: StrategyConfig) {
    this.config = config;
  }

  // Guards to prevent overlapping async calls when network is slow
  private _posCheckRunning = false;
  private _fibCheckRunning = false;

  start(): void {
    this.running = true;
    // Listen for PumpPortal price data (fallback when DexScreener hasn't indexed yet)
    bus.on('token:early_momentum', this.onEarlyMomentum);
    this.updateSolPrice().catch(() => {}); // prime SOL price cache
    this.solPriceInterval = setInterval(
      () => this.updateSolPrice().catch(e => log.debug(`[${this.config.name}] SOL price refresh failed: ${e}`)),
      SOL_PRICE_TTL,
    );
    this.priceCheckInterval = setInterval(() => {
      if (this._posCheckRunning) return; // skip if previous call still pending
      this._posCheckRunning = true;
      this.checkOpenPositions()
        .catch(e => log.error(`[${this.config.name}] Price check error`, e))
        .finally(() => { this._posCheckRunning = false; });
    }, SHARED.priceCheckIntervalMs);
    this.fibCheckInterval = setInterval(() => {
      if (this._fibCheckRunning) return;
      this._fibCheckRunning = true;
      this.checkFibWatchlist()
        .catch(e => log.error(`[${this.config.name}] Fib check error`, e))
        .finally(() => { this._fibCheckRunning = false; });
    }, SHARED.fibCheckIntervalMs);
    // Cleanup stale cache entries every 5 min to prevent memory leaks
    this.cleanupInterval = setInterval(() => this.cleanupCaches(), 5 * 60_000);
    log.info(
      `[${this.config.name}] Started — ${this.config.label} (v9.6 flat SL)\n` +
      `  TP: +${this.config.takeProfitPct}% | SL: -${this.config.stopLossPct}% | ` +
      `Timeout: ${this.config.timeoutMinutes}m | Size: ${this.config.sizeSOL} SOL | ` +
      `Max: ${this.config.maxPositions} | Score: ${this.config.minScore}+ | Price: ${SHARED.priceCheckIntervalMs / 1000}s\n` +
      `  Fib: ${SHARED.fibEntryLow}-${SHARED.fibEntryHigh} zone | ${SHARED.fibWatchMaxMs / 60_000}m watch | skip > ${SHARED.fibEntryHigh + 0.1}\n` +
      `  SL slippage: +${SHARED.slSlippagePct}% penalty on SL exits (realistic fills)\n` +
      `  Age: <${SHARED.maxTokenAgeMinutes}m only (first pump retrace)`
    );
  }

  stop(): void {
    this.running = false;
    bus.off('token:early_momentum', this.onEarlyMomentum);
    if (this.priceCheckInterval) clearInterval(this.priceCheckInterval);
    if (this.fibCheckInterval) clearInterval(this.fibCheckInterval);
    if (this.solPriceInterval) clearInterval(this.solPriceInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    // Close all open positions
    for (const [, pos] of this.positions) {
      this.closePosition(pos, pos.lastCheckedPrice || pos.entryPrice, 'shutdown');
    }

    if (this.fibWatchlist.size > 0) {
      log.info(`[${this.config.name}] ${this.fibWatchlist.size} Fib watches abandoned on shutdown`);
    }
  }

  /** Called by StrategyRouter when a token matches this bot's criteria.
   *  Doesn't enter immediately — adds to Fib watchlist for pullback entry. */
  tryEnter(token: ScoredToken): boolean {
    if (!this.running) return false;
    if (token.overallScore < this.config.minScore) return false;
    if (token.priceUSD <= 0) return false;

    // Age filter: only trade tokens < 60 min old (first pump retrace only)
    if (token.ageMinutes > SHARED.maxTokenAgeMinutes) {
      log.debug(
        `[${this.config.name}] ✗ $${token.symbol} too old (${token.ageMinutes.toFixed(0)}m > ${SHARED.maxTokenAgeMinutes}m)`
      );
      return false;
    }

    if (this.positions.has(token.mint)) return false;
    if (this.fibWatchlist.has(token.mint)) return false;
    if (this.positions.size + this.fibWatchlist.size >= this.config.maxPositions) return false;

    const lastTrade = this.recentTrades.get(token.mint);
    if (lastTrade && Date.now() - lastTrade < SHARED.cooldownPerTokenMs) return false;

    // Don't enter at pump peak — add to Fib watchlist.
    // Estimate the pre-pump low: tokens are typically up 30-50% by detection time.
    // Use signalPrice * 0.65 as estimated low (assumes ~54% pump before we see it).
    const estimatedLow = token.priceUSD * 0.65;

    this.fibWatchlist.set(token.mint, {
      mint: token.mint,
      symbol: token.symbol,
      score: token.overallScore,
      chartPattern: token.chartPattern || 'UNKNOWN',
      signalPrice: token.priceUSD,
      signalMcUSD: token.marketCapUSD,
      estimatedLow,
      watchedAt: Date.now(),
    });

    // Fib levels for logging
    const range = token.priceUSD - estimatedLow;
    const fib382 = token.priceUSD - range * SHARED.fibEntryLow;
    const fib618 = token.priceUSD - range * SHARED.fibEntryHigh;

    const chartLabel = token.chartPattern ? ` | Chart: ${token.chartPattern}` : '';
    log.info(
      `[${this.config.name}] 🔍 FIB WATCH $${token.symbol} — waiting for pullback\n` +
      `  Signal: $${token.priceUSD.toPrecision(4)} | Score: ${token.overallScore}${chartLabel}\n` +
      `  Entry zone: $${fib618.toPrecision(4)} — $${fib382.toPrecision(4)} (${SHARED.fibEntryLow}-${SHARED.fibEntryHigh} Fib)`
    );

    return true;
  }

  /** Check Fibonacci watchlist — enter when price pulls back to Fib entry zone */
  private async checkFibWatchlist(): Promise<void> {
    if (!this.running || this.fibWatchlist.size === 0) return;

    const mints = [...this.fibWatchlist.keys()];
    const prices = await this.fetchPrices(mints);
    const now = Date.now();

    for (const [mint, watch] of [...this.fibWatchlist.entries()]) {
      // Timeout: if no pullback in 5 min, skip this token
      if (now - watch.watchedAt > SHARED.fibWatchMaxMs) {
        log.info(`[${this.config.name}] ⏰ FIB EXPIRED $${watch.symbol} — no pullback in ${SHARED.fibWatchMaxMs / 60_000}m`);
        this.fibWatchlist.delete(mint);
        this.stats.fibEntriesExpired++;
        continue;
      }

      const currentPrice = prices.get(mint);
      if (!currentPrice || currentPrice <= 0) continue;

      // Peak tracking: if token pumps higher after detection, update signal price
      // This is critical for early-detected PumpFun tokens that pump 5-10x after watchlist entry
      if (currentPrice > watch.signalPrice) {
        watch.signalPrice = currentPrice;
        watch.estimatedLow = currentPrice * 0.65;
        // Reset timer — give full watch window from the peak, not from detection
        watch.watchedAt = now;
        // Don't enter while pumping — wait for the pullback
        continue;
      }

      const range = watch.signalPrice - watch.estimatedLow;
      if (range <= 0) continue; // safety: avoid division by zero
      const pullbackFromPeak = (watch.signalPrice - currentPrice) / range;

      // Price dropped below 0.618 retracement — momentum lost, skip
      if (pullbackFromPeak > SHARED.fibEntryHigh + 0.1) {
        log.info(
          `[${this.config.name}] ❌ FIB SKIP $${watch.symbol} — dropped too far ` +
          `($${currentPrice.toPrecision(4)}, ${(pullbackFromPeak * 100).toFixed(0)}% retracement)`
        );
        this.fibWatchlist.delete(mint);
        this.stats.fibEntriesExpired++;
        continue;
      }

      // Price in the Fib entry zone
      if (pullbackFromPeak >= SHARED.fibEntryLow && pullbackFromPeak <= SHARED.fibEntryHigh) {
        this.fibWatchlist.delete(mint);
        this.stats.fibEntriesConverted++;
        this.enterPosition(watch, currentPrice);
        continue;
      }

      // Still above 0.382 — hasn't pulled back enough yet, keep watching
    }
  }

  private enterPosition(watch: FibWatch, entryPrice: number): void {
    if (this.positions.size >= this.config.maxPositions) return;

    const now = Date.now();
    const { sizeSOL } = this.config;
    const improvement = ((watch.signalPrice - entryPrice) / watch.signalPrice * 100).toFixed(1);

    // Persist to DB
    let tradeId = 0;
    try {
      const db = getDb();
      const result = db.prepare(`
        INSERT INTO paper_trades
        (mint, symbol, source, score, entry_price, entry_mc, size_sol, entry_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(
        watch.mint, watch.symbol, this.config.name, watch.score,
        entryPrice, watch.signalMcUSD, sizeSOL, now,
      );
      tradeId = result.lastInsertRowid as number;
    } catch (err) {
      log.error(`[${this.config.name}] DB insert failed for $${watch.symbol}`, err);
    }

    const pos: PaperPosition = {
      id: tradeId,
      mint: watch.mint,
      symbol: watch.symbol,
      entryPrice,
      entryMcUSD: watch.signalMcUSD,
      sizeSOL,
      entryTime: now,
      score: watch.score,
      chartPattern: watch.chartPattern,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      lastCheckedPrice: entryPrice,
      lastCheckedAt: now,
    };

    // On-chain memo timestamp (fire-and-forget — never blocks trading)
    const memoTradeId = generateTradeId(this.config.name, watch.symbol);
    pos.memoTradeId = memoTradeId;
    const entryMemo = buildEntryMemo(
      this.config.name, watch.symbol, watch.mint,
      entryPrice, sizeSOL, watch.score, watch.chartPattern, memoTradeId,
    );
    getMemoService().sendTradeMemo(entryMemo);

    this.positions.set(watch.mint, pos);
    this.recentTrades.set(watch.mint, now);

    log.info(
      `[${this.config.name}] 📈 PAPER BUY $${watch.symbol} @ $${entryPrice.toPrecision(4)} — ` +
      `FIB ENTRY (${improvement}% below signal) | Score: ${watch.score} | Chart: ${watch.chartPattern} ` +
      `(${this.positions.size}/${this.config.maxPositions}) | ${watch.mint}`
    );

    // Telegram alert
    const buyMsg =
      `📈 <b>[${this.config.name}] PAPER BUY: $${watch.symbol}</b>\n\n` +
      `Score: ${watch.score} | Chart: ${watch.chartPattern}\n` +
      `Signal: $${watch.signalPrice.toPrecision(4)} → Entry: $${entryPrice.toPrecision(4)} (${improvement}% better)\n` +
      `TP: +${this.config.takeProfitPct}% | SL: -${this.config.stopLossPct}%\n` +
      `<code>${watch.mint}</code>`;
    bus.emit('ops:alert', { level: 'critical', message: buyMsg });
  }

  // ── Price monitoring ──

  private async checkOpenPositions(): Promise<void> {
    if (!this.running || this.positions.size === 0) return;

    const mints = [...this.positions.keys()];
    const prices = await this.fetchPrices(mints);

    for (const [mint, pos] of [...this.positions.entries()]) {
      const now = Date.now();
      const currentPrice = prices.get(mint);

      // Timeout
      const ageMinutes = (now - pos.entryTime) / 60_000;
      if (ageMinutes >= this.config.timeoutMinutes) {
        this.closePosition(pos, currentPrice || pos.lastCheckedPrice, 'timeout');
        continue;
      }

      if (currentPrice === undefined || currentPrice <= 0) {
        // Safety close if no price for 45s
        if (pos.lastCheckedAt > 0 && now - pos.lastCheckedAt > SHARED.stalePriceCloseMs) {
          log.warn(
            `[${this.config.name}] ⚠ $${pos.symbol} — no price for ${Math.round((now - pos.lastCheckedAt) / 1000)}s, safety closing`
          );
          this.closePosition(pos, pos.lastCheckedPrice, 'sl');
        }
        continue;
      }

      pos.lastCheckedPrice = currentPrice;
      pos.lastCheckedAt = now;
      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // TP hit
      if (pnlPct >= this.config.takeProfitPct) {
        this.closePosition(pos, currentPrice, 'tp');
        continue;
      }

      // v9.6: Simple flat SL (trailing/breakeven removed — broken with 2s price checks)
      if (pnlPct <= -this.config.stopLossPct) {
        this.closePosition(pos, currentPrice, 'sl');
        continue;
      }
    }
  }

  private closePosition(pos: PaperPosition, exitPrice: number, reason: 'tp' | 'sl' | 'timeout' | 'shutdown'): void {
    // Apply slippage to SL exits only — selling into a dump gets worse fills.
    // TP exits sell into demand (no slippage). This makes paper results more realistic.
    let adjustedExitPrice = exitPrice;
    if (reason === 'sl' && exitPrice > 0) {
      adjustedExitPrice = exitPrice * (1 - SHARED.slSlippagePct / 100);
    }

    const pnlPct = adjustedExitPrice > 0 && pos.entryPrice > 0
      ? ((adjustedExitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : 0;
    const pnlSOL = (pnlPct / 100) * pos.sizeSOL;

    this.stats.totalTrades++;
    this.stats.totalPnlPct += pnlPct;
    this.stats.totalPnlSOL += pnlSOL;
    if (reason === 'tp' || (reason === 'timeout' && pnlPct > 0)) this.stats.wins++;
    else if (reason === 'sl') this.stats.losses++;
    else this.stats.timeouts++;

    const emoji = pnlPct >= 0 ? '🟢' : '🔴';
    const reasonLabel = { tp: 'TAKE PROFIT', sl: 'STOP LOSS', timeout: 'TIMEOUT', shutdown: 'SHUTDOWN' }[reason];
    const holdTime = ((Date.now() - pos.entryTime) / 60_000).toFixed(1);

    const slippageNote = reason === 'sl' && exitPrice > 0
      ? ` (incl ${SHARED.slSlippagePct}% slippage: raw $${exitPrice.toPrecision(4)})`
      : '';

    log.info(
      `[${this.config.name}] ${emoji} PAPER SELL $${pos.symbol} — ${reasonLabel}\n` +
      `  Entry: $${pos.entryPrice.toPrecision(4)} → Exit: $${adjustedExitPrice.toPrecision(4)}${slippageNote}\n` +
      `  P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)\n` +
      `  High: $${pos.highestPrice.toPrecision(4)} | Low: $${pos.lowestPrice.toPrecision(4)}\n` +
      `  Hold: ${holdTime}m | Score: ${pos.score} | Chart: ${pos.chartPattern}\n` +
      `  ${this.config.name}: ${this.stats.wins}W/${this.stats.losses}L/${this.stats.timeouts}T ` +
      `(${this.stats.totalPnlPct >= 0 ? '+' : ''}${this.stats.totalPnlPct.toFixed(1)}%)`
    );

    // Persist to DB
    try {
      const db = getDb();
      db.prepare(`
        UPDATE paper_trades SET
          exit_price = ?, exit_time = ?, exit_reason = ?,
          pnl_pct = ?, pnl_sol = ?,
          highest_price = ?, lowest_price = ?,
          status = 'closed'
        WHERE id = ?
      `).run(
        adjustedExitPrice, Date.now(), reason,
        Math.round(pnlPct * 100) / 100, Math.round(pnlSOL * 10000) / 10000,
        pos.highestPrice, pos.lowestPrice,
        pos.id,
      );
    } catch (err) {
      log.error(`[${this.config.name}] Failed to persist trade close`, err);
    }

    // On-chain memo timestamp (fire-and-forget — never blocks trading)
    if (pos.memoTradeId) {
      const exitMemo = buildExitMemo(
        this.config.name, pos.symbol, pos.mint,
        adjustedExitPrice, pnlPct, pnlSOL, pos.memoTradeId,
      );
      getMemoService().sendTradeMemo(exitMemo);
    }

    // Telegram alert
    this.notifyTradeClosed(pos, adjustedExitPrice, pnlPct, pnlSOL, reason, parseFloat(holdTime));
    this.positions.delete(pos.mint);
  }

  private notifyTradeClosed(
    pos: PaperPosition, exitPrice: number,
    pnlPct: number, pnlSOL: number,
    reason: string, holdMinutes: number,
  ): void {
    const emoji = pnlPct >= 0 ? '🟢' : '🔴';
    const reasonLabel = { tp: '✅ TAKE PROFIT', sl: '🛑 STOP LOSS', timeout: '⏱ TIMEOUT', shutdown: '🔌 SHUTDOWN' }[reason] ?? reason;

    const msg =
      `${emoji} <b>[${this.config.name}] PAPER TRADE: $${pos.symbol}</b>\n\n` +
      `${reasonLabel}\n` +
      `Entry: $${pos.entryPrice.toPrecision(4)} → Exit: $${exitPrice.toPrecision(4)}\n` +
      `P&L: <b>${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b> (${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)\n` +
      `Hold: ${holdMinutes.toFixed(1)}m | Score: ${pos.score} | Chart: ${pos.chartPattern}\n` +
      `<code>${pos.mint}</code>\n\n` +
      `${this.config.name}: ${this.stats.wins}W/${this.stats.losses}L | ` +
      `${this.stats.totalPnlPct >= 0 ? '+' : ''}${this.stats.totalPnlPct.toFixed(1)}%`;

    bus.emit('ops:alert', { level: 'critical', message: msg });
  }

  // ── Cache cleanup (prevents memory leaks over long runs) ──

  private cleanupCaches(): void {
    const now = Date.now();
    const PUMP_CACHE_TTL = 30 * 60_000; // 30 min — after this, DexScreener should have data
    const COOLDOWN_TTL = SHARED.cooldownPerTokenMs + 60_000; // cooldown + 1 min buffer

    let pumpCleaned = 0;
    for (const [mint, entry] of this.pumpPriceCache) {
      if (now - entry.at > PUMP_CACHE_TTL) {
        this.pumpPriceCache.delete(mint);
        pumpCleaned++;
      }
    }

    let cooldownCleaned = 0;
    for (const [mint, timestamp] of this.recentTrades) {
      if (now - timestamp > COOLDOWN_TTL) {
        this.recentTrades.delete(mint);
        cooldownCleaned++;
      }
    }

    if (pumpCleaned > 0 || cooldownCleaned > 0) {
      log.debug(
        `[${this.config.name}] Cache cleanup: ${pumpCleaned} pump prices, ${cooldownCleaned} cooldowns removed`
      );
    }
  }

  // ── Price fetching ──

  private async fetchPrices(mints: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (mints.length === 0) return prices;

    // DexScreener API limit: 30 tokens per request — batch if needed
    const BATCH_SIZE = 30;
    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
      try {
        const batch = mints.slice(i, i + BATCH_SIZE).join(',');
        const resp = await axios.get<Array<{ baseToken: { address: string }; priceUsd: string }>>(
          `https://api.dexscreener.com/tokens/v1/solana/${batch}`,
          { timeout: 8_000 },
        );

        const pairs = Array.isArray(resp.data) ? resp.data : [];
        for (const pair of pairs) {
          const mint = pair.baseToken?.address;
          const price = parseFloat(pair.priceUsd);
          if (mint && price > 0) {
            const existing = prices.get(mint) ?? 0;
            if (price > existing) prices.set(mint, price);
          }
        }
      } catch { /* retry next interval */ }
    }

    // Fallback: use PumpPortal price cache for mints DexScreener doesn't have yet
    for (const mint of mints) {
      if (!prices.has(mint)) {
        const cached = this.pumpPriceCache.get(mint);
        if (cached && cached.price > 0) {
          prices.set(mint, cached.price);
        }
      }
    }

    return prices;
  }

  // SOL price for PumpPortal MC → USD conversion
  private async updateSolPrice(): Promise<void> {
    if (Date.now() - solPriceUpdatedAt < SOL_PRICE_TTL) return;
    try {
      const resp = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
        { timeout: 5000 },
      );
      const pairs = resp.data?.pairs;
      if (Array.isArray(pairs) && pairs.length > 0) {
        const best = pairs
          .filter((p: any) => p.priceUsd && parseFloat(p.priceUsd) > 1)
          .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (best?.priceUsd) {
          const parsed = parseFloat(best.priceUsd);
          if (parsed > 1 && isFinite(parsed)) {
            solPriceUSD = parsed;
            solPriceUpdatedAt = Date.now();
          }
        }
      }
    } catch { /* keep existing price */ }
  }

  // ── Accessors ──
  getOpenPositionCount(): number { return this.positions.size; }
  getFibWatchCount(): number { return this.fibWatchlist.size; }
  getStats() { return { ...this.stats }; }
}


