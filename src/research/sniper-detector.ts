// ── Sniper Detector ────────────────────────────────────
// Analyzes new pump.fun tokens for red flags:
// - Bundled launches (creator + first buys in same block)
// - Mint/freeze authority not revoked
// - Creator wallet history (serial rugger?)
// - Top holder concentration
// Listens for token:new events, emits token:safety reports.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import { getDb } from '../core/db.js';
import type { Agent, AgentMeta, NewTokenEvent, SafetyReport } from '../core/types.js';

// Helius enhanced transaction response (simplified)
interface HeliusTx {
  signature: string;
  slot: number;
  timestamp: number;
  type: string;
  feePayer: string;
  tokenTransfers: Array<{
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
  }>;
}

// RugCheck API response
interface RugCheckReport {
  score?: number;
  risks?: Array<{ name: string; level: string; description: string }>;
  tokenMeta?: {
    mint_authority: string | null;
    freeze_authority: string | null;
  };
  topHolders?: Array<{
    address: string;
    pct: number;
  }>;
  fileMeta?: { description?: string };
}

export class SniperDetector implements Agent {
  meta: AgentMeta = {
    name: 'Sniper Detector',
    squad: 'research',
    version: '1.0.0',
  };

  // Queue to process tokens sequentially (avoid API hammering)
  private queue: NewTokenEvent[] = [];
  private processing = false;
  private running = false;

  // Cache creator history to avoid repeated lookups
  private creatorCache: Map<string, { tokens: number; rugRate: number; checkedAt: number }> = new Map();
  private static readonly CREATOR_CACHE_TTL = 30 * 60_000; // 30 min
  private static readonly MAX_CREATOR_CACHE = 500;

  // Rate limiting
  private lastApiCall = 0;
  private static readonly API_DELAY = 300; // 300ms between API calls

  // Handler ref for cleanup
  private onNewToken = (event: NewTokenEvent) => this.enqueue(event);

  async start(): Promise<void> {
    this.running = true;
    bus.on('token:new', this.onNewToken);
    log.info(`[${this.meta.name}] Started — listening for new tokens to analyze`);
  }

  async stop(): Promise<void> {
    this.running = false;
    bus.off('token:new', this.onNewToken);
    this.queue = [];
    this.creatorCache.clear();
    log.info(`[${this.meta.name}] Stopped`);
  }

  private enqueue(event: NewTokenEvent): void {
    // Cap queue to prevent unbounded growth during bursts
    if (this.queue.length >= 50) {
      this.queue.shift(); // Drop oldest
    }
    this.queue.push(event);
    if (!this.processing) this.processQueue();
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.running) {
        const token = this.queue.shift();
        if (!token) break;
        try {
          await this.analyzeToken(token);
        } catch (err) {
          log.error(`[${this.meta.name}] Failed to analyze $${token.symbol}`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async analyzeToken(token: NewTokenEvent): Promise<void> {
    const riskFlags: string[] = [];

    // ── 1. RugCheck API (fastest, gives us authority + score + holders) ──
    const rugCheck = await this.fetchRugCheck(token.mint);

    let mintAuthorityRevoked = true;
    let freezeAuthorityRevoked = true;
    let rugCheckScore = 50;
    let rugCheckRisk: SafetyReport['rugCheckRisk'] = 'unknown';
    let topHolderConcentration = 0;

    if (rugCheck) {
      // Authority checks from RugCheck
      mintAuthorityRevoked = rugCheck.tokenMeta?.mint_authority === null;
      freezeAuthorityRevoked = rugCheck.tokenMeta?.freeze_authority === null;

      if (!mintAuthorityRevoked) riskFlags.push('Mint authority NOT revoked — creator can mint unlimited tokens');
      if (!freezeAuthorityRevoked) riskFlags.push('Freeze authority NOT revoked — creator can freeze your wallet');

      // Score: RugCheck API returns raw risk score (higher = riskier)
      // Normalize to 0-100 where 100 = safest using smooth inverse curve
      // rawScore 0→100, 200→50, 500→29, 1000→17, 5000→4
      const rawScore = Math.max(0, rugCheck.score ?? 0);
      rugCheckScore = Math.round(100 / (1 + rawScore / 200));

      if (rugCheckScore >= 70) rugCheckRisk = 'good';
      else if (rugCheckScore >= 40) rugCheckRisk = 'warning';
      else rugCheckRisk = 'danger';

      if (rugCheckScore < config.safety.minRugCheckScore) {
        riskFlags.push(`RugCheck safety ${rugCheckScore}/100 (below ${config.safety.minRugCheckScore} threshold)`);
      }

      // Risks flagged by RugCheck
      if (rugCheck.risks) {
        for (const risk of rugCheck.risks) {
          if (risk.level === 'danger' || risk.level === 'error') {
            riskFlags.push(`RugCheck: ${risk.name}`);
          }
        }
      }

      // Top holder concentration
      if (rugCheck.topHolders && rugCheck.topHolders.length > 0) {
        topHolderConcentration = rugCheck.topHolders
          .slice(0, 10)
          .reduce((sum, h) => sum + h.pct, 0);

        if (topHolderConcentration > config.safety.maxTopHolderPct) {
          riskFlags.push(`Top 10 holders own ${topHolderConcentration.toFixed(1)}% (>${config.safety.maxTopHolderPct}%)`);
        }
      }
    } else {
      // Brand new pump.fun tokens often haven't been indexed by RugCheck yet — this is expected.
      // Use conservative defaults: assume authorities are OK (pump.fun defaults to revoked).
      // Note: pump.fun tokens have mint/freeze authority revoked by default in the bonding curve phase.
      rugCheckScore = 50; // slightly below neutral — no data yet, don't boost score
      rugCheckRisk = 'unknown';
      riskFlags.push('RugCheck: no data yet (token too new)');
    }

    // ── 2. Sniper/bundle detection via Helius ──
    let bundledLaunch = false;
    let sniperCount = 0;
    let creatorHoldingPct = 0;

    if (config.heliusApiKey) {
      const earlyTxns = await this.fetchEarlyTransactions(token.mint);
      if (earlyTxns.length > 0) {
        const creationSlot = earlyTxns[0]?.slot;

        // Only check for bundled launch if we have a valid creation slot
        if (creationSlot !== undefined && creationSlot !== null) {
          const sameSlotBuys = earlyTxns.filter(
            tx => tx.slot === creationSlot && tx.feePayer !== token.creator
          );
          sniperCount = sameSlotBuys.length;

          if (sniperCount > config.safety.maxSniperCount) {
            bundledLaunch = true;
            riskFlags.push(`${sniperCount} buys in first block — bundled launch detected`);
          }
        }

        // Check for creator self-buys: creator appears as buyer in token transfers (not just feePayer)
        const creatorTokenBuys = earlyTxns.filter(tx =>
          tx.tokenTransfers?.some(t =>
            t.toUserAccount === token.creator && t.mint === token.mint
          )
        );
        // First tx is the creation itself, so >1 means additional self-buys
        if (creatorTokenBuys.length > 1) {
          riskFlags.push(`Creator received tokens in ${creatorTokenBuys.length} transactions — potential self-buy`);
        }
      }
    }

    // ── 3. Creator wallet history ──
    const creatorHistory = await this.getCreatorHistory(token.creator);
    const creatorPreviousTokens = creatorHistory.tokens;
    const creatorRugRate = creatorHistory.rugRate;

    if (creatorPreviousTokens > 5) {
      riskFlags.push(`Creator deployed ${creatorPreviousTokens} previous tokens`);
    }
    if (creatorRugRate > config.safety.maxCreatorRugRate) {
      riskFlags.push(`Creator rug rate: ${creatorRugRate.toFixed(0)}% (>${config.safety.maxCreatorRugRate}%)`);
    }

    // ── 4. Initial buy size check ──
    if (token.initialBuySOL > 10) {
      riskFlags.push(`Large initial buy: ${token.initialBuySOL.toFixed(1)} SOL (insider advantage)`);
    }

    // ── Determine overall safety ──
    const criticalFlags = riskFlags.filter(f =>
      f.includes('Mint authority NOT') ||
      f.includes('Freeze authority NOT') ||
      f.includes('bundled launch') ||
      f.includes('rug rate') ||
      f.includes('RugCheck safety')
    );
    const safe = criticalFlags.length === 0;

    const report: SafetyReport = {
      mint: token.mint,
      symbol: token.symbol,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      bundledLaunch,
      sniperCount,
      creatorHoldingPct,
      topHolderConcentration,
      creatorPreviousTokens,
      creatorRugRate,
      sellable: true, // Will be checked by Token Analyzer via Jupiter sim
      rugCheckRisk,
      rugCheckScore,
      safe,
      riskFlags,
      checkedAt: Date.now(),
    };

    // Persist
    this.persistSafetyCheck(report);

    // Emit for Token Analyzer
    bus.emit('token:safety', report);

    const statusIcon = safe ? '✅' : '⚠️';
    log.info(
      `[${this.meta.name}] ${statusIcon} $${token.symbol}: ` +
      `RugCheck=${rugCheckScore}/100, Snipers=${sniperCount}, ` +
      `Creator=${creatorPreviousTokens} prev tokens (${creatorRugRate.toFixed(0)}% rug rate), ` +
      `Flags: ${riskFlags.length === 0 ? 'none' : riskFlags.join('; ')}`
    );
  }

  /** Fetch RugCheck report for a token */
  private async fetchRugCheck(mint: string): Promise<RugCheckReport | null> {
    await this.rateLimit();
    try {
      const resp = await axios.get<RugCheckReport>(
        `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
        {
          timeout: 8000,
          headers: config.rugcheckApiKey
            ? { Authorization: `Bearer ${config.rugcheckApiKey}` }
            : undefined,
        },
      );
      return resp.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Token too new for RugCheck — expected for brand new tokens
        log.debug(`[${this.meta.name}] RugCheck: no data yet for ${mint.slice(0, 8)}...`);
      } else {
        log.debug(`[${this.meta.name}] RugCheck API failed for ${mint.slice(0, 8)}...`);
      }
      return null;
    }
  }

  /** Fetch first N transactions for a token to detect bundled buys */
  private async fetchEarlyTransactions(mint: string): Promise<HeliusTx[]> {
    await this.rateLimit();
    try {
      const resp = await axios.get<HeliusTx[]>(
        `https://api.helius.xyz/v0/addresses/${mint}/transactions`, {
          params: {
            'api-key': config.heliusApiKey,
            limit: 10,
          },
          timeout: 10000,
        },
      );
      return resp.data || [];
    } catch {
      log.debug(`[${this.meta.name}] Helius tx fetch failed for ${mint.slice(0, 8)}...`);
      return [];
    }
  }

  /** Get creator's history: how many tokens deployed, rug rate */
  private async getCreatorHistory(creator: string): Promise<{ tokens: number; rugRate: number }> {
    // Check cache
    const cached = this.creatorCache.get(creator);
    if (cached && Date.now() - cached.checkedAt < SniperDetector.CREATOR_CACHE_TTL) {
      return { tokens: cached.tokens, rugRate: cached.rugRate };
    }

    // Check DB for past tokens by this creator
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM token_scans WHERE creator = ?`
      ).get(creator) as { count: number } | undefined;

      const safeRow = db.prepare(
        `SELECT COUNT(*) as count FROM safety_checks sc
         JOIN token_scans ts ON sc.mint = ts.mint
         WHERE ts.creator = ? AND sc.safe = 0`
      ).get(creator) as { count: number } | undefined;

      const total = row?.count ?? 0;
      const rugged = safeRow?.count ?? 0;
      const rugRate = total > 0 ? (rugged / total) * 100 : 0;

      const result = { tokens: total, rugRate };

      // Cache
      if (this.creatorCache.size >= SniperDetector.MAX_CREATOR_CACHE) {
        const oldest = [...this.creatorCache.entries()]
          .sort((a, b) => a[1].checkedAt - b[1].checkedAt)[0];
        if (oldest) this.creatorCache.delete(oldest[0]);
      }
      this.creatorCache.set(creator, { ...result, checkedAt: Date.now() });

      return result;
    } catch {
      return { tokens: 0, rugRate: 0 };
    }
  }

  private persistSafetyCheck(report: SafetyReport): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO safety_checks
        (mint, symbol, mint_authority_revoked, freeze_authority_revoked, bundled_launch,
         sniper_count, creator_holding_pct, top_holder_concentration, creator_previous_tokens,
         creator_rug_rate, sellable, rugcheck_risk, rugcheck_score, safe, risk_flags, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.mint, report.symbol,
        report.mintAuthorityRevoked ? 1 : 0,
        report.freezeAuthorityRevoked ? 1 : 0,
        report.bundledLaunch ? 1 : 0,
        report.sniperCount, report.creatorHoldingPct, report.topHolderConcentration,
        report.creatorPreviousTokens, report.creatorRugRate,
        report.sellable ? 1 : 0,
        report.rugCheckRisk, report.rugCheckScore,
        report.safe ? 1 : 0,
        JSON.stringify(report.riskFlags),
        report.checkedAt,
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist safety check`, err);
    }
  }

  /** Simple rate limiter */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCall;
    if (elapsed < SniperDetector.API_DELAY) {
      await new Promise(r => setTimeout(r, SniperDetector.API_DELAY - elapsed));
    }
    this.lastApiCall = Date.now();
  }
}


