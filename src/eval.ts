import { z } from "zod";
import { $ } from "bun";
import { generateObject } from "ai";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { Database } from "bun:sqlite";
import { Logger } from "./util/logger.js";
import { Task } from "./tasks/index.js";
import { Agent } from "./agents/index.js";
import { Metric } from "./metrics/index.js";
import { average, variance, weightedSum } from "./util/math.js";
import { Judge } from "./judges.js";
import { getZenLanguageModel } from "./zenModels.js";
import { withRetries } from "./util/retry.js";

export namespace Eval {
  export const DISAGREEMENT_PENALTY = 0.5;

  export interface Execution {
    schema_version: 1;
    task: string;
    model: string;
    agent: string;
    session_ids: string[];
    duration_ms: number;
    usage: { input: number; output: number; cost: number };
    diff: string;
    before_results: Record<string, Metric.CommandExecution[]>;
    after_results: Record<string, Metric.CommandExecution[]>;
    parts: any[];
    mechanism: ReturnType<typeof computeMechanismMetricsFromParts>;
    timestamp: string;
  }

  export interface Scores {
    schema_version: 1;
    judge_set: string[];
    judge_set_id: string;
    scored_at: string;
    criteria: Array<{
      name: string;
      weight: number;
      judges: Array<{ judge: string; score: number; rationale: string }>;
      average: number;
      variance: number;
    }>;
    score: { base: number; penalty: number; final: number };
  }

  export type Result = Execution & {
    score: Scores["score"];
    scoreDetails: Scores["criteria"];
  };

  export async function run(
    agentName: string,
    modelId: string,
    taskId: string,
    opts: { logger: Logger.Instance },
  ): Promise<Result> {
    const exec = await execute(agentName, modelId, taskId, opts);
    const scores = await score(exec, { logger: opts.logger });
    return {
      ...exec,
      score: scores.score,
      scoreDetails: scores.criteria,
    };
  }

  export async function execute(
    agentName: string,
    modelId: string,
    taskId: string,
    opts: { logger: Logger.Instance },
  ): Promise<Execution> {
    const timeoutMins = 20;
    opts.logger.log(`Starting episode with ${timeoutMins}min timeout...`);
    return await withRetries(
      () => executeOnce(agentName, modelId, taskId, { logger: opts.logger }),
      {
        retries: 3,
        timeoutMs: timeoutMins * 60 * 1000,
        logger: opts.logger,
      },
    );
  }

  async function executeOnce(
    agentName: string,
    modelId: string,
    taskId: string,
    opts: { logger: Logger.Instance },
  ): Promise<Execution> {
    const agent = Agent.get(agentName);
    Agent.validateModel(agent, modelId);
    const task = await Task.get(taskId);
    const cwd = await mkdtemp(join(tmpdir(), "openreval-"));
    $.cwd(cwd);

    try {
      opts.logger.log(`Cloning repository to ${cwd}...`);
      await cloneRepositoryAtCommit(task.source.repo, task.source.from, cwd);

      opts.logger.log(`Running pre-task commands...`);
      const beforeResults: Record<string, Metric.CommandExecution[]> = {};
      for (const { name, args } of task.metrics) {
        if (!args) continue;
        const cl = opts.logger.child(`[criterion ${name}]`);
        await runCommands(args.setup, { logger: cl, cwd });
        const results = await runCommands(args.commands, { logger: cl, cwd });
        beforeResults[name] = results;
      }

      opts.logger.log(`Running task...`);
      let duration = 0;
      const usage = { input: 0, output: 0, cost: 0 };
      const sessionIds = new Set<string>();
      for (const { commit, prompt } of task.prompts) {
        const cl = opts.logger.child(
          `[prompt ${task.source.repo.split("/")[1]}@${commit.slice(0, 7)}]`,
        );

        const startedAt = Date.now();
        const result = await agent.definition.run(modelId, prompt, {
          cwd,
          logger: cl,
        });
        duration += Date.now() - startedAt;

        usage.input += result.usage.input;
        usage.output += result.usage.output;
        usage.cost += result.usage.cost;

        // Extract session ID from first action (the message info)
        if (result.actions.length > 0) {
          try {
            const info = JSON.parse(result.actions[0]);
            if (info?.sessionID) sessionIds.add(info.sessionID);
          } catch {}
        }
      }

      opts.logger.log(`Finalizing changes...`);
      await finalizeChanges(task.source.from);
      const diff = await generateDiff(task.source.from);

      opts.logger.log(`Running post-task commands...`);
      const afterResults: Record<string, Metric.CommandExecution[]> = {};
      for (const { name, args } of task.metrics) {
        if (!args) continue;
        const cl = opts.logger.child(`[metric ${name}]`);
        afterResults[name] = await runCommands(args.commands, { logger: cl, cwd });
      }

      const sessionIdList = Array.from(sessionIds);
      const parts = await fetchPartsFromOpencodeDB(sessionIdList, opts.logger);
      const mechanism = computeMechanismMetricsFromParts(parts);
      opts.logger.log(
        `Mechanism: text=${mechanism.text_chars}c reasoning=${mechanism.reasoning_chars}c tools=${mechanism.tool_calls} parts=${mechanism.total_parts}`,
      );

      return {
        schema_version: 1,
        task: taskId,
        model: modelId,
        agent: agentName,
        session_ids: sessionIdList,
        duration_ms: duration,
        usage,
        diff,
        before_results: beforeResults,
        after_results: afterResults,
        parts,
        mechanism,
        timestamp: new Date().toISOString(),
      };
    } finally {
      await cleanupRepository(cwd, opts.logger);
    }
  }

  export async function score(
    execution: Execution,
    opts: { logger: Logger.Instance; judgeSet?: string[]; judgeSetId?: string },
  ): Promise<Scores> {
    const judgeSet = opts.judgeSet ?? Judge.all;
    const judgeSetId = opts.judgeSetId ?? "default";
    const task = await Task.get(execution.task);
    opts.logger.log(`Scoring with judges: ${judgeSet.join(", ")}`);

    const criteria: Scores["criteria"] = [];
    for (const { name, weight } of task.metrics) {
      const cl = opts.logger.child(`[metric ${name}]`);
      const judgeResults = [];
      for (const judge of judgeSet) {
        const ccl = cl.child(`[judge ${judge}]`);
        let result;
        try {
          result = await judgeScore(
            name,
            judge,
            {
              expectedDiff: task.diff,
              actualDiff: execution.diff,
              beforeResults: execution.before_results[name],
              afterResults: execution.after_results[name],
            },
            { logger: ccl },
          );
        } catch (e: any) {
          result = { score: 0, rationale: String(e.message) };
        }
        judgeResults.push({ judge, score: result.score, rationale: result.rationale });
      }
      const avg = average(judgeResults.map((s) => s.score));
      const vrc = variance(avg, judgeResults.map((s) => s.score));
      criteria.push({ name, weight, judges: judgeResults, average: avg, variance: vrc });
    }

    const base = weightedSum(criteria.map(({ average, weight }) => ({ value: average, weight })));
    const vrcWeighted = weightedSum(criteria.map(({ variance, weight }) => ({ value: variance, weight })));
    const penalty = DISAGREEMENT_PENALTY * vrcWeighted;
    const final = Math.max(0, base - penalty);
    opts.logger.log(`Score: ${final.toFixed(3)} (base ${base.toFixed(3)} - penalty ${penalty.toFixed(3)})`);

    return {
      schema_version: 1,
      judge_set: judgeSet,
      judge_set_id: judgeSetId,
      scored_at: new Date().toISOString(),
      criteria,
      score: { base, penalty, final },
    };
  }

  export async function saveExecution(execution: Execution, dir: string) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "execution.json"), JSON.stringify(execution, null, 2));
    await writeFile(join(dir, "diff.patch"), execution.diff);
  }

  export async function loadExecution(dir: string): Promise<Execution> {
    const raw = await readFile(join(dir, "execution.json"), "utf8");
    return JSON.parse(raw) as Execution;
  }

  export async function saveScores(scores: Scores, dir: string) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "scores.json"), JSON.stringify(scores, null, 2));
  }

  function computeMechanismMetricsFromParts(parts: any[]) {
    let textChars = 0;
    let reasoningChars = 0;
    let toolCalls = 0;
    const toolBreakdown: Record<string, number> = {};
    let totalParts = 0;
    for (const p of parts) {
      if (!p || typeof p !== "object" || typeof p.type !== "string") continue;
      totalParts++;
      if (p.type === "text" && typeof p.text === "string") textChars += p.text.length;
      else if (p.type === "reasoning" && typeof p.text === "string") reasoningChars += p.text.length;
      else if (p.type === "tool") {
        toolCalls++;
        const t = typeof p.tool === "string" ? p.tool : "unknown";
        toolBreakdown[t] = (toolBreakdown[t] ?? 0) + 1;
      }
    }
    return {
      text_chars: textChars,
      reasoning_chars: reasoningChars,
      tool_calls: toolCalls,
      tool_breakdown: toolBreakdown,
      total_parts: totalParts,
    };
  }

  async function fetchPartsFromOpencodeDB(
    sessionIds: string[],
    logger: Logger.Instance,
  ): Promise<any[]> {
    if (sessionIds.length === 0) return [];
    const dbPath = join(homedir(), ".local/share/opencode/opencode.db");
    if (!existsSync(dbPath)) {
      logger.log(`opencode.db not found at ${dbPath}, parts will be empty`);
      return [];
    }
    try {
      const db = new Database(dbPath, { readonly: true });
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT data FROM part WHERE session_id IN (${placeholders}) ORDER BY time_created`,
        )
        .all(...sessionIds) as Array<{ data: string }>;
      db.close();
      return rows.map((r) => {
        try {
          return JSON.parse(r.data);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (e) {
      logger.log(`Failed to fetch parts from opencode.db: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  async function finalizeChanges(baselineCommit: string) {
    try {
      await $`git config user.email "opencode-bench@example.com"`.quiet();
      await $`git config user.name "opencode-bench"`.quiet();
    } catch (error) {
      console.error(
        "Failed to configure git user for agent diff:",
        error instanceof Error ? error.message : error,
      );
    }

    try {
      await $`git add --all`.quiet();
    } catch (e) {
      console.error(
        "Failed to stage agent changes:",
        e instanceof Error ? e.message : e,
      );
    }

    let hasStagedChanges = false;
    try {
      await $`git diff --cached --quiet`.quiet();
    } catch {
      hasStagedChanges = true;
    }

    if (hasStagedChanges) {
      try {
        await $`git commit --no-verify -m "opencode-bench-agent-snapshot"`.quiet();
      } catch (e) {
        console.error("Failed to commit agent changes:", e);
      }
    }

    try {
      await $`git diff --exit-code ${baselineCommit} HEAD`.quiet();
      return false;
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "exitCode" in e &&
        (e as { exitCode?: number }).exitCode === 1
      ) {
        return true;
      }

      console.error(
        "Failed to check final agent diff:",
        e instanceof Error ? e.message : e,
      );
      return false;
    }
  }

  async function generateDiff(baselineCommit: string) {
    let diff;
    try {
      diff = (
        await $`git diff --unified=5 ${baselineCommit} HEAD`.text()
      ).trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to generate diff:", msg);
      throw e;
    }

    if (diff.length === 0) throw new Error("Diff is empty");
    return diff;
  }

  async function judgeScore(
    criterionName: string,
    judge: string,
    context: Metric.Context,
    opts: { logger: Logger.Instance },
  ) {
    opts.logger.log("Judging...");
    try {
      const c = Metric.all[criterionName as keyof typeof Metric.all];
      const { object } = await generateObject({
        model: getZenLanguageModel(judge),
        schema: z.object({
          score: z.number().refine((val) => val === 0 || val === 1, {
            message: "Score must be binary: 0 (fail) or 1 (pass)",
          }),
          rationale: z.string().min(1),
        }),
        system: c.systemPrompt,
        temperature: 0,
        prompt: c.createUserPrompt(context),
      });
      if (!object || typeof object !== "object")
        throw new Error("Score evaluators must return an object.");
      if (typeof object.score !== "number")
        throw new Error("Score evaluators must return a number.");
      if (typeof object.rationale !== "string" || object.rationale.length === 0)
        throw new Error("Score evaluators must include a rationale string.");
      if (object.score < 0 || object.score > 1)
        throw new Error(
          "Score evaluators must return a score between 0 and 1.",
        );

      opts.logger.log("Judge result:", object);
      return object;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to judge score:", msg);
      throw e;
    }
  }

  async function runCommands(
    commands: string[],
    opts: { logger: Logger.Instance; cwd: string },
  ) {
    const results = [];

    for (const command of commands) {
      opts.logger.log(command);
      const result = await runCommand(command, opts.cwd);
      opts.logger.log(...formatExecutionForLog(result).split("\n"));
      results.push(result);
    }

    return results;
  }

  async function runCommand(command: string, cwd: string) {
    const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

    const start = Date.now();

    return await new Promise<Metric.CommandExecution>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: {
          ...process.env,
          CI: process.env.CI ?? "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let errorMessage: string | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let settled = false;

      timeout = setTimeout(() => {
        errorMessage = `Timed out after ${COMMAND_TIMEOUT_MS}ms`;
        child.kill("SIGKILL");
      }, COMMAND_TIMEOUT_MS);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        errorMessage = error.message;
      });

      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : null;
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);

        const runtimeMs = Date.now() - start;
        const success = exitCode === 0 && !errorMessage;

        resolve({
          command,
          success,
          exitCode,
          stdout,
          stderr,
          runtimeMs,
          errorMessage,
        });
      });
    });
  }

  function formatExecutionForLog(execution: Metric.CommandExecution): string {
    const status = execution.success ? "PASS" : "FAIL";
    const exitInfo =
      execution.exitCode !== null
        ? `exit ${execution.exitCode}`
        : "no exit code";
    const duration = `${execution.runtimeMs}ms`;
    const error = execution.errorMessage
      ? ` error: ${execution.errorMessage}`
      : "";

    return `${status} (${exitInfo}, ${duration})${error}`;
  }

  const CACHE_DIR = join(process.cwd(), ".cache", "repos");

  async function cloneRepositoryAtCommit(repo: string, commitSha: string, cwd: string) {
    const cachedRepo = join(CACHE_DIR, repo);
    if (existsSync(join(cachedRepo, ".git"))) {
      await $`cp -R ${cachedRepo}/. ${cwd}/`.quiet();
      await $`git checkout ${commitSha}`.cwd(cwd).quiet();
      return;
    }
    await $`git clone https://github.com/${repo}.git ${cachedRepo}`.quiet();
    await $`cp -R ${cachedRepo}/. ${cwd}/`.quiet();
    await $`git checkout ${commitSha}`.cwd(cwd).quiet();
  }

  async function cleanupRepository(
    cwd: string,
    logger: Logger.Instance,
  ): Promise<void> {
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch (e) {
      logger.error(
        `Failed to clean up temporary repo:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}
