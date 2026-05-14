#!/usr/bin/env bun
import process from "node:process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Agent } from "~/src/agents/index.js";
import { Task } from "~/src/tasks/index.js";
import { Summarizer } from "~/src/summarizer.js";
import { Logger } from "~/src/util/logger.js";
import { Eval } from "./src/eval.js";
import { Analysis } from "./src/analysis.js";

const cli = yargs(hideBin(process.argv))
  .scriptName("orvl")
  .wrap(null)
  .version(false)
  .help("help", "show help")
  .alias("help", "h")
  .strict();

cli.command(
  "generate",
  "Generate dataset for all tasks",
  async (yargs) =>
    yargs.example([["orvl generate", "Generate dataset for all tasks"]]),
  async () => {
    const logger = Logger.create("[generate]");
    await Task.generate({ logger });
  },
);

cli.command(
  "run <agent>",
  "Stage 1 — execute agent on task; persist execution.json + diff.patch (+ run.log)",
  async (yargs) =>
    yargs
      .positional("agent", {
        type: "string",
        choices: Agent.list().map((a) => a.name),
        required: true,
      })
      .option("model", { type: "string", required: true })
      .option("task", { type: "string", required: true })
      .option("out", {
        type: "string",
        required: true,
        description: "output directory for execution.json",
      })
      .option("force", {
        type: "boolean",
        default: false,
        description: "re-run even if execution.json exists",
      })
      .option("no-log", {
        type: "boolean",
        default: false,
        description: "do not write run.log next to execution.json",
      }),
  async ({ agent, model, task, out, force, "no-log": noLog }) => {
    if (!agent) throw new Error("Agent name is required");
    const execPath = join(out, "execution.json");
    if (existsSync(execPath) && !force) {
      console.log(`SKIP: ${execPath} already exists (pass --force to re-run)`);
      return;
    }
    if (!noLog) Logger.attachFileSink(join(out, "run.log"));
    const logger = Logger.create(`[run ${model}]`);
    const execution = await Eval.execute(agent, model, task, { logger });
    await Eval.saveExecution(execution, out);
    logger.log(`Wrote ${execPath}`);
    logger.log(
      `Mechanism: text=${execution.mechanism.text_chars}c reasoning=${execution.mechanism.reasoning_chars}c tools=${execution.mechanism.tool_calls} parts=${execution.mechanism.total_parts}`,
    );
  },
);

cli.command(
  "score <ep_dir>",
  "Stage 2 — read execution.json, run judges; persist scores.json (+ score.log)",
  async (yargs) =>
    yargs
      .positional("ep_dir", { type: "string", required: true })
      .option("judge-set-id", { type: "string", default: "default" })
      .option("force", {
        type: "boolean",
        default: false,
        description: "re-score even if scores.json exists",
      })
      .option("no-log", {
        type: "boolean",
        default: false,
        description: "do not write score.log next to scores.json",
      }),
  async ({
    ep_dir,
    "judge-set-id": judgeSetId,
    force,
    "no-log": noLog,
  }) => {
    if (!ep_dir) throw new Error("ep_dir required");
    const scoresPath = join(ep_dir, "scores.json");
    if (existsSync(scoresPath) && !force) {
      const existing = JSON.parse(await readFile(scoresPath, "utf8"));
      if (existing.judge_set_id === judgeSetId) {
        console.log(
          `SKIP: ${scoresPath} already scored with judge_set_id=${judgeSetId}`,
        );
        return;
      }
    }
    if (!noLog) Logger.attachFileSink(join(ep_dir, "score.log"));
    const logger = Logger.create(`[score ${ep_dir}]`);
    const execution = await Eval.loadExecution(ep_dir);
    const scores = await Eval.score(execution, { logger, judgeSetId });
    await Eval.saveScores(scores, ep_dir);
    logger.log(`Wrote ${scoresPath} → final=${scores.score.final.toFixed(3)}`);
  },
);

cli.command(
  "analyze <root>",
  "Stage 3 — aggregate execution+scores; emit summary.json + attribution.md",
  async (yargs) =>
    yargs
      .positional("root", {
        type: "string",
        required: true,
        description: "experiments root (one level above arm dirs)",
      })
      .option("baseline", {
        type: "string",
        description: "arm directory name to use as baseline for Δ",
      })
      .option("arms", {
        type: "string",
        description: "comma-separated arm names; default = all subdirs",
      })
      .option("out", {
        type: "string",
        description: "output directory; default = <root>/_analysis",
      }),
  async ({ root, baseline, arms, out }) => {
    if (!root) throw new Error("root required");
    const armsFilter = arms ? arms.split(",").map((s) => s.trim()) : undefined;
    const outDir = out ?? join(root, "_analysis");
    const records = await Analysis.collect(root, { armsFilter });
    if (records.length === 0) {
      console.log("No execution.json files found under", root);
      return;
    }
    const summary = Analysis.buildSummary(root, records, {
      baseline: baseline ?? null,
    });
    await Analysis.write(summary, outDir);
    console.log(`Wrote ${join(outDir, "summary.json")}`);
    console.log(`Wrote ${join(outDir, "attribution.md")}`);
    console.log(
      `${summary.cells.length} cells across ${summary.arms.length} arms (${records.length} episodes total)`,
    );
    if (baseline) {
      console.log(`Computed Δ for ${summary.deltas.length} non-baseline cells.`);
    }
    if (summary.judge_disagreement_hotspots.length) {
      console.log(
        `${summary.judge_disagreement_hotspots.length} judge-disagreement hotspot(s).`,
      );
    }
  },
);

cli.command(
  "aggregate <root>",
  "[deprecated] alias for `analyze`; prints a summary table to stdout",
  async (yargs) =>
    yargs
      .positional("root", { type: "string", required: true })
      .option("out", { type: "string" })
      .option("baseline", { type: "string" }),
  async ({ root, out, baseline }) => {
    if (!root) throw new Error("root required");
    const records = await Analysis.collect(root, {});
    const summary = Analysis.buildSummary(root, records, {
      baseline: baseline ?? null,
    });
    if (out) {
      await writeFile(out, JSON.stringify(summary, null, 2));
      console.log(`Wrote ${out}`);
    }
    console.log(Analysis.renderMarkdown(summary));
  },
);

// Backwards compat: `orvl <agent> --model X --task Y` runs stages 1+2 in-process, no persistence.
cli.command(
  "$0 [agent]",
  "One-shot run: execute + score, no persistence (use `run` + `score` for caching)",
  async (yargs) =>
    yargs
      .positional("agent", {
        type: "string",
        choices: Agent.list().map((a) => a.name),
        required: true,
      })
      .option("model", { type: "string", required: true })
      .option("task", { type: "string", required: true }),
  async ({ agent: agentName, model: modelId, task: taskId }) => {
    if (!agentName) throw new Error("Agent name is required");
    const logger = Logger.create(`[model ${modelId}]`);
    const result = await Eval.run(agentName, modelId, taskId, { logger });

    const summary = await Summarizer.summarizeRuns([result]);
    const fmtUsage = (u: { input: number; output: number }) =>
      `${u.input} input / ${u.output} output`;
    const fmtScore = (s: Eval.Result["score"]) =>
      `${s.final.toFixed(3)} (base ${s.base.toFixed(3)} - penalty ${s.penalty.toFixed(3)})`;

    logger.log(`Final score: ${summary.averageScore.toFixed(3)}`);
    logger.log(`Avg duration: ${(summary.averageDuration / 1000).toFixed(0)}s`);
    logger.log(`Avg usage: ${fmtUsage(summary.averageUsage)}`);
    logger.log(`Avg cost: $${summary.averageUsage.cost.toFixed(2)}`);
    logger.log(`  Score: ${fmtScore(result.score)}`);
    logger.log(
      `  Mechanism: text=${result.mechanism.text_chars}c reasoning=${result.mechanism.reasoning_chars}c tools=${result.mechanism.tool_calls} parts=${result.mechanism.total_parts}`,
    );
  },
);

try {
  await cli.parse();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  const agents = Agent.list();
  for (const agent of agents) {
    if (agent.definition.cleanup) {
      await agent.definition.cleanup();
    }
  }
  process.exit();
}
