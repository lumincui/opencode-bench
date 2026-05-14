#!/bin/bash
# Re-extract score/duration/cost from orvl.log into meta.yaml.
# Idempotent: rewrites meta.yaml fields in place from the log.
# Usage: bash scripts/reextract-scores.sh
set -e

EXP_DIR="/Users/lumin/opencode-optimize-workspace/experiments"

count=0
fixed=0
empty=0

for META in "$EXP_DIR"/01-ablation-*/*/ep*/meta.yaml; do
  [[ -f "$META" ]] || continue
  count=$((count + 1))
  EP_DIR=$(dirname "$META")
  LOG="$EP_DIR/orvl.log"
  if [[ ! -f "$LOG" ]]; then
    echo "MISS log: $META"
    continue
  fi

  # Extract values AFTER the label, ignoring timestamp prefix.
  SCORE=$(sed -n 's/.*Final score: \([0-9.]*\).*/\1/p' "$LOG" | tail -1)
  DURATION=$(sed -n 's/.*Avg duration: \([0-9]*\)s.*/\1/p' "$LOG" | tail -1)
  COST=$(sed -n 's/.*Avg cost: \$\([0-9.]*\).*/\1/p' "$LOG" | tail -1)

  # Mechanism metrics from "Mechanism: text=Xc reasoning=Yc tools=Z parts=W"
  MECH_LINE=$(grep -E "^.*Mechanism: text=" "$LOG" | tail -1)
  TEXT_CHARS=$(echo "$MECH_LINE" | sed -n 's/.*text=\([0-9]*\)c.*/\1/p')
  REASON_CHARS=$(echo "$MECH_LINE" | sed -n 's/.*reasoning=\([0-9]*\)c.*/\1/p')
  TOOL_CALLS=$(echo "$MECH_LINE" | sed -n 's/.*tools=\([0-9]*\).*/\1/p')
  TOTAL_PARTS=$(echo "$MECH_LINE" | sed -n 's/.*parts=\([0-9]*\).*/\1/p')

  if [[ -z "$SCORE" && -z "$DURATION" && -z "$COST" ]]; then
    empty=$((empty + 1))
    echo "EMPTY  $META (run likely failed mid-flight)"
    continue
  fi

  SCORE=${SCORE:-null}
  DURATION=${DURATION:-null}
  COST=${COST:-null}
  TEXT_CHARS=${TEXT_CHARS:-null}
  REASON_CHARS=${REASON_CHARS:-null}
  TOOL_CALLS=${TOOL_CALLS:-null}
  TOTAL_PARTS=${TOTAL_PARTS:-null}

  # Update existing lines AND append mechanism if missing.
  awk -v s="$SCORE" -v d="$DURATION" -v c="$COST" \
      -v tc="$TEXT_CHARS" -v rc="$REASON_CHARS" -v tl="$TOOL_CALLS" -v tp="$TOTAL_PARTS" '
    /^duration_s:/   { print "duration_s: " d; next }
    /^cost_usd:/     { print "cost_usd: " c; next }
    /^final_score:/  { print "final_score: " s; next }
    /^text_chars:/   { print "text_chars: " tc; seen_tc=1; next }
    /^reasoning_chars:/ { print "reasoning_chars: " rc; seen_rc=1; next }
    /^tool_calls:/   { print "tool_calls: " tl; seen_tl=1; next }
    /^total_parts:/  { print "total_parts: " tp; seen_tp=1; next }
    { print }
    END {
      if (!seen_tc) print "text_chars: " tc
      if (!seen_rc) print "reasoning_chars: " rc
      if (!seen_tl) print "tool_calls: " tl
      if (!seen_tp) print "total_parts: " tp
    }
  ' "$META" > "$META.tmp" && mv "$META.tmp" "$META"

  fixed=$((fixed + 1))
  echo "OK     $META  score=$SCORE  text=${TEXT_CHARS}c reason=${REASON_CHARS}c tools=$TOOL_CALLS"
done

echo ""
echo "=== Summary: $fixed/$count meta.yaml updated, $empty empty (no scores in log) ==="
