// ── Narrative AI — Shared Types ─────────────────────────

/** Agent identity */
export type SquadName = 'research' | 'trading' | 'deploy' | 'ops';

export interface AgentMeta {
  name: string;
  squad: SquadName;
  version: string;
}

/** Narrative detected by sentiment analysis */
export interface Narrative {
  id: string;
  topic: string;                 // e.g. "AI agents", "RWA", "memecoins"
  confidence: number;            // 0–100
  sentiment: number;             // -100 to +100
  sources: NarrativeSource[];
  topTokens: TokenSignal[];
  detectedAt: number;            // unix ms
  expiresAt: number;             // estimated narrative lifespan
}

export interface NarrativeSource {
  platform: 'reddit' | 'telegram' | 'twitter' | 'dexscreener';
  postCount: number;
  avgSentiment: number;
  samplePosts: string[];         // preview subset (max 5)
  allPosts?: string[];           // full post texts for narrative analysis
  trendVelocity: number;         // posts per hour acceleration
}

/** A token signal attached to a narrative */
export interface TokenSignal {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  volume24h: number;
  marketCap: number;
  holders: number;
  narrative: string;
  score: number;                 // composite score 0–100
  source: string;                // which agent found it
}

/** Raw new token from pump.fun WebSocket */
export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  bondingCurveKey: string;
  initialBuySOL: number;
  marketCapSOL: number;
  signature: string;
  timestamp: number;
}

/** Safety check result from sniper detector + token analyzer */
export interface SafetyReport {
  mint: string;
  symbol: string;
  // Authority checks
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  // Sniper/bundle detection
  bundledLaunch: boolean;          // creator + first buy in same tx
  sniperCount: number;             // buys in first block
  creatorHoldingPct: number;       // % of supply held by creator
  topHolderConcentration: number;  // % held by top 10 wallets
  // Creator history
  creatorPreviousTokens: number;   // how many tokens this wallet deployed
  creatorRugRate: number;          // % of their tokens that rugged (0-100)
  // Honeypot check
  sellable: boolean;               // can you actually sell this token?
  // RugCheck
  rugCheckRisk: 'good' | 'warning' | 'danger' | 'unknown';
  rugCheckScore: number;           // 0-100 (100 = safest)
  // Overall
  safe: boolean;                   // passed all checks
  riskFlags: string[];             // human-readable list of issues
  checkedAt: number;
}

/** Scored token ready for alerting (after safety + analysis) */
export interface ScoredToken {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  // Market data
  marketCapSOL: number;
  marketCapUSD: number;
  liquidityUSD: number;
  volume24h: number;
  priceUSD: number;
  // On-chain metrics
  holderCount: number;
  buyCount1h: number;
  sellCount1h: number;
  buyVolume1h: number;
  // Scores
  momentumScore: number;           // 0-100 based on vol/MC, buy pressure
  safetyScore: number;             // 0-100 from SafetyReport
  socialScore: number;             // 0-100 from KOL/smart money signals
  overallScore: number;            // composite 0-100
  // Context
  ageMinutes: number;
  source: string;                  // which agent found it
  bondingCurveProgress: number;    // 0-100% toward graduation
  chartPattern?: string;           // BREAKOUT, PUMP_PHASE, ALREADY_PEAKED, etc.
  entryAdvice?: string;            // strong_buy, buy, watch, avoid, do_not_enter
  safety: SafetyReport;
  smartMoneyBuyers: string[];      // labels of known wallets that bought
  timestamp: number;
}

/** Smart money wallet trade */
export interface SmartMoneyTrade {
  wallet: string;
  label: string;
  mint: string;
  symbol: string;
  action: 'buy' | 'sell';
  amountSOL: number;
  signature: string;
  walletPnl: number;              // wallet's historical PnL
  walletWinRate: number;          // wallet's historical win rate
  timestamp: number;
}

/** Whale movement alert */
export interface WhaleAlert {
  wallet: string;
  token: string;
  symbol: string;
  action: 'buy' | 'sell' | 'transfer';
  amount: number;
  usdValue: number;
  timestamp: number;
}

/** Pump.fun graduation status */
export interface GraduationStatus {
  mint: string;
  symbol: string;
  bondingCurveProgress: number;  // 0–100%
  marketCap: number;
  isKingOfHill: boolean;
  timeToGraduation: number | null;  // estimated ms
}

/** Trade signal emitted by research → consumed by trading */
export interface TradeSignal {
  id: string;
  type: 'narrative_entry' | 'whale_follow' | 'SignalEngine_copy' | 'graduation_play';
  token: TokenSignal;
  narrative: Narrative;
  action: 'buy' | 'sell';
  confidence: number;
  suggestedSize: number;         // % of portfolio
  reasoning: string;
  timestamp: number;
}

/** Risk limits — The Kredo */
export interface KredoConfig {
  maxDailyLossPct: number;       // 30%
  maxPerTradePct: number;        // 10%
  maxOpenPositions: number;
  maxExposurePct: number;        // total portfolio at risk
  stopLossPct: number;
  cooldownMs: number;            // between trades
  killSwitch: boolean;           // emergency halt
}

// ── Emotion Radar types ──

/** Emotional state label for a token or market */
export type EmotionLabel =
  | 'fomo_wave'        // rapid buy acceleration, latecomers piling in
  | 'panic_selling'    // sell cascade, capitulation
  | 'greed_peak'       // profit-taking at high multiples
  | 'euphoria'         // max bullish — usually precedes dump
  | 'exhaustion'       // narrative dying, volume fading
  | 'early_interest'   // organic early buying, smart money entering
  | 'neutral';

/** Per-token emotional profile */
export interface TokenEmotionProfile {
  mint: string;
  symbol: string;
  fomoScore: number;              // 0-100
  panicScore: number;             // 0-100
  greedScore: number;             // 0-100
  emotionScore: number;           // 0-100 composite for scoring
  emotionLabel: EmotionLabel;
  buyAcceleration: number;        // buys/min rate of change
  sellBuyRatio: number;           // sells / buys in recent window
  mcMultiplier: number;           // current MC / MC at detection
  profitTakingDetected: boolean;  // smart money selling into strength
  updatedAt: number;
}

/** Global market mood snapshot */
export interface MarketMood {
  overall: 'fear' | 'caution' | 'neutral' | 'greed' | 'extreme_greed';
  overallScore: number;           // 0-100 (0=max fear, 100=extreme greed)
  newTokenRate: number;           // tokens/hour
  avgFomoScore: number;
  avgPanicScore: number;
  smartMoneyNetFlow: number;      // buys - sells in recent window
  hourOfDay: number;              // 0-23 UTC
  isUSHours: boolean;             // 14:00-22:00 UTC
  isAsiaHours: boolean;           // 00:00-08:00 UTC
  isWeekend: boolean;
  activeNarrativeCount: number;
  narrativeFatigueScore: number;  // 0-100
  updatedAt: number;
}

/** Early momentum data from PumpFun Watcher trade tracking */
export interface EarlyMomentumEvent {
  mint: string;
  symbol: string;
  buyCount: number;              // total buys tracked
  sellCount: number;             // total sells tracked
  totalBuySOL: number;           // cumulative SOL volume from buys
  uniqueBuyers: number;          // distinct buyer addresses
  largestBuySOL: number;         // single largest buy in SOL
  timeSinceCreationMs: number;   // ms since token was created
  latestMarketCapSOL: number;    // most recent MC from PumpPortal trades
}

/** Events flowing through the system */
export type EventMap = {
  // Research pipeline (new flow: token:new → token:safety → token:scored)
  'token:new': NewTokenEvent;            // pump.fun watcher detects new token
  'token:safety': SafetyReport;          // sniper detector checked token safety
  'token:scored': ScoredToken;           // token analyzer scored and approved token
  'token:early_momentum': EarlyMomentumEvent; // early trade velocity from PumpFun Watcher
  'smart_money:trade': SmartMoneyTrade;  // smart money wallet made a trade
  'emotion:token': TokenEmotionProfile;  // per-token emotion update
  'emotion:mood': MarketMood;            // global market mood update

  // Legacy flow (kept for backward compat during transition)
  'narrative:detected': Narrative;
  'narrative:expired': Narrative;
  'token:signal': TokenSignal;
  'whale:alert': WhaleAlert;
  'graduation:update': GraduationStatus;
  'trade:signal': TradeSignal;
  'risk:breach': { rule: string; details: string };
  'ops:alert': { level: 'info' | 'warn' | 'critical'; message: string; data?: unknown };
  'ops:daily_report': DailyReport;
};

export interface DailyReport {
  date: string;
  narrativesDetected: number;
  topNarrative: string;
  signalsGenerated: number;
  alertsSent: number;
  uptime: number;
}

/** Token performance tracking — did it actually pump? */
export interface TokenPerformance {
  id?: number;
  mint: string;
  symbol: string;
  pairAddress?: string;
  dex?: string;
  alertType: string;                 // 'pumpfun','sniper','smart_money','graduation','narrative'
  alertScore?: number;               // overall score at alert
  safetyScore?: number;
  momentumScore?: number;
  socialScore?: number;
  alertPrice?: number;
  alertMc?: number;
  alertTime: number;
  peakPrice?: number;
  peakMc?: number;
  peakTime?: number;
  currentPrice?: number;
  currentMc?: number;
  priceChangePct?: number;
  volume24h?: number;
  liquidityUsd?: number;
  txns24h?: number;
  hit: boolean;                      // pumped 2x+
  outcome?: 'runner' | 'moderate' | 'flat' | 'dump';
  notes?: string;
  checkedAt?: number;
}

/** Base agent interface */
export interface Agent {
  meta: AgentMeta;
  start(): Promise<void>;
  stop(): Promise<void>;
}


