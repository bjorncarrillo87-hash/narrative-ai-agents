// ── Ops Squad Coordinator ───────────────────────────────
// Monitors, reports, protects. Your command center.
// V9: StrategyRouter replaces PaperTrader (runs 4 strategy bots).

import { log } from '../core/index.js';
import type { Agent, AgentMeta } from '../core/types.js';
import { AlertDispatcher } from './alert-dispatcher.js';
import { RiskAuditor } from './risk-auditor.js';
import { DailyReporter } from './daily-reporter.js';
import { PerformanceTracker } from './performance-tracker.js';
import { StrategyRouter } from './strategy-router.js';

export class OpsSquad implements Agent {
  meta: AgentMeta = {
    name: 'Ops Squad',
    squad: 'ops',
    version: '9.0.0',
  };

  readonly alertDispatcher: AlertDispatcher;
  readonly riskAuditor: RiskAuditor;
  readonly dailyReporter: DailyReporter;
  readonly performanceTracker: PerformanceTracker;
  readonly strategyRouter: StrategyRouter;

  private agents: Agent[];

  constructor() {
    this.alertDispatcher = new AlertDispatcher();
    this.riskAuditor = new RiskAuditor();
    this.dailyReporter = new DailyReporter();
    this.performanceTracker = new PerformanceTracker();
    this.strategyRouter = new StrategyRouter();

    this.agents = [
      this.alertDispatcher,
      this.riskAuditor,
      this.dailyReporter,
      this.performanceTracker,
      this.strategyRouter,
    ];
  }

  async start(): Promise<void> {
    log.info(`[${this.meta.name}] ═══ OPS SQUAD ONLINE (V9) ═══`);

    for (const agent of this.agents) {
      await agent.start();
      log.info(`[${this.meta.name}] ✓ ${agent.meta.name} started`);
    }

    log.info(`[${this.meta.name}] All ${this.agents.length} agents active`);
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) {
      await agent.stop();
    }
    log.info(`[${this.meta.name}] ═══ OPS SQUAD OFFLINE ═══`);
  }
}

export { AlertDispatcher } from './alert-dispatcher.js';
export { RiskAuditor } from './risk-auditor.js';
export { DailyReporter } from './daily-reporter.js';
export { PerformanceTracker } from './performance-tracker.js';
export { StrategyRouter } from './strategy-router.js';
export { PaperTrader } from './paper-trader.js';


