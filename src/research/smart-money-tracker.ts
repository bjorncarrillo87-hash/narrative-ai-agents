// ── Smart Money Tracker ────────────────────────────────
// Monitors known profitable wallets on Solana in real-time.
// When a smart money wallet buys a new meme coin, emit a signal
// that boosts that token's social score in the Token Analyzer.
// Uses Helius enhanced transactions API for wallet monitoring.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import { getDb } from '../core/db.js';
import { SmartMoneyDiscovery } from './smart-money-discovery.js';
import type { Agent, AgentMeta, SmartMoneyTrade } from '../core/types.js';

// Helius enhanced transaction
interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  description: string;
  feePayer: string;
  tokenTransfers: Array<{
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    tokenStandard: string;
  }>;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

interface TrackedWallet {
  address: string;
  label: string;
  lastSignature?: string;
  pnl?: number;
  winRate?: number;
}

// Known DEX program addresses (to identify swaps)
const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter v6
]);

// SOL mint for identifying SOL transfers
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Tokens to ignore (stablecoins, wrapped SOL, major tokens)
const IGNORE_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
]);

export class SmartMoneyTracker implements Agent {
  meta: AgentMeta = {
    name: 'Smart Money Tracker',
    squad: 'research',
    version: '1.0.0',
  };

  private wallets: TrackedWallet[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Dedup: prevent alerting same wallet+mint within 1 hour
  private recentTrades: Map<string, number> = new Map();
  private static readonly DEDUP_COOLDOWN = 60 * 60_000; // 1 hour
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private walletRefreshInterval: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    this.running = true;

    if (!config.heliusApiKey) {
      log.warn(`[${this.meta.name}] No HELIUS_API_KEY — smart money tracking disabled`);
      log.info(`[${this.meta.name}] Set HELIUS_API_KEY and SMART_MONEY_WALLETS in .env to enable`);
      return;
    }

    // Load wallets: DB first (auto-discovered), then env var fallback
    this.loadWallets();

    if (this.wallets.length === 0) {
      log.warn(`[${this.meta.name}] No wallets yet — Discovery agent will populate over time`);
      log.info(`[${this.meta.name}] Or set SMART_MONEY_WALLETS=Label1:address1,Label2:address2 in .env`);
    } else {
      log.info(`[${this.meta.name}] Tracking ${this.wallets.length} smart money wallets`);
      // Initial scan to set baseline signatures
      await this.initialScan();
    }

    // Poll for new trades (scan() checks wallet count internally)
    this.interval = setInterval(() => this.scan(), config.intervals.smartMoneyScan);

    // Periodic dedup cleanup
    this.cleanupInterval = setInterval(() => this.cleanupDedup(), 5 * 60_000);

    // Refresh wallet list from DB every 10 minutes (picks up newly discovered wallets)
    this.walletRefreshInterval = setInterval(() => this.refreshWallets(), 10 * 60_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.walletRefreshInterval) clearInterval(this.walletRefreshInterval);
    this.recentTrades.clear();
    log.info(`[${this.meta.name}] Stopped`);
  }

  /** Load wallets from DB (auto-discovered) + env var, deduped */
  private loadWallets(): void {
    // Get auto-discovered wallets from DB
    const dbWallets = SmartMoneyDiscovery.getActiveWallets();

    // Merge with env var wallets (env wallets always included)
    const envWallets = config.smartMoney.wallets;
    const walletMap = new Map<string, TrackedWallet>();

    // DB wallets first
    for (const w of dbWallets) {
      const existing = this.wallets.find(tw => tw.address === w.address);
      walletMap.set(w.address, {
        address: w.address,
        label: w.label,
        lastSignature: existing?.lastSignature, // preserve scan state
        pnl: w.pnl,
        winRate: w.winRate,
      });
    }

    // Env wallets override labels
    for (const w of envWallets) {
      const existing = walletMap.get(w.address) || this.wallets.find(tw => tw.address === w.address);
      walletMap.set(w.address, {
        address: w.address,
        label: w.label,
        lastSignature: existing?.lastSignature,
        pnl: existing?.pnl,
        winRate: existing?.winRate,
      });
    }

    const oldCount = this.wallets.length;
    this.wallets = Array.from(walletMap.values());

    if (this.wallets.length !== oldCount && oldCount > 0) {
      log.info(`[${this.meta.name}] Wallet list refreshed: ${oldCount} → ${this.wallets.length}`);
    }
  }

  /** Refresh wallets from DB and initialize any new ones */
  private async refreshWallets(): Promise<void> {
    const oldAddresses = new Set(this.wallets.map(w => w.address));
    this.loadWallets();

    // Find newly added wallets (no lastSignature yet)
    const newWallets = this.wallets.filter(w => !oldAddresses.has(w.address) && !w.lastSignature);
    if (newWallets.length > 0) {
      log.info(`[${this.meta.name}] ${newWallets.length} new wallets discovered — setting baseline`);
      for (const wallet of newWallets) {
        try {
          const txns = await this.fetchWalletTxns(wallet.address, 1);
          if (txns.length > 0) wallet.lastSignature = txns[0].signature;
        } catch { /* continue */ }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  /** First scan — just record latest signatures without emitting signals */
  private async initialScan(): Promise<void> {
    for (const wallet of this.wallets) {
      try {
        const txns = await this.fetchWalletTxns(wallet.address, 1);
        if (txns.length > 0) {
          wallet.lastSignature = txns[0].signature;
        }
      } catch {
        // Continue with other wallets
      }
      // Small delay between wallets to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
    log.info(`[${this.meta.name}] Initial scan complete — baseline signatures set`);
  }

  /** Main scan loop — check each wallet for new swap transactions */
  private async scan(): Promise<void> {
    if (!this.running || this.wallets.length === 0) return;

    for (const wallet of this.wallets) {
      if (!this.running) break;

      try {
        const txns = await this.fetchWalletTxns(wallet.address, 5);
        const newTxns = this.filterNewTxns(wallet, txns);

        for (const tx of newTxns) {
          this.analyzeTrade(tx, wallet);
        }
      } catch (err) {
        log.debug(`[${this.meta.name}] Error scanning ${wallet.label}`);
      }

      // Rate limit between wallets
      await new Promise(r => setTimeout(r, 250));
    }
  }

  private async fetchWalletTxns(address: string, limit: number): Promise<HeliusEnhancedTx[]> {
    try {
      const resp = await axios.get<HeliusEnhancedTx[]>(
        `https://api.helius.xyz/v0/addresses/${address}/transactions`, {
          params: {
            'api-key': config.heliusApiKey,
            limit,
            type: 'SWAP',
          },
          timeout: 10000,
        },
      );
      return resp.data || [];
    } catch {
      return [];
    }
  }

  private filterNewTxns(wallet: TrackedWallet, txns: HeliusEnhancedTx[]): HeliusEnhancedTx[] {
    if (!wallet.lastSignature) {
      if (txns.length > 0) wallet.lastSignature = txns[0].signature;
      return [];
    }

    const newTxns: HeliusEnhancedTx[] = [];
    let foundLastSeen = false;
    for (const tx of txns) {
      if (tx.signature === wallet.lastSignature) {
        foundLastSeen = true;
        break;
      }
      newTxns.push(tx);
    }

    if (!foundLastSeen && txns.length > 0) {
      // Last known signature not in results — may have missed transactions
      log.warn(
        `[${this.meta.name}] ${wallet.label}: last signature not found in latest txns — ` +
        `possible gap (${newTxns.length} new txns)`
      );
    }

    if (newTxns.length > 0) {
      wallet.lastSignature = newTxns[0].signature;
    }

    return newTxns;
  }

  private analyzeTrade(tx: HeliusEnhancedTx, wallet: TrackedWallet): void {
    if (!tx.tokenTransfers?.length) return;

    // Determine trade direction from native SOL transfers:
    // If wallet SENT SOL out → they bought tokens (SOL leaves wallet)
    // If wallet RECEIVED SOL in → they sold tokens (SOL enters wallet)
    let solSent = 0;
    let solReceived = 0;
    if (tx.nativeTransfers) {
      for (const nt of tx.nativeTransfers) {
        if (nt.fromUserAccount === wallet.address) {
          solSent += nt.amount / 1e9; // lamports to SOL
        }
        if (nt.toUserAccount === wallet.address) {
          solReceived += nt.amount / 1e9;
        }
      }
    }

    // Net SOL flow determines direction: negative = bought tokens, positive = sold tokens
    const netSOL = solReceived - solSent;
    const isBuy = netSOL < 0; // wallet lost SOL → bought tokens
    const action = isBuy ? 'buy' : 'sell';
    const amountSOL = Math.abs(netSOL);

    // Skip tiny trades
    if (amountSOL < config.smartMoney.minTradeSOL) return;

    // Find the non-SOL token mint involved in the swap
    const tradedMint = tx.tokenTransfers.find(t => !IGNORE_MINTS.has(t.mint))?.mint;
    if (!tradedMint) return; // No relevant token transfer found

    // Dedup check
    const dedupKey = `${wallet.address}-${tradedMint}-${action}`;
    const lastTrade = this.recentTrades.get(dedupKey);
    if (lastTrade && Date.now() - lastTrade < SmartMoneyTracker.DEDUP_COOLDOWN) return;
    this.recentTrades.set(dedupKey, Date.now());

    // Use truncated mint as placeholder — will be enriched by Token Analyzer via DexScreener
    // Helius descriptions contain generic words (SWAP, SOL, UNKNOWN) so regex is unreliable
    const symbol = `${tradedMint.slice(0, 6)}`;

    const trade: SmartMoneyTrade = {
      wallet: wallet.address,
      label: wallet.label,
      mint: tradedMint,
      symbol,
      action,
      amountSOL,
      signature: tx.signature,
      walletPnl: wallet.pnl ?? 0,
      walletWinRate: wallet.winRate ?? 0,
      timestamp: Date.now(),
    };

    // Persist
    this.persistTrade(trade);

    // Emit signal — Token Analyzer will pick this up
    bus.emit('smart_money:trade', trade);

    // Ops alert for significant buys
    if (isBuy && amountSOL >= 5) {
      bus.emit('ops:alert', {
        level: 'info',
        message: `Smart Money: ${wallet.label} bought ${tradedMint.slice(0, 8)}... for ${amountSOL.toFixed(1)} SOL`,
      });
    }

    log.info(
      `[${this.meta.name}] ${wallet.label} ${action.toUpperCase()} — ` +
      `${tradedMint.slice(0, 8)}... for ${amountSOL.toFixed(2)} SOL ` +
      `(sig: ${tx.signature.slice(0, 12)}...)`
    );
  }

  private persistTrade(trade: SmartMoneyTrade): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO smart_money_trades
        (wallet, label, mint, symbol, action, amount_sol, signature, wallet_pnl, wallet_win_rate, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trade.wallet, trade.label, trade.mint, trade.symbol,
        trade.action, trade.amountSOL, trade.signature,
        trade.walletPnl, trade.walletWinRate, trade.timestamp,
      );
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist trade`, err);
    }
  }

  private cleanupDedup(): void {
    const cutoff = Date.now() - SmartMoneyTracker.DEDUP_COOLDOWN;
    for (const [key, ts] of this.recentTrades) {
      if (ts < cutoff) this.recentTrades.delete(key);
    }
  }
}

