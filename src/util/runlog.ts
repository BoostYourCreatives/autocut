import fs from "node:fs";
import type { RunPaths } from "./run.ts";
import { readJson, writeJson } from "./files.ts";

export interface StepApiUsage {
  provider: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  audio_seconds?: number;
  est_cost_usd: number;
}
export interface StepEntry {
  step: string;
  clip?: string;
  started_at: string;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
  api?: StepApiUsage;
}
export interface RunLog {
  steps: StepEntry[];
  totals: { duration_ms: number; est_cost_usd: number };
}

export function readRunLog(run: RunPaths): RunLog {
  return fs.existsSync(run.log) ? readJson<RunLog>(run.log) : { steps: [], totals: { duration_ms: 0, est_cost_usd: 0 } };
}

/** Misst einen Schritt und hängt ihn an run.log.json an. Fehler werden geloggt und weitergeworfen. */
export async function timed<T>(
  run: RunPaths,
  step: string,
  clip: string | undefined,
  fn: () => Promise<{ value: T; api?: StepApiUsage }>,
): Promise<T> {
  const started = new Date();
  const t0 = performance.now();
  const entry = (extra: Partial<StepEntry>): StepEntry => ({
    step,
    ...(clip ? { clip } : {}),
    started_at: started.toISOString(),
    duration_ms: Math.round(performance.now() - t0),
    status: "ok",
    ...extra,
  });
  const append = (e: StepEntry) => {
    const log = readRunLog(run);
    log.steps.push(e);
    log.totals = {
      duration_ms: log.steps.reduce((a, s) => a + s.duration_ms, 0),
      est_cost_usd: round4(log.steps.reduce((a, s) => a + (s.api?.est_cost_usd ?? 0), 0)),
    };
    writeJson(run.log, log);
  };
  try {
    const { value, api } = await fn();
    append(entry({ api }));
    return value;
  } catch (err) {
    append(entry({ status: "error", error: err instanceof Error ? err.message.split("\n")[0] : String(err) }));
    throw err;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
