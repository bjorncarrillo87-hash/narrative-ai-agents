// ── Risk Auditor ────────────────────────────────────────
// Checks exposure, drawdown limits. Flags if any agent breaks rules.
// The Kredo is law.

import { bus, log, kredo } from '../core/index.js';
import type { Agent, AgentMeta, TradeSignal } from '../core/types.js';

interface PositionTracker {
  totalExposurePct: number;
  dailyPnlPct: number;
  openPositions: number;
  tradesInCooldown: boolean;
  lastTradeTime: number;
  dailyTradeCount: number;
}

export class RiskAuditor implements Agent {
  meta: AgentMeta = {
    name: 'Risk Auditor',
    squad: 'ops',
    version: '0.1.0',
  };

  private interval: ReturnType<typeof setInterval> | null = null;
  private tradeHandler = (signal: TradeSignal) => this.validateSignal(signal);
  private tracker: PositionTracker = {
    totalExposurePct: 0,
    dailyPnlPct: 0,
    openPositions: 0,
    tradesInCooldown: false,
    lastTradeTime: 0,
    dailyTradeCount: 0,
  };

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] Starting — The Kredo is law`);
    log.info(
      `[${this.meta.name}] Rules: ` +
      `max daily loss=${kredo.maxDailyLossPct}%, ` +
      `max per trade=${kredo.maxPerTradePct}%, ` +
      `max positions=${kredo.maxOpenPositions}, ` +
      `stop-loss=${kredo.stopLossPct}%`
    );

    // Intercept trade signals and validate against Kredo
    bus.on('trade:signal', this.tradeHandler);

    // Periodic audit
    this.interval = setInterval(() => this.audit(), 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    bus.off('trade:signal', this.tradeHandler);
    log.info(`[${this.meta.name}] Stopped`);
  }

  /** Validate a trade signal against The Kredo */
  private validateSignal(signal: TradeSignal): void {
    const violations: string[] = [];

    // Check kill switch
    if (kredo.killSwitch) {
      violations.push('KILL SWITCH ACTIVE — all trading halted');
    }

    // Check daily loss limit
    if (this.tracker.dailyPnlPct <= -kredo.maxDailyLossPct) {
      violations.push(`Daily loss limit reached: ${this.tracker.dailyPnlPct.toFixed(1)}% (max: -${kredo.maxDailyLossPct}%)`);
    }

    // Check per-trade size
    if (signal.suggestedSize > kredo.maxPerTradePct) {
      violations.push(`Trade size ${signal.suggestedSize}% exceeds max ${kredo.maxPerTradePct}%`);
    }

    // Check open positions
    if (signal.action === 'buy' && this.tracker.openPositions >= kredo.maxOpenPositions) {
      violations.push(`Max open positions reached: ${this.tracker.openPositions}/${kredo.maxOpenPositions}`);
    }

    // Check total exposure
    if (this.tracker.totalExposurePct + signal.suggestedSize > kredo.maxExposurePct) {
      violations.push(`Would exceed max exposure: ${(this.tracker.totalExposurePct + signal.suggestedSize).toFixed(1)}% > ${kredo.maxExposurePct}%`);
    }

    // Check cooldown
    const timeSinceLastTrade = Date.now() - this.tracker.lastTradeTime;
    if (timeSinceLastTrade < kredo.cooldownMs) {
      violations.push(`Trade cooldown active: ${Math.round((kredo.cooldownMs - timeSinceLastTrade) / 1000)}s remaining`);
    }

    if (violations.length > 0) {
      for (const v of violations) {
        bus.emit('risk:breach', { rule: 'Kredo', details: v });
        log.warn(`[${this.meta.name}] ⚠️ KREDO VIOLATION: ${v}`);
      }

      bus.emit('ops:alert', {
        level: 'critical',
        message: `🚨 KREDO VIOLATION on $${signal.token.symbol}:\n${violations.map(v => `• ${v}`).join('\n')}`,
      });
    } else {
      log.info(
        `[${this.meta.name}] ✅ Trade signal $${signal.token.symbol} PASSED Kredo check`
      );
    }
  }

  /** Periodic audit of overall risk posture */
  private audit(): void {
    log.info(
      `[${this.meta.name}] Audit: ` +
      `exposure=${this.tracker.totalExposurePct.toFixed(1)}%, ` +
      `dailyPnL=${this.tracker.dailyPnlPct.toFixed(1)}%, ` +
      `positions=${this.tracker.openPositions}, ` +
      `trades today=${this.tracker.dailyTradeCount}`
    );

    // Alert if approaching limits
    if (this.tracker.dailyPnlPct <= -(kredo.maxDailyLossPct * 0.7)) {
      bus.emit('ops:alert', {
        level: 'warn',
        message: `⚠️ Approaching daily loss limit: ${this.tracker.dailyPnlPct.toFixed(1)}% (limit: -${kredo.maxDailyLossPct}%)`,
      });
    }

    if (this.tracker.totalExposurePct >= kredo.maxExposurePct * 0.8) {
      bus.emit('ops:alert', {
        level: 'warn',
        message: `⚠️ High exposure: ${this.tracker.totalExposurePct.toFixed(1)}% (limit: ${kredo.maxExposurePct}%)`,
      });
    }
  }

  /** Update tracker state (called by trading agents when live) */
  updatePosition(change: Partial<PositionTracker>): void {
    Object.assign(this.tracker, change);
  }

  /** Reset daily counters (called by daily reporter at midnight) */
  resetDaily(): void {
    this.tracker.dailyPnlPct = 0;
    this.tracker.dailyTradeCount = 0;
    log.info(`[${this.meta.name}] Daily counters reset`);
  }
}


