// ── Research Squad Coordinator ───────────────────────────
// Manages all research agents. Aggregates signals into actionable intel.

import { bus, log, config } from '../core/index.js';
import type { Agent, AgentMeta, Narrative, WhaleAlert, GraduationStatus, TradeSignal, ScoredToken } from '../core/types.js';
// Phase 1: New real-time pipeline
import { PumpFunWatcher } from './pumpfun-watcher.js';
import { SniperDetector } from './sniper-detector.js';
import { TokenAnalyzer } from './token-analyzer.js';
import { SmartMoneyTracker } from './smart-money-tracker.js';
import { SmartMoneyDiscovery } from './smart-money-discovery.js';
import { EmotionRadar } from './emotion-radar.js';
// Legacy agents (kept for backward compat)
import { SentimentMonitor } from './sentiment-monitor.js';
import { WhaleWatcher } from './whale-watcher.js';
import { GraduationMonitor } from './graduation-monitor.js';
import { SignalEngineSentinel } from './signal-monitor.js';
import { TrendingScanner } from './trending-scanner.js';
import { getDb } from '../core/db.js';

export class ResearchSquad implements Agent {
  meta: AgentMeta = {
    name: 'Research Squad',
    squad: 'research',
    version: '0.1.0',
  };

  private agents: Agent[] = [];
  private activeNarratives: Map<string, Narrative> = new Map();
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  // Store handler refs for cleanup
  private handlers = {
    narrative: (narrative: Narrative) => this.onNarrativeDetected(narrative),
    whale: (alert: WhaleAlert) => this.persistWhaleAlert(alert),
    graduation: (status: GraduationStatus) => this.onGraduationUpdate(status),
    scored: (token: ScoredToken) => this.onTokenScored(token),
  };

  constructor() {
    // Phase 1 agents (new real-time pipeline):
    //   PumpFunWatcher → SniperDetector → TokenAnalyzer (sequential pipeline)
    //   SmartMoneyTracker runs in parallel, feeds social signals to TokenAnalyzer
    //
    // Legacy agents kept but deprioritized:
    //   GraduationMonitor (still useful for pump.fun graduation tracking)
    //   TrendingScanner (secondary DexScreener source)
    //   SentimentMonitor (Reddit — demoted)
    //   WhaleWatcher / SignalEngineSentinel (replaced by SmartMoneyTracker but kept for now)
    this.agents = [
      // Phase 1: real-time pipeline (order matters — listeners first)
      new SniperDetector(),        // listens: token:new → emits: token:safety
      new EmotionRadar(),          // listens: token:scored/new/smart_money → emits: emotion:token/mood
      new TokenAnalyzer(),         // listens: token:safety + emotion:token → emits: token:scored
      new SmartMoneyDiscovery(),   // discovers profitable wallets → populates DB
      new SmartMoneyTracker(),     // pulls wallets from DB, emits: smart_money:trade
      new PumpFunWatcher(),        // emits: token:new (start last — it's the emitter)
      // Legacy agents
      new GraduationMonitor(),
      new TrendingScanner(),
      new SignalEngineSentinel(),
      new SentimentMonitor(),
    ];
  }

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] ═══ RESEARCH SQUAD ONLINE ═══`);

    // Wire up event listeners
    bus.on('narrative:detected', this.handlers.narrative);
    bus.on('whale:alert', this.handlers.whale);
    bus.on('graduation:update', this.handlers.graduation);
    bus.on('token:scored', this.handlers.scored);

    // Periodic narrative expiry cleanup (every 60s, independent of new arrivals)
    this.expiryInterval = setInterval(() => this.cleanExpiredNarratives(), 60_000);

    // Start all agents
    for (const agent of this.agents) {
      await agent.start();
      log.info(`[${this.meta.name}] ✓ ${agent.meta.name} started`);
    }

    log.info(`[${this.meta.name}] All ${this.agents.length} agents active`);
  }

  async stop(): Promise<void> {
    // Stop interval first to prevent cleanup running mid-shutdown
    if (this.expiryInterval) clearInterval(this.expiryInterval);

    // Stop agents before unsubscribing (agents may emit during stop)
    for (const agent of this.agents) {
      await agent.stop();
    }

    // Unsubscribe squad-level handlers last
    bus.off('narrative:detected', this.handlers.narrative);
    bus.off('whale:alert', this.handlers.whale);
    bus.off('graduation:update', this.handlers.graduation);
    bus.off('token:scored', this.handlers.scored);

    log.info(`[${this.meta.name}] ═══ RESEARCH SQUAD OFFLINE ═══`);
  }

  private onNarrativeDetected(narrative: Narrative): void {
    // Deduplicate by topic: if same topic is already active in memory, update instead of re-emitting
    const existing = this.findActiveByTopic(narrative.topic);
    if (existing) {
      const oldConfidence = existing.confidence;
      const confidenceChanged = Math.abs(oldConfidence - narrative.confidence) >= 10;
      existing.confidence = narrative.confidence;
      existing.sentiment = narrative.sentiment;
      existing.topTokens = narrative.topTokens;
      existing.expiresAt = narrative.expiresAt;

      if (confidenceChanged) {
        log.info(
          `[${this.meta.name}] Narrative "${narrative.topic}" updated — ` +
          `confidence: ${narrative.confidence}% (was ${oldConfidence}%)`
        );
      }
      return;
    }

    // Cross-session dedup: check DB for same topic within last 24 hours
    if (this.wasRecentlyAlerted(narrative.topic)) {
      log.info(`[${this.meta.name}] Narrative "${narrative.topic}" already alerted within 24h — skipping`);
      return;
    }

    this.activeNarratives.set(narrative.id, narrative);
    this.persistNarrative(narrative);

    // Emit token:signal for each token in the narrative (feeds Whale Watcher + SignalEngine)
    for (const token of narrative.topTokens) {
      bus.emit('token:signal', token);
    }

    // Generate trade signals for high-confidence narratives with strong tokens
    if (narrative.confidence >= 70 && narrative.topTokens.length > 0) {
      this.emitTradeSignals(narrative);
    }

    log.info(
      `[${this.meta.name}] Active narratives: ${this.activeNarratives.size} — ` +
      `Top: "${narrative.topic}" (${narrative.confidence}%)`
    );
  }

  /** Check if this topic was already alerted in the DB within the last 24 hours */
  private wasRecentlyAlerted(topic: string): boolean {
    try {
      const db = getDb();
      const lookback = Date.now() - 24 * 3600_000;
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM narratives WHERE topic = ? AND detected_at >= ?`
      ).get(topic, lookback) as { count: number } | undefined;
      return (row?.count ?? 0) > 0;
    } catch {
      return false; // On DB error, allow the narrative through
    }
  }

  /** Find an existing active narrative by topic */
  private findActiveByTopic(topic: string): Narrative | null {
    for (const n of this.activeNarratives.values()) {
      if (n.topic === topic) return n;
    }
    return null;
  }

  /** Handle scored tokens from the new pipeline — log and persist only.
   *  Alert Dispatcher handles Telegram directly via token:scored event. */
  private onTokenScored(token: ScoredToken): void {
    log.info(
      `[${this.meta.name}] Token scored: $${token.symbol} — ` +
      `Score: ${token.overallScore}/100 (safety=${token.safetyScore}, momentum=${token.momentumScore}, social=${token.socialScore})`
    );
  }

  private onGraduationUpdate(status: GraduationStatus): void {
    if (status.bondingCurveProgress >= 85) {
      log.info(
        `[${this.meta.name}] 🎓 ${status.symbol} approaching graduation: ${status.bondingCurveProgress}%`
      );
    }
  }

  /** Clean expired narratives — runs on its own interval */
  private cleanExpiredNarratives(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, n] of this.activeNarratives) {
      if (n.expiresAt < now) {
        this.activeNarratives.delete(id);
        bus.emit('narrative:expired', n);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info(`[${this.meta.name}] Cleaned ${cleaned} expired narratives`);
    }
  }

  private persistNarrative(narrative: Narrative): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO narratives (id, topic, confidence, sentiment, sources, top_tokens, detected_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        narrative.id,
        narrative.topic,
        narrative.confidence,
        narrative.sentiment,
        JSON.stringify(narrative.sources),
        JSON.stringify(narrative.topTokens),
        narrative.detectedAt,
        narrative.expiresAt,
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist narrative`, err);
    }
  }

  /** Convert high-confidence narratives into trade signals */
  private emitTradeSignals(narrative: Narrative): void {
    // Only signal the top token if it has real momentum
    const bestToken = narrative.topTokens[0];
    if (!bestToken || !bestToken.mint) return;

    // Require minimum momentum score (set by token resolver based on vol/MC ratio)
    if (bestToken.score < 30) {
      log.info(
        `[${this.meta.name}] $${bestToken.symbol} momentum too low (${bestToken.score}) — no trade signal`
      );
      return;
    }

    const signal: TradeSignal = {
      id: `sig-${Date.now()}-${bestToken.symbol}`,
      type: 'narrative_entry',
      token: bestToken,
      narrative,
      action: narrative.sentiment >= 0 ? 'buy' : 'sell',
      confidence: Math.min(100, Math.round((narrative.confidence + bestToken.score) / 2)),
      suggestedSize: bestToken.score >= 80 ? 5 : bestToken.score >= 50 ? 3 : 2,
      reasoning: `Narrative "${narrative.topic}" at ${narrative.confidence}% confidence. $${bestToken.symbol} has ${bestToken.score}% momentum (vol/MC ratio). MC: $${bestToken.marketCap.toLocaleString()}.`,
      timestamp: Date.now(),
    };

    bus.emit('trade:signal', signal);
    this.persistTradeSignal(signal);

    log.info(
      `[${this.meta.name}] 🎯 TRADE SIGNAL: ${signal.action.toUpperCase()} $${bestToken.symbol} ` +
      `(confidence=${signal.confidence}%, size=${signal.suggestedSize}%)`
    );
  }

  private persistTradeSignal(signal: TradeSignal): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO signals (id, type, token_mint, token_symbol, narrative_id, action, confidence, reasoning, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.id,
        signal.type,
        signal.token.mint,
        signal.token.symbol,
        signal.narrative.id,
        signal.action,
        signal.confidence,
        signal.reasoning,
        signal.timestamp,
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist trade signal`, err);
    }
  }

  private persistWhaleAlert(alert: WhaleAlert): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO whale_alerts (wallet, token, symbol, action, amount, usd_value, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(alert.wallet, alert.token, alert.symbol, alert.action, alert.amount, alert.usdValue, alert.timestamp);
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist whale alert`, err);
    }
  }

  /** Get current state for reports */
  getActiveNarratives(): Narrative[] {
    return Array.from(this.activeNarratives.values())
      .sort((a, b) => b.confidence - a.confidence);
  }
}

// Phase 1 agents
export { PumpFunWatcher } from './pumpfun-watcher.js';
export { SniperDetector } from './sniper-detector.js';
export { TokenAnalyzer } from './token-analyzer.js';
export { SmartMoneyTracker } from './smart-money-tracker.js';
export { SmartMoneyDiscovery } from './smart-money-discovery.js';
export { EmotionRadar } from './emotion-radar.js';
// Legacy agents
export { SentimentMonitor } from './sentiment-monitor.js';
export { WhaleWatcher } from './whale-watcher.js';
export { GraduationMonitor } from './graduation-monitor.js';
export { SignalEngineSentinel } from './signal-monitor.js';
export { TrendingScanner } from './trending-scanner.js';

