// ── Token Performance Tracker ────────────────────────────
// Records and queries token outcomes to measure hit rate.
// Works with the Phase 1 pipeline (ScoredToken) and legacy signals.

import { getDb } from './db.js';
import { log } from './logger.js';
import type { TokenPerformance, ScoredToken } from './types.js';

/** Insert a new token performance record */
export function recordPerformance(tp: TokenPerformance): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO token_performance (
      mint, symbol, pair_address, dex, alert_type,
      alert_score, safety_score, momentum_score, social_score,
      alert_price, alert_mc, alert_time,
      peak_price, peak_mc, peak_time,
      current_price, current_mc, price_change_pct,
      volume_24h, liquidity_usd, txns_24h,
      hit, outcome, notes, checked_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  const result = stmt.run(
    tp.mint, tp.symbol, tp.pairAddress ?? null, tp.dex ?? null, tp.alertType,
    tp.alertScore ?? null, tp.safetyScore ?? null, tp.momentumScore ?? null, tp.socialScore ?? null,
    tp.alertPrice ?? null, tp.alertMc ?? null, tp.alertTime,
    tp.peakPrice ?? null, tp.peakMc ?? null, tp.peakTime ?? null,
    tp.currentPrice ?? null, tp.currentMc ?? null, tp.priceChangePct ?? null,
    tp.volume24h ?? null, tp.liquidityUsd ?? null, tp.txns24h ?? null,
    tp.hit ? 1 : 0, tp.outcome ?? null, tp.notes ?? null, tp.checkedAt ?? null,
  );

  log.info(`[Performance] Recorded ${tp.symbol} (${tp.mint.slice(0, 8)}...) — ${tp.hit ? 'HIT' : 'MISS'} ${tp.outcome ?? ''}`);
  return result.lastInsertRowid as number;
}

/** Auto-record from a ScoredToken event (called when alert fires) */
export function recordFromScoredToken(token: ScoredToken): number {
  return recordPerformance({
    mint: token.mint,
    symbol: token.symbol,
    alertType: token.source,
    alertScore: token.overallScore,
    safetyScore: token.safetyScore,
    momentumScore: token.momentumScore,
    socialScore: token.socialScore,
    alertPrice: token.priceUSD,
    alertMc: token.marketCapUSD,
    alertTime: token.timestamp,
    hit: false,  // default — updated later when we check outcome
    outcome: 'flat',
  });
}

/** Update an existing record with new price data */
export function updatePerformance(id: number, updates: Partial<TokenPerformance>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    peakPrice: 'peak_price', peakMc: 'peak_mc', peakTime: 'peak_time',
    currentPrice: 'current_price', currentMc: 'current_mc',
    priceChangePct: 'price_change_pct', volume24h: 'volume_24h',
    liquidityUsd: 'liquidity_usd', txns24h: 'txns_24h',
    hit: 'hit', outcome: 'outcome', notes: 'notes', checkedAt: 'checked_at',
    pairAddress: 'pair_address', dex: 'dex',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (key in updates) {
      fields.push(`${col} = ?`);
      values.push(key === 'hit' ? ((updates as Record<string, unknown>)[key] ? 1 : 0) : (updates as Record<string, unknown>)[key]);
    }
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE token_performance SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  log.info(`[Performance] Updated record #${id}`);
}

/** Get hit rate stats */
export function getHitRate(): {
  total: number; hits: number; misses: number; hitRate: number;
  byType: Record<string, { total: number; hits: number; rate: number }>;
  byOutcome: Record<string, number>;
} {
  const db = getDb();

  const overall = db.prepare(
    `SELECT COUNT(*) as total, SUM(hit) as hits FROM token_performance`
  ).get() as { total: number; hits: number };

  const byType = db.prepare(
    `SELECT alert_type, COUNT(*) as total, SUM(hit) as hits FROM token_performance GROUP BY alert_type`
  ).all() as Array<{ alert_type: string; total: number; hits: number }>;

  const byOutcome = db.prepare(
    `SELECT outcome, COUNT(*) as count FROM token_performance WHERE outcome IS NOT NULL GROUP BY outcome`
  ).all() as Array<{ outcome: string; count: number }>;

  const typeStats: Record<string, { total: number; hits: number; rate: number }> = {};
  for (const row of byType) {
    typeStats[row.alert_type] = {
      total: row.total,
      hits: row.hits,
      rate: row.total > 0 ? Math.round((row.hits / row.total) * 100) : 0,
    };
  }

  const outcomeStats: Record<string, number> = {};
  for (const row of byOutcome) {
    outcomeStats[row.outcome] = row.count;
  }

  return {
    total: overall.total,
    hits: overall.hits ?? 0,
    misses: overall.total - (overall.hits ?? 0),
    hitRate: overall.total > 0 ? Math.round(((overall.hits ?? 0) / overall.total) * 100) : 0,
    byType: typeStats,
    byOutcome: outcomeStats,
  };
}

/** Get all records, optionally filtered */
export function getPerformanceRecords(filter?: { hit?: boolean; outcome?: string; limit?: number }): TokenPerformance[] {
  const db = getDb();
  let sql = 'SELECT * FROM token_performance';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.hit !== undefined) {
    conditions.push('hit = ?');
    params.push(filter.hit ? 1 : 0);
  }
  if (filter?.outcome) {
    conditions.push('outcome = ?');
    params.push(filter.outcome);
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY alert_time DESC';
  if (filter?.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as number,
    mint: row.mint as string,
    symbol: row.symbol as string,
    pairAddress: row.pair_address as string | undefined,
    dex: row.dex as string | undefined,
    alertType: row.alert_type as string,
    alertScore: row.alert_score as number | undefined,
    safetyScore: row.safety_score as number | undefined,
    momentumScore: row.momentum_score as number | undefined,
    socialScore: row.social_score as number | undefined,
    alertPrice: row.alert_price as number | undefined,
    alertMc: row.alert_mc as number | undefined,
    alertTime: row.alert_time as number,
    peakPrice: row.peak_price as number | undefined,
    peakMc: row.peak_mc as number | undefined,
    peakTime: row.peak_time as number | undefined,
    currentPrice: row.current_price as number | undefined,
    currentMc: row.current_mc as number | undefined,
    priceChangePct: row.price_change_pct as number | undefined,
    volume24h: row.volume_24h as number | undefined,
    liquidityUsd: row.liquidity_usd as number | undefined,
    txns24h: row.txns_24h as number | undefined,
    hit: !!(row.hit as number),
    outcome: row.outcome as TokenPerformance['outcome'],
    notes: row.notes as string | undefined,
    checkedAt: row.checked_at as number | undefined,
  }));
}

/** Get unchecked records that need outcome verification */
export function getUncheckedRecords(olderThanMs = 3600_000): TokenPerformance[] {
  const db = getDb();
  const cutoff = Date.now() - olderThanMs;
  const rows = db.prepare(
    `SELECT * FROM token_performance WHERE checked_at IS NULL AND alert_time < ? ORDER BY alert_time ASC`
  ).all(cutoff) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as number,
    mint: row.mint as string,
    symbol: row.symbol as string,
    alertType: row.alert_type as string,
    alertTime: row.alert_time as number,
    alertPrice: row.alert_price as number | undefined,
    alertMc: row.alert_mc as number | undefined,
    hit: !!(row.hit as number),
  }));
}

