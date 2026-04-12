// ── Graduation Monitor ──────────────────────────────────
// Tracks bonding curve progress on pump.fun.
// Alerts when tokens approach King of Hill or graduation to Raydium.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import type { Agent, AgentMeta, GraduationStatus } from '../core/types.js';

// Thresholds from config
const getGraduationMc = () => config.pumpfun.graduationMcUSD;
const getKothMc = () => config.pumpfun.kothMcUSD;

interface PumpFunToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  market_cap: number;
  usd_market_cap: number;
  reply_count: number;
  creator: string;
  created_timestamp: number;
  is_currently_live: boolean;
  complete: boolean; // graduated
  king_of_the_hill_timestamp: number | null;
}

export class GraduationMonitor implements Agent {
  meta: AgentMeta = {
    name: 'Graduation Monitor',
    squad: 'research',
    version: '0.1.0',
  };

  private interval: ReturnType<typeof setInterval> | null = null;
  private trackedMints: Map<string, GraduationStatus> = new Map();
  private static readonly MAX_TRACKED = 200;

  // Handler ref for cleanup
  private onNarrative = (narrative: { topTokens: Array<{ mint: string; symbol: string }> }) => {
    for (const token of narrative.topTokens) {
      if (token.mint) {
        this.trackToken(token.mint, token.symbol);
      }
    }
  };

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] Starting — watching pump.fun bonding curves`);

    // Watch tokens that come through signals
    bus.on('narrative:detected', this.onNarrative);

    // Scan loop
    await this.scan();
    this.interval = setInterval(() => this.scan(), config.intervals.graduationScan);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    bus.off('narrative:detected', this.onNarrative);
    log.info(`[${this.meta.name}] Stopped`);
  }

  /** Add a token to track */
  trackToken(mint: string, symbol: string): void {
    if (!this.trackedMints.has(mint)) {
      // Evict graduated or lowest-progress tokens when at capacity
      if (this.trackedMints.size >= GraduationMonitor.MAX_TRACKED) {
        this.evictStaleTokens();
      }
      this.trackedMints.set(mint, {
        mint,
        symbol,
        bondingCurveProgress: 0,
        marketCap: 0,
        isKingOfHill: false,
        timeToGraduation: null,
      });
      log.info(`[${this.meta.name}] Tracking ${symbol} for graduation (${this.trackedMints.size} total)`);
    }
  }

  /** Remove graduated tokens and lowest-progress ones to stay within cap */
  private evictStaleTokens(): void {
    // First remove any that graduated (100%) or are clearly dead (MC = 0 for tracked tokens)
    for (const [mint, status] of this.trackedMints) {
      if (status.bondingCurveProgress >= 100 || (status.marketCap === 0 && status.bondingCurveProgress === 0)) {
        this.trackedMints.delete(mint);
      }
    }
    // If still over cap, remove lowest market cap entries
    if (this.trackedMints.size >= GraduationMonitor.MAX_TRACKED) {
      const sorted = Array.from(this.trackedMints.entries())
        .sort((a, b) => a[1].marketCap - b[1].marketCap);
      const toRemove = sorted.slice(0, Math.ceil(sorted.length * 0.2)); // evict bottom 20%
      for (const [mint] of toRemove) {
        this.trackedMints.delete(mint);
      }
      log.info(`[${this.meta.name}] Evicted ${toRemove.length} low-value tracked tokens`);
    }
  }

  private async scan(): Promise<void> {
    try {
      // Scan trending tokens on pump.fun
      await this.scanTrending();

      // Update tracked tokens
      for (const [mint] of this.trackedMints) {
        try {
          await this.updateToken(mint);
        } catch (err) {
          log.error(`[${this.meta.name}] Error updating ${mint}`, err);
        }
      }
    } catch (err) {
      log.error(`[${this.meta.name}] Scan cycle failed`, err);
    }
  }

  /** Fetch trending tokens from pump.fun */
  private async scanTrending(): Promise<void> {
    try {
      // pump.fun frontend API for trending/new tokens
      const resp = await axios.get<PumpFunToken[]>(
        'https://frontend-api.pump.fun/coins/currently-live',
        {
          params: { limit: 20, offset: 0, includeNsfw: false },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000,
        },
      );

      if (!Array.isArray(resp.data)) return;

      for (const token of resp.data) {
        const progress = Math.min(100, (token.usd_market_cap / getGraduationMc()) * 100);
        const isKOTH = token.usd_market_cap >= getKothMc();

        const status: GraduationStatus = {
          mint: token.mint,
          symbol: token.symbol,
          bondingCurveProgress: Math.round(progress * 10) / 10,
          marketCap: token.usd_market_cap,
          isKingOfHill: isKOTH,
          timeToGraduation: progress >= 80 ? this.estimateTimeToGrad(progress) : null,
        };

        // Only emit if progress changed meaningfully (avoid spamming event bus)
        const prev = this.trackedMints.get(token.mint);
        if (prev && Math.abs(prev.bondingCurveProgress - status.bondingCurveProgress) < 1) {
          continue; // Skip if less than 1% change
        }

        bus.emit('graduation:update', status);
        this.trackedMints.set(token.mint, status);
      }

      log.debug(`[${this.meta.name}] Scanned ${resp.data.length} live tokens`);
    } catch (err: any) {
      const status = err?.response?.status ?? 'unknown';
      log.debug(`[${this.meta.name}] Pump.fun API unavailable (${status}) — using demo mode`);
      this.demoScan();
    }
  }

  /** Update a specific tracked token */
  private async updateToken(mint: string): Promise<void> {
    try {
      const resp = await axios.get<PumpFunToken>(
        `https://frontend-api.pump.fun/coins/${mint}`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 5000,
        },
      );

      const token = resp.data;
      if (!token) return;

      const progress = Math.min(100, (token.usd_market_cap / getGraduationMc()) * 100);

      const status: GraduationStatus = {
        mint,
        symbol: token.symbol,
        bondingCurveProgress: Math.round(progress * 10) / 10,
        marketCap: token.usd_market_cap,
        isKingOfHill: token.king_of_the_hill_timestamp !== null,
        timeToGraduation: progress >= 80 ? this.estimateTimeToGrad(progress) : null,
      };

      // Only emit if progress changed meaningfully
      const prev = this.trackedMints.get(mint);
      if (!prev || Math.abs(prev.bondingCurveProgress - status.bondingCurveProgress) >= 1) {
        bus.emit('graduation:update', status);
      }

      this.trackedMints.set(mint, status);
    } catch (err: any) {
      log.debug(`[${this.meta.name}] Token ${mint} update failed — may have graduated or been removed`);
    }
  }

  private estimateTimeToGrad(currentProgress: number): number {
    // Rough estimate based on remaining % — returns ms
    const remaining = 100 - currentProgress;
    return remaining * 60_000; // ~1 min per %
  }

  /** Demo mode — console-only, never sends to Telegram */
  private demoScan(): void {
    if (Math.random() > 0.4) return;

    const demoTokens = [
      { symbol: 'NARR', mc: Math.random() * 70000 },
      { symbol: 'SIGNAL', mc: Math.random() * 50000 },
      { symbol: 'AIDOGE', mc: Math.random() * 80000 },
    ];

    const token = demoTokens[Math.floor(Math.random() * demoTokens.length)];
    const progress = Math.min(100, (token.mc / getGraduationMc()) * 100);

    // Log only — don't emit to event bus
    log.info(
      `[${this.meta.name}] [DEMO] $${token.symbol} — ` +
      `MC: $${Math.round(token.mc).toLocaleString()} — ` +
      `Progress: ${(Math.round(progress * 10) / 10)}%${token.mc >= getKothMc() ? ' 👑 KOTH' : ''}`
    );
  }
}


