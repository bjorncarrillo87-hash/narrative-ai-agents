// ── Performance Tracker ─────────────────────────────────
// Win rate, avg profit, best trades. Weekly and monthly reports.

import { bus, log } from '../core/index.js';
import type { Agent, AgentMeta, TradeSignal, Narrative, WhaleAlert } from '../core/types.js';

interface PerformanceStats {
  totalSignals: number;
  narrativesDetected: number;
  topNarratives: Array<{ topic: string; count: number; avgConfidence: number }>;
  whaleAlerts: number;
  uptime: number;  // hours
  sessionStart: number;
}

export class PerformanceTracker implements Agent {
  meta: AgentMeta = {
    name: 'Performance Tracker',
    squad: 'ops',
    version: '0.1.0',
  };

  private stats: PerformanceStats = {
    totalSignals: 0,
    narrativesDetected: 0,
    topNarratives: [],
    whaleAlerts: 0,
    uptime: 0,
    sessionStart: Date.now(),
  };

  private narrativeCounts: Map<string, { count: number; totalConfidence: number }> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;

  // Store handler refs for cleanup
  private handlers = {
    trade: (_signal: TradeSignal) => { this.stats.totalSignals++; },
    narrative: (narrative: Narrative) => {
      this.stats.narrativesDetected++;
      const existing = this.narrativeCounts.get(narrative.topic);
      if (existing) {
        existing.count++;
        existing.totalConfidence += narrative.confidence;
      } else {
        // Cap at 200 unique topics to prevent unbounded growth
        if (this.narrativeCounts.size >= 200) {
          // Remove the least-seen topic
          let minKey = '';
          let minCount = Infinity;
          for (const [key, val] of this.narrativeCounts) {
            if (val.count < minCount) { minCount = val.count; minKey = key; }
          }
          if (minKey) this.narrativeCounts.delete(minKey);
        }
        this.narrativeCounts.set(narrative.topic, { count: 1, totalConfidence: narrative.confidence });
      }
    },
    whale: (_alert: WhaleAlert) => { this.stats.whaleAlerts++; },
  };

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] Starting — tracking all performance metrics`);

    bus.on('trade:signal', this.handlers.trade);
    bus.on('narrative:detected', this.handlers.narrative);
    bus.on('whale:alert', this.handlers.whale);

    // Log stats every 30 minutes
    this.interval = setInterval(() => this.logStats(), 30 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    bus.off('trade:signal', this.handlers.trade);
    bus.off('narrative:detected', this.handlers.narrative);
    bus.off('whale:alert', this.handlers.whale);
    this.logStats(); // Final stats
    log.info(`[${this.meta.name}] Stopped`);
  }

  private logStats(): void {
    const uptimeHours = (Date.now() - this.stats.sessionStart) / 3600_000;

    const topNarratives = Array.from(this.narrativeCounts.entries())
      .map(([topic, data]) => ({
        topic,
        count: data.count,
        avgConfidence: Math.round(data.totalConfidence / data.count),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    log.info(
      `[${this.meta.name}] ═══ PERFORMANCE STATS ═══\n` +
      `  Uptime: ${uptimeHours.toFixed(1)}h\n` +
      `  Narratives detected: ${this.stats.narrativesDetected}\n` +
      `  Signals generated: ${this.stats.totalSignals}\n` +
      `  Whale alerts: ${this.stats.whaleAlerts}\n` +
      `  Top narratives: ${topNarratives.map(n => `${n.topic}(${n.count}x, ${n.avgConfidence}%)`).join(', ') || 'None yet'}`
    );
  }

  /** Get current stats snapshot */
  getStats(): PerformanceStats {
    this.stats.uptime = (Date.now() - this.stats.sessionStart) / 3600_000;
    this.stats.topNarratives = Array.from(this.narrativeCounts.entries())
      .map(([topic, data]) => ({
        topic,
        count: data.count,
        avgConfidence: Math.round(data.totalConfidence / data.count),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return { ...this.stats };
  }
}

