// ── Emotion Radar ───────────────────────────────────────
// Masters emotional human trading patterns to predict market behavior.
// Tracks FOMO waves, panic selling, greed peaks, and narrative exhaustion.
// Combines with the data-driven pipeline to enter before emotional waves
// and exit before emotional crashes.
//
// Inputs:  token:new, token:scored, smart_money:trade, narrative:detected/expired
// Outputs: emotion:token (per-token), emotion:mood (global market mood)

import { bus, log, config } from '../core/index.js';
import { getDb } from '../core/db.js';
import type {
  Agent, AgentMeta, NewTokenEvent, ScoredToken, SmartMoneyTrade,
  Narrative, TokenEmotionProfile, MarketMood, EmotionLabel,
} from '../core/types.js';

// ── Internal tracking structures ──

interface TokenHistory {
  firstSeenMC: number;                                   // MC at first detection (SOL)
  mcSnapshots: Array<{ mc: number; ts: number }>;        // MC over time
  buySnapshots: Array<{ buys: number; sells: number; ts: number }>; // buy/sell rate over time
  smartMoneyBuys: number;
  smartMoneySells: number;
  lastScoredAt: number;
}

interface ActivityBucket {
  timestamp: number;        // start of 5-min bucket
  newTokenCount: number;
  smartMoneyBuys: number;
  smartMoneySells: number;
  scoredTokenCount: number;
  avgScore: number;
  scoreSum: number;
}

const cfg = config.emotionRadar;

export class EmotionRadar implements Agent {
  meta: AgentMeta = {
    name: 'Emotion Radar',
    squad: 'research',
    version: '1.0.0',
  };

  // Per-token emotion profiles (bounded)
  private tokenProfiles: Map<string, TokenEmotionProfile> = new Map();

  // Per-token history for computing trends
  private tokenHistory: Map<string, TokenHistory> = new Map();

  // Time-bucketed activity for market mood
  private activityBuckets: ActivityBucket[] = [];

  // Smart money action log (rolling window)
  private smartMoneyLog: Array<{ mint: string; action: 'buy' | 'sell'; ts: number }> = [];
  private static readonly SM_LOG_MAX = 500;
  private static readonly SM_WINDOW = 2 * 60 * 60_000; // 2 hours

  // Narrative lifecycle tracking
  private narrativeFirstSeen: Map<string, number> = new Map();
  private activeNarrativeCount = 0;

  // New token rate tracking
  private recentNewTokens: number[] = []; // timestamps
  private static readonly TOKEN_RATE_WINDOW = 60 * 60_000; // 1 hour

  // Current mood state
  private currentMood: MarketMood | null = null;
  private lastMoodScore = 50;

  // Intervals
  private moodInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private bucketInterval: ReturnType<typeof setInterval> | null = null;

  // Handler refs for cleanup
  private onNewToken = (event: NewTokenEvent) => this.handleNewToken(event);
  private onTokenScored = (token: ScoredToken) => this.handleTokenScored(token);
  private onSmartMoneyTrade = (trade: SmartMoneyTrade) => this.handleSmartMoneyTrade(trade);
  private onNarrativeDetected = (n: Narrative) => this.handleNarrativeDetected(n);
  private onNarrativeExpired = (n: Narrative) => this.handleNarrativeExpired(n);

  async start(): Promise<void> {
    bus.on('token:new', this.onNewToken);
    bus.on('token:scored', this.onTokenScored);
    bus.on('smart_money:trade', this.onSmartMoneyTrade);
    bus.on('narrative:detected', this.onNarrativeDetected);
    bus.on('narrative:expired', this.onNarrativeExpired);

    // Publish market mood periodically
    this.moodInterval = setInterval(() => this.publishMood(), cfg.moodPublishIntervalMs);

    // Create activity buckets
    this.bucketInterval = setInterval(() => this.rotateBucket(), cfg.bucketIntervalMs);
    this.rotateBucket(); // initial bucket

    // Periodic cleanup of old data
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);

    log.info(`[${this.meta.name}] Started — reading the market's emotions`);
  }

  async stop(): Promise<void> {
    if (this.moodInterval) clearInterval(this.moodInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.bucketInterval) clearInterval(this.bucketInterval);

    bus.off('token:new', this.onNewToken);
    bus.off('token:scored', this.onTokenScored);
    bus.off('smart_money:trade', this.onSmartMoneyTrade);
    bus.off('narrative:detected', this.onNarrativeDetected);
    bus.off('narrative:expired', this.onNarrativeExpired);

    this.tokenProfiles.clear();
    this.tokenHistory.clear();
    this.smartMoneyLog = [];
    this.narrativeFirstSeen.clear();
    this.recentNewTokens = [];

    log.info(`[${this.meta.name}] Stopped — ${this.tokenProfiles.size} profiles tracked`);
  }

  // ══════════════════════════════════════════════════════
  // Event Handlers
  // ══════════════════════════════════════════════════════

  private handleNewToken(event: NewTokenEvent): void {
    // Record for token rate calculation
    this.recentNewTokens.push(Date.now());

    // Initialize history for MC tracking
    if (!this.tokenHistory.has(event.mint)) {
      this.tokenHistory.set(event.mint, {
        firstSeenMC: event.marketCapSOL,
        mcSnapshots: [{ mc: event.marketCapSOL, ts: Date.now() }],
        buySnapshots: [],
        smartMoneyBuys: 0,
        smartMoneySells: 0,
        lastScoredAt: 0,
      });
    }

    // Emit a preliminary emotion profile so TokenAnalyzer has data
    // BEFORE it scores the token (solves the chicken-and-egg ordering issue)
    const preliminary: TokenEmotionProfile = {
      mint: event.mint,
      symbol: event.symbol,
      fomoScore: event.initialBuySOL >= 5 ? 30 : event.initialBuySOL >= 1 ? 15 : 5,
      panicScore: 0,
      greedScore: 0,
      emotionScore: 55, // slightly above neutral for fresh tokens
      emotionLabel: event.initialBuySOL >= 3 ? 'early_interest' : 'neutral',
      buyAcceleration: 0,
      sellBuyRatio: 0,
      mcMultiplier: 1,
      profitTakingDetected: false,
      updatedAt: Date.now(),
    };
    this.tokenProfiles.set(event.mint, preliminary);
    bus.emit('emotion:token', preliminary);

    // Update current activity bucket
    const bucket = this.getCurrentBucket();
    if (bucket) bucket.newTokenCount++;

    this.evictIfNeeded();
  }

  private handleTokenScored(token: ScoredToken): void {
    const now = Date.now();
    const history = this.tokenHistory.get(token.mint);

    if (history) {
      // Add MC snapshot
      history.mcSnapshots.push({ mc: token.marketCapSOL, ts: now });
      if (history.mcSnapshots.length > 20) history.mcSnapshots.shift();

      // Add buy/sell snapshot
      history.buySnapshots.push({ buys: token.buyCount1h, sells: token.sellCount1h, ts: now });
      if (history.buySnapshots.length > 20) history.buySnapshots.shift();

      history.lastScoredAt = now;
    } else {
      // First time seeing this token in scorer (missed token:new — e.g. from trending scanner)
      this.tokenHistory.set(token.mint, {
        firstSeenMC: token.marketCapSOL,
        mcSnapshots: [{ mc: token.marketCapSOL, ts: now }],
        buySnapshots: [{ buys: token.buyCount1h, sells: token.sellCount1h, ts: now }],
        smartMoneyBuys: 0,
        smartMoneySells: 0,
        lastScoredAt: now,
      });
    }

    // Compute and emit emotion profile
    const profile = this.computeTokenEmotion(token);
    this.tokenProfiles.set(token.mint, profile);
    bus.emit('emotion:token', profile);

    // Update activity bucket
    const bucket = this.getCurrentBucket();
    if (bucket) {
      bucket.scoredTokenCount++;
      bucket.scoreSum += token.overallScore;
      bucket.avgScore = bucket.scoreSum / bucket.scoredTokenCount;
    }

    // Persist notable emotions
    if (profile.emotionLabel !== 'neutral') {
      this.persistEmotion(profile);
    }
  }

  private handleSmartMoneyTrade(trade: SmartMoneyTrade): void {
    const now = Date.now();

    // Log for market mood
    this.smartMoneyLog.push({ mint: trade.mint, action: trade.action, ts: now });
    if (this.smartMoneyLog.length > EmotionRadar.SM_LOG_MAX) {
      this.smartMoneyLog = this.smartMoneyLog.slice(-EmotionRadar.SM_LOG_MAX);
    }

    // Update per-token history
    const history = this.tokenHistory.get(trade.mint);
    if (history) {
      if (trade.action === 'buy') history.smartMoneyBuys++;
      else history.smartMoneySells++;
    }

    // Update activity bucket
    const bucket = this.getCurrentBucket();
    if (bucket) {
      if (trade.action === 'buy') bucket.smartMoneyBuys++;
      else bucket.smartMoneySells++;
    }

    // Recompute emotion for this token if we have a profile
    const existing = this.tokenProfiles.get(trade.mint);
    if (existing) {
      existing.profitTakingDetected = history ? history.smartMoneySells > 0 && history.smartMoneyBuys > 0 : false;
      existing.updatedAt = now;
    }
  }

  private handleNarrativeDetected(n: Narrative): void {
    if (!this.narrativeFirstSeen.has(n.topic)) {
      this.narrativeFirstSeen.set(n.topic, Date.now());
    }
    this.activeNarrativeCount = this.narrativeFirstSeen.size;
  }

  private handleNarrativeExpired(n: Narrative): void {
    this.narrativeFirstSeen.delete(n.topic);
    this.activeNarrativeCount = Math.max(0, this.activeNarrativeCount - 1);
  }

  // ══════════════════════════════════════════════════════
  // Core Emotion Computation
  // ══════════════════════════════════════════════════════

  private computeTokenEmotion(token: ScoredToken): TokenEmotionProfile {
    const history = this.tokenHistory.get(token.mint);
    const now = Date.now();

    const fomoScore = this.computeFomo(token, history);
    const panicScore = this.computePanic(token, history);
    const greedScore = this.computeGreed(token, history);
    const label = this.classifyEmotion(fomoScore, panicScore, greedScore, token.ageMinutes);

    // Composite: FOMO is opportunity, panic/greed are warnings
    // High FOMO + low panic + low greed = best entry
    const emotionScore = Math.min(100, Math.max(0, Math.round(
      fomoScore * 0.5 - panicScore * 0.3 - greedScore * 0.2 + 50
    )));

    const mcMultiplier = history
      ? token.marketCapSOL / Math.max(0.01, history.firstSeenMC)
      : 1;

    const buyAcceleration = this.computeBuyAcceleration(history);
    const sellBuyRatio = token.buyCount1h > 0
      ? token.sellCount1h / token.buyCount1h
      : token.sellCount1h > 0 ? 10 : 0;

    return {
      mint: token.mint,
      symbol: token.symbol,
      fomoScore,
      panicScore,
      greedScore,
      emotionScore,
      emotionLabel: label,
      buyAcceleration,
      sellBuyRatio,
      mcMultiplier,
      profitTakingDetected: history ? history.smartMoneySells > 0 : false,
      updatedAt: now,
    };
  }

  /** FOMO = rapid buy acceleration + high momentum + early in lifecycle */
  private computeFomo(token: ScoredToken, history: TokenHistory | undefined): number {
    let fomo = 0;

    // Buy acceleration: are buys speeding up?
    const accel = this.computeBuyAcceleration(history);
    if (accel > 5) fomo += 30;       // buys accelerating fast
    else if (accel > 2) fomo += 20;
    else if (accel > 0) fomo += 10;

    // High buy/sell ratio = demand outpacing supply
    if (token.buyCount1h > 0) {
      const ratio = token.buyCount1h / Math.max(1, token.sellCount1h);
      if (ratio >= 5) fomo += 25;
      else if (ratio >= 3) fomo += 20;
      else if (ratio >= 2) fomo += 15;
      else if (ratio >= 1.5) fomo += 10;
    }

    // High momentum score = market is excited
    if (token.momentumScore >= 70) fomo += 20;
    else if (token.momentumScore >= 50) fomo += 15;
    else if (token.momentumScore >= 30) fomo += 10;

    // MC growing rapidly (multiple snapshots)
    if (history && history.mcSnapshots.length >= 2) {
      const first = history.mcSnapshots[0].mc;
      const latest = history.mcSnapshots[history.mcSnapshots.length - 1].mc;
      const growth = latest / Math.max(0.01, first);
      if (growth >= 3) fomo += 15;
      else if (growth >= 2) fomo += 10;
      else if (growth >= 1.5) fomo += 5;
    }

    // Freshness multiplier: FOMO is strongest in first 30 min
    if (token.ageMinutes <= 10) fomo = Math.round(fomo * 1.3);
    else if (token.ageMinutes <= 30) fomo = Math.round(fomo * 1.1);
    else if (token.ageMinutes > 120) fomo = Math.round(fomo * 0.7);

    return Math.min(100, Math.max(0, fomo));
  }

  /** Panic = sells dominating buys + MC declining + smart money exiting */
  private computePanic(token: ScoredToken, history: TokenHistory | undefined): number {
    let panic = 0;

    // Sell/buy ratio: sells dominating
    if (token.sellCount1h > 0) {
      const sellRatio = token.sellCount1h / Math.max(1, token.buyCount1h);
      if (sellRatio >= 5) panic += 35;
      else if (sellRatio >= 3) panic += 25;
      else if (sellRatio >= 2) panic += 20;
      else if (sellRatio >= 1.5) panic += 10;
    }

    // MC declining across snapshots
    if (history && history.mcSnapshots.length >= 2) {
      const recent = history.mcSnapshots.slice(-3);
      let declining = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i].mc < recent[i - 1].mc) declining++;
      }
      if (declining === recent.length - 1) panic += 20; // consistently falling
    }

    // Smart money exiting this token
    if (history && history.smartMoneySells > 0) {
      panic += Math.min(25, history.smartMoneySells * 10);
    }

    // Low momentum = market losing interest
    if (token.momentumScore < 20) panic += 15;
    else if (token.momentumScore < 30) panic += 5;

    // Old token with declining activity is exhaustion, not panic
    if (token.ageMinutes > 120) panic = Math.round(panic * 0.8);

    return Math.min(100, Math.max(0, panic));
  }

  /** Greed = high MC multiple + smart money profit-taking + euphoric volume */
  private computeGreed(token: ScoredToken, history: TokenHistory | undefined): number {
    let greed = 0;

    // MC multiplier from initial detection
    if (history) {
      const multiplier = token.marketCapSOL / Math.max(0.01, history.firstSeenMC);
      if (multiplier >= 10) greed += 40;       // 10x = extreme greed
      else if (multiplier >= 5) greed += 30;   // 5x = high greed
      else if (multiplier >= 3) greed += 20;   // 3x = moderate greed
      else if (multiplier >= 2) greed += 10;   // 2x = building
    }

    // Smart money selling (profit-taking)
    if (history && history.smartMoneySells > 0 && history.smartMoneyBuys > 0) {
      // More sells than buys = taking profit
      const exitRatio = history.smartMoneySells / history.smartMoneyBuys;
      if (exitRatio >= 1) greed += 30;  // selling as much or more than buying
      else if (exitRatio >= 0.5) greed += 15;
    }

    // Near graduation = peak speculation
    if (token.bondingCurveProgress >= 85) greed += 20;
    else if (token.bondingCurveProgress >= 70) greed += 10;

    return Math.min(100, Math.max(0, greed));
  }

  /** Classify the dominant emotion from the three sub-scores */
  private classifyEmotion(
    fomo: number, panic: number, greed: number, ageMinutes: number
  ): EmotionLabel {
    // Priority order matters — panic > euphoria > greed > fomo > exhaustion > early > neutral
    if (panic >= cfg.panicThreshold) return 'panic_selling';
    if (fomo >= 70 && greed >= 50) return 'euphoria';       // FOMO + greed = blow-off top
    if (greed >= cfg.greedThreshold) return 'greed_peak';
    if (fomo >= cfg.fomoThreshold) return 'fomo_wave';
    if (fomo < 20 && greed < 20 && ageMinutes > 120) return 'exhaustion';
    if (fomo >= 30 && greed < 20 && ageMinutes <= 30) return 'early_interest';
    return 'neutral';
  }

  /** Compute how fast buying is accelerating (positive = speeding up) */
  private computeBuyAcceleration(history: TokenHistory | undefined): number {
    if (!history || history.buySnapshots.length < 2) return 0;

    const snapshots = history.buySnapshots.slice(-5);
    if (snapshots.length < 2) return 0;

    // Compare most recent buy count to earlier one
    const latest = snapshots[snapshots.length - 1];
    const earlier = snapshots[0];
    const timeDeltaMin = Math.max(1, (latest.ts - earlier.ts) / 60_000);

    // Rate of change in buy count per minute
    return (latest.buys - earlier.buys) / timeDeltaMin;
  }

  // ══════════════════════════════════════════════════════
  // Market Mood
  // ══════════════════════════════════════════════════════

  private publishMood(): void {
    const mood = this.computeMarketMood();
    this.currentMood = mood;

    // Check for significant shift
    const shift = Math.abs(mood.overallScore - this.lastMoodScore);
    if (shift >= cfg.moodShiftThreshold) {
      log.info(
        `[${this.meta.name}] MOOD SHIFT: ${this.lastMoodScore} → ${mood.overallScore} (${mood.overall})`
      );
    }
    this.lastMoodScore = mood.overallScore;

    bus.emit('emotion:mood', mood);

    // Persist mood snapshot periodically (every 5 min)
    if (this.activityBuckets.length > 0) {
      this.persistMood(mood);
    }
  }

  private computeMarketMood(): MarketMood {
    const now = Date.now();
    const hour = new Date().getUTCHours();
    const day = new Date().getUTCDay();

    // ── Token arrival rate ──
    const cutoff = now - EmotionRadar.TOKEN_RATE_WINDOW;
    this.recentNewTokens = this.recentNewTokens.filter(ts => ts > cutoff);
    const newTokenRate = this.recentNewTokens.length; // per hour

    // ── Average FOMO/panic across active profiles ──
    let totalFomo = 0, totalPanic = 0, profileCount = 0;
    for (const p of this.tokenProfiles.values()) {
      if (now - p.updatedAt < 30 * 60_000) { // only recent profiles
        totalFomo += p.fomoScore;
        totalPanic += p.panicScore;
        profileCount++;
      }
    }
    const avgFomo = profileCount > 0 ? totalFomo / profileCount : 0;
    const avgPanic = profileCount > 0 ? totalPanic / profileCount : 0;

    // ── Smart money net flow ──
    const smWindow = now - 60 * 60_000; // last hour
    let smBuys = 0, smSells = 0;
    for (const entry of this.smartMoneyLog) {
      if (entry.ts > smWindow) {
        if (entry.action === 'buy') smBuys++;
        else smSells++;
      }
    }
    const smartMoneyNetFlow = smBuys - smSells;

    // ── Narrative fatigue ──
    let totalAge = 0, narrativeCount = 0;
    for (const firstSeen of this.narrativeFirstSeen.values()) {
      totalAge += (now - firstSeen) / 60_000; // minutes
      narrativeCount++;
    }
    const avgNarrativeAge = narrativeCount > 0 ? totalAge / narrativeCount : 0;
    // Fatigue: narratives older than 3 hours are getting tired
    const narrativeFatigueScore = Math.min(100, Math.round(
      narrativeCount > 0 ? (avgNarrativeAge / 180) * 100 : 50
    ));

    // ── Composite mood score (0-100) ──
    let moodScore = 50; // neutral baseline

    // FOMO increases mood (market excitement)
    moodScore += avgFomo * 0.25;

    // Panic decreases mood (market fear)
    moodScore -= avgPanic * 0.25;

    // Smart money buying = confidence (greed)
    if (smartMoneyNetFlow > 3) moodScore += 10;
    else if (smartMoneyNetFlow > 0) moodScore += 5;
    else if (smartMoneyNetFlow < -3) moodScore -= 10;
    else if (smartMoneyNetFlow < 0) moodScore -= 5;

    // High token creation rate = speculative mania
    if (newTokenRate > 200) moodScore += 5;
    else if (newTokenRate < 50) moodScore -= 5;

    // Narrative fatigue drags mood down
    if (narrativeFatigueScore > 70) moodScore -= 5;

    // Time-of-day patterns:
    // US hours (14-22 UTC) = highest activity, more volatile
    // Asia hours (0-8 UTC) = second wave
    // Weekend = lower liquidity, more manipulation
    const isUSHours = hour >= 14 && hour <= 22;
    const isAsiaHours = hour >= 0 && hour <= 8;
    const isWeekend = day === 0 || day === 6;

    if (isWeekend) moodScore -= 3; // lower liquidity, be cautious

    moodScore = Math.min(100, Math.max(0, Math.round(moodScore)));

    // Classify
    let overall: MarketMood['overall'];
    if (moodScore >= 80) overall = 'extreme_greed';
    else if (moodScore >= 60) overall = 'greed';
    else if (moodScore >= 40) overall = 'neutral';
    else if (moodScore >= 20) overall = 'caution';
    else overall = 'fear';

    return {
      overall,
      overallScore: moodScore,
      newTokenRate,
      avgFomoScore: Math.round(avgFomo),
      avgPanicScore: Math.round(avgPanic),
      smartMoneyNetFlow,
      hourOfDay: hour,
      isUSHours,
      isAsiaHours,
      isWeekend,
      activeNarrativeCount: narrativeCount,
      narrativeFatigueScore,
      updatedAt: now,
    };
  }

  // ══════════════════════════════════════════════════════
  // Activity Buckets
  // ══════════════════════════════════════════════════════

  private rotateBucket(): void {
    const bucket: ActivityBucket = {
      timestamp: Date.now(),
      newTokenCount: 0,
      smartMoneyBuys: 0,
      smartMoneySells: 0,
      scoredTokenCount: 0,
      avgScore: 0,
      scoreSum: 0,
    };
    this.activityBuckets.push(bucket);

    // Keep only last N buckets (2 hours of 5-min buckets)
    while (this.activityBuckets.length > cfg.maxHistoryBuckets) {
      this.activityBuckets.shift();
    }
  }

  private getCurrentBucket(): ActivityBucket | null {
    return this.activityBuckets.length > 0
      ? this.activityBuckets[this.activityBuckets.length - 1]
      : null;
  }

  // ══════════════════════════════════════════════════════
  // Persistence
  // ══════════════════════════════════════════════════════

  private persistEmotion(profile: TokenEmotionProfile): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO emotion_snapshots
          (mint, symbol, emotion_label, fomo_score, panic_score, greed_score, emotion_score, hour_of_day, is_weekend, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profile.mint, profile.symbol, profile.emotionLabel,
        profile.fomoScore, profile.panicScore, profile.greedScore, profile.emotionScore,
        new Date().getUTCHours(), new Date().getUTCDay() === 0 || new Date().getUTCDay() === 6 ? 1 : 0,
        Date.now(),
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist emotion`, err);
    }
  }

  private persistMood(mood: MarketMood): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO emotion_snapshots
          (mint, emotion_label, market_mood_score, fomo_score, panic_score, hour_of_day, is_weekend, timestamp)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mood.overall, mood.overallScore, mood.avgFomoScore, mood.avgPanicScore,
        mood.hourOfDay, mood.isWeekend ? 1 : 0, mood.updatedAt,
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist mood`, err);
    }
  }

  // ══════════════════════════════════════════════════════
  // Memory Management
  // ══════════════════════════════════════════════════════

  private evictIfNeeded(): void {
    // Evict oldest token profiles
    if (this.tokenProfiles.size > cfg.maxTokenProfiles) {
      const entries = [...this.tokenProfiles.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const toRemove = entries.slice(0, entries.length - cfg.maxTokenProfiles + 50);
      for (const [mint] of toRemove) {
        this.tokenProfiles.delete(mint);
        this.tokenHistory.delete(mint);
      }
    }

    // Evict old token history
    if (this.tokenHistory.size > cfg.maxTokenProfiles + 100) {
      const now = Date.now();
      for (const [mint, h] of this.tokenHistory) {
        if (now - h.lastScoredAt > 60 * 60_000 && !this.tokenProfiles.has(mint)) {
          this.tokenHistory.delete(mint);
        }
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();

    // Clean old smart money log entries
    const smCutoff = now - EmotionRadar.SM_WINDOW;
    this.smartMoneyLog = this.smartMoneyLog.filter(e => e.ts > smCutoff);

    // Clean old new token timestamps
    const rateCutoff = now - EmotionRadar.TOKEN_RATE_WINDOW;
    this.recentNewTokens = this.recentNewTokens.filter(ts => ts > rateCutoff);

    // Clean stale token profiles (not updated in 1 hour)
    const staleCutoff = now - 60 * 60_000;
    for (const [mint, profile] of this.tokenProfiles) {
      if (profile.updatedAt < staleCutoff) {
        this.tokenProfiles.delete(mint);
      }
    }

    // Clean old narrative entries (older than 24h)
    const narrativeCutoff = now - 24 * 60 * 60_000;
    for (const [topic, ts] of this.narrativeFirstSeen) {
      if (ts < narrativeCutoff) this.narrativeFirstSeen.delete(topic);
    }

    log.debug(
      `[${this.meta.name}] Cleanup: ${this.tokenProfiles.size} profiles, ` +
      `${this.tokenHistory.size} histories, ${this.smartMoneyLog.length} SM events`
    );
  }

  /** Get current mood for external queries */
  getCurrentMood(): MarketMood | null {
    return this.currentMood;
  }

  /** Get emotion profile for a specific token */
  getTokenEmotion(mint: string): TokenEmotionProfile | undefined {
    return this.tokenProfiles.get(mint);
  }
}

