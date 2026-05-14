import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { Eval } from "./eval.js";

export namespace Analysis {
  export const VARIANCE_BAR_MIN_EPISODES = 3;
  export const JUDGE_DISAGREEMENT_VAR_THRESHOLD = 0.2;

  export interface CellStat {
    arm: string;
    task: string;
    episodes: number;
    meets_variance_bar: boolean;
    final: Stat;
    base: Stat;
    penalty: Stat;
    duration_s: Stat;
    cost_usd: Stat;
    text_chars: Stat;
    reasoning_chars: Stat;
    tool_calls: Stat;
    total_parts: Stat;
    criteria: Record<
      string,
      { weight: number; mean: number; std: number; judge_var: number }
    >;
    /** Episode dirs that contributed to this cell. */
    sources: string[];
  }

  export interface ArmStat {
    arm: string;
    tasks: string[];
    episodes_total: number;
    cells_meeting_variance_bar: number;
    final_mean: number;
    final_std_across_tasks: number;
  }

  export interface DeltaCell {
    arm: string;
    task: string;
    delta_final: number;
    delta_per_criterion: Record<string, number>;
    delta_text_chars: number;
    delta_reasoning_chars: number;
    delta_tool_calls: number;
  }

  export interface Summary {
    schema_version: 1;
    generated_at: string;
    root: string;
    baseline: string | null;
    arms: ArmStat[];
    cells: CellStat[];
    deltas: DeltaCell[];
    /** Cells with judge variance > threshold on at least one criterion. */
    judge_disagreement_hotspots: Array<{
      arm: string;
      task: string;
      criterion: string;
      judge_var: number;
    }>;
  }

  export interface Stat {
    n: number;
    mean: number;
    std: number;
    min: number;
    max: number;
  }

  function stat(values: number[]): Stat {
    const filtered = values.filter((v) => Number.isFinite(v));
    if (filtered.length === 0) {
      return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN };
    }
    const n = filtered.length;
    const mean = filtered.reduce((a, b) => a + b, 0) / n;
    const std =
      n < 2
        ? 0
        : Math.sqrt(
            filtered.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1),
          );
    return {
      n,
      mean,
      std,
      min: Math.min(...filtered),
      max: Math.max(...filtered),
    };
  }

  type EpisodeRecord = {
    arm: string;
    task: string;
    epDir: string;
    execution: Eval.Execution;
    scores: Eval.Scores | null;
  };

  export async function collect(
    root: string,
    opts: { armsFilter?: string[] } = {},
  ): Promise<EpisodeRecord[]> {
    const records: EpisodeRecord[] = [];
    const armEntries = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const armEnt of armEntries) {
      if (!armEnt.isDirectory()) continue;
      if (armEnt.name.startsWith("_")) continue;
      if (opts.armsFilter && !opts.armsFilter.includes(armEnt.name)) continue;

      const armPath = join(root, armEnt.name);
      const taskEntries = await readdir(armPath, {
        withFileTypes: true,
      }).catch(() => []);
      for (const taskEnt of taskEntries) {
        if (!taskEnt.isDirectory()) continue;
        const taskPath = join(armPath, taskEnt.name);
        const epEntries = await readdir(taskPath, {
          withFileTypes: true,
        }).catch(() => []);
        for (const epEnt of epEntries) {
          if (!epEnt.isDirectory()) continue;
          const epDir = join(taskPath, epEnt.name);
          const execPath = join(epDir, "execution.json");
          if (!existsSync(execPath)) continue;
          let execution: Eval.Execution;
          try {
            execution = JSON.parse(await readFile(execPath, "utf8"));
          } catch {
            continue;
          }
          const scoresPath = join(epDir, "scores.json");
          let scores: Eval.Scores | null = null;
          if (existsSync(scoresPath)) {
            try {
              scores = JSON.parse(await readFile(scoresPath, "utf8"));
            } catch {
              scores = null;
            }
          }
          records.push({
            arm: armEnt.name,
            task: taskEnt.name,
            epDir,
            execution,
            scores,
          });
        }
      }
    }
    return records;
  }

  export function buildSummary(
    root: string,
    records: EpisodeRecord[],
    opts: { baseline?: string | null } = {},
  ): Summary {
    const baseline = opts.baseline ?? null;
    const byCell = new Map<string, EpisodeRecord[]>();
    for (const r of records) {
      const k = `${r.arm}|${r.task}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(r);
    }

    const cells: CellStat[] = [];
    const hotspots: Summary["judge_disagreement_hotspots"] = [];

    for (const [, recs] of byCell) {
      const cell = computeCell(recs);
      cells.push(cell);
      for (const [name, c] of Object.entries(cell.criteria)) {
        if (c.judge_var > JUDGE_DISAGREEMENT_VAR_THRESHOLD) {
          hotspots.push({
            arm: cell.arm,
            task: cell.task,
            criterion: name,
            judge_var: c.judge_var,
          });
        }
      }
    }

    cells.sort((a, b) =>
      a.arm === b.arm ? a.task.localeCompare(b.task) : a.arm.localeCompare(b.arm),
    );

    const arms: ArmStat[] = computeArmStats(cells);

    const deltas: DeltaCell[] = [];
    if (baseline) {
      const baselineByTask = new Map<string, CellStat>();
      for (const c of cells.filter((c) => c.arm === baseline)) {
        baselineByTask.set(c.task, c);
      }
      for (const c of cells) {
        if (c.arm === baseline) continue;
        const b = baselineByTask.get(c.task);
        if (!b) continue;
        const deltaCriterion: Record<string, number> = {};
        for (const name of Object.keys(c.criteria)) {
          const armC = c.criteria[name];
          const bC = b.criteria[name];
          if (armC && bC) deltaCriterion[name] = armC.mean - bC.mean;
        }
        deltas.push({
          arm: c.arm,
          task: c.task,
          delta_final: c.final.mean - b.final.mean,
          delta_per_criterion: deltaCriterion,
          delta_text_chars: c.text_chars.mean - b.text_chars.mean,
          delta_reasoning_chars: c.reasoning_chars.mean - b.reasoning_chars.mean,
          delta_tool_calls: c.tool_calls.mean - b.tool_calls.mean,
        });
      }
    }

    hotspots.sort((a, b) => b.judge_var - a.judge_var);

    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      root,
      baseline,
      arms,
      cells,
      deltas,
      judge_disagreement_hotspots: hotspots,
    };
  }

  function computeCell(records: EpisodeRecord[]): CellStat {
    const arm = records[0].arm;
    const task = records[0].task;
    const withScores = records.filter((r) => r.scores);
    const finalScores = withScores.map((r) => r.scores!.score.final);
    const baseScores = withScores.map((r) => r.scores!.score.base);
    const penaltyScores = withScores.map((r) => r.scores!.score.penalty);
    const durations = records.map((r) => r.execution.duration_ms / 1000);
    const costs = records.map((r) => r.execution.usage.cost ?? 0);
    const text = records.map((r) => r.execution.mechanism?.text_chars ?? 0);
    const reasoning = records.map(
      (r) => r.execution.mechanism?.reasoning_chars ?? 0,
    );
    const tools = records.map((r) => r.execution.mechanism?.tool_calls ?? 0);
    const totalParts = records.map(
      (r) => r.execution.mechanism?.total_parts ?? 0,
    );

    const criteria: CellStat["criteria"] = {};
    if (withScores.length > 0) {
      const criterionNames = withScores[0].scores!.criteria.map((c) => c.name);
      for (const name of criterionNames) {
        const perEp: number[] = [];
        const perEpVar: number[] = [];
        let weight = 0;
        for (const r of withScores) {
          const c = r.scores!.criteria.find((c) => c.name === name);
          if (!c) continue;
          perEp.push(c.average);
          perEpVar.push(c.variance);
          weight = c.weight;
        }
        const mean = perEp.length ? perEp.reduce((a, b) => a + b, 0) / perEp.length : 0;
        const std =
          perEp.length < 2
            ? 0
            : Math.sqrt(
                perEp.reduce((a, b) => a + (b - mean) ** 2, 0) /
                  (perEp.length - 1),
              );
        const judgeVar = perEpVar.length
          ? perEpVar.reduce((a, b) => a + b, 0) / perEpVar.length
          : 0;
        criteria[name] = { weight, mean, std, judge_var: judgeVar };
      }
    }

    const episodes = records.length;
    return {
      arm,
      task,
      episodes,
      meets_variance_bar: episodes >= VARIANCE_BAR_MIN_EPISODES,
      final: stat(finalScores),
      base: stat(baseScores),
      penalty: stat(penaltyScores),
      duration_s: stat(durations),
      cost_usd: stat(costs),
      text_chars: stat(text),
      reasoning_chars: stat(reasoning),
      tool_calls: stat(tools),
      total_parts: stat(totalParts),
      criteria,
      sources: records.map((r) => r.epDir),
    };
  }

  function computeArmStats(cells: CellStat[]): ArmStat[] {
    const byArm = new Map<string, CellStat[]>();
    for (const c of cells) {
      if (!byArm.has(c.arm)) byArm.set(c.arm, []);
      byArm.get(c.arm)!.push(c);
    }
    const out: ArmStat[] = [];
    for (const [arm, list] of byArm) {
      const taskMeans = list.map((c) => c.final.mean).filter(Number.isFinite);
      const meta = stat(taskMeans);
      out.push({
        arm,
        tasks: list.map((c) => c.task).sort(),
        episodes_total: list.reduce((a, b) => a + b.episodes, 0),
        cells_meeting_variance_bar: list.filter((c) => c.meets_variance_bar)
          .length,
        final_mean: meta.mean,
        final_std_across_tasks: meta.std,
      });
    }
    out.sort((a, b) => a.arm.localeCompare(b.arm));
    return out;
  }

  export async function write(summary: Summary, outDir: string) {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    await writeFile(join(outDir, "attribution.md"), renderMarkdown(summary));
  }

  function fmtMS(s: Stat): string {
    if (!Number.isFinite(s.mean)) return "  -  ";
    if (s.n < 2) return s.mean.toFixed(3);
    return `${s.mean.toFixed(3)}±${s.std.toFixed(3)}`;
  }

  function fmtSigned(v: number): string {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(3)}`;
  }

  export function renderMarkdown(s: Summary): string {
    const tasks = Array.from(new Set(s.cells.map((c) => c.task))).sort();
    const arms = Array.from(new Set(s.cells.map((c) => c.arm))).sort();

    const out: string[] = [];
    out.push(`# Stage 3 attribution`);
    out.push("");
    out.push(`Generated at \`${s.generated_at}\` from \`${s.root}\`.`);
    out.push(`Variance bar: ≥${VARIANCE_BAR_MIN_EPISODES} episodes per cell.`);
    if (s.baseline) out.push(`Baseline arm: \`${s.baseline}\`.`);
    out.push("");

    out.push(`## 1. Final score per arm × task (mean ± std, n)`);
    out.push("");
    const header1 = ["arm", ...tasks, "arm-mean"];
    out.push(`| ${header1.join(" | ")} |`);
    out.push(`| ${header1.map(() => "---").join(" | ")} |`);
    for (const arm of arms) {
      const row = [arm];
      for (const task of tasks) {
        const cell = s.cells.find((c) => c.arm === arm && c.task === task);
        if (!cell) {
          row.push("—");
          continue;
        }
        const compliance = cell.meets_variance_bar ? "" : " ⚠";
        row.push(`${fmtMS(cell.final)} (n=${cell.final.n})${compliance}`);
      }
      const armStat = s.arms.find((a) => a.arm === arm);
      row.push(armStat ? armStat.final_mean.toFixed(3) : "—");
      out.push(`| ${row.join(" | ")} |`);
    }
    out.push("");
    out.push(`> ⚠ marks cells with n < ${VARIANCE_BAR_MIN_EPISODES} — not headline-eligible per project rules.`);
    out.push("");

    if (s.baseline && s.deltas.length) {
      out.push(`## 2. Δfinal vs baseline \`${s.baseline}\``);
      out.push("");
      const armsNonBaseline = arms.filter((a) => a !== s.baseline);
      const header2 = ["arm", ...tasks];
      out.push(`| ${header2.join(" | ")} |`);
      out.push(`| ${header2.map(() => "---").join(" | ")} |`);
      for (const arm of armsNonBaseline) {
        const row = [arm];
        for (const task of tasks) {
          const d = s.deltas.find((d) => d.arm === arm && d.task === task);
          row.push(d ? fmtSigned(d.delta_final) : "—");
        }
        out.push(`| ${row.join(" | ")} |`);
      }
      out.push("");

      out.push(`## 3. Per-criterion attribution (Δmean vs baseline)`);
      out.push("");
      const allCriteria = collectCriteria(s.cells);
      for (const arm of armsNonBaseline) {
        out.push(`### Arm \`${arm}\``);
        out.push("");
        const header3 = ["task", ...allCriteria, "Δfinal"];
        out.push(`| ${header3.join(" | ")} |`);
        out.push(`| ${header3.map(() => "---").join(" | ")} |`);
        for (const task of tasks) {
          const d = s.deltas.find((d) => d.arm === arm && d.task === task);
          if (!d) continue;
          const row = [task];
          for (const c of allCriteria) {
            const v = d.delta_per_criterion[c];
            row.push(v == null ? "—" : fmtSigned(v));
          }
          row.push(fmtSigned(d.delta_final));
          out.push(`| ${row.join(" | ")} |`);
        }
        out.push("");
      }
    }

    out.push(`## 4. Mechanism shifts (mean per arm × task)`);
    out.push("");
    out.push(
      `| arm | task | text_chars | reasoning_chars | tool_calls | total_parts | duration_s | cost_usd |`,
    );
    out.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const c of s.cells) {
      out.push(
        `| ${c.arm} | ${c.task} | ${c.text_chars.mean.toFixed(0)} | ${c.reasoning_chars.mean.toFixed(0)} | ${c.tool_calls.mean.toFixed(1)} | ${c.total_parts.mean.toFixed(1)} | ${c.duration_s.mean.toFixed(0)} | ${c.cost_usd.mean.toFixed(4)} |`,
      );
    }
    out.push("");

    if (s.judge_disagreement_hotspots.length) {
      out.push(`## 5. Judge disagreement hotspots (judge_var > ${JUDGE_DISAGREEMENT_VAR_THRESHOLD})`);
      out.push("");
      out.push(`| arm | task | criterion | judge_var |`);
      out.push(`| --- | --- | --- | --- |`);
      for (const h of s.judge_disagreement_hotspots) {
        out.push(
          `| ${h.arm} | ${h.task} | ${h.criterion} | ${h.judge_var.toFixed(3)} |`,
        );
      }
      out.push("");
    }

    out.push(`## 6. Compliance summary (variance bar ≥${VARIANCE_BAR_MIN_EPISODES} episodes)`);
    out.push("");
    out.push(`| arm | episodes_total | cells_meeting_bar | final_mean (across tasks) | std_across_tasks |`);
    out.push(`| --- | --- | --- | --- | --- |`);
    for (const a of s.arms) {
      out.push(
        `| ${a.arm} | ${a.episodes_total} | ${a.cells_meeting_variance_bar} / ${a.tasks.length} | ${Number.isFinite(a.final_mean) ? a.final_mean.toFixed(3) : "—"} | ${Number.isFinite(a.final_std_across_tasks) ? a.final_std_across_tasks.toFixed(3) : "—"} |`,
      );
    }
    out.push("");
    return out.join("\n");
  }

  function collectCriteria(cells: CellStat[]): string[] {
    const set = new Set<string>();
    for (const c of cells) for (const k of Object.keys(c.criteria)) set.add(k);
    return Array.from(set).sort();
  }

  // Suppress unused warning: basename re-exported for callers that compose paths.
  void basename;
}
