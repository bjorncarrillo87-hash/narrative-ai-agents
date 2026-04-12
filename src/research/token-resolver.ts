// ── Token Resolver ──────────────────────────────────────
// Resolves $SYMBOL tickers to Solana mint addresses + market data.
// Only surfaces FRESH tokens with real momentum — no old/dead coins.
// Uses DexScreener (free, no auth).

import axios from 'axios';
import { log } from '../core/index.js';
import type { TokenSignal } from '../core/types.js';

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  volume: { h24: number };
  marketCap: number;
  fdv: number;
  liquidity: { usd: number };
  pairCreatedAt?: number;  // Unix ms — when pair was created on DEX
  txns?: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  priceChange?: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  url: string;
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

// Cache resolved tokens to avoid hammering APIs
const tokenCache = new Map<string, { data: TokenSignal | null; expiresAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const CACHE_TTL_FAILURE = 2 * 60 * 1000; // 2 min for failed lookups
const CACHE_MAX_SIZE = 500;

// ── Quality filters — only pump candidates ──
const MIN_LIQUIDITY_USD = 3_000;       // $3k min liquidity (avoid honeypots)
const MIN_MARKET_CAP = 10_000;         // $10k min MC (avoid dead tokens)
const MAX_MARKET_CAP = 20_000_000;     // $20M max MC (relaxed from $5M — narrative plays can be larger)
const MIN_VOLUME_24H = 1_000;          // $1k daily volume (someone's trading it)
const MAX_AGE_DAYS = 90;               // Max 90 days old (relaxed from 30 — narrative revivals happen)
const MIN_BUY_TX_24H = 3;             // At least 3 buy transactions in 24h (relaxed from 10)
const MIN_BUY_SELL_RATIO = 0.5;        // Buys ≥ 50% of sells (relaxed from 0.6)

// In-flight dedup
const pendingResolves = new Map<string, Promise<TokenSignal | null>>();

/** Evict expired entries when cache gets too large */
function cleanCache(): void {
  if (tokenCache.size <= CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (now >= entry.expiresAt) tokenCache.delete(key);
  }
  if (tokenCache.size > CACHE_MAX_SIZE) {
    const overflow = tokenCache.size - CACHE_MAX_SIZE;
    const keys = Array.from(tokenCache.keys());
    for (let i = 0; i < overflow && i < keys.length; i++) {
      tokenCache.delete(keys[i]);
    }
  }
}

/**
 * Resolve a ticker symbol to a Solana token with mint address + market data.
 * Returns null if not found or doesn't meet quality criteria.
 */
export async function resolveToken(symbol: string): Promise<TokenSignal | null> {
  const upper = symbol.toUpperCase();

  const cached = tokenCache.get(upper);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const pending = pendingResolves.get(upper);
  if (pending) return pending;

  const promise = resolveTokenImpl(upper);
  pendingResolves.set(upper, promise);
  try {
    return await promise;
  } finally {
    pendingResolves.delete(upper);
  }
}

async function resolveTokenImpl(upper: string): Promise<TokenSignal | null> {
  try {
    const resp = await axios.get<DexScreenerResponse>(
      `https://api.dexscreener.com/latest/dex/search?q=${upper}`,
      { timeout: 8000 },
    );

    if (!resp.data?.pairs || resp.data.pairs.length === 0) {
      tokenCache.set(upper, { data: null, expiresAt: Date.now() + CACHE_TTL_FAILURE });
      return null;
    }

    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 3600_000;

    // ── Apply quality filters with detailed rejection logging ──
    const solanaPairs = resp.data.pairs.filter(p =>
      p.chainId === 'solana' && p.baseToken.symbol.toUpperCase() === upper
    );

    if (solanaPairs.length === 0) {
      tokenCache.set(upper, { data: null, expiresAt: Date.now() + CACHE_TTL_FAILURE });
      return null;
    }

    // Log why tokens get rejected (helps tune filters)
    const candidates = solanaPairs.filter(p => {
      const liq = p.liquidity?.usd ?? 0;
      const mc = p.marketCap || p.fdv || 0;
      const vol = p.volume?.h24 ?? 0;
      const ageDays = p.pairCreatedAt ? (now - p.pairCreatedAt) / (24 * 3600_000) : -1;
      const buys = p.txns?.h24?.buys ?? 0;
      const sells = p.txns?.h24?.sells ?? 0;
      const ratio = sells > 0 ? buys / sells : buys;

      if (liq < MIN_LIQUIDITY_USD) {
        log.info(`[TokenResolver] ✗ $${upper}: liq=$${liq.toLocaleString()} < $${MIN_LIQUIDITY_USD} min`);
        return false;
      }
      if (mc > MAX_MARKET_CAP) {
        log.info(`[TokenResolver] ✗ $${upper}: MC=$${mc.toLocaleString()} > $${MAX_MARKET_CAP.toLocaleString()} max (too established)`);
        return false;
      }
      if (mc < MIN_MARKET_CAP) {
        log.info(`[TokenResolver] ✗ $${upper}: MC=$${mc.toLocaleString()} < $${MIN_MARKET_CAP.toLocaleString()} min (dead)`);
        return false;
      }
      if (vol < MIN_VOLUME_24H) {
        log.info(`[TokenResolver] ✗ $${upper}: vol=$${vol.toLocaleString()} < $${MIN_VOLUME_24H.toLocaleString()} min`);
        return false;
      }
      if (ageDays > MAX_AGE_DAYS) {
        log.info(`[TokenResolver] ✗ $${upper}: ${Math.round(ageDays)}d old > ${MAX_AGE_DAYS}d max`);
        return false;
      }
      if (buys < MIN_BUY_TX_24H) {
        log.info(`[TokenResolver] ✗ $${upper}: ${buys} buys < ${MIN_BUY_TX_24H} min`);
        return false;
      }
      if (sells > 0 && ratio < MIN_BUY_SELL_RATIO) {
        log.info(`[TokenResolver] ✗ $${upper}: buy/sell=${ratio.toFixed(2)} < ${MIN_BUY_SELL_RATIO} (dumping)`);
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      tokenCache.set(upper, { data: null, expiresAt: Date.now() + CACHE_TTL_FAILURE });
      return null;
    }

    // ── Score and rank candidates ──
    const scored = candidates.map(p => {
      const mc = p.marketCap || p.fdv || 0;
      const vol = p.volume?.h24 ?? 0;
      const liq = p.liquidity?.usd ?? 0;

      // Momentum: volume relative to market cap
      const volMcRatio = mc > 0 ? vol / mc : 0;
      const momentumPts = Math.min(30, Math.round(volMcRatio * 100));

      // Freshness: newer = better (max 20 pts)
      let freshnessPts = 10;
      if (p.pairCreatedAt) {
        const ageDays = (now - p.pairCreatedAt) / (24 * 3600_000);
        freshnessPts = ageDays <= 1 ? 20 : ageDays <= 3 ? 18 : ageDays <= 7 ? 15 : ageDays <= 14 ? 10 : 5;
      }

      // Buy pressure: buys vs sells ratio (max 20 pts)
      let buyPressurePts = 10;
      if (p.txns?.h24) {
        const { buys, sells } = p.txns.h24;
        const ratio = sells > 0 ? buys / sells : buys;
        buyPressurePts = ratio >= 3 ? 20 : ratio >= 2 ? 17 : ratio >= 1.5 ? 14 : ratio >= 1 ? 10 : 5;
      }

      // Price action: recent price increase (max 15 pts)
      let priceActionPts = 0;
      if (p.priceChange) {
        if (p.priceChange.h1 > 5) priceActionPts += 5;    // up 5%+ in last hour
        if (p.priceChange.h6 > 10) priceActionPts += 5;   // up 10%+ in 6h
        if (p.priceChange.h24 > 20) priceActionPts += 5;  // up 20%+ in 24h
      }

      // Liquidity health: higher liq relative to MC = harder to rug (max 15 pts)
      const liqMcRatio = mc > 0 ? liq / mc : 0;
      const liqHealthPts = Math.min(15, Math.round(liqMcRatio * 50));

      const totalScore = momentumPts + freshnessPts + buyPressurePts + priceActionPts + liqHealthPts;

      return { pair: p, score: Math.min(100, totalScore), mc, vol, liq };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const p = best.pair;
    const ageDays = p.pairCreatedAt ? (now - p.pairCreatedAt) / (24 * 3600_000) : -1;
    const buyCount = p.txns?.h24?.buys ?? 0;
    const sellCount = p.txns?.h24?.sells ?? 0;
    const priceChange24h = p.priceChange?.h24 ?? 0;

    const token: TokenSignal = {
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol.toUpperCase(),
      name: p.baseToken.name,
      price: parseFloat(p.priceUsd) || 0,
      volume24h: best.vol,
      marketCap: best.mc,
      holders: 0,
      narrative: '',
      score: best.score,
      source: 'dexscreener',
    };

    const ageStr = ageDays >= 0 ? `${ageDays < 1 ? '<1' : Math.round(ageDays)}d old` : 'age unknown';
    log.info(
      `[TokenResolver] ✓ $${upper}: MC=$${best.mc.toLocaleString()}, Vol=$${best.vol.toLocaleString()}, ` +
      `score=${best.score}, ${ageStr}, buys=${buyCount}/sells=${sellCount}, ` +
      `24h=${priceChange24h > 0 ? '+' : ''}${priceChange24h.toFixed(1)}%`
    );

    tokenCache.set(upper, { data: token, expiresAt: Date.now() + CACHE_TTL });
    cleanCache();
    return token;
  } catch (err) {
    log.debug(`[TokenResolver] Failed to resolve $${upper}`);
    tokenCache.set(upper, { data: null, expiresAt: Date.now() + CACHE_TTL_FAILURE });
    return null;
  }
}

// Track tokens already used in this scan cycle to prevent cross-narrative duplicates
let currentCycleTokens = new Set<string>();
let lastCycleReset = 0;

/** Reset cross-narrative dedup at start of each scan cycle */
export function resetCycleDedup(): void {
  currentCycleTokens = new Set();
  lastCycleReset = Date.now();
}

/**
 * Resolve multiple ticker symbols in parallel.
 * Returns only successfully resolved tokens, sorted by score (best pump candidates first).
 */
export async function resolveTokens(
  symbols: string[],
  narrative: string,
  mentionCounts: Record<string, number>,
): Promise<TokenSignal[]> {
  // Auto-reset if stale (safety: 5 min max)
  if (Date.now() - lastCycleReset > 5 * 60_000) {
    resetCycleDedup();
  }

  const results = await Promise.allSettled(
    symbols.map(s => resolveToken(s))
  );

  const resolved: TokenSignal[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      const token = { ...result.value };

      // Skip if this token was already used in another narrative this cycle
      if (currentCycleTokens.has(token.mint)) {
        log.debug(`[TokenResolver] $${token.symbol} already in another narrative — skipping`);
        continue;
      }

      token.narrative = narrative;
      // Boost score with mention frequency (social signal)
      const mentionBoost = Math.min(20, (mentionCounts[symbols[i]] || 1) * 5);
      token.score = Math.min(100, token.score + mentionBoost);

      resolved.push(token);
      currentCycleTokens.add(token.mint);
    }
  }

  return resolved.sort((a, b) => b.score - a.score);
}

