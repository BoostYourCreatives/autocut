import fs from "node:fs";
import path from "node:path";
import type { Config, Style } from "../config.ts";
import type { LlmClient } from "../llm/client.ts";
import { ingest } from "../steps/ingest.ts";
import { transcribe } from "../steps/transcribe/index.ts";
import { analyze } from "../steps/analyze.ts";
import { measureChin } from "../steps/chin.ts";
import { plan, planPaths, PlanFailedError } from "../steps/plan.ts";
import { deliver } from "../steps/deliver.ts";
import { validatePlanFile } from "../steps/check.ts";
import { writeRunReport } from "../steps/report.ts";
import { log, logListeners } from "../util/log.ts";
import { runPaths } from "../util/run.ts";
import { exec } from "../util/exec.ts";

export interface JobOptions {
  hookLines?: [string, string];
  transition?: "blitz_riser" | "hart";
  precut: "auto" | boolean;
  provider: "auto" | "openai" | "faster-whisper";
  selfcheck: boolean;
  video?: string;
}

export type JobEvent =
  | { type: "log"; level: "info" | "warn" | "error"; msg: string; t: number }
  | { type: "step"; step: string; status: "start" | "ok" | "error"; t: number }
  | { type: "done"; t: number }
  | { type: "error"; msg: string; t: number };

export interface Job {
  run: string;
  kind: "pipeline" | "rerender" | "replan";
  status: "running" | "done" | "error";
  current: string | null;
  error: string | null;
  events: JobEvent[];
  listeners: Set<(e: JobEvent) => void>;
}

export const STEP_ORDER = ["ingest", "transcribe", "analyze", "chin", "plan", "render"] as const;

export class JobRunner {
  jobs = new Map<string, Job>();
  private busy: string | null = null;
  constructor(private cfg: Config, private style: Style, private llm?: LlmClient) {}

  get busyRun() {
    return this.busy;
  }

  private push(job: Job, e: JobEvent) {
    job.events.push(e);
    for (const l of job.listeners) l(e);
  }

  /** Startet im Hintergrund. Es läuft immer nur ein Job (Rendern belegt den Rechner). */
  start(run: string, kind: Job["kind"], opts: JobOptions, source?: string): Job {
    if (this.busy) throw new Error(`Es läuft schon ein Lauf (${this.busy}). Bitte warten, bis er fertig ist.`);
    const job: Job = { run, kind, status: "running", current: null, error: null, events: [], listeners: new Set() };
    this.jobs.set(run, job);
    this.busy = run;
    void this.execute(job, opts, source).finally(() => (this.busy = null));
    return job;
  }

  private async execute(job: Job, opts: JobOptions, source?: string) {
    const { cfg, style } = this;
    const t = () => Date.now();
    const listener = (level: "info" | "warn" | "error", msg: string) => this.push(job, { type: "log", level, msg, t: t() });
    logListeners.add(listener);
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      job.current = name;
      this.push(job, { type: "step", step: name, status: "start", t: t() });
      try {
        const r = await fn();
        this.push(job, { type: "step", step: name, status: "ok", t: t() });
        return r;
      } catch (e) {
        this.push(job, { type: "step", step: name, status: "error", t: t() });
        throw e;
      }
    };
    const run = runPaths(cfg, job.run);
    const planFile = planPaths(run).plan;
    try {
      if (job.kind === "pipeline") {
        await step("ingest", () => ingest(cfg, style, job.run, { reels: [source!], hooks: [], precut: opts.precut }));
        const provider = opts.provider === "auto" ? (process.env.OPENAI_API_KEY ? "openai" : "faster-whisper") : opts.provider;
        await step("transcribe", () => transcribe(cfg, style, job.run, { provider }));
        await step("analyze", () => analyze(cfg, style, job.run));
        await step("chin", () => measureChin(cfg, style, job.run));
      }
      if (job.kind === "pipeline" || job.kind === "replan") {
        await step("plan", () => plan(cfg, style, job.run, { llm: this.llm, transition: opts.transition, hookLines: opts.hookLines, video: opts.video }));
      }
      // rerender/pipeline/replan: Validator ist schon bestanden bzw. wird hier erneut geprüft
      const v = validatePlanFile(cfg, style, planFile).result;
      if (!v.ok) throw new Error(`Der Plan besteht den Validator nicht (${v.errors.length} Fehler), es wird nicht gerendert.`);
      await step("render", () => deliver(cfg, style, planFile, { selfcheck: opts.selfcheck, llm: this.llm }));
      job.status = "done";
      this.push(job, { type: "done", t: t() });
    } catch (e) {
      job.status = "error";
      job.error = e instanceof PlanFailedError ? `${e.message}` : e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : String(e);
      log.error(job.error);
      this.push(job, { type: "error", msg: job.error, t: t() });
    } finally {
      logListeners.delete(listener);
      job.current = null;
      writeRunReport(run.dir);
    }
  }
}

export async function videoThumb(video: string, out: string): Promise<void> {
  if (fs.existsSync(out)) return;
  await exec("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-ss", "1", "-i", video, "-frames:v", "1", "-vf", "scale=180:-2", out]);
}
void path;
