#!/bin/bash
# DEPRECATED: prefer scripts/run-matrix.ts — that one writes the new staged
# artifacts (execution.json + scores.json) which `orvl analyze` consumes.
# This wrapper calls the legacy one-shot CLI and only writes meta.yaml; cells
# generated here will not be visible to stage-3 analysis.
#
# Phase 1 ablation runner
# Usage: bash scripts/run-ablation.sh
# Runs 9 conditions × 3 tasks × 3 episodes = 81 invocations
set -e

BENCH_DIR="/Users/lumin/opencode-optimize-workspace/opencode-bench"
EXP_DIR="/Users/lumin/opencode-optimize-workspace/experiments"
MODEL="minimax-cn/MiniMax-M2.7"
TASKS=("sst-opencode-formatting" "sst-opencode-session-rename" "helix-db-cli-update")
ARMS=("A" "B" "C" "D" "E" "F" "Z" "baseline")

cd "$BENCH_DIR"

for ARM in "${ARMS[@]}"; do
  PROMPT_FILE="$EXP_DIR/01-ablation-$ARM/prompt.txt"
  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "SKIP $ARM: no prompt.txt"
    continue
  fi

  for TASK in "${TASKS[@]}"; do
    OUT_DIR="$EXP_DIR/01-ablation-$ARM/$TASK"
    mkdir -p "$OUT_DIR"

    for EP in 1 2 3; do
      EP_DIR="$OUT_DIR/ep$EP"
      mkdir -p "$EP_DIR"
      LOG="$EP_DIR/orvl.log"

      # Skip if already done
      if [[ -f "$EP_DIR/meta.yaml" ]]; then
        echo "SKIP $ARM/$TASK/ep$EP (exists)"
        continue
      fi

      echo "[$(date -Iseconds)] START $ARM/$TASK ep$EP"
      PROMPT=$(cat "$PROMPT_FILE")

      # Use a tempfile to avoid shell escaping issues
      PROMPT_FILE_TMP=$(mktemp)
      printf '%s' "$PROMPT" > "$PROMPT_FILE_TMP"

      START=$(date +%s)
      set +e
      OPENCODE_BENCH_AGENT_PROMPT="$PROMPT" bun run dev -- opencode --model "$MODEL" --task "$TASK" 2>&1 | tee "$LOG"
      EXIT=$?
      set -e
      END=$(date +%s)

      rm -f "$PROMPT_FILE_TMP"

      # Extract score lines via sed (BSD-compatible, ignores year-in-timestamp)
      SCORE=$(sed -n 's/.*Final score: \([0-9.]*\).*/\1/p' "$LOG" | tail -1)
      DURATION=$(sed -n 's/.*Avg duration: \([0-9]*\)s.*/\1/p' "$LOG" | tail -1)
      COST=$(sed -n 's/.*Avg cost: \$\([0-9.]*\).*/\1/p' "$LOG" | tail -1)
      MECH=$(grep "Mechanism: text=" "$LOG" | tail -1)
      TEXT_CHARS=$(echo "$MECH" | sed -n 's/.*text=\([0-9]*\)c.*/\1/p')
      REASON_CHARS=$(echo "$MECH" | sed -n 's/.*reasoning=\([0-9]*\)c.*/\1/p')
      TOOL_CALLS=$(echo "$MECH" | sed -n 's/.*tools=\([0-9]*\).*/\1/p')
      TOTAL_PARTS=$(echo "$MECH" | sed -n 's/.*parts=\([0-9]*\).*/\1/p')

      cat > "$EP_DIR/meta.yaml" <<EOF
arm: ablation-$ARM
task: $TASK
episode: $EP
model: $MODEL
duration_s: ${DURATION:-null}
cost_usd: ${COST:-null}
final_score: ${SCORE:-null}
text_chars: ${TEXT_CHARS:-null}
reasoning_chars: ${REASON_CHARS:-null}
tool_calls: ${TOOL_CALLS:-null}
total_parts: ${TOTAL_PARTS:-null}
exit_code: $EXIT
wall_time_s: $((END - START))
timestamp: $(date -Iseconds)
EOF

      echo "[$(date -Iseconds)] DONE $ARM/$TASK ep$EP score=$SCORE text=${TEXT_CHARS}c reason=${REASON_CHARS}c tools=$TOOL_CALLS"
    done
  done
done

echo "=== PHASE 1 ABLATION COMPLETE ==="