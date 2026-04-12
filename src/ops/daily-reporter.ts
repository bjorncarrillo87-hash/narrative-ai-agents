// ── Daily Reporter ──────────────────────────────────────
// Morning report at 8am: overnight PnL, trades executed, rugs avoided.

import * as cron from 'node-cron';
import { bus, log, config } from '../core/index.js';
import { getDb } from '../core/db.js';
import type { Agent, AgentMeta, DailyReport } from '../core/types.js';

export class DailyReporter implements Agent {
  meta: AgentMeta = {
    name: 'Daily Reporter',
    squad: 'ops',
    version: '0.1.0',
  };

  private cronJob: cron.ScheduledTask | null = null;
  private startTime = Date.now();

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] Starting — daily reports at 8:00 AM`);

    // Schedule daily report
    this.cronJob = cron.schedule(config.intervals.dailyReport as string, () => {
      this.generateReport();
    });

    log.info(`[${this.meta.name}] Cron scheduled: ${config.intervals.dailyReport}`);
  }

  async stop(): Promise<void> {
    if (this.cronJob) this.cronJob.stop();
    log.info(`[${this.meta.name}] Stopped`);
  }

  /** Generate and emit the daily report */
  async generateReport(): Promise<void> {
    log.info(`[${this.meta.name}] Generating daily report...`);

    const today = new Date().toISOString().slice(0, 10);
    const dayStart = new Date(today).getTime();
    const dayEnd = dayStart + 86400_000;

    let narrativeCount: { count: number } | undefined;
    let topNarrative: { topic: string; confidence: number } | undefined;
    let signalCount: { count: number } | undefined;
    let whaleCount: { count: number } | undefined;

    try {
      const db = getDb();
      narrativeCount = db.prepare(
        `SELECT COUNT(*) as count FROM narratives WHERE detected_at >= ? AND detected_at < ?`
      ).get(dayStart, dayEnd) as { count: number } | undefined;

      topNarrative = db.prepare(
        `SELECT topic, confidence FROM narratives WHERE detected_at >= ? AND detected_at < ? ORDER BY confidence DESC LIMIT 1`
      ).get(dayStart, dayEnd) as { topic: string; confidence: number } | undefined;

      signalCount = db.prepare(
        `SELECT COUNT(*) as count FROM signals WHERE timestamp >= ? AND timestamp < ?`
      ).get(dayStart, dayEnd) as { count: number } | undefined;

      whaleCount = db.prepare(
        `SELECT COUNT(*) as count FROM whale_alerts WHERE timestamp >= ? AND timestamp < ?`
      ).get(dayStart, dayEnd) as { count: number } | undefined;
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to query database for daily report`, err);
    }

    const uptimeHours = (Date.now() - this.startTime) / 3600_000;

    const report: DailyReport = {
      date: today,
      narrativesDetected: narrativeCount?.count ?? 0,
      topNarrative: topNarrative?.topic ?? 'None',
      signalsGenerated: signalCount?.count ?? 0,
      alertsSent: (whaleCount?.count ?? 0) + (narrativeCount?.count ?? 0),
      uptime: Math.round(uptimeHours * 10) / 10,
    };

    // Persist report
    try {
      getDb().prepare(`
        INSERT OR REPLACE INTO daily_reports (date, narratives_detected, top_narrative, signals_generated, alerts_sent, uptime)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(report.date, report.narrativesDetected, report.topNarrative, report.signalsGenerated, report.alertsSent, report.uptime);
    } catch (err) {
      log.error(`[${this.meta.name}] Failed to persist daily report`, err);
    }

    // Cleanup old data (retain 30 days)
    this.cleanOldData();

    bus.emit('ops:daily_report', report);

    // Send formatted report via alert system
    const reportMsg = [
      `📋 <b>DAILY REPORT — ${today}</b>`,
      '',
      `🔍 Narratives detected: <b>${report.narrativesDetected}</b>`,
      `🏆 Top narrative: <b>${report.topNarrative}</b>`,
      `📡 Signals generated: <b>${report.signalsGenerated}</b>`,
      `🐋 Whale alerts: <b>${whaleCount?.count ?? 0}</b>`,
      `📨 Total alerts sent: <b>${report.alertsSent}</b>`,
      `⏱ Uptime: <b>${report.uptime}h</b>`,
      '',
      `<i>Narrative AI — The Kredo is law.</i>`,
    ].join('\n');

    bus.emit('ops:alert', { level: 'info', message: reportMsg });

    log.info(`[${this.meta.name}] Daily report generated for ${today}`);
  }

  /** Purge data older than 30 days to prevent unbounded DB growth */
  private cleanOldData(): void {
    try {
      const db = getDb();
      const cutoff = Date.now() - 30 * 24 * 3600_000;

      const narr = db.prepare(`DELETE FROM narratives WHERE detected_at < ?`).run(cutoff);
      const sigs = db.prepare(`DELETE FROM signals WHERE timestamp < ?`).run(cutoff);
      const whales = db.prepare(`DELETE FROM whale_alerts WHERE timestamp < ?`).run(cutoff);
      const reports = db.prepare(`DELETE FROM daily_reports WHERE created_at < ?`).run(cutoff);

      const total = narr.changes + sigs.changes + whales.changes + reports.changes;
      if (total > 0) {
        log.info(`[${this.meta.name}] Cleaned ${total} old records (30-day retention)`);
      }
    } catch (err) {
      log.error(`[${this.meta.name}] Data cleanup failed`, err);
    }
  }

  /** Manual trigger for testing */
  async triggerReport(): Promise<void> {
    await this.generateReport();
  }
}

