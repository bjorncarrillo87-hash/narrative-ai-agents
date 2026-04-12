/**
 * Narrative AI — Solana SPL Memo Timestamp Service
 *
 * Sends trade memos on-chain as immutable, publicly verifiable proof
 * that trade signals were generated BEFORE outcomes were known.
 *
 * Design: fire-and-forget. Never throws — paper trades must never be
 * blocked by a failed memo transaction.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
} from '@solana/web3.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Dynamic imports for ESM-only packages (populated by init())
let _bs58Decode: (str: string) => Uint8Array;
let _createMemoInstruction: (memo: string, signerPubkeys?: PublicKey[]) => TransactionInstruction;

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const MEMO_LOG_FILE = 'memo-log.jsonl';

// Errors that should NOT be retried (permanent failures)
const NON_RETRIABLE = [
  'insufficient lamports',
  'insufficient funds',
  'invalid instruction',
  'unauthorized signer',
];

export class SolanaMemoService {
  private connection: Connection | null = null;
  private wallet: Keypair | null = null;
  private logPath: string;
  private initPromise: Promise<boolean> | null = null;

  constructor() {
    this.logPath = path.resolve(process.cwd(), MEMO_LOG_FILE);
  }

  /**
   * Check if the service is enabled. Read at call time (not constructor)
   * so dotenv has time to load.
   */
  private get enabled(): boolean {
    return process.env.MEMO_SERVICE_ENABLED === 'true';
  }

  /**
   * Lazy-initialize the connection and wallet on first use.
   * Uses a promise lock to prevent concurrent init races.
   */
  private init(): Promise<boolean> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<boolean> {
    try {
      // Dynamic imports for ESM-only packages
      const [splMemo, bs58Module] = await Promise.all([
        import('@solana/spl-memo'),
        import('bs58'),
      ]);
      _createMemoInstruction = splMemo.createMemoInstruction;
      _bs58Decode = bs58Module.default.decode;

      const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
      this.connection = new Connection(rpcUrl, 'confirmed' as Commitment);

      const privateKey = process.env.TIMESTAMP_WALLET_PRIVATE_KEY;
      if (!privateKey) {
        console.error('[MemoService] ERROR: TIMESTAMP_WALLET_PRIVATE_KEY not set');
        return false;
      }

      this.wallet = Keypair.fromSecretKey(_bs58Decode(privateKey));
      console.log(`[MemoService] Initialized — wallet: ${this.wallet.publicKey.toBase58()}`);
      console.log(`[MemoService] RPC: ${rpcUrl}`);
      return true;
    } catch (err) {
      console.error('[MemoService] ERROR: Failed to initialize', err);
      return false;
    }
  }

  /**
   * Send a trade memo on-chain via SPL Memo instruction.
   *
   * Returns the transaction signature on success, empty string on failure,
   * or 'disabled' if the service is turned off.
   *
   * NEVER throws — paper trading must not be blocked by memo failures.
   */
  async sendTradeMemo(memo: string): Promise<string> {
    if (!this.enabled) {
      return 'disabled';
    }

    const ready = await this.init();
    if (!ready || !this.connection || !this.wallet) {
      this.logLocally(memo, '', 'ERROR', 'Service not initialized');
      return '';
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Pass wallet.publicKey (not wallet) — spl-memo expects PublicKey[]
        const instruction = _createMemoInstruction(memo, [this.wallet.publicKey]);
        const tx = new Transaction().add(instruction);

        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          [this.wallet],
          { commitment: 'confirmed' },
        );

        console.log(`[MemoService] TX confirmed: ${signature}`);
        console.log(`[MemoService] Memo: ${memo}`);
        this.logLocally(memo, signature, 'OK');
        return signature;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errLower = errMsg.toLowerCase();

        // Don't retry permanent failures
        if (NON_RETRIABLE.some(e => errLower.includes(e))) {
          console.error(`[MemoService] ERROR: Non-retriable failure: ${errMsg}`);
          this.logLocally(memo, '', 'ERROR', errMsg);
          return '';
        }

        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAYS_MS[attempt];
          console.warn(`[MemoService] Attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delay}ms: ${errMsg}`);
          await sleep(delay);
        } else {
          console.error(`[MemoService] ERROR: All ${MAX_RETRIES} attempts failed: ${errMsg}`);
          this.logLocally(memo, '', 'ERROR', errMsg);
          return '';
        }
      }
    }

    return ''; // unreachable but satisfies TypeScript
  }

  /**
   * Append memo event to local JSONL log file for audit purposes.
   */
  private logLocally(memo: string, txSig: string, status: string, error?: string): void {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        memo,
        txSignature: txSig || null,
        status,
        error: error || null,
      };
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Logging should never crash the service
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lazy singleton — reads env at call time, not import time
let _instance: SolanaMemoService | null = null;
export function getMemoService(): SolanaMemoService {
  if (!_instance) {
    _instance = new SolanaMemoService();
  }
  return _instance;
}


