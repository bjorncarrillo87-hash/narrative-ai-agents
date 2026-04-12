// ── Strategy Router ─────────────────────────────────────
// V9.5: Routes scored tokens to 4 strategy bots.
// Each bot is a PaperTrader instance with different TP/filter config.
// DUMP_IN_PROGRESS tokens are already rejected by Token Analyzer.

import { bus, log } from '../core/index.js';
import { PaperTrader, type StrategyConfig } from './paper-trader.js';
import type { Agent, AgentMeta, ScoredToken, TradeSignal } from '../core/types.js';

// ── Strategy definitions (v9.6: removed trailing/breakeven, flat SL + slippage sim) ──
const STRATEGIES: StrategyConfig[] = [
  {
    name: 'ALPHA',
    label: 'BREAKOUT',
    takeProfitPct: 35,
    stopLossPct: 12,
    minScore: 45,      // was 65 — Fib pullback entry IS the quality filter, score just filters noise
    maxPositions: 8,
    sizeSOL: 2,
    timeoutMinutes: 30,
  },
  {
    name: 'BRAVO',
    label: 'PUMP_PHASE',
    takeProfitPct: 20,       // was 25 — v9.4d showed 36% WR, lower TP to capture more wins
    stopLossPct: 12,
    minScore: 45,      // was 65 — Fib pullback entry IS the quality filter, score just filters noise
    maxPositions: 8,
    sizeSOL: 2,
    timeoutMinutes: 30,
  },
  {
    name: 'CHARLIE',
    label: 'TRENDING',
    takeProfitPct: 20,
    stopLossPct: 12,
    minScore: 55,      // was 45 — v9.4d showed 29% WR on catch-all UNKNOWN tokens, raise to filter junk
    maxPositions: 8,
    sizeSOL: 2,
    timeoutMinutes: 30,
  },
  {
    name: 'DELTA',
    label: 'NARRATIVE',
    takeProfitPct: 30,
    stopLossPct: 12,
    minScore: 45,      // was 65 — Fib pullback entry IS the quality filter, score just filters noise
    maxPositions: 8,
    sizeSOL: 2,
    timeoutMinutes: 30,
  },
];

export class StrategyRouter implements Agent {
  meta: AgentMeta = {
    name: 'Strategy Router',
    squad: 'ops',
    version: '9.6.0',
  };

  private bots: Map<string, PaperTrader> = new Map();

  // Handler refs
  private onScoredToken = (token: ScoredToken) => this.route(token, 'scored');
  private onTradeSignal = (signal: TradeSignal) => {
    if (signal.action !== 'buy') return;
    const t = signal.token;
    if (!t.mint || t.price <= 0) return;
    // Convert TradeSignal to a ScoredToken-like object for routing
    const scored: ScoredToken = {
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      creator: '',
      marketCapSOL: 0,
      marketCapUSD: t.marketCap,
      liquidityUSD: 0,
      volume24h: t.volume24h,
      priceUSD: t.price,
      holderCount: 0,
      buyCount1h: 0,
      sellCount1h: 0,
      buyVolume1h: 0,
      momentumScore: t.score,
      safetyScore: 50,
      socialScore: 0,
      overallScore: t.score,
      ageMinutes: 0,
      source: 'trending',
      bondingCurveProgress: 0,
      safety: {} as any,
      smartMoneyBuyers: [],
      timestamp: Date.now(),
    };
    this.route(scored, 'trending');
  };

  async start(): Promise<void> {
    // Create all bots
    for (const stratConfig of STRATEGIES) {
      const bot = new PaperTrader(stratConfig);
      bot.start();
      this.bots.set(stratConfig.name, bot);
    }

    // Listen for signals
    bus.on('token:scored', this.onScoredToken);
    bus.on('trade:signal', this.onTradeSignal);

    log.info(
      `[${this.meta.name}] V9 Multi-Strategy started — ` +
      `${this.bots.size} bots: ${[...this.bots.keys()].join(', ')}`
    );
  }

  async stop(): Promise<void> {
    bus.off('token:scored', this.onScoredToken);
    bus.off('trade:signal', this.onTradeSignal);

    // Stop all bots
    for (const [, bot] of this.bots) {
      bot.stop();
    }

    // Print combined stats
    this.printSessionStats();
  }

  /** Route a scored token to the appropriate bot. Priority: ALPHA > DELTA > BRAVO > CHARLIE */
  private route(token: ScoredToken, source: 'scored' | 'trending'): void {
    const pattern = token.chartPattern || 'UNKNOWN';
    const social = token.socialScore ?? 0;

    // Trending tokens → CHARLIE
    if (source === 'trending') {
      const charlie = this.bots.get('CHARLIE')!;
      if (charlie.tryEnter(token)) {
        log.debug(`[${this.meta.name}] → CHARLIE (trending) $${token.symbol}`);
      }
      return;
    }

    // BREAKOUT → ALPHA (highest priority)
    if (pattern === 'BREAKOUT') {
      const alpha = this.bots.get('ALPHA')!;
      if (alpha.tryEnter(token)) {
        log.debug(`[${this.meta.name}] → ALPHA (BREAKOUT) $${token.symbol}`);
        return;
      }
    }

    // Narrative bonus active (social > 10) → DELTA
    if (social > 10) {
      const delta = this.bots.get('DELTA')!;
      if (delta.tryEnter(token)) {
        log.debug(`[${this.meta.name}] → DELTA (narrative, social=${social}) $${token.symbol}`);
        return;
      }
    }

    // PUMP_PHASE → BRAVO
    if (pattern === 'PUMP_PHASE') {
      const bravo = this.bots.get('BRAVO')!;
      if (bravo.tryEnter(token)) {
        log.debug(`[${this.meta.name}] → BRAVO (PUMP_PHASE) $${token.symbol}`);
        return;
      }
    }

    // Catch-all → CHARLIE (any scored PumpFun token that didn't match BREAKOUT/PUMP_PHASE/NARRATIVE)
    // Most brand new tokens won't have enough data for pattern detection yet.
    // The Fib pullback entry is the real quality filter — let CHARLIE handle the rest.
    {
      const charlie = this.bots.get('CHARLIE')!;
      if (charlie.tryEnter(token)) {
        log.debug(`[${this.meta.name}] → CHARLIE (catch-all, pattern=${pattern}) $${token.symbol}`);
        return;
      }
    }

    // No bot picked it up — log for debugging
    log.debug(
      `[${this.meta.name}] ✗ $${token.symbol} not routed — ` +
      `pattern=${pattern}, social=${social}, score=${token.overallScore}, price=$${token.priceUSD}`
    );
  }

  private printSessionStats(): void {
    const lines: string[] = [`[${this.meta.name}] ═══ V9.6 STRATEGY STATS ═══`];
    let totalTrades = 0, totalWins = 0, totalLosses = 0, totalTimeouts = 0, totalPnl = 0;
    let totalFibConverted = 0, totalFibExpired = 0;

    for (const [name, bot] of this.bots) {
      const s = bot.getStats();
      totalTrades += s.totalTrades;
      totalWins += s.wins;
      totalLosses += s.losses;
      totalTimeouts += s.timeouts;
      totalPnl += s.totalPnlPct;
      totalFibConverted += s.fibEntriesConverted;
      totalFibExpired += s.fibEntriesExpired;

      const winRate = s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(0) : '-';
      lines.push(
        `  ${name.padEnd(8)} (${bot.config.label.padEnd(10)}): ` +
        `${s.totalTrades} trades | ${s.wins}W/${s.losses}L/${s.timeouts}T | ` +
        `${winRate}% WR | ${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(1)}% | ` +
        `Fib: ${s.fibEntriesConverted}/${s.fibEntriesConverted + s.fibEntriesExpired}`
      );
    }

    const combinedWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '-';
    lines.push(`  ${'─'.repeat(65)}`);
    lines.push(
      `  COMBINED: ${totalTrades} trades | ${totalWins}W/${totalLosses}L/${totalTimeouts}T | ` +
      `${combinedWinRate}% win rate | ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`
    );
    lines.push(`  FIB ENTRIES: ${totalFibConverted} converted / ${totalFibExpired} expired`);

    log.info(lines.join('\n'));

    // Also send summary to Telegram
    const msg =
      `📊 <b>V9 SESSION STATS</b>\n\n` +
      [...this.bots.entries()].map(([name, bot]) => {
        const s = bot.getStats();
        return `<b>${name}</b> (${bot.config.label}): ${s.totalTrades} trades | ` +
          `${s.wins}W/${s.losses}L | ${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(1)}%`;
      }).join('\n') +
      `\n\n<b>COMBINED:</b> ${totalTrades} trades | ${totalWins}W/${totalLosses}L | ` +
      `${combinedWinRate}% WR | ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`;

    bus.emit('ops:alert', { level: 'critical', message: msg });
  }
}

