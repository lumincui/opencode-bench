#!/usr/bin/env bun
/**
 * Matrix orchestrator for the staged benchmark pipeline.
 *
 * Spawns one child process per (arm × task × episode) cell because
 * `agents/opencode.ts` reads OPENCODE_BENCH_AGENT_PROMPT at module load —
 * a single Node process cannot switch candidate prompts.
 *
 * Each child is `bun cli.ts run opencode ... --out <dir>` (stage 1)
 * followed by `bun cli.ts score <dir>` (stage 2). Cache is by file presence:
 *  - execution.json present → skip stage 1
 *  - scores.json present with matching judge_set_id → skip stage 2
 *
 * After the matrix, optionally invokes `orvl analyze` for stage 3.
 *
 * Layout:
 *   <exp-root>/<arm>/prompt.txt              # candidate prompt for the arm
 *   <exp-root>/<arm>/<task>/ep<N>/           # per-cell artifacts
 *     execution.json
 *     diff.patch
 *     run.log
 *     scores.json
 *     score.log
 *
 * Arms are auto-discovered as immediate subdirs of <exp-root> containing
 * `prompt.txt` (or via --arms).
 */
import process from "node:process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface Cell {
  arm: string;
  task: string;
  episode: number;
  dir: string;
  promptFile: string;
}

interface CellResult extends Cell {
  status:
    | "execute-skipped"
    | "executed"
    | "execute-failed"
    | "score-skipped"
    | "scored"
    | "score-failed";
  exitCode?: number;
  durationMs: number;
}

const argv = await yargs(hideBin(process.argv))
  .scriptName("run-matrix")
  .wrap(null)
  .strict()
  .option("exp-root", { type: "string", required: true })
  .option("arms", {
    type: "string",
    description: "comma-separated arm names; default = all subdirs with prompt.txt",
  })
  .option("tasks", { type: "string", required: true })
  .option("episodes", { type: "number", default: 1 })
  .option("model", { type: "string", required: true })
  .option("agent", { type: "string", default: "opencode" })
  .option("skip-score", { type: "boolean", default: false })
  .option("judge-set-id", { type: "string", default: "default" })
  .option("analyze", { type: "boolean", default: false })
  .option("baseline", { type: "string" })
  .option("force-execute", { type: "boolean", default: false })
  .option("force-score", { type: "boolean", default: false })
  .parse();

const expRoot = resolve(argv["exp-root"]);
const tasks = argv.tasks.split(",").map((s) => s.trim());
const episodes = Array.from({ length: argv.episodes }, (_, i) => i + 1);
const model = argv.model;
const agent = argv.agent;

const arms = await resolveArms(expRoot, argv.arms);
if (arms.length === 0) {
  console.error("No arms found (need <exp-root>/<arm>/prompt.txt)");
  process.exit(1);
}

const cells: Cell[] = [];
for (const arm of arms) {
  const promptFile = join(expRoot, arm, "prompt.txt");
  for (const task of tasks) {
    for (const ep of episodes) {
      cells.push({
        arm,
        task,
        episode: ep,
        dir: join(expRoot, arm, task, `ep${ep}`),
        promptFile,
      });
    }
  }
}

console.log(
  `Planned ${cells.length} cells: ${arms.length} arm(s) × ${tasks.length} task(s) × ${episodes.length} episode(s)`,
);
console.log(`Model: ${model}`);
console.log(`Skip score: ${argv["skip-score"]}`);

const results: CellResult[] = [];
for (const cell of cells) {
  await mkdir(cell.dir, { recursive: true });
  const t0 = Date.now();

  // Stage 1: execute
  const execPath = join(cell.dir, "execution.json");
  let stage1: CellResult["status"];
  if (existsSync(execPath) && !argv["force-execute"]) {
    stage1 = "execute-skipped";
  } else {
    const promptText = await readFile(cell.promptFile, "utf8");
    const exitCode = await runChild(
      [
        "run",
        agent,
        "--model",
        model,
        "--task",
        cell.task,
        "--out",
        cell.dir,
        ...(argv["force-execute"] ? ["--force"] : []),
      ],
      { OPENCODE_BENCH_AGENT_PROMPT: promptText },
    );
    stage1 = exitCode === 0 ? "executed" : "execute-failed";
    if (exitCode !== 0) {
      results.push({
        ...cell,
        status: stage1,
        exitCode,
        durationMs: Date.now() - t0,
      });
      console.log(
        `[${cell.arm}/${cell.task}/ep${cell.episode}] ${stage1} (exit=${exitCode})`,
      );
      continue;
    }
  }

  // Stage 2: score
  if (argv["skip-score"]) {
    results.push({
      ...cell,
      status: stage1,
      durationMs: Date.now() - t0,
    });
    console.log(`[${cell.arm}/${cell.task}/ep${cell.episode}] ${stage1}`);
    continue;
  }

  const scoresPath = join(cell.dir, "scores.json");
  let stage2: CellResult["status"];
  let scoreSetMatches = false;
  if (existsSync(scoresPath)) {
    try {
      const j = JSON.parse(await readFile(scoresPath, "utf8"));
      scoreSetMatches = j.judge_set_id === argv["judge-set-id"];
    } catch {}
  }
  if (scoreSetMatches && !argv["force-score"]) {
    stage2 = "score-skipped";
  } else {
    const exitCode = await runChild([
      "score",
      cell.dir,
      "--judge-set-id",
      argv["judge-set-id"],
      ...(argv["force-score"] ? ["--force"] : []),
    ]);
    stage2 = exitCode === 0 ? "scored" : "score-failed";
    if (exitCode !== 0) {
      results.push({
        ...cell,
        status: stage2,
        exitCode,
        durationMs: Date.now() - t0,
      });
      console.log(
        `[${cell.arm}/${cell.task}/ep${cell.episode}] ${stage1} → ${stage2} (exit=${exitCode})`,
      );
      continue;
    }
  }

  results.push({
    ...cell,
    status: stage2,
    durationMs: Date.now() - t0,
  });
  console.log(
    `[${cell.arm}/${cell.task}/ep${cell.episode}] ${stage1} → ${stage2} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}

console.log("\n=== Matrix complete ===");
const counts: Record<string, number> = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

if (argv.analyze) {
  console.log("\nRunning stage 3 analyze...");
  const analyzeArgs = ["analyze", expRoot];
  if (argv.baseline) analyzeArgs.push("--baseline", argv.baseline);
  if (argv.arms) analyzeArgs.push("--arms", argv.arms);
  await runChild(analyzeArgs);
}

const failed = results.filter((r) => r.status.endsWith("-failed"));
if (failed.length) process.exit(1);

async function resolveArms(
  root: string,
  argArms: string | undefined,
): Promise<string[]> {
  if (argArms) return argArms.split(",").map((s) => s.trim());
  const ents = await readdir(root, { withFileTypes: true }).catch(() => []);
  const arms: string[] = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("_")) continue;
    if (existsSync(join(root, e.name, "prompt.txt"))) arms.push(e.name);
  }
  arms.sort();
  return arms;
}

function runChild(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<number>((resolveExit) => {
    const child = spawn("bun", ["run", "cli.ts", ...args], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("exit", (code) => resolveExit(code ?? 1));
    child.on("error", () => resolveExit(1));
  });
}
