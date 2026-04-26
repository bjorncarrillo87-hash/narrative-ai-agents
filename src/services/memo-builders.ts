/**
 * Narrative AI — Memo Format Builders for Solana SPL Memo Timestamps
 *
 * Builds pipe-delimited memo strings for ENTRY and EXIT trade events.
 * All output is ASCII-only to avoid multi-byte UTF-8 issues.
 * Max 566 bytes per SPL Memo instruction.
 */

const MEMO_VERSION = 'v1';
const MEMO_PREFIX = 'NAI';
const MAX_MEMO_BYTES = 566;

/**
 * Generate ISO 8601 compact UTC timestamp: 20260405T081900Z
 */
export function formatTimestamp(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/**
 * Truncate contract address to first 8 + "..." + last 4 chars.
 * Uses ASCII ellipsis (3 dots) to avoid multi-byte UTF-8 issues.
 */
export function truncateCA(ca: string): string {
  if (ca.length <= 16) return ca;
  return `${ca.slice(0, 8)}...${ca.slice(-4)}`;
}

/**
 * Generate a human-readable trade ID.
 * Format: {AgentInitial}-{SYMBOL}-{MMDD}-{HHmm}
 * Example: A-BUNNY-0405-0819
 */
export function generateTradeId(agent: string, token: string, date: Date = new Date()): string {
  const initial = agent.length > 0 ? agent.charAt(0).toUpperCase() : 'X';
  // Strip non-ASCII and cap at 8 chars for consistent byte length
  const symbol = token.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${initial}-${symbol || 'UNK'}-${mo}${d}-${h}${mi}`;
}

/**
 * Build ENTRY memo string.
 * Format: NAI|v1|ENTRY|{agent}|{symbol}|{ca}|BUY|{price}|{size}|{score}|{strategy}|{ts}|{tradeId}
 */
export function buildEntryMemo(
  agent: string,
  tokenSymbol: string,
  tokenCA: string,
  entryPriceUsd: number,
  sizeSol: number,
  score: number,
  strategy: string,
  tradeId: string,
  timestamp?: Date,
): string {
  const ts = formatTimestamp(timestamp);
  const ca = truncateCA(tokenCA);
  const parts = [
    MEMO_PREFIX,
    MEMO_VERSION,
    'ENTRY',
    agent,
    tokenSymbol,
    ca,
    'BUY',
    formatPrice(entryPriceUsd),
    String(sizeSol),
    String(Math.round(score)),
    strategy,
    ts,
    tradeId,
  ];

  let memo = parts.join('|');

  // Final safety: hard truncate to byte limit (ASCII-safe since all fields are ASCII)
  if (memo.length > MAX_MEMO_BYTES) {
    memo = memo.slice(0, MAX_MEMO_BYTES);
  }

  return memo;
}

/**
 * Build EXIT memo string.
 * Format: NAI|v1|EXIT|{agent}|{symbol}|{ca}|SELL|{exitPrice}|{pnlPct}|{pnlSol}|{ts}|{tradeId}
 */
export function buildExitMemo(
  agent: string,
  tokenSymbol: string,
  tokenCA: string,
  exitPriceUsd: number,
  pnlPct: number,
  pnlSol: number,
  tradeId: string,
  timestamp?: Date,
): string {
  const ts = formatTimestamp(timestamp);
  const pnlPctStr = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1);
  const pnlSolStr = (pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(2);
  const ca = truncateCA(tokenCA);

  const parts = [
    MEMO_PREFIX,
    MEMO_VERSION,
    'EXIT',
    agent,
    tokenSymbol,
    ca,
    'SELL',
    formatPrice(exitPriceUsd),
    pnlPctStr,
    pnlSolStr,
    ts,
    tradeId,
  ];

  let memo = parts.join('|');

  if (memo.length > MAX_MEMO_BYTES) {
    memo = memo.slice(0, MAX_MEMO_BYTES);
  }

  return memo;
}

// ── Helpers ──

function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price === 0) return '0';
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(6);
  // For micro-cap tokens: fixed decimal notation, never scientific
  const str = price.toFixed(10);
  // Trim trailing zeros but keep at least 2 significant digits
  return str.replace(/0+$/, '').replace(/\.$/, '.0');
}


