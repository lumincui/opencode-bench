# Staged benchmark pipeline

The bench is split into three stages so each can be re-run independently against cached artifacts. Each stage's output lands on disk and acts as the cache key for the next stage.

```
Stage 1 (run)        Stage 2 (score)         Stage 3 (analyze)
─────────────        ───────────────         ──────────────────
agent rollout    →   judge LLM calls    →    aggregate + attribute
   ↓                    ↓                       ↓
execution.json       scores.json             summary.json
diff.patch                                    attribution.md
run.log              score.log
```

## Per-cell layout

For each (arm, task, episode):

```
<exp-root>/<arm>/prompt.txt              # candidate system prompt for the arm
<exp-root>/<arm>/<task>/ep<N>/
  execution.json    # stage-1 artifact: diff, before/after results, mechanism, usage
  diff.patch        # raw diff (also embedded in execution.json)
  run.log           # stage-1 narration
  scores.json       # stage-2 artifact: per-criterion judges, final score
  score.log         # stage-2 narration
```

Cache rule: stages skip when their output file already exists. `--force` (or matching mismatched `judge_set_id` for stage 2) re-runs.

## Stage 1: `orvl run`

```
bun run cli.ts run opencode \
  --model minimax-cn/MiniMax-M2.7 \
  --task sst-opencode-formatting \
  --out experiments/01-ablation-A/sst-opencode-formatting/ep1
```

What it does:
- Clones the task repo (cached at `.cache/repos/`)
- Runs pre-task `args.commands` per metric → `before_results`
- Runs the agent (one prompt at a time)
- Finalizes the agent diff
- Runs post-task `args.commands` → `after_results`
- Pulls per-part data from opencode's local DB → `mechanism` (text/reasoning chars, tool calls)

Reads `OPENCODE_BENCH_AGENT_PROMPT` env at module load (`src/agents/opencode.ts:10`). To switch candidate prompts you must spawn a fresh process — use `scripts/run-matrix.ts`.

## Stage 2: `orvl score`

```
bun run cli.ts score experiments/01-ablation-A/sst-opencode-formatting/ep1
```

What it does:
- Reads `execution.json` (no re-clone, no agent run)
- Calls each judge LLM on each criterion against the cached diff/results
- Computes `base = Σ wᵢ·avgᵢ`, `penalty = λ·Σ wᵢ·varᵢ`, `final = max(0, base − penalty)`
- Writes `scores.json` with per-judge rationales

`--judge-set-id <id>` namespaces the cache; if `scores.json` was produced with a different id, the stage re-runs. This lets you re-score against a different judge set without losing the previous scores.

## Stage 3: `orvl analyze`

```
bun run cli.ts analyze experiments/ \
  --baseline 01-ablation-baseline \
  --arms 01-ablation-A,01-ablation-B,01-ablation-baseline
```

What it does:
- Walks `<root>/<arm>/<task>/ep*/` and collects `execution.json` + `scores.json`
- Aggregates per (arm, task) cell: mean ± std for final/base/penalty, mechanism, duration, cost; per-criterion mean and judge_var
- Per (arm, task), Δ vs baseline: Δfinal, per-criterion contribution, mechanism deltas
- Flags cells with n < 3 episodes (CLAUDE.md variance-control rule) and judge-variance hotspots
- Writes `summary.json` (machine-readable) + `attribution.md` (per-arm tables, criterion attribution, hotspots)

Output lands in `<root>/_analysis/` by default; override with `--out`.

## Matrix orchestrator

`scripts/run-matrix.ts` drives the full matrix:

```
bun run scripts/run-matrix.ts \
  --exp-root ../experiments \
  --tasks sst-opencode-formatting,sst-opencode-session-rename,helix-db-cli-update \
  --episodes 3 \
  --model minimax-cn/MiniMax-M2.7 \
  --analyze --baseline 01-ablation-baseline
```

- Auto-discovers arms from `<exp-root>/<arm>/prompt.txt`
- Spawns a fresh `bun cli.ts run` per cell with the right `OPENCODE_BENCH_AGENT_PROMPT`
- Spawns `bun cli.ts score` after each successful run
- Cache-aware: skips cells where the artifact already exists
- `--analyze` also runs stage 3 at the end

Failures don't abort the matrix — failing cells are reported in the final summary table and the script exits with code 1 if any cell failed.

## Migrating from `run-ablation.sh`

The old shell wrapper called the legacy single-shot CLI and parsed scores out of stdout via `sed`. The matrix runner replaces it; existing `meta.yaml` files in `experiments/` are not consumed by stage 3 (only `execution.json` + `scores.json`). Cells run before this PR will need a fresh stage-1 run to populate the new artifacts.
