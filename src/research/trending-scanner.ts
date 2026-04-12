// ── Trending Scanner ────────────────────────────────────
// Scans DexScreener for fresh Solana tokens with real momentum.
// This bypasses Reddit entirely — finds tokens based on actual
// on-chain activity: volume, buy pressure, price action, age.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import type { Agent, AgentMeta, TokenSignal } from '../core/types.js';

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { symbol: string };
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
  priceChange?: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  url: string;
}

interface DexScreenerBoost {
  tokenAddress: string;
  chainId: string;
  amount: number;
  totalAmount: number;
  url: string;
}

// ── Quality thresholds for pump candidates ──
const MIN_LIQUIDITY = 3_000;
const MIN_MC = 10_000;
const MAX_MC = 5_000_000;
const MIN_VOL_24H = 2_000;
const MAX_AGE_DAYS = 30;
const MIN_BUYS_1H = 1;           // at least 1 buy in the last hour (relaxed from 3)
const MIN_BUY_SELL_RATIO = 0.5;  // not being heavily dumped (relaxed from 0.7)

export class TrendingScanner implements Agent {
  meta: AgentMeta = {
    name: 'Trending Scanner',
    squad: 'research',
    version: '0.1.0',
  };

  private interval: ReturnType<typeof setInterval> | null = null;
  // Track already-emitted mints to avoid spamming same token
  private emittedMints: Map<string, number> = new Map(); // mint -> timestamp
  private static readonly EMIT_COOLDOWN = 4 * 3600_000; // 4 hours

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] Starting — scanning DexScreener for trending Solana tokens`);

    await this.scan();
    // Scan every 3 minutes (offset from sentiment monitor's 2-min cycle)
    this.interval = setInterval(() => this.scan(), 3 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    log.info(`[${this.meta.name}] Stopped`);
  }

  private async scan(): Promise<void> {
    try {
      const tokens: TokenSignal[] = [];

      // Strategy 1: DexScreener boosted tokens (projects paying for visibility = active)
      const boosted = await this.scanBoostedTokens();
      tokens.push(...boosted);

      // Strategy 2: DexScreener token profiles (recently updated = active teams)
      const profiles = await this.scanTokenProfiles();
      tokens.push(...profiles);

      // Deduplicate by mint
      const seen = new Set<string>();
      const unique = tokens.filter(t => {
        if (seen.has(t.mint)) return false;
        seen.add(t.mint);
        return true;
      });

      // Sort by score (best pump candidates first)
      unique.sort((a, b) => b.score - a.score);

      // Emit top 3 as token signals
      const toEmit = unique.slice(0, 3);

      for (const token of toEmit) {
        // Cooldown: don't re-emit same token within 4 hours
        const lastEmit = this.emittedMints.get(token.mint);
        if (lastEmit && Date.now() - lastEmit < TrendingScanner.EMIT_COOLDOWN) {
          continue;
        }

        this.emittedMints.set(token.mint, Date.now());

        // Emit as a narrative with the token attached
        const narrative = {
          id: `trend-${Date.now()}-${token.symbol}`,
          topic: `Trending: $${token.symbol}`,
          confidence: Math.min(95, token.score + 10),
          sentiment: 50, // neutral-bullish (we don't have sentiment data, just momentum)
          sources: [{
            platform: 'dexscreener' as const,
            postCount: 1,
            avgSentiment: 50,
            samplePosts: [`$${token.symbol} trending on DexScreener — ${token.name}`],
            trendVelocity: 10,
          }],
          topTokens: [token],
          detectedAt: Date.now(),
          expiresAt: Date.now() + 4 * 3600_000, // 4hr expiry for trending
        };

        bus.emit('narrative:detected', narrative);

        log.info(
          `[${this.meta.name}] 🚀 TRENDING: $${token.symbol} — ` +
          `MC: $${token.marketCap.toLocaleString()}, Vol: $${token.volume24h.toLocaleString()}, ` +
          `Score: ${token.score}/100`
        );
      }

      // Clean old emitted entries
      if (this.emittedMints.size > 200) {
        const cutoff = Date.now() - TrendingScanner.EMIT_COOLDOWN;
        for (const [mint, ts] of this.emittedMints) {
          if (ts < cutoff) this.emittedMints.delete(mint);
        }
      }

      if (toEmit.length === 0) {
        log.info(`[${this.meta.name}] No trending tokens passed quality filters this cycle`);
      }
    } catch (err) {
      log.error(`[${this.meta.name}] Scan failed`, err);
    }
  }

  /** Scan DexScreener boosted tokens — projects paying for boost = active development */
  private async scanBoostedTokens(): Promise<TokenSignal[]> {
    try {
      const resp = await axios.get<DexScreenerBoost[]>(
        'https://api.dexscreener.com/token-boosts/latest/v1',
        { timeout: 8000 },
      );

      if (!Array.isArray(resp.data)) {
        log.debug(`[${this.meta.name}] Boosted API returned non-array`);
        return [];
      }

      // Filter to Solana only
      const solanaBoosted = resp.data
        .filter(b => b.chainId === 'solana')
        .slice(0, 15); // Check top 15

      log.info(`[${this.meta.name}] Boosted: ${resp.data.length} total, ${solanaBoosted.length} Solana`);

      if (solanaBoosted.length === 0) return [];

      // Fetch pair data for each boosted token
      const tokens: TokenSignal[] = [];
      const addresses = solanaBoosted.map(b => b.tokenAddress).join(',');

      // DexScreener v1 endpoint returns a FLAT ARRAY of pairs (not { pairs: [...] })
      const pairResp = await axios.get<DexScreenerPair[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${addresses}`,
        { timeout: 10000 },
      );

      const pairs = Array.isArray(pairResp.data) ? pairResp.data : [];
      if (pairs.length === 0) {
        log.warn(`[${this.meta.name}] Boosted: pairs API returned empty for ${solanaBoosted.length} tokens`);
        return [];
      }

      for (const pair of pairs) {
        const token = this.evaluatePair(pair, 'boosted');
        if (token) tokens.push(token);
      }

      log.info(`[${this.meta.name}] Boosted scan: ${pairs.length} pairs checked, ${tokens.length} passed filters`);
      return tokens;
    } catch (err) {
      log.warn(`[${this.meta.name}] Boosted token scan failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return [];
    }
  }

  /** Scan DexScreener token profiles — recently active Solana projects */
  private async scanTokenProfiles(): Promise<TokenSignal[]> {
    try {
      const resp = await axios.get<Array<{ tokenAddress: string; chainId: string; url: string }>>(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { timeout: 8000 },
      );

      if (!Array.isArray(resp.data)) {
        log.debug(`[${this.meta.name}] Profiles API returned non-array`);
        return [];
      }

      // Filter to Solana tokens
      const solanaTokens = resp.data
        .filter(t => t.chainId === 'solana')
        .slice(0, 20); // Check top 20

      log.info(`[${this.meta.name}] Profiles: ${resp.data.length} total, ${solanaTokens.length} Solana`);

      if (solanaTokens.length === 0) return [];

      // Fetch live pair data for these tokens (batch request)
      // DexScreener v1 endpoint returns a FLAT ARRAY of pairs (not { pairs: [...] })
      const addresses = solanaTokens.map(t => t.tokenAddress).join(',');
      const pairResp = await axios.get<DexScreenerPair[]>(
        `https://api.dexscreener.com/tokens/v1/solana/${addresses}`,
        { timeout: 10000 },
      );

      const allPairs = Array.isArray(pairResp.data) ? pairResp.data : [];
      if (allPairs.length === 0) {
        log.warn(`[${this.meta.name}] Profiles: pairs API returned empty for ${solanaTokens.length} tokens`);
        return [];
      }

      const tokens: TokenSignal[] = [];
      // Group pairs by token address, pick best pair per token
      const pairsByToken = new Map<string, DexScreenerPair[]>();
      for (const pair of allPairs) {
        const addr = pair.baseToken.address;
        const existing = pairsByToken.get(addr) || [];
        existing.push(pair);
        pairsByToken.set(addr, existing);
      }

      for (const [, pairs] of pairsByToken) {
        // Pick the pair with highest liquidity
        const bestPair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        const token = this.evaluatePair(bestPair, 'profile');
        if (token) tokens.push(token);
      }

      log.info(`[${this.meta.name}] Profiles scan: ${solanaTokens.length} tokens, ${tokens.length} passed filters`);
      return tokens;
    } catch (err) {
      log.debug(`[${this.meta.name}] Token profiles scan failed`);
      return [];
    }
  }

  /** Evaluate a single pair against quality criteria. Returns null if it fails. */
  private evaluatePair(p: DexScreenerPair, source: string): TokenSignal | null {
    if (p.chainId !== 'solana') return null;

    const mc = p.marketCap || p.fdv || 0;
    const liq = p.liquidity?.usd ?? 0;
    const vol24h = p.volume?.h24 ?? 0;
    const vol1h = p.volume?.h1 ?? 0;
    const sym = p.baseToken?.symbol ?? '???';
    const now = Date.now();

    // ── Hard filters (with reject logging) ──
    const reject = (reason: string) => {
      log.debug(`[${this.meta.name}] ✗ $${sym} (${source}): ${reason}`);
      return null;
    };

    if (liq < MIN_LIQUIDITY) return reject(`liq=$${liq.toFixed(0)} < $${MIN_LIQUIDITY}`);
    if (mc < MIN_MC) return reject(`MC=$${mc.toLocaleString()} < $${MIN_MC.toLocaleString()}`);
    if (mc > MAX_MC) return reject(`MC=$${mc.toLocaleString()} > $${MAX_MC.toLocaleString()}`);
    if (vol24h < MIN_VOL_24H) return reject(`vol=$${vol24h.toFixed(0)} < $${MIN_VOL_24H}`);

    // Age check
    if (p.pairCreatedAt) {
      const ageDays = (now - p.pairCreatedAt) / (24 * 3600_000);
      if (ageDays > MAX_AGE_DAYS) return reject(`${Math.round(ageDays)}d > ${MAX_AGE_DAYS}d max`);
    }

    // Buy activity in last hour
    const buys1h = p.txns?.h1?.buys ?? 0;
    const sells1h = p.txns?.h1?.sells ?? 0;
    if (buys1h < MIN_BUYS_1H) return reject(`buys1h=${buys1h} < ${MIN_BUYS_1H}`);

    // 24h buy/sell ratio
    const buys24h = p.txns?.h24?.buys ?? 0;
    const sells24h = p.txns?.h24?.sells ?? 0;
    if (sells24h > 0 && buys24h / sells24h < MIN_BUY_SELL_RATIO) return null;

    // Wash trade filter: extreme vol/MC ratio = manipulated volume
    const volMcRatio = mc > 0 ? vol24h / mc : 0;
    if (volMcRatio > 15) return reject(`vol/MC=${volMcRatio.toFixed(1)}x > 15x (likely wash trading)`);

    // ── Score ── (max 100)
    let score = 0;

    // Vol/MC ratio — BELL CURVE: organic range 0.5-3x is best, >5x is suspicious (0-20 pts)
    if (volMcRatio <= 3) {
      // Linear climb: 0→0, 1→7, 2→13, 3→20
      score += Math.min(20, Math.round(volMcRatio * 6.7));
    } else if (volMcRatio <= 6) {
      // Declining: 3→20, 4→16, 5→12, 6→8
      score += Math.max(8, 20 - Math.round((volMcRatio - 3) * 4));
    } else {
      // Penalty zone: 6→8, 10→0
      score += Math.max(0, 8 - Math.round((volMcRatio - 6) * 2));
    }

    // 5-minute momentum — is it hot RIGHT NOW? (0-15 pts)
    const buys5m = p.txns?.m5?.buys ?? 0;
    const sells5m = p.txns?.m5?.sells ?? 0;
    if (buys5m > 0) {
      const ratio5m = sells5m > 0 ? buys5m / sells5m : Math.min(buys5m, 5);
      // Reward active buying: ratio * 3, plus txn count bonus
      score += Math.min(15, Math.round(ratio5m * 3) + Math.min(5, Math.floor(buys5m / 3)));
    }

    // Multi-timeframe price consistency (0-15 pts)
    const pc = p.priceChange;
    if (pc) {
      let timeframesUp = 0;
      if (pc.m5 > 0) timeframesUp++;
      if (pc.h1 > 0) timeframesUp++;
      if (pc.h6 > 0) timeframesUp++;
      if (pc.h24 > 0) timeframesUp++;
      // 0=0, 1=2, 2=5, 3=9, 4=15
      score += [0, 2, 5, 9, 15][timeframesUp] ?? 0;

      // Penalty for declining on short timeframes (dump in progress)
      if (pc.m5 < -10) score -= 5;
      if (pc.h1 < -15) score -= 5;
    }

    // Hourly buy pressure (0-15 pts)
    const ratio1h = sells1h > 0 ? buys1h / sells1h : Math.min(buys1h, 5);
    score += ratio1h >= 3 ? 15 : ratio1h >= 2 ? 12 : ratio1h >= 1.5 ? 9 : ratio1h >= 1 ? 6 : 3;

    // Transaction diversity — many txns = organic, few large txns = whale manipulation (0-10 pts)
    const totalTxns1h = buys1h + sells1h;
    score += totalTxns1h >= 100 ? 10 : totalTxns1h >= 50 ? 7 : totalTxns1h >= 20 ? 4 : totalTxns1h >= 5 ? 2 : 0;

    // Freshness (0-12 pts — reduced from 20, freshness alone isn't quality)
    if (p.pairCreatedAt) {
      const ageDays = (now - p.pairCreatedAt) / (24 * 3600_000);
      score += ageDays <= 1 ? 12 : ageDays <= 3 ? 10 : ageDays <= 7 ? 7 : ageDays <= 14 ? 4 : 2;
    } else {
      score += 3;
    }

    // Chart pattern — reject tokens past their peak
    const pcData = p.priceChange;
    if (pcData) {
      // DUMP_IN_PROGRESS: hard reject
      if (pcData.m5 < -10 && pcData.h1 < -15 && sells1h > buys1h) {
        return reject(`DUMP_IN_PROGRESS (m5=${pcData.m5.toFixed(0)}%, h1=${pcData.h1.toFixed(0)}%)`);
      }
      // ALREADY_PEAKED: was pumping, now reversing — heavy penalty
      if ((pcData.m5 < -5 && pcData.h1 > 20) || (pcData.h1 < 0 && pcData.h6 > 30)) {
        score -= 15; // may still pass if other signals very strong
        log.debug(`[${this.meta.name}] ⚠ $${sym}: ALREADY_PEAKED penalty -15`);
      }
      // BREAKOUT: fresh upward move — bonus
      const avgHourlyVol = (p.volume?.h6 ?? 0) / 6;
      if (pcData.m5 > 10 && pcData.h1 > 5 && pcData.h6 < 20 && avgHourlyVol > 0 && vol1h > avgHourlyVol * 2) {
        score += 10;
      }
    }

    // Liquidity health (0-13 pts)
    const liqRatio = mc > 0 ? liq / mc : 0;
    score += Math.min(13, Math.round(liqRatio * 45));

    score = Math.max(0, Math.min(100, score));

    // Minimum score to be worth alerting (raised: need real quality signals)
    if (score < 50) return reject(`score=${score} < 50 min`);

    log.debug(
      `[${this.meta.name}] ✓ $${sym} (${source}): score=${score} — ` +
      `vol/MC=${volMcRatio.toFixed(1)}x, buys5m=${buys5m}, ratio1h=${ratio1h.toFixed(1)}, txns1h=${totalTxns1h}`
    );

    return {
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol.toUpperCase(),
      name: p.baseToken.name,
      price: parseFloat(p.priceUsd) || 0,
      volume24h: vol24h,
      marketCap: mc,
      holders: 0,
      narrative: source,
      score,
      source: 'dexscreener',
    };
  }
}

