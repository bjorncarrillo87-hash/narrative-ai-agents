#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  Narrative AI — DAILY TEST RUNNER (v9.6 Frozen Build)
# ══════════════════════════════════════════════════════════════
#
#  USAGE:  cd ~/Narrative_AI_Agent_Kabal && bash test-results/run-daily-test.sh
#
#  This script:
#    1. Checks out the frozen v9.6 commit (dd8be78) in detached HEAD
#    2. Builds the project
#    3. Runs the bot for exactly 60 minutes
#    4. Saves the full terminal output to test-results/
#    5. Returns you to your previous branch when done
#
# ══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FROZEN_COMMIT="dd8be78"
DURATION_SECONDS=3600
DATE_STAMP=$(date +"%Y-%m-%d")
TIME_STAMP=$(date +"%H%M")
OUTPUT_FILE="$SCRIPT_DIR/raw-output-${DATE_STAMP}-${TIME_STAMP}.log"

cd "$PROJECT_DIR"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Narrative AI — DAILY TEST RUNNER"
echo "  Version: v9.6 (frozen commit: $FROZEN_COMMIT)"
echo "  Duration: 60 minutes"
echo "  Output:   $OUTPUT_FILE"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── Save current branch so we can return after the test ──
ORIGINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
echo "[1/5] Current branch: $ORIGINAL_BRANCH"

# ── Fetch and checkout frozen commit ──
echo "[2/5] Fetching v9.6 branch..."
git fetch origin claude/create-narrative-ai-team-LV4ez 2>/dev/null
echo "[2/5] Checking out frozen commit $FROZEN_COMMIT (detached HEAD)..."
git checkout "$FROZEN_COMMIT" 2>/dev/null

# ── Verify ──
CURRENT_COMMIT=$(git rev-parse --short HEAD)
if [ "$CURRENT_COMMIT" != "$FROZEN_COMMIT" ]; then
  echo "ERROR: Expected commit $FROZEN_COMMIT but got $CURRENT_COMMIT. Aborting."
  exit 1
fi
echo "[3/5] Confirmed: HEAD at $CURRENT_COMMIT"

# ── Build ──
echo "[3/5] Building..."
npm run build
echo "[3/5] Build clean."

# ── Run for 60 minutes ──
echo ""
echo "══════════════════════════════════════════════════════════"
echo "  STARTING 60-MINUTE TEST RUN"
echo "  Start: $(date)"
echo "  Stop:  $(date -d '+60 minutes' 2>/dev/null || date -v+60M 2>/dev/null || echo 'in 60 min')"
echo "══════════════════════════════════════════════════════════"
echo ""

echo "[4/5] Bot running... output saved to $OUTPUT_FILE"
echo "      Press Ctrl+C to stop early."
echo ""

# Run with timeout, capture all output (strip ANSI codes for clean log)
timeout "$DURATION_SECONDS" node dist/index.js 2>&1 | tee >(sed 's/\x1b\[[0-9;]*m//g' > "$OUTPUT_FILE") || true

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  TEST RUN COMPLETE"
echo "  End: $(date)"
echo "  Output saved: $OUTPUT_FILE"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── Return to original branch ──
echo "[5/5] Returning to branch: $ORIGINAL_BRANCH"
if [ "$ORIGINAL_BRANCH" != "detached" ]; then
  git checkout "$ORIGINAL_BRANCH" 2>/dev/null
else
  echo "  (was detached — staying on $FROZEN_COMMIT)"
fi

echo ""
echo "Done! Now paste the output into Claude Code to generate the investor report."
echo "Raw log: $OUTPUT_FILE"
echo ""

