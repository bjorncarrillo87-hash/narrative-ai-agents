# **Narrative AI v9.6 — 1-YEAR PROJECTED PERFORMANCE REPORT**

---

> **DISCLAIMER:** This is a **statistical projection** based on 2 live paper-trading sessions
> (51 total trades). It extrapolates observed win rates, P&L distributions, and trade
> frequencies over 365 daily sessions. **This is NOT a backtest against historical data.**
> Actual performance will vary due to market conditions, liquidity, volatility cycles,
> and PumpFun ecosystem changes. Past paper-trade results do not guarantee future performance.

---

## **Projection Basis**

| | |
|---|---|
| **Source Data** | Run #1 (2025-04-01) + Run #2 (2025-04-01) |
| **Version** | v9.6 (frozen tag: `dd8be78`) |
| **Total Source Trades** | 51 |
| **Total Source Sessions** | 2 |
| **Avg Trades/Session** | 25.5 |
| **Avg Session Duration** | ~57 minutes |
| **Projection Period** | 365 daily sessions (1 year) |
| **Mode** | Paper Trading (no real capital) |

---

## **1-YEAR PROJECTED TOTALS**

| **Metric** | **Projected Value** |
|---|---|
| **Total Sessions** | **365** |
| **Total Trades** | **~9,308** |
| **Total Wins** | **~3,468** |
| **Total Losses** | **~4,017** |
| **Total Timeouts** | **~1,823** |
| **Overall Win Rate** | **37.3%** |
| **Projected Annual P&L** | **-3,997%** |

> **Note:** The heavily negative projected P&L is driven primarily by BRAVO's consistent
> underperformance (-52.1% avg per session). If BRAVO were disabled, projected annual P&L
> would be significantly improved. See Scenario Analysis below.

---

## **Per-Bot Annual Projections**

### **ALPHA (BREAKOUT)**

| **Metric** | **Per Session Avg** | **Annual Projected** |
|---|---|---|
| **Trades** | 3.5 | ~1,278 |
| **Win Rate** | 29% | 29% |
| **Avg Session P&L** | +24.9% | — |
| **Annual P&L** | — | **+9,089%** |
| **Fib Conversion** | 17% | 17% |
| **W / L / T** | 1.0 / 1.0 / 1.5 | 365 / 365 / 548 |

> **Analysis:** ALPHA is profitable despite low win rate — large +79.0% Run #1 win carries
> the average. High timeout rate (43%) suggests many BREAKOUT entries fail to reach TP/SL
> within 30 minutes.

---

### **BRAVO (PUMP_PHASE)**

| **Metric** | **Per Session Avg** | **Annual Projected** |
|---|---|---|
| **Trades** | 8.0 | ~2,920 |
| **Win Rate** | 25% | 25% |
| **Avg Session P&L** | -52.1% | — |
| **Annual P&L** | — | **-19,017%** |
| **Fib Conversion** | 19% | 19% |
| **W / L / T** | 2.0 / 3.5 / 2.5 | 730 / 1,278 / 913 |

> **Analysis:** BRAVO is the **worst-performing bot by a wide margin**. 25% win rate with
> TP at only +20% cannot overcome losses at -12% SL + 3% slippage. Losses compound rapidly.
> **Strong candidate for removal or major reconfiguration.**

---

### **CHARLIE (TRENDING)**

| **Metric** | **Per Session Avg** | **Annual Projected** |
|---|---|---|
| **Trades** | 4.5 | ~1,643 |
| **Win Rate** | 56% | 56% |
| **Avg Session P&L** | +12.5% | — |
| **Annual P&L** | — | **+4,553%** |
| **Fib Conversion** | 18% | 18% |
| **W / L / T** | 2.5 / 2.0 / 0.0 | 913 / 730 / 0 |

> **Analysis:** CHARLIE is the **most consistent bot**. Highest win rate (56%), zero
> timeouts, and the only bot profitable in BOTH sessions. Higher minScore (55 vs 45)
> filters out weaker setups. **Best candidate to increase position sizing.**

---

### **DELTA (NARRATIVE)**

| **Metric** | **Per Session Avg** | **Annual Projected** |
|---|---|---|
| **Trades** | 9.5 | ~3,468 |
| **Win Rate** | 42% | 42% |
| **Avg Session P&L** | +3.8% | — |
| **Annual P&L** | — | **+1,370%** |
| **Fib Conversion** | 19% | 19% |
| **W / L / T** | 4.0 / 4.5 / 1.0 | 1,460 / 1,643 / 365 |

> **Analysis:** DELTA takes the most trades (highest volume) with moderate win rate. Barely
> profitable on average — one bad session can erase multiple good ones. Vulnerable to
> extreme dumps ($BARK -55.4% in Run #2 bypassed SL).

---

## **Monthly Projected P&L Breakdown**

| **Month** | **Sessions** | **Trades** | **ALPHA** | **BRAVO** | **CHARLIE** | **DELTA** | **Combined** |
|---|---|---|---|---|---|---|---|
| Month 1 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 2 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 3 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 4 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 5 | 31 | 791 | +772% | -1,615% | +386% | +117% | -340% |
| Month 6 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 7 | 31 | 791 | +772% | -1,615% | +386% | +117% | -340% |
| Month 8 | 31 | 791 | +772% | -1,615% | +386% | +117% | -340% |
| Month 9 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 10 | 31 | 791 | +772% | -1,615% | +386% | +117% | -340% |
| Month 11 | 30 | 765 | +747% | -1,563% | +374% | +113% | -329% |
| Month 12 | 31 | 791 | +772% | -1,615% | +386% | +117% | -340% |
| **TOTAL** | **365** | **9,308** | **+9,089%** | **-19,017%** | **+4,553%** | **+1,370%** | **-4,005%** |

> **Note:** Monthly figures assume uniform distribution. Real performance would show
> variance — some months significantly better or worse than average.

---

## **Scenario Analysis**

### **Scenario A: All 4 Bots (Current Config)**

| | |
|---|---|
| **Annual P&L** | **-3,997%** |
| **Win Rate** | 37.3% |
| **Trades** | ~9,308 |
| **Verdict** | ❌ **Not viable** — BRAVO drags system deeply negative |

---

### **Scenario B: Remove BRAVO (3 Bots)**

| | |
|---|---|
| **Annual P&L** | **+15,012%** |
| **Win Rate** | 41.4% |
| **Trades** | ~6,388 |
| **Verdict** | ✅ **Highly profitable** — removing BRAVO flips the system positive |

---

### **Scenario C: CHARLIE Only (Best Bot)**

| | |
|---|---|
| **Annual P&L** | **+4,553%** |
| **Win Rate** | 56% |
| **Trades** | ~1,643 |
| **Verdict** | ✅ **Safest configuration** — highest win rate, most consistent |

---

### **Scenario D: ALPHA + CHARLIE (Top 2)**

| | |
|---|---|
| **Annual P&L** | **+13,642%** |
| **Win Rate** | 43.8% |
| **Trades** | ~2,920 |
| **Verdict** | ✅ **Best risk/reward** — two profitable bots, moderate volume |

---

## **Key Observations & Recommendations**

- **BRAVO is the clear problem.** -19,017% projected annual loss. Its 20% TP cannot overcome the -12% SL + 3% slippage on a 25% win rate. Recommend **disabling or reconfiguring BRAVO** immediately.

- **CHARLIE is the star.** 56% win rate, zero timeouts, profitable in both sessions. Consider **increasing CHARLIE's position size** or **lowering its minScore** to capture more trades.

- **ALPHA is surprisingly strong** despite only 29% win rate — its +35% TP means wins are nearly 3x the size of losses. Classic asymmetric risk/reward.

- **DELTA is marginal.** High volume but thin edge (+3.8% avg). Vulnerable to tail-risk events (extreme dumps). Consider **tightening DELTA's entry criteria** or reducing position size.

- **Fib conversion rate is low (~18%).** 82% of tokens that enter the Fibonacci watchlist expire without triggering entry. This is the primary filter keeping trade quality high — do not loosen it.

- **Win rate needs to exceed ~40% at current TP/SL ratios** for consistent profitability. Only CHARLIE and DELTA meet this threshold.

- **Sample size caveat:** 51 trades across 2 sessions is a small sample. Confidence intervals are wide. Recommend **minimum 10 sessions (250+ trades)** before making strategy changes.

---

## **Risk Factors (Not Modeled)**

| **Risk** | **Impact** |
|---|---|
| Market regime change | Bull/bear cycles will shift win rates dramatically |
| PumpFun ecosystem changes | Token quality, volume, and dump patterns may evolve |
| Liquidity drying up | Slippage could exceed the modeled 3% |
| API/WebSocket downtime | Missed entries and stale prices |
| Extreme dump cascades | -55%+ losses that bypass SL (seen in Run #2) |
| Narrative exhaustion | DELTA relies on social momentum that may fade |
| Serial deployer adaptation | Spam creators may evolve to bypass detection |

---

## **Strategy Configuration Reference (v9.6)**

| **Bot** | **TP** | **SL** | **Min Score** | **Size** | **Max Pos** | **Timeout** |
|---|---|---|---|---|---|---|
| **ALPHA** | +35% | -12% | 45 | 0.5 SOL | 8 | 30m |
| **BRAVO** | +20% | -12% | 45 | 0.5 SOL | 8 | 30m |
| **CHARLIE** | +20% | -12% | 55 | 0.5 SOL | 8 | 30m |
| **DELTA** | +30% | -12% | 45 | 0.5 SOL | 8 | 30m |

> **Entry:** Fibonacci retracement (0.382–0.500 zone) | **SL Slippage:** +3% on stops | **Age Filter:** <60m tokens only

---

> **Narrative AI v9.6** | Fibonacci Retracement Scalping | Solana PumpFun Tokens
> _1-Year Statistical Projection — Generated for investor review_
> _Based on 2 live paper-trading sessions (51 trades) — April 2025_

