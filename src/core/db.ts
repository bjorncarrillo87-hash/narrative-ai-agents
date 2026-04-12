// ── Narrative AI — SQLite Database ──────────────────────

import Database from 'better-sqlite3';
import path from 'path';
import { log } from './logger.js';

const DB_PATH = path.resolve(process.cwd(), 'narrative-ai.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
    log.info('[DB] Database initialized', DB_PATH);
  }
  return db;
}

function initTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS narratives (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      confidence REAL NOT NULL,
      sentiment REAL NOT NULL,
      sources TEXT NOT NULL,        -- JSON
      top_tokens TEXT NOT NULL,     -- JSON
      detected_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      narrative_id TEXT,
      action TEXT NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (narrative_id) REFERENCES narratives(id)
    );

    CREATE TABLE IF NOT EXISTS whale_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      token TEXT NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      amount REAL NOT NULL,
      usd_value REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      narratives_detected INTEGER,
      top_narrative TEXT,
      signals_generated INTEGER,
      alerts_sent INTEGER,
      uptime REAL,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_narratives_topic ON narratives(topic);
    CREATE INDEX IF NOT EXISTS idx_narratives_detected ON narratives(detected_at);
    CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_whale_timestamp ON whale_alerts(timestamp);

    -- ── Phase 1: New token pipeline tables ──

    CREATE TABLE IF NOT EXISTS token_scans (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      market_cap_sol REAL,
      market_cap_usd REAL,
      liquidity_usd REAL,
      volume_24h REAL,
      price_usd REAL,
      holder_count INTEGER DEFAULT 0,
      bonding_curve_progress REAL DEFAULT 0,
      overall_score REAL DEFAULT 0,
      safety_score REAL DEFAULT 0,
      momentum_score REAL DEFAULT 0,
      social_score REAL DEFAULT 0,
      source TEXT NOT NULL,
      alerted INTEGER DEFAULT 0,
      detected_at INTEGER NOT NULL,
      scored_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS safety_checks (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      mint_authority_revoked INTEGER NOT NULL,
      freeze_authority_revoked INTEGER NOT NULL,
      bundled_launch INTEGER NOT NULL,
      sniper_count INTEGER DEFAULT 0,
      creator_holding_pct REAL DEFAULT 0,
      top_holder_concentration REAL DEFAULT 0,
      creator_previous_tokens INTEGER DEFAULT 0,
      creator_rug_rate REAL DEFAULT 0,
      sellable INTEGER DEFAULT 1,
      rugcheck_risk TEXT DEFAULT 'unknown',
      rugcheck_score REAL DEFAULT 0,
      safe INTEGER NOT NULL,
      risk_flags TEXT,
      checked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS smart_money_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      label TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      signature TEXT NOT NULL UNIQUE,
      wallet_pnl REAL DEFAULT 0,
      wallet_win_rate REAL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS smart_wallets (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      total_pnl_sol REAL DEFAULT 0,
      avg_trade_sol REAL DEFAULT 0,
      last_seen INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'discovered',
      active INTEGER DEFAULT 1,
      discovered_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_token_scans_score ON token_scans(overall_score);
    CREATE INDEX IF NOT EXISTS idx_token_scans_detected ON token_scans(detected_at);
    CREATE INDEX IF NOT EXISTS idx_token_scans_creator ON token_scans(creator);
    CREATE INDEX IF NOT EXISTS idx_token_scans_alerted ON token_scans(alerted);
    CREATE INDEX IF NOT EXISTS idx_safety_checks_safe ON safety_checks(safe);
    CREATE INDEX IF NOT EXISTS idx_safety_checks_mint ON safety_checks(mint);
    CREATE INDEX IF NOT EXISTS idx_smart_money_mint ON smart_money_trades(mint);
    CREATE INDEX IF NOT EXISTS idx_smart_money_wallet ON smart_money_trades(wallet);
    CREATE INDEX IF NOT EXISTS idx_smart_money_timestamp ON smart_money_trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_smart_wallets_active ON smart_wallets(active);
    CREATE INDEX IF NOT EXISTS idx_smart_wallets_winrate ON smart_wallets(win_rate);
    CREATE INDEX IF NOT EXISTS idx_smart_wallets_pnl ON smart_wallets(total_pnl_sol);

    -- ── Emotion Radar snapshots ──

    CREATE TABLE IF NOT EXISTS emotion_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT,                    -- NULL for market mood entries
      symbol TEXT,
      emotion_label TEXT NOT NULL,
      fomo_score REAL DEFAULT 0,
      panic_score REAL DEFAULT 0,
      greed_score REAL DEFAULT 0,
      emotion_score REAL DEFAULT 0,
      market_mood_score REAL,       -- only for mood snapshots
      hour_of_day INTEGER,
      is_weekend INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emotion_ts ON emotion_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_emotion_mint ON emotion_snapshots(mint);

    -- ── Token Performance Tracking (hit rate analysis) ──

    CREATE TABLE IF NOT EXISTS token_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      pair_address TEXT,
      dex TEXT,                        -- e.g. 'raydium', 'pump.fun'
      alert_type TEXT NOT NULL,        -- 'pumpfun','sniper','smart_money','graduation','narrative'
      alert_score REAL,                -- overall score at time of alert
      safety_score REAL,
      momentum_score REAL,
      social_score REAL,
      alert_price REAL,                -- price USD at alert time
      alert_mc REAL,                   -- market cap at alert time
      alert_time INTEGER NOT NULL,     -- unix ms when we alerted
      peak_price REAL,                 -- highest price after alert
      peak_mc REAL,                    -- highest market cap after alert
      peak_time INTEGER,               -- when peak occurred
      current_price REAL,              -- latest checked price
      current_mc REAL,                 -- latest checked market cap
      price_change_pct REAL,           -- % change from alert to peak
      volume_24h REAL,
      liquidity_usd REAL,
      txns_24h INTEGER,
      hit INTEGER NOT NULL DEFAULT 0,  -- 1 = pumped 2x+, 0 = miss
      outcome TEXT,                    -- 'runner','moderate','flat','dump'
      notes TEXT,
      checked_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_perf_mint ON token_performance(mint);
    CREATE INDEX IF NOT EXISTS idx_perf_symbol ON token_performance(symbol);
    CREATE INDEX IF NOT EXISTS idx_perf_hit ON token_performance(hit);
    CREATE INDEX IF NOT EXISTS idx_perf_alert_time ON token_performance(alert_time);

    -- ── Paper Trading (scalping bot Phase 1) ──

    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,              -- 'scored' or 'trending'
      score REAL NOT NULL,
      entry_price REAL NOT NULL,
      entry_mc REAL,
      exit_price REAL,
      size_sol REAL NOT NULL,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER,
      exit_reason TEXT,                  -- 'tp', 'sl', 'timeout', 'shutdown'
      pnl_pct REAL,
      pnl_sol REAL,
      highest_price REAL,
      lowest_price REAL,
      status TEXT NOT NULL DEFAULT 'open', -- 'open' or 'closed'
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_paper_mint ON paper_trades(mint);
    CREATE INDEX IF NOT EXISTS idx_paper_status ON paper_trades(status);
    CREATE INDEX IF NOT EXISTS idx_paper_entry ON paper_trades(entry_time);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    log.info('[DB] Database closed');
  }
}

