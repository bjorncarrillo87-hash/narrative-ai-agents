// ── Token Analyzer ─────────────────────────────────────
// Scores tokens that passed safety checks.
// Uses DexScreener for market data + Jupiter for honeypot simulation.
// Combines safety score + momentum score + social score into overall score.
// Emits token:scored events for the alert dispatcher.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import { getDb } from '../core/db.js';
import { recordFromScoredToken } from '../core/token-performance.js';
import type {
  Agent, AgentMeta, SafetyReport, ScoredToken, NewTokenEvent,
  TokenEmotionProfile, MarketMood, EarlyMomentumEvent,
} from '../core/types.js';

// DexScreener pair data
interface DexPair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number };
  marketCap: number;
  fdv: number;
  liquidity: { usd: number };
  pairCreatedAt?: number;
  txns?: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  priceChange?: { h24: number; h6: number; h1: number; m5: number };
}

// ── Chart Pattern Detection ──
type ChartPattern =
  | 'BREAKOUT' | 'PUMP_PHASE' | 'STAIRCASE'
  | 'ALREADY_PEAKED' | 'DUMP_IN_PROGRESS'
  | 'V_RECOVERY' | 'FLAT_ACCUMULATION' | 'UNKNOWN';

interface ChartAnalysis {
  pattern: ChartPattern;
  scoreModifier: number;   // -30 to +15, applied to momentum
  entryAdvice: 'strong_buy' | 'buy' | 'watch' | 'avoid' | 'do_not_enter';
}

// SOL price cache
let solPriceUSD = 150; // default fallback
let solPriceUpdatedAt = 0;
const SOL_PRICE_TTL = 5 * 60_000; // 5 min

export class TokenAnalyzer implements Agent {
  meta: AgentMeta = {
    name: 'Token Analyzer',
    squad: 'research',
    version: '1.0.0',
  };

  private running = false;
  private solPriceInterval: ReturnType<typeof setInterval> | null = null;

  // Queue safety reports to analyze
  private queue: SafetyReport[] = [];
  private processing = false;

  // Store original NewTokenEvent data for context
  private tokenEvents: Map<string, NewTokenEvent> = new Map();
  private static readonly MAX_TOKEN_EVENTS = 200;

  // Track smart money buyers per token (bounded — cleaned periodically)
  private smartMoneySignals: Map<string, string[]> = new Map(); // mint -> labels
  private static readonly MAX_SMART_MONEY_SIGNALS = 500;

  // Alert cooldown
  private alertedTokens: Map<string, number> = new Map(); // mint -> timestamp

  // Early momentum from PumpFun Watcher (real-time trade velocity)
  private earlyMomentum: Map<string, EarlyMomentumEvent> = new Map();
  private static readonly MAX_EARLY_MOMENTUM = 500;

  // Emotion Radar integration
  private emotionProfiles: Map<string, TokenEmotionProfile> = new Map();
  private currentMood: MarketMood | null = null;
  private static readonly MAX_EMOTION_PROFILES = 300;

  // Handler refs
  private onSafetyReport = (report: SafetyReport) => this.enqueue(report);
  private onNewToken = (event: NewTokenEvent) => this.cacheTokenEvent(event);
  private onEmotionUpdate = (profile: TokenEmotionProfile) => {
    this.emotionProfiles.set(profile.mint, profile);
    if (this.emotionProfiles.size > TokenAnalyzer.MAX_EMOTION_PROFILES) {
      const oldest = this.emotionProfiles.keys().next().value;
      if (oldest) this.emotionProfiles.delete(oldest);
    }
  };
  private onMoodUpdate = (mood: MarketMood) => { this.currentMood = mood; };
  private onEarlyMomentum = (event: EarlyMomentumEvent) => {
    this.earlyMomentum.set(event.mint, event);
    if (this.earlyMomentum.size > TokenAnalyzer.MAX_EARLY_MOMENTUM) {
      const oldest = this.earlyMomentum.keys().next().value;
      if (oldest) this.earlyMomentum.delete(oldest);
    }
  };
  private onSmartMoneyTrade = (trade: { mint: string; label: string }) => {
    // Evict oldest entries if at capacity
    if (this.smartMoneySignals.size >= TokenAnalyzer.MAX_SMART_MONEY_SIGNALS && !this.smartMoneySignals.has(trade.mint)) {
      const oldest = this.smartMoneySignals.keys().next().value;
      if (oldest) this.smartMoneySignals.delete(oldest);
    }
    const existing = this.smartMoneySignals.get(trade.mint) || [];
    if (!existing.includes(trade.label)) {
      existing.push(trade.label);
      this.smartMoneySignals.set(trade.mint, existing);
    }
  };

  async start(): Promise<void> {
    this.running = true;
    bus.on('token:safety', this.onSafetyReport);
    bus.on('token:new', this.onNewToken);
    bus.on('token:early_momentum', this.onEarlyMomentum);
    bus.on('smart_money:trade', this.onSmartMoneyTrade as any);
    bus.on('emotion:token', this.onEmotionUpdate);
    bus.on('emotion:mood', this.onMoodUpdate);

    // Update SOL price
    await this.updateSolPrice();
    this.solPriceInterval = setInterval(() => this.updateSolPrice(), SOL_PRICE_TTL);

    log.info(`[${this.meta.name}] Started — scoring tokens that pass safety checks`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.solPriceInterval) clearInterval(this.solPriceInterval);
    bus.off('token:safety', this.onSafetyReport);
    bus.off('token:new', this.onNewToken);
    bus.off('token:early_momentum', this.onEarlyMomentum);
    bus.off('smart_money:trade', this.onSmartMoneyTrade as any);
    bus.off('emotion:token', this.onEmotionUpdate);
    bus.off('emotion:mood', this.onMoodUpdate);
    this.queue = [];
    this.tokenEvents.clear();
    this.earlyMomentum.clear();
    this.smartMoneySignals.clear();
    this.alertedTokens.clear();
    this.emotionProfiles.clear();
    this.currentMood = null;
    log.info(`[${this.meta.name}] Stopped`);
  }

  private cacheTokenEvent(event: NewTokenEvent): void {
    if (this.tokenEvents.size >= TokenAnalyzer.MAX_TOKEN_EVENTS) {
      const oldest = [...this.tokenEvents.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.tokenEvents.delete(oldest[0]);
    }
    this.tokenEvents.set(event.mint, event);
  }

  private enqueue(report: SafetyReport): void {
    if (this.queue.length >= 50) this.queue.shift();
    this.queue.push(report);
    if (!this.processing) this.processQueue();
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.running) {
        const report = this.queue.shift()!;
        try {
          await this.scoreToken(report);
        } catch (err) {
          log.error(`[${this.meta.name}] Failed to score $${report.symbol}`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  // Delay scoring for brand-new tokens to let PumpFun Watcher accumulate trade data
  private static readonly NEW_TOKEN_SCORE_DELAY_MS = 20_000; // 20 seconds

  private async scoreToken(originalSafety: SafetyReport): Promise<void> {
    // Clone safety to avoid mutating the original emitted/persisted object
    const safety = { ...originalSafety, riskFlags: [...originalSafety.riskFlags] };

    // Skip tokens that failed critical safety checks
    if (!safety.safe) {
      log.debug(`[${this.meta.name}] Skipping $${safety.symbol} — failed safety (${safety.riskFlags.length} flags)`);
      return;
    }

    // Alert cooldown check
    const lastAlert = this.alertedTokens.get(safety.mint);
    if (lastAlert && Date.now() - lastAlert < config.scoring.alertCooldownMs) {
      return;
    }

    // Get original token event for creator/bonding curve info
    const tokenEvent = this.tokenEvents.get(safety.mint);

    // Wait for early trade data to accumulate before scoring brand-new tokens.
    // PumpFun Watcher needs ~15-20s of trades to emit meaningful momentum signals.
    if (tokenEvent) {
      const tokenAge = Date.now() - tokenEvent.timestamp;
      if (tokenAge < TokenAnalyzer.NEW_TOKEN_SCORE_DELAY_MS) {
        const waitMs = TokenAnalyzer.NEW_TOKEN_SCORE_DELAY_MS - tokenAge;
        log.debug(`[${this.meta.name}] $${safety.symbol} is ${Math.round(tokenAge / 1000)}s old — waiting ${Math.round(waitMs / 1000)}s for trade data`);
        await new Promise(r => setTimeout(r, waitMs));
        if (!this.running) return;
      }
    }

    // ── Fetch market data from DexScreener ──
    const marketData = await this.fetchMarketData(safety.mint);

    // ── Honeypot check: can we sell via Jupiter? ──
    const sellable = await this.checkSellable(safety.mint);
    safety.sellable = sellable;

    if (!sellable) {
      safety.riskFlags.push('HONEYPOT — cannot sell via Jupiter');
      safety.safe = false;
      log.info(`[${this.meta.name}] $${safety.symbol} HONEYPOT — Jupiter sell simulation failed`);
      return;
    }

    // ── Calculate scores ──
    // For brand new tokens, DexScreener may not have data yet.
    // Fall back to PumpPortal data from the NewTokenEvent.
    // DexScreener often returns garbage data for tokens < 2 min old (e.g., MC=$0.83
    // instead of ~$7000), so sanity-check: if DexScreener MC is unreasonably low
    // and we have PumpPortal data, prefer PumpPortal.
    const dexMcUSD = marketData ? (marketData.marketCap || marketData.fdv || 0) : 0;
    const pumpPortalMcSOL = tokenEvent?.marketCapSOL ?? 0;
    const pumpPortalMcUSD = pumpPortalMcSOL * solPriceUSD;

    // DexScreener data is "good" only if it returned a reasonable MC (> $500)
    // OR if we don't have PumpPortal data to compare against
    const hasDexData = marketData
      && dexMcUSD > 500
      && (marketData.marketCap > 0 || marketData.fdv > 0);

    let mcUSD: number;
    let mcSOL: number;
    let liq: number;
    let vol24h: number;
    let priceUSD: number;
    let buys1h: number;
    let sells1h: number;
    let buyVol1h: number;

    if (hasDexData) {
      mcUSD = dexMcUSD;
      mcSOL = mcUSD / solPriceUSD;
      liq = marketData!.liquidity?.usd ?? 0;
      vol24h = marketData!.volume?.h24 ?? 0;
      priceUSD = parseFloat(marketData!.priceUsd || '0');
      buys1h = marketData!.txns?.h1?.buys ?? 0;
      sells1h = marketData!.txns?.h1?.sells ?? 0;
      buyVol1h = marketData!.volume?.h1 ?? 0;
    } else {
      // Use PumpPortal data — token is too new or DexScreener data is unreliable.
      // Prefer latest MC from trade events (more current than creation MC).
      // SANITY CHECK: trade events sometimes report tiny marketCapSol values that
      // are wildly inconsistent with the creation MC. If liveMcSOL is < 10% of
      // the creation MC, it's bad data — use creation MC instead.
      const earlyMom = this.earlyMomentum.get(safety.mint);
      const liveMcSOL = earlyMom?.latestMarketCapSOL || 0;
      const creationMcSOL = pumpPortalMcSOL || 30;
      const liveMcReliable = liveMcSOL > 0 && (liveMcSOL >= creationMcSOL * 0.1);
      mcSOL = liveMcReliable ? liveMcSOL : creationMcSOL;
      mcUSD = mcSOL * solPriceUSD;
      liq = 0;
      vol24h = 0;
      // Pump.fun tokens = 1B supply. Use live MC for price (NOT genesis bonding curve).
      priceUSD = mcUSD > 500 ? mcUSD / 1_000_000_000 : 0;
      buys1h = 0;
      sells1h = 0;
      buyVol1h = 0;
    }

    const holderCount = 0; // Would need Birdeye Premium for this

    // Age in minutes
    const ageMs = marketData?.pairCreatedAt
      ? Date.now() - marketData.pairCreatedAt
      : tokenEvent
        ? Date.now() - tokenEvent.timestamp
        : 0;
    const ageMinutes = Math.max(1, Math.round(ageMs / 60_000));

    // Bonding curve progress estimate (based on MC relative to graduation)
    const bondingCurveProgress = Math.min(100, (mcSOL / config.pumpfun.graduationMcSOL) * 100);

    // ── Momentum Score (0-100) ──
    let momentumScore = 0;
    let chart: ChartAnalysis | null = null;

    if (hasDexData) {
      // Vol/MC ratio (0-30 pts)
      if (mcUSD > 0) {
        const volMcRatio = vol24h / mcUSD;
        momentumScore += Math.min(30, Math.round(volMcRatio * 100));
      }

      // Buy pressure (0-25 pts)
      const buyRatio = sells1h > 0 ? buys1h / sells1h : buys1h;
      if (buyRatio >= 3) momentumScore += 25;
      else if (buyRatio >= 2) momentumScore += 20;
      else if (buyRatio >= 1.5) momentumScore += 15;
      else if (buyRatio >= 1) momentumScore += 10;
      else momentumScore += 3;

      // Price action (0-15 pts)
      const pc = marketData?.priceChange;
      if (pc) {
        if (pc.m5 > 10) momentumScore += 5;
        if (pc.h1 > 20) momentumScore += 5;
        if (pc.h6 > 50) momentumScore += 5;
      }

      // Chart pattern detection — where is this token in its lifecycle?
      chart = TokenAnalyzer.detectChartPattern(marketData!, buys1h, sells1h);
      momentumScore += chart.scoreModifier;

      // Liquidity health (0-10 pts)
      if (mcUSD > 0) {
        const liqRatio = liq / mcUSD;
        momentumScore += Math.min(10, Math.round(liqRatio * 40));
      }
    } else {
      // Brand new token — no DexScreener data yet.
      // Use continuous curves instead of fixed tiers for better differentiation.

      // Initial buy size (0-15 pts) — log curve rewards conviction without hard tiers
      const initialBuy = tokenEvent?.initialBuySOL ?? 0;
      if (initialBuy > 0) {
        // log2(1+SOL) * 4, capped at 15: 0.5→3, 1→4, 2→6, 5→10, 10→14, 15→15
        momentumScore += Math.min(15, Math.round(Math.log2(1 + initialBuy) * 4));
      }

      // MC-based momentum (0-15 pts) — continuous curve based on bonding curve position
      // Virtual SOL starts at 30, graduation at ~85. Real progress = mcSOL - 30
      const realProgress = Math.max(0, mcSOL - 30);
      // sqrt curve: 5→5, 10→7, 20→10, 35→13, 55→15
      momentumScore += Math.min(15, Math.round(Math.sqrt(realProgress) * 2.1));
    }

    // ── Early trade velocity from PumpFun Watcher (0-50 pts) ──
    // Applied to BOTH DexScreener and no-data paths — this is real-time trade data
    // that supplements whatever market data source we're using.
    // Caps widened: 38 buyers/38.7 SOL must score much higher than 3 buyers/0.6 SOL.
    const earlyMom = this.earlyMomentum.get(safety.mint);
    if (earlyMom) {
      // Unique buyers (0-20 pts): most important organic signal
      // log2(1+buyers) * 3.5: 3→7, 8→12, 15→16, 30→20
      momentumScore += Math.min(20, Math.round(Math.log2(1 + earlyMom.uniqueBuyers) * 3.5));

      // Buy volume in SOL (0-18 pts): real money flowing in
      // log2(1+SOL) * 3.3: 1→3, 5→8, 15→13, 40→18
      momentumScore += Math.min(18, Math.round(Math.log2(1 + earlyMom.totalBuySOL) * 3.3));

      // Buy/sell ratio (0-18 pts): strongest predictor per backtest
      if (earlyMom.buyCount > 0) {
        const buySellRatio = earlyMom.sellCount > 0
          ? earlyMom.buyCount / earlyMom.sellCount
          : Math.min(earlyMom.buyCount, 10); // cap unbounded ratio
        // Continuous: min(18, sqrt(ratio) * 7): 1.5→9, 3→12, 5→16, 7→18
        momentumScore += Math.min(18, Math.round(Math.sqrt(buySellRatio) * 7));
      }
    }

    // ── Chart pattern for new tokens (no DexScreener data) ──
    // Use early momentum to detect basic patterns — prevents entering tokens
    // that are already dumping even before DexScreener indexes them.
    if (!chart && earlyMom) {
      const buyRatio = earlyMom.sellCount > 0
        ? earlyMom.buyCount / earlyMom.sellCount
        : Math.min(earlyMom.buyCount, 10);
      const sellDominant = earlyMom.sellCount > earlyMom.buyCount;
      const heavySells = earlyMom.sellCount > earlyMom.buyCount * 2;

      if (heavySells) {
        // More sells than buys by 2x — active dump
        chart = { pattern: 'DUMP_IN_PROGRESS', scoreModifier: -30, entryAdvice: 'do_not_enter' };
      } else if (sellDominant) {
        // Sells outnumber buys — peaked and declining
        chart = { pattern: 'ALREADY_PEAKED', scoreModifier: -20, entryAdvice: 'avoid' };
      } else if (buyRatio >= 3 && earlyMom.uniqueBuyers >= 10) {
        // Strong buying with diverse buyers — breakout
        chart = { pattern: 'BREAKOUT', scoreModifier: 15, entryAdvice: 'strong_buy' };
      } else if (buyRatio >= 1.5 && earlyMom.uniqueBuyers >= 5) {
        // Healthy buying — pump phase
        chart = { pattern: 'PUMP_PHASE', scoreModifier: 10, entryAdvice: 'buy' };
      }

      if (chart) {
        momentumScore += chart.scoreModifier;
      }
    }

    // Freshness bonus (0-15 pts) — newer = more potential (reduced from 20 to balance with velocity)
    if (ageMinutes <= 5) momentumScore += 15;
    else if (ageMinutes <= 30) momentumScore += 12;
    else if (ageMinutes <= 60) momentumScore += 9;
    else if (ageMinutes <= 360) momentumScore += 5;
    else if (ageMinutes <= 1440) momentumScore += 3;

    momentumScore = Math.min(100, momentumScore);

    // ── Safety Score (0-100) — from RugCheck + our checks ──
    let safetyScore = safety.rugCheckScore;
    // Bonus for clean authorities
    if (safety.mintAuthorityRevoked) safetyScore += 10;
    if (safety.freezeAuthorityRevoked) safetyScore += 10;
    // Pump.fun bonding curve tokens are inherently safe — liquidity is locked in the
    // bonding curve contract, creator cannot rug. Give a safety bonus for pre-graduation.
    if (bondingCurveProgress > 0 && bondingCurveProgress < 100) safetyScore += 10;
    // Penalty for snipers
    if (safety.sniperCount > 3) safetyScore -= 15;
    if (safety.bundledLaunch) safetyScore -= 25;
    // Penalty for high concentration
    if (safety.topHolderConcentration > 30) safetyScore -= 10;
    safetyScore = Math.max(0, Math.min(100, safetyScore));

    // ── Social Score (0-100) — from smart money + emotion + narrative signals ──
    const smartBuyers = this.smartMoneySignals.get(safety.mint) || [];
    let socialScore = 0;

    // Smart money component (0-60)
    socialScore += Math.min(60, smartBuyers.length * 20);

    // Narrative category bonus (0-15) — historical data shows AI, animal, political
    // themes produce 50%+ of 100M+ winners. Reward tokens matching these categories.
    const tokenName = (tokenEvent?.name || safety.symbol).toLowerCase();
    const tokenSymbol = safety.symbol.toLowerCase();
    const nameAndSymbol = `${tokenName} ${tokenSymbol}`;
    const narrativeBonus = TokenAnalyzer.getNarrativeCategoryBonus(nameAndSymbol);
    socialScore += narrativeBonus;

    // Bonding curve progress (0-20)
    if (bondingCurveProgress >= 50) socialScore += 10; // approaching KOTH
    if (bondingCurveProgress >= 80) socialScore += 10; // near graduation

    // Emotion Radar component (adjusts -20 to +20)
    const emotion = this.emotionProfiles.get(safety.mint);
    if (emotion) {
      // FOMO wave = buy signal (people are piling in)
      if (emotion.fomoScore > 50) socialScore += Math.min(15, Math.round(emotion.fomoScore / 5));

      // Panic selling = avoid (capitulation in progress)
      if (emotion.panicScore > 50) socialScore -= Math.min(20, Math.round(emotion.panicScore / 4));

      // Greed peak = smart money exiting, reduce confidence
      if (emotion.greedScore > 60) socialScore -= Math.min(10, Math.round(emotion.greedScore / 8));

      // Euphoria = blow-off top imminent, big penalty
      if (emotion.emotionLabel === 'euphoria') socialScore -= 15;

      // Early interest = sweet spot
      if (emotion.emotionLabel === 'early_interest') socialScore += 10;
    }

    // Market mood adjustment (global context)
    if (this.currentMood) {
      // Extreme fear = bad time to enter
      if (this.currentMood.overallScore < 20) socialScore -= 10;
      // Extreme greed on weekends = low liquidity trap
      if (this.currentMood.overallScore > 80 && this.currentMood.isWeekend) socialScore -= 5;
    }

    socialScore = Math.max(0, Math.min(100, socialScore));

    // ── Hard reject: DUMP_IN_PROGRESS tokens should never be entered ──
    if (chart?.entryAdvice === 'do_not_enter') {
      log.info(
        `[${this.meta.name}] ✗ $${safety.symbol} REJECTED — ${chart.pattern} ` +
        `(${hasDexData ? 'DexScreener' : 'early momentum'} data)`
      );
      return;
    }

    // ── Overall Score ──
    // Adaptive weights: for brand-new tokens (< 5 min), safety is always ~50 (no RugCheck data)
    // and social is always 0 (no smart money/emotion data yet). Momentum is the ONLY
    // meaningful signal, so we give it dominant weight. As the token ages and accumulates
    // safety + social data, we shift back to balanced weights.
    let momWeight = 0.35;
    let safetyWeight = 0.40;
    let socialWeight = 0.25;

    const isNewToken = ageMinutes <= 5 && safety.rugCheckScore === 50 && socialScore === 0;
    if (isNewToken) {
      momWeight = 0.55;
      safetyWeight = 0.30;
      socialWeight = 0.15;
    }

    const overallScore = Math.min(100, Math.round(
      momentumScore * momWeight +
      safetyScore * safetyWeight +
      socialScore * socialWeight
    ));

    // Apply minimum thresholds — lower bar for new tokens since they have limited data
    const effectiveThreshold = isNewToken
      ? Math.max(35, config.scoring.minOverallScore - 15) // 40 with default config
      : config.scoring.minOverallScore;                    // 55

    if (overallScore < effectiveThreshold) {
      log.debug(
        `[${this.meta.name}] $${safety.symbol} score ${overallScore} < ${effectiveThreshold} threshold` +
        `${isNewToken ? ' (new token)' : ''} — skipping`
      );
      return;
    }
    if (safetyScore < config.scoring.minSafetyScore) {
      log.debug(`[${this.meta.name}] $${safety.symbol} safety ${safetyScore} too low — skipping`);
      return;
    }

    const scored: ScoredToken = {
      mint: safety.mint,
      symbol: safety.symbol,
      name: tokenEvent?.name || safety.symbol,
      creator: tokenEvent?.creator || '',
      marketCapSOL: mcSOL,
      marketCapUSD: mcUSD,
      liquidityUSD: liq,
      volume24h: vol24h,
      priceUSD,
      holderCount,
      buyCount1h: buys1h,
      sellCount1h: sells1h,
      buyVolume1h: buyVol1h,
      momentumScore,
      safetyScore,
      socialScore,
      overallScore,
      ageMinutes,
      source: smartBuyers.length > 0 ? 'smart_money+pumpfun' : 'pumpfun',
      bondingCurveProgress,
      chartPattern: chart?.pattern,
      entryAdvice: chart?.entryAdvice,
      safety,
      smartMoneyBuyers: smartBuyers,
      timestamp: Date.now(),
    };

    // Persist
    this.persistTokenScan(scored);

    // Mark cooldown
    this.alertedTokens.set(safety.mint, Date.now());

    // Clean old cooldowns
    if (this.alertedTokens.size > 500) {
      const cutoff = Date.now() - config.scoring.alertCooldownMs;
      for (const [mint, ts] of this.alertedTokens) {
        if (ts < cutoff) this.alertedTokens.delete(mint);
      }
    }

    // Emit for alert dispatcher
    bus.emit('token:scored', scored);

    // Auto-record for hit rate tracking
    try { recordFromScoredToken(scored); } catch { /* non-critical */ }

    const filled = Math.min(10, Math.max(0, Math.round(overallScore / 10)));
    const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const weightsLabel = isNewToken ? ' [new-token weights]' : '';
    const chartLabel = chart ? ` | Chart: ${chart.pattern}(${chart.scoreModifier >= 0 ? '+' : ''}${chart.scoreModifier})` : '';
    log.info(
      `[${this.meta.name}] SCORED $${scored.symbol}: ${scoreBar} ${overallScore}/100 — ` +
      `Safety=${safetyScore} Momentum=${momentumScore} Social=${socialScore}${weightsLabel} — ` +
      `MC: $${mcUSD.toLocaleString()}, Age: ${ageMinutes}m${chartLabel}` +
      (smartBuyers.length > 0 ? `, Smart Money: ${smartBuyers.join(', ')}` : '') +
      (earlyMom ? `, Early: ${earlyMom.uniqueBuyers} buyers/${earlyMom.totalBuySOL.toFixed(1)} SOL` : '')
    );
  }

  /** Fetch market data from DexScreener */
  private async fetchMarketData(mint: string): Promise<DexPair | null> {
    try {
      // DexScreener v1 returns a flat array of pairs, not { pairs: [...] }
      const resp = await axios.get<DexPair[] | { pairs: DexPair[] | null }>(
        `https://api.dexscreener.com/tokens/v1/solana/${mint}`,
        { timeout: 8000 },
      );
      // Handle both v1 (flat array) and legacy (object with pairs) response formats
      const pairs = Array.isArray(resp.data)
        ? resp.data
        : resp.data?.pairs ?? [];
      if (pairs.length === 0) return null;
      // Return the pair with highest liquidity
      return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    } catch {
      return null;
    }
  }

  /** Check if token is sellable via Jupiter (honeypot detection) */
  private async checkSellable(mint: string): Promise<boolean> {
    try {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      // Try to get a sell quote for a small amount
      const resp = await axios.get(`${config.jupiterApiUrl}/quote`, {
        params: {
          inputMint: mint,
          outputMint: SOL_MINT,
          amount: '1000000', // 1 token (assuming 6 decimals)
          slippageBps: 500,  // 5% slippage tolerance
        },
        timeout: 8000,
      });
      // If we get a valid quote, it's sellable
      return resp.data && resp.data.outAmount && parseInt(resp.data.outAmount) > 0;
    } catch (err: unknown) {
      // Distinguish "no route" (token issue) from server/network errors
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        // 400 = bad request (invalid mint or no route) — likely honeypot or unsupported token
        if (status === 400) return false;
        // 5xx or timeout — Jupiter is down, give benefit of the doubt for new tokens
        if ((status && status >= 500) || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
          return true;
        }
      }
      // Unknown error — default to benefit of the doubt for very new tokens
      return true;
    }
  }

  /** Update SOL price in USD */
  private async updateSolPrice(): Promise<void> {
    if (Date.now() - solPriceUpdatedAt < SOL_PRICE_TTL) return;
    try {
      const resp = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
        { timeout: 5000 },
      );
      const pairs = resp.data?.pairs;
      if (Array.isArray(pairs) && pairs.length > 0) {
        // Pick the pair with highest liquidity — pairs[0] is often a garbage low-liq pair
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
    } catch {
      // Keep existing price
    }
  }

  private persistTokenScan(token: ScoredToken): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO token_scans
        (mint, symbol, name, creator, market_cap_sol, market_cap_usd, liquidity_usd,
         volume_24h, price_usd, holder_count, bonding_curve_progress,
         overall_score, safety_score, momentum_score, social_score,
         source, detected_at, scored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        token.mint, token.symbol, token.name, token.creator,
        token.marketCapSOL, token.marketCapUSD, token.liquidityUSD,
        token.volume24h, token.priceUSD, token.holderCount, token.bondingCurveProgress,
        token.overallScore, token.safetyScore, token.momentumScore, token.socialScore,
        token.source, token.timestamp, Date.now(),
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist token scan`, err);
    }
  }

  /** Detect chart pattern from DexScreener price change data.
   *  Identifies where a token is in its lifecycle to prevent entering dumps. */
  static detectChartPattern(pair: DexPair, buys1h: number, sells1h: number): ChartAnalysis {
    const pc = pair.priceChange;
    if (!pc) return { pattern: 'UNKNOWN', scoreModifier: 0, entryAdvice: 'watch' };

    const vol1h = pair.volume?.h1 ?? 0;
    const vol6h = pair.volume?.h6 ?? 0;
    const avgHourlyVol = vol6h > 0 ? vol6h / 6 : 0;
    const buyRatio = sells1h > 0 ? buys1h / sells1h : buys1h;

    // ── DUMP_IN_PROGRESS: actively crashing — DO NOT ENTER ──
    if (pc.m5 < -10 && pc.h1 < -15 && sells1h > buys1h) {
      return { pattern: 'DUMP_IN_PROGRESS', scoreModifier: -30, entryAdvice: 'do_not_enter' };
    }

    // ── ALREADY_PEAKED: was pumping, now reversing — AVOID ──
    // This is the #1 cause of missed trades: entering after the peak
    if ((pc.m5 < -5 && pc.h1 > 20) || (pc.h1 < 0 && pc.h6 > 30)) {
      return { pattern: 'ALREADY_PEAKED', scoreModifier: -20, entryAdvice: 'avoid' };
    }

    // ── BREAKOUT: sharp fresh move with volume — STRONG ENTRY ──
    if (pc.m5 > 10 && pc.h1 > 5 && pc.h6 < 20 && avgHourlyVol > 0 && vol1h > avgHourlyVol * 2) {
      return { pattern: 'BREAKOUT', scoreModifier: 15, entryAdvice: 'strong_buy' };
    }

    // ── PUMP_PHASE: rising with volume — GOOD ENTRY ──
    if (pc.m5 > 0 && pc.h1 > 0 && buyRatio > 1.5 && vol1h > avgHourlyVol) {
      return { pattern: 'PUMP_PHASE', scoreModifier: 10, entryAdvice: 'buy' };
    }

    // ── STAIRCASE: consistent uptrend across all timeframes ──
    if (pc.h24 > 0 && pc.h6 > 0 && pc.h1 > 0 && pc.m5 >= 0 &&
        pc.h24 < 100 && pc.h6 < 50 && pc.h1 < 30) {
      return { pattern: 'STAIRCASE', scoreModifier: 8, entryAdvice: 'buy' };
    }

    // ── V_RECOVERY: bouncing from dip — CAUTIOUS ──
    if (pc.m5 > 5 && pc.h1 < -10) {
      return { pattern: 'V_RECOVERY', scoreModifier: 5, entryAdvice: 'watch' };
    }

    // ── FLAT_ACCUMULATION: sideways with volume — WATCH ──
    if (Math.abs(pc.m5) < 2 && Math.abs(pc.h1) < 5 && vol1h > 0) {
      return { pattern: 'FLAT_ACCUMULATION', scoreModifier: 0, entryAdvice: 'watch' };
    }

    return { pattern: 'UNKNOWN', scoreModifier: 0, entryAdvice: 'watch' };
  }

  /** Narrative category bonus based on historical 100M+ winners.
   *  AI=6, Animal=6, Political=3, Culture=3 out of 23 top performers. */
  private static readonly NARRATIVE_KEYWORDS: Array<{ category: string; words: string[]; bonus: number }> = [
    { category: 'AI', words: ['ai', 'gpt', 'agent', 'llm', 'neural', 'sentient', 'artificial', 'bot', 'intelligence'], bonus: 15 },
    { category: 'Animal', words: ['dog', 'cat', 'pepe', 'frog', 'monkey', 'ape', 'bear', 'bull', 'whale', 'doge', 'shiba', 'inu', 'mew', 'popcat', 'hippo', 'sloth', 'penguin'], bonus: 12 },
    { category: 'Political', words: ['trump', 'elon', 'musk', 'president', 'election', 'political', 'government', 'congress'], bonus: 10 },
    { category: 'Culture', words: ['anime', 'manga', 'meme', 'viral', 'tiktok', 'chad', 'giga', 'based', 'degen', 'wojak', 'npc'], bonus: 8 },
  ];

  static getNarrativeCategoryBonus(nameAndSymbol: string): number {
    let bestBonus = 0;
    for (const { words, bonus } of TokenAnalyzer.NARRATIVE_KEYWORDS) {
      for (const word of words) {
        if (nameAndSymbol.includes(word)) {
          bestBonus = Math.max(bestBonus, bonus);
          break; // one match per category is enough
        }
      }
    }
    return bestBonus;
  }
}


