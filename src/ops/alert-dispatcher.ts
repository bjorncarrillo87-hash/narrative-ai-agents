// ── Alert Dispatcher ────────────────────────────────────
// Multi-tenant alert routing. Each customer gets their own Telegram alerts
// based on their subscription tier and squad access.

import axios from 'axios';
import { bus, log, config } from '../core/index.js';
import type { Agent, AgentMeta, Narrative, WhaleAlert, TradeSignal, GraduationStatus, ScoredToken, SmartMoneyTrade, MarketMood, TokenEmotionProfile } from '../core/types.js';
import type { TenantManager } from '../tenants/tenant-manager.js';

/** Escape HTML special chars for Telegram HTML parse mode */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Strip HTML tags for console logging */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

export class AlertDispatcher implements Agent {
  meta: AgentMeta = {
    name: 'Alert Dispatcher',
    squad: 'ops',
    version: '0.2.0',
  };

  private alertCount = 0;
  private tenantManager: TenantManager | null = null;
  private botToken: string = '';
  // Narrative dedup: track recently alerted topics
  private recentNarrativeTopics: Map<string, number> = new Map(); // topic -> timestamp
  private static readonly NARRATIVE_COOLDOWN = 6 * 3600_000; // 6 hours

  // Token alert rate limiting: prevent Telegram flooding
  private tokenAlertTimestamps: number[] = [];
  private static readonly MAX_TOKEN_ALERTS_PER_WINDOW = 6; // max 6 token alerts per window
  private static readonly TOKEN_ALERT_WINDOW = 5 * 60_000;  // per 5 minutes

  // Symbol dedup: same ticker from different creators within cooldown
  private recentSymbols: Map<string, number> = new Map(); // symbol -> timestamp
  private static readonly SYMBOL_COOLDOWN = 10 * 60_000;  // 10 min same-symbol cooldown

  // Store handler refs for cleanup
  private handlers = {
    narrative: (n: Narrative) => this.onNarrative(n),
    whale: (a: WhaleAlert) => this.onWhaleAlert(a),
    trade: (s: TradeSignal) => this.onTradeSignal(s),
    graduation: (g: GraduationStatus) => this.onGraduation(g),
    risk: (r: { rule: string; details: string }) => this.onRiskBreach(r),
    ops: (a: { level: 'info' | 'warn' | 'critical'; message: string; data?: unknown }) => this.onGenericAlert(a),
    scored: (t: ScoredToken) => this.onScoredToken(t),
    smartMoney: (t: SmartMoneyTrade) => this.onSmartMoneyTrade(t),
    mood: (m: MarketMood) => this.onMoodShift(m),
    emotionToken: (p: TokenEmotionProfile) => {
      this.emotionCache.set(p.mint, p);
      if (this.emotionCache.size > 300) {
        const oldest = this.emotionCache.keys().next().value;
        if (oldest) this.emotionCache.delete(oldest);
      }
    },
  };

  // Track last mood to detect shifts
  private lastMoodLabel: MarketMood['overall'] | null = null;
  // Track emotion profiles for embedding in scored token alerts
  private emotionCache: Map<string, TokenEmotionProfile> = new Map();

  /** Inject tenant manager for multi-tenant routing */
  setTenantManager(manager: TenantManager): void {
    this.tenantManager = manager;
    log.info(`[${this.meta.name}] Multi-tenant routing enabled`);
  }

  async start(): Promise<void> {
    this.botToken = config.telegram.botToken;

    if (!this.botToken) {
      log.warn(`[${this.meta.name}] Telegram bot token not set — alerts will be console-only`);
    }

    const mode = this.tenantManager ? 'multi-tenant' : 'single-tenant';
    log.info(`[${this.meta.name}] Starting in ${mode} mode`);

    // Announce online — console only
    await this.broadcast('🟢 <b>Narrative AI Agents ONLINE</b>\n\nYour subscribed squads are now active.', 'ops', true);

    // Subscribe to all events
    bus.on('narrative:detected', this.handlers.narrative);
    bus.on('whale:alert', this.handlers.whale);
    bus.on('trade:signal', this.handlers.trade);
    bus.on('graduation:update', this.handlers.graduation);
    bus.on('risk:breach', this.handlers.risk);
    bus.on('ops:alert', this.handlers.ops);
    bus.on('token:scored', this.handlers.scored);
    bus.on('smart_money:trade', this.handlers.smartMoney);
    bus.on('emotion:mood', this.handlers.mood);
    bus.on('emotion:token', this.handlers.emotionToken);

    log.info(`[${this.meta.name}] Listening on all event channels`);
  }

  async stop(): Promise<void> {
    bus.off('narrative:detected', this.handlers.narrative);
    bus.off('whale:alert', this.handlers.whale);
    bus.off('trade:signal', this.handlers.trade);
    bus.off('graduation:update', this.handlers.graduation);
    bus.off('risk:breach', this.handlers.risk);
    bus.off('ops:alert', this.handlers.ops);
    bus.off('token:scored', this.handlers.scored);
    bus.off('smart_money:trade', this.handlers.smartMoney);
    bus.off('emotion:mood', this.handlers.mood);
    bus.off('emotion:token', this.handlers.emotionToken);

    await this.broadcast(
      `🔴 <b>Narrative AI Agents OFFLINE</b>\n\nAlerts sent this session: ${this.alertCount}`,
      'ops',
      true, // console only
    );
    log.info(`[${this.meta.name}] Stopped — ${this.alertCount} alerts sent`);
  }

  // ── Event handlers ────────────────────────────────────────

  private async onNarrative(narrative: Narrative): Promise<void> {
    // Dedup: don't re-alert same topic within cooldown
    const lastAlert = this.recentNarrativeTopics.get(narrative.topic);
    if (lastAlert && Date.now() - lastAlert < AlertDispatcher.NARRATIVE_COOLDOWN) {
      return; // silently skip duplicate
    }
    this.recentNarrativeTopics.set(narrative.topic, Date.now());

    // Clean old entries
    if (this.recentNarrativeTopics.size > 50) {
      const cutoff = Date.now() - AlertDispatcher.NARRATIVE_COOLDOWN;
      for (const [topic, ts] of this.recentNarrativeTopics) {
        if (ts < cutoff) this.recentNarrativeTopics.delete(topic);
      }
    }

    const tokens = (narrative.topTokens || [])
      .slice(0, 3)
      .map(t => {
        const sym = esc(t.symbol);
        const mc = t.marketCap > 0 ? `MC: $${t.marketCap.toLocaleString()}` : '';
        const price = t.price > 0 ? `$${t.price.toPrecision(4)}` : '';
        const vol = t.volume24h > 0 ? `Vol: $${t.volume24h.toLocaleString()}` : '';
        const score = `Score: ${t.score}/100`;
        const trade = t.mint
          ? `\n  🔗 <a href="https://trade.padre.gg/${t.mint}">Trade $${sym} on Padre</a>`
          : '';
        const details = [price, mc, vol, score].filter(Boolean).join(' | ');
        return `• <b>$${sym}</b>\n  ${details}\n  <code>${t.mint}</code>${trade}`;
      })
      .join('\n\n');

    const emoji = narrative.confidence >= 80 ? '🔥🔥' : narrative.confidence >= 60 ? '🔥' : '📊';
    const topic = esc(narrative.topic);

    const msg = [
      `${emoji} <b>NARRATIVE SPIKE: ${topic}</b>`,
      '',
      `Confidence: <b>${narrative.confidence}%</b>`,
      `Sentiment: ${this.sentimentBar(narrative.sentiment)}  (${narrative.sentiment})`,
      `Sources: ${narrative.sources.map(s => s.platform).join(', ')}`,
      '',
      tokens ? `<b>Top tokens:</b>\n${tokens}` : '<i>No specific tokens detected</i>',
      '',
      `⏱ Expires: ${new Date(narrative.expiresAt).toLocaleTimeString()}`,
    ].join('\n');

    // Console only — Telegram reserved for trade signals
    await this.broadcast(msg, 'research', true);
  }

  private async onWhaleAlert(alert: WhaleAlert): Promise<void> {
    const emoji = alert.action === 'buy' ? '🟢' : '🔴';
    const sym = esc(alert.symbol);
    const trade = alert.token && !alert.token.startsWith('demo_')
      ? `\n<a href="https://trade.padre.gg/${alert.token}">Trade on Padre</a>`
      : '';
    const msg = [
      `🐋 <b>WHALE ${alert.action.toUpperCase()}</b>`,
      '',
      `${emoji} $${sym}`,
      `Amount: ${alert.amount.toLocaleString()} tokens`,
      `Value: $${alert.usdValue.toLocaleString()}`,
      `Wallet: <code>${alert.wallet.slice(0, 8)}...${alert.wallet.slice(-4)}</code>`,
      trade,
    ].filter(Boolean).join('\n');

    await this.broadcast(msg, 'research', true); // console only
  }

  private async onTradeSignal(signal: TradeSignal): Promise<void> {
    const emoji = signal.action === 'buy' ? '🟢' : '🔴';
    const sym = esc(signal.token.symbol);
    const trade = signal.token.mint
      ? `\n<a href="https://trade.padre.gg/${signal.token.mint}">Trade on Padre</a>`
      : '';
    const msg = [
      `🎯 <b>TRADE SIGNAL: ${signal.type.toUpperCase()}</b>`,
      '',
      `${emoji} ${signal.action.toUpperCase()} $${sym}`,
      signal.token.mint ? `Mint: <code>${signal.token.mint}</code>` : '',
      `Confidence: <b>${signal.confidence}%</b>`,
      `Suggested size: ${signal.suggestedSize}%`,
      `Narrative: ${esc(signal.narrative.topic)}`,
      trade,
      '',
      `💡 <i>${esc(signal.reasoning)}</i>`,
    ].filter(Boolean).join('\n');

    // Console only — Paper Trader handles Telegram BUY/SELL alerts (prevents duplicate messages)
    await this.broadcast(msg, 'trading', true);
  }

  private async onGraduation(status: GraduationStatus): Promise<void> {
    // Alert on KOTH or approaching graduation (75%+)
    if (!status.isKingOfHill && status.bondingCurveProgress < 75) return;

    const emoji = status.isKingOfHill ? '👑' : '🎓';
    const msg = [
      `${emoji} <b>GRADUATION WATCH: $${esc(status.symbol)}</b>`,
      '',
      `Progress: ${this.progressBar(status.bondingCurveProgress)}  ${status.bondingCurveProgress}%`,
      `Market Cap: $${status.marketCap.toLocaleString()}`,
      status.isKingOfHill ? '👑 <b>KING OF THE HILL</b>' : '',
      status.timeToGraduation
        ? `⏱ Est. graduation: ${Math.round(status.timeToGraduation / 60000)} min`
        : '',
    ].filter(Boolean).join('\n');

    await this.broadcast(msg, 'research', true); // console only
  }

  private async onRiskBreach(breach: { rule: string; details: string }): Promise<void> {
    const msg = [
      `🚨 <b>RISK BREACH</b>`,
      '',
      `Rule: ${esc(breach.rule)}`,
      `Details: ${esc(breach.details)}`,
      '',
      `⚠️ <i>Review immediately</i>`,
    ].join('\n');

    await this.broadcast(msg, 'ops');
  }

  /** New pipeline: scored token alert with full safety + scoring breakdown */
  private async onScoredToken(token: ScoredToken): Promise<void> {
    const now = Date.now();

    // Rate limit: max N token alerts per window to prevent flooding
    this.tokenAlertTimestamps = this.tokenAlertTimestamps.filter(
      ts => now - ts < AlertDispatcher.TOKEN_ALERT_WINDOW
    );
    if (this.tokenAlertTimestamps.length >= AlertDispatcher.MAX_TOKEN_ALERTS_PER_WINDOW) {
      log.debug(`[${this.meta.name}] Rate limit: skipping $${token.symbol} (${this.tokenAlertTimestamps.length} alerts in last 5m)`);
      return;
    }

    // Symbol dedup: same ticker from different creators = trend spam
    const symbolUpper = token.symbol.toUpperCase();
    const lastSymbolAlert = this.recentSymbols.get(symbolUpper);
    if (lastSymbolAlert && now - lastSymbolAlert < AlertDispatcher.SYMBOL_COOLDOWN) {
      log.debug(`[${this.meta.name}] Symbol dedup: skipping $${token.symbol} (same symbol alerted ${Math.round((now - lastSymbolAlert) / 1000)}s ago)`);
      return;
    }
    this.recentSymbols.set(symbolUpper, now);

    // Clean old symbol entries
    if (this.recentSymbols.size > 100) {
      for (const [s, ts] of this.recentSymbols) {
        if (now - ts > AlertDispatcher.SYMBOL_COOLDOWN) this.recentSymbols.delete(s);
      }
    }

    this.tokenAlertTimestamps.push(now);

    const sym = esc(token.symbol);
    const name = esc(token.name);

    // Score visual
    const filled = Math.min(10, Math.max(0, Math.round(token.overallScore / 10)));
    const scoreBar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const safetyEmoji = token.safetyScore >= 70 ? '🟢' : token.safetyScore >= 40 ? '🟡' : '🔴';
    const momentumEmoji = token.momentumScore >= 50 ? '🚀' : token.momentumScore >= 25 ? '📈' : '📊';

    // Risk flags
    const flags = token.safety.riskFlags.length > 0
      ? `\n\n⚠️ <b>Risk Flags:</b>\n${token.safety.riskFlags.map(f => `  • ${esc(f)}`).join('\n')}`
      : '\n\n✅ No risk flags detected';

    // Smart money
    const smartMoney = token.smartMoneyBuyers.length > 0
      ? `\n\n💰 <b>Smart Money:</b> ${token.smartMoneyBuyers.map(b => esc(b)).join(', ')}`
      : '';

    // Emotion Radar
    const emotion = this.emotionCache.get(token.mint);
    const emotionLine = emotion ? this.formatEmotionLine(emotion) : '';

    const msg = [
      `🎯 <b>NEW TOKEN DETECTED: $${sym}</b>`,
      `<i>${name}</i>`,
      '',
      `${scoreBar} <b>${token.overallScore}/100</b>`,
      '',
      `${safetyEmoji} Safety: ${token.safetyScore}/100`,
      `${momentumEmoji} Momentum: ${token.momentumScore}/100`,
      `🗣 Social: ${token.socialScore}/100`,
      token.chartPattern ? `📊 Chart: ${token.chartPattern}${token.entryAdvice ? ` → ${token.entryAdvice.toUpperCase().replace('_', ' ')}` : ''}` : '',
      emotionLine,
      '',
      `💰 MC: $${token.marketCapUSD.toLocaleString()} (${token.marketCapSOL.toFixed(1)} SOL)`,
      token.liquidityUSD > 0 ? `💧 Liquidity: $${token.liquidityUSD.toLocaleString()}` : '',
      token.volume24h > 0 ? `📊 Volume 24h: $${token.volume24h.toLocaleString()}` : '',
      `⏱ Age: ${token.ageMinutes}m`,
      token.bondingCurveProgress > 0 ? `📈 Bonding: ${this.progressBar(token.bondingCurveProgress)} ${token.bondingCurveProgress.toFixed(0)}%` : '',
      `🔒 Authorities: Mint ${token.safety.mintAuthorityRevoked ? '🟢 Revoked' : '🔴 ACTIVE'} | Freeze ${token.safety.freezeAuthorityRevoked ? '🟢 Revoked' : '🔴 ACTIVE'}`,
      token.safety.sniperCount > 0 ? `🎯 Snipers in block 0: ${token.safety.sniperCount}` : '',
      flags,
      smartMoney,
      '',
      `<code>${token.mint}</code>`,
      `🔗 <a href="https://trade.padre.gg/${token.mint}">Trade on Padre</a>`,
      `🔗 <a href="https://pump.fun/${token.mint}">View on Pump.fun</a>`,
      `🔗 <a href="https://rugcheck.xyz/tokens/${token.mint}">RugCheck</a>`,
    ].filter(Boolean).join('\n');

    await this.broadcast(msg, 'research', true); // console only — trade signals go to Telegram
  }

  /** Format emotion label into a readable line for Telegram */
  private formatEmotionLine(emotion: TokenEmotionProfile): string {
    const labels: Record<string, string> = {
      fomo_wave: '🔥 FOMO Wave — buyers piling in',
      panic_selling: '😱 Panic Selling — capitulation detected',
      greed_peak: '🤑 Greed Peak — profit-taking zone',
      euphoria: '🎆 Euphoria — blow-off top risk',
      exhaustion: '😴 Exhaustion — momentum fading',
      early_interest: '👀 Early Interest — smart entry window',
      neutral: '😐 Neutral',
    };
    const label = labels[emotion.emotionLabel] || '😐 Neutral';
    return `🧠 Emotion: ${label} (F:${emotion.fomoScore} P:${emotion.panicScore} G:${emotion.greedScore})`;
  }

  /** Market mood shift alert — only fires when mood label changes */
  private async onMoodShift(mood: MarketMood): Promise<void> {
    // Only alert when the mood label actually changes (not every 60s tick)
    if (this.lastMoodLabel === mood.overall) return;
    const prevLabel = this.lastMoodLabel;
    this.lastMoodLabel = mood.overall;

    // Don't alert on first mood (startup)
    if (!prevLabel) return;

    const moodEmojis: Record<string, string> = {
      fear: '😨', caution: '⚠️', neutral: '😐', greed: '🤑', extreme_greed: '🔥',
    };
    const emoji = moodEmojis[mood.overall] || '📊';
    const timeLabel = mood.isUSHours ? '🇺🇸 US hours' : mood.isAsiaHours ? '🇯🇵 Asia hours' : '🌍 Off-peak';
    const weekendLabel = mood.isWeekend ? ' (Weekend)' : '';

    const msg = [
      `${emoji} <b>MARKET MOOD SHIFT</b>`,
      '',
      `${prevLabel?.toUpperCase().replace('_', ' ')} → <b>${mood.overall.toUpperCase().replace('_', ' ')}</b>`,
      `Score: ${mood.overallScore}/100`,
      '',
      `📊 Avg FOMO: ${mood.avgFomoScore} | Avg Panic: ${mood.avgPanicScore}`,
      `💰 Smart Money Flow: ${mood.smartMoneyNetFlow > 0 ? '+' : ''}${mood.smartMoneyNetFlow} (buys-sells/hr)`,
      `🕐 ${timeLabel}${weekendLabel}`,
      mood.activeNarrativeCount > 0 ? `📰 Active Narratives: ${mood.activeNarrativeCount} (fatigue: ${mood.narrativeFatigueScore}%)` : '',
    ].filter(Boolean).join('\n');

    await this.broadcast(msg, 'research', true); // console only
  }

  /** Smart money trade alert */
  private async onSmartMoneyTrade(trade: SmartMoneyTrade): Promise<void> {
    // Only alert significant buys (>= 5 SOL)
    if (trade.action !== 'buy' || trade.amountSOL < 5) return;

    const msg = [
      `💰 <b>SMART MONEY ${trade.action.toUpperCase()}</b>`,
      '',
      `Wallet: <b>${esc(trade.label)}</b>`,
      `Token: <code>${trade.mint}</code>`,
      `Amount: ${trade.amountSOL.toFixed(2)} SOL`,
      '',
      `🔗 <a href="https://trade.padre.gg/${trade.mint}">Trade on Padre</a>`,
      `🔗 <a href="https://solscan.io/tx/${trade.signature}">View TX</a>`,
    ].join('\n');

    await this.broadcast(msg, 'research', true); // console only
  }

  private async onGenericAlert(alert: { level: string; message: string }): Promise<void> {
    const levelEmoji = { info: 'ℹ️', warn: '⚠️', critical: '🚨' }[alert.level] || '📌';
    // Critical alerts go to Telegram, info/warn console only
    const consoleOnly = alert.level !== 'critical';
    await this.broadcast(`${levelEmoji} ${alert.message}`, 'ops', consoleOnly);
  }

  // ── Multi-tenant routing ──────────────────────────────────

  /** Send to global chat ID (fallback when no tenant targets exist) */
  private async sendToGlobal(text: string): Promise<void> {
    if (config.telegram.chatId) {
      await this.sendTelegram(config.telegram.chatId, text);
    }
  }

  /** Broadcast to all tenants that have a specific squad enabled.
   *  consoleOnly=true logs the alert but does NOT send to Telegram. */
  private async broadcast(text: string, squad: 'research' | 'trading' | 'deploy' | 'ops', consoleOnly = false): Promise<void> {
    this.alertCount++;
    const headline = stripHtml(text.split('\n')[0]);

    if (!this.botToken || consoleOnly) {
      log.info(`[${this.meta.name}] [console] #${this.alertCount}: ${headline}`);
      return;
    }
    log.info(`[${this.meta.name}] ALERT #${this.alertCount}: ${headline}`);

    if (this.tenantManager) {
      const targets = this.tenantManager.getAlertTargets(squad);
      if (targets.length > 0) {
        // Send to all tenants in parallel for scalability
        await Promise.allSettled(
          targets.map(async (target) => {
            await this.sendTelegram(target.chatId, text);
            this.tenantManager!.recordAlert(target.tenantId);
          })
        );
      } else {
        await this.sendToGlobal(text);
      }
    } else {
      await this.sendToGlobal(text);
    }
  }

  /** Broadcast narrative with per-tenant filtering */
  private async broadcastNarrative(text: string, narrativeTopic: string): Promise<void> {
    this.alertCount++;
    if (!this.botToken) {
      log.info(`[${this.meta.name}] [console-only] #${this.alertCount}: ${stripHtml(text.split('\n')[0])}`);
      return;
    }
    log.info(`[${this.meta.name}] ALERT #${this.alertCount}: ${stripHtml(text.split('\n')[0])}`);

    if (this.tenantManager) {
      const targets = this.tenantManager.getAlertTargets('research')
        .filter(t => this.tenantManager!.matchesNarrativeFilter(t.tenantId, narrativeTopic));

      if (targets.length > 0) {
        await Promise.allSettled(
          targets.map(async (target) => {
            await this.sendTelegram(target.chatId, text);
            this.tenantManager!.recordAlert(target.tenantId);
          })
        );
      } else {
        await this.sendToGlobal(text);
      }
    } else {
      await this.sendToGlobal(text);
    }
  }

  // ── Telegram API ──────────────────────────────────────────

  private async sendTelegram(chatId: string, text: string, retries = 2): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          { timeout: 5000 },
        );
        return;
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const isRateLimit = status === 429;
        const isServerError = (status ?? 0) >= 500;
        const isTimeout = axios.isAxiosError(err) && err.code === 'ECONNABORTED';
        const isClientError = status !== undefined && status >= 400 && status < 500 && status !== 429;

        // Don't retry client errors (400, 401, 403, 404) — they won't resolve
        if (isClientError) {
          log.warn(`[${this.meta.name}] Telegram ${status} for chat ${chatId} — not retrying`);
          return;
        }

        if (attempt < retries && (isRateLimit || isServerError || isTimeout)) {
          const delay = isRateLimit
            ? (err as { response?: { data?: { parameters?: { retry_after?: number } } } })
                .response?.data?.parameters?.retry_after ?? 3
            : (attempt + 1) * 2;
          await new Promise(r => setTimeout(r, delay * 1000));
          continue;
        }
        log.error(`[${this.meta.name}] Telegram send failed for chat ${chatId} (attempt ${attempt + 1})`, err);
      }
    }
  }

  // ── Visual helpers ────────────────────────────────────────

  private sentimentBar(score: number): string {
    const normalized = Math.round((score + 100) / 20);
    const filled = Math.max(0, Math.min(10, normalized));
    return '▓'.repeat(filled) + '░'.repeat(10 - filled);
  }

  private progressBar(pct: number): string {
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  getAlertCount(): number {
    return this.alertCount;
  }
}


