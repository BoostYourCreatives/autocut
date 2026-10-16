import fs from "node:fs";
import path from "node:path";
import type { Config, Style } from "../config.ts";
import { ROOT } from "../config.ts";
import { AnthropicLlm, costUsd, type LlmClient, type LlmMessage, type LlmUsage } from "../llm/client.ts";
import { buildSfxIndex } from "../lib/sfxIndex.ts";
import { finalize } from "../plan/finalize.ts";
import { PlanDraft, toApiSchema } from "../plan/draft.ts";
import { buildSystemPrompt, buildUserPrompt } from "../plan/prompt.ts";
import { Analysis } from "../schema/analysis.ts";
import { ClipMeta } from "../schema/ingest.ts";
import { Transcript } from "../schema/transcript.ts";
import type { Plan } from "../schema/plan.ts";
import { formatIssuesForLlm, validate, type ValidationResult } from "../validate/validate.ts";
import { ensureDir, readJsonSchema, writeJson } from "../util/files.ts";
import { de2 } from "../util/fmt.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths, type RunPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import { writeRunReport } from "./report.ts";
import { round3 } from "../lib/intervals.ts";

export interface PlanOptions {
  clip?: string;
  /** Austauschbar für Tests */
  llm?: LlmClient;
  transition?: "blitz_riser" | "hart";
  hookLines?: [string, string];
  video?: string;
  /** Ordner mit Beispielplänen für den Prompt (Standard: beispiel-plan_*.json im Stilordner) */
  exampleFiles?: string[];
}

/** Zieht das JSON-Objekt aus einer Antwort, auch wenn Claude es in einen Codeblock gesetzt oder Text davor/danach geschrieben hat. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("keine JSON-Klammern in der Antwort gefunden");
  }
}

export class PlanFailedError extends Error {
  constructor(message: string, public reportPath: string) {
    super(message);
  }
}

export interface QualitySummary {
  clip: string;
  attempts: number;
  validator_errors_per_attempt: number[];
  validator_errors_total: number;
  warnings: number;
  source_duration_s: number;
  out_duration_s: number;
  length_ratio: number;
  removed: { total_s: number; by_kind: Record<string, number>; speech_share: number };
  counts: { segments: number; captions: number; gold: number; zooms: number; broll: number; sfx: number };
  tokens: LlmUsage;
  est_cost_usd: number;
  selfcheck: null | { ok: boolean };
}

export function planPaths(run: RunPaths) {
  return {
    plan: path.join(run.dir, "plan.json"),
    quality: path.join(run.dir, "quality.json"),
    attempts: path.join(run.dir, "plan-attempts"),
    failed: path.join(run.dir, "plan.failed.json"),
    report: path.join(run.dir, "fehlerbericht.md"),
    sfxIndex: path.join(run.dir, "sfx-index.json"),
  };
}

/** plan + validate mit Retry: Claude entwirft, Code finalisiert und prüft; Fehler gehen zurück an Claude (max. maxPlanAttempts). */
export async function plan(cfg: Config, style: Style, runName: string, opts: PlanOptions = {}): Promise<Plan> {
  const run = runPaths(cfg, runName);
  const manifest = loadManifest(run);
  const clip = opts.clip ? manifest.clips.find((c) => c.id === opts.clip) : manifest.clips.find((c) => c.role === "reel");
  if (!clip) throw new Error(opts.clip ? `Clip "${opts.clip}" nicht im Run` : "Der Run enthält kein Reel (ingest mit --reel)");
  const paths = run.clip(clip.id);
  const meta = readJsonSchema(paths.meta, ClipMeta);
  const transcript = readJsonSchema(paths.transcript, Transcript);
  const analysis = readJsonSchema(paths.analysis, Analysis);
  const pp = planPaths(run);
  ensureDir(pp.attempts);

  const sfxIndex = buildSfxIndex(cfg.sfxLibrary);
  writeJson(pp.sfxIndex, sfxIndex);
  log.info(`plan: SFX-Index mit ${sfxIndex.length} Dateien aus ${cfg.sfxLibrary}`);

  // Übergang: CLI-Vorgabe > fester Standard in params.json > Claude entscheidet ("auto")
  const std = style.params.hook_uebergang.modus_standard;
  const forcedTransition = opts.transition ?? (std === "auto" ? undefined : std);
  const exampleFiles =
    opts.exampleFiles ?? fs.readdirSync(style.dir).filter((f) => /^beispiel-plan_.*\.json$/.test(f)).sort().map((f) => path.join(style.dir, f));
  const schema = toApiSchema(PlanDraft);
  const system = buildSystemPrompt(style, sfxIndex, exampleFiles, schema);
  const userPrompt = buildUserPrompt({ meta, transcript, analysis, minPause: style.params.schnitt.min_pause_s, force: { transition: forcedTransition, hookLines: opts.hookLines } });
  const llm = opts.llm ?? new AnthropicLlm();
  const model = cfg.llm.planModel;
  const video = opts.video ?? `TW_Reel_${runName}`;

  const messages: LlmMessage[] = [{ role: "user", content: userPrompt }];
  const errorsPerAttempt: number[] = [];
  const tokens: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  let lastPlan: Plan | undefined;
  let lastFeedback = "";
  let lastStructuredError: string | undefined;
  let finalValidation: ValidationResult | undefined;

  for (let attempt = 1; attempt <= cfg.llm.maxPlanAttempts; attempt++) {
    const turn = await timed(run, "plan", clip.id, async () => {
      const t = await llm.complete({ model, system, messages, schema, effort: style.params.plan.claude_effort, maxTokens: style.params.plan.max_tokens });
      return {
        value: t,
        api: {
          provider: "anthropic",
          model,
          input_tokens: t.usage.input_tokens,
          output_tokens: t.usage.output_tokens,
          cache_read_tokens: t.usage.cache_read_tokens,
          cache_write_tokens: t.usage.cache_write_tokens,
          est_cost_usd: costUsd(cfg, model, t.usage),
        },
      };
    });
    for (const k of Object.keys(tokens) as (keyof LlmUsage)[]) tokens[k] += turn.usage[k];

    // 1) Antwort parsen und gegen das Entwurfsschema prüfen
    let draft: PlanDraft | undefined;
    let feedback = "";
    try {
      const parsed = PlanDraft.safeParse(extractJson(turn.text));
      if (parsed.success) draft = parsed.data;
      else feedback = "Die Antwort entspricht nicht dem Schema:\n" + parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    } catch (e) {
      feedback = `Die Antwort ist kein gültiges JSON (${(e as Error).message}). Antworte ausschließlich mit dem JSON-Objekt, ohne Codeblock.`;
    }

    // 2) Entwurf → Plan (deterministisch) → Validator
    let errorCount = 0;
    let attemptRecord: Record<string, unknown> = {};
    if (draft) {
      const fin = finalize({ draft, transcript, analysis, meta, params: style.params, sfxIndex, style: cfg.style, video, force: { transition: forcedTransition, hookLines: opts.hookLines } });
      if (!fin.plan) {
        errorCount = fin.issues.length;
        feedback = "Der Entwurf lässt sich nicht in einen Plan umsetzen:\n" + fin.issues.map((i) => `- ${i}`).join("\n");
        attemptRecord = { stage: "finalize", issues: fin.issues };
      } else {
        lastPlan = fin.plan;
        const v = validate({ plan: fin.plan, transcript, analysis, params: style.params, sfxIndex });
        finalValidation = v;
        errorCount = v.errors.length;
        attemptRecord = { stage: "validate", errors: v.errors, warnings: v.warnings };
        if (v.ok) {
          errorsPerAttempt.push(0);
          writeJson(path.join(pp.attempts, `attempt-${attempt}.json`), { attempt, draft, ...attemptRecord, usage: turn.usage });
          return finish(cfg, run, fin.plan, v, attempt, errorsPerAttempt, tokens, model);
        }
        feedback = "Der Validator hat den Plan abgelehnt:\n" + formatIssuesForLlm(v);
      }
    } else {
      errorCount = 1;
      attemptRecord = { stage: "parse", feedback };
    }
    errorsPerAttempt.push(errorCount);
    lastFeedback = feedback;
    lastStructuredError = turn.structuredError ?? lastStructuredError;
    writeJson(path.join(pp.attempts, `attempt-${attempt}.json`), { attempt, draft: draft ?? null, raw: draft ? undefined : turn.text.slice(0, 4000), structured_error: turn.structuredError, ...attemptRecord, usage: turn.usage });
    log.warn(`plan: Versuch ${attempt}/${cfg.llm.maxPlanAttempts} abgelehnt (${errorCount} Fehler)`);

    // Fehler zurück an Claude (Konversation wird nur verlängert, nie verändert)
    messages.push({ role: "assistant", content: turn.content });
    messages.push({ role: "user", content: `${feedback}\n\nGib den vollständigen, korrigierten Entwurf im selben Schema zurück. Korrigiere nur, was die Fehler verlangen, und behalte alles andere bei.` });
  }

  // Alle Versuche verbraucht: nicht rendern, Bericht schreiben
  if (lastPlan) writeJson(pp.failed, lastPlan);
  const report = failureReport(runName, clip.id, errorsPerAttempt, lastFeedback, finalValidation, cfg.llm.maxPlanAttempts, lastStructuredError);
  fs.writeFileSync(pp.report, report);
  writeRunReport(run.dir);
  throw new PlanFailedError(`Plan besteht den Validator nach ${cfg.llm.maxPlanAttempts} Versuchen nicht. Es wird nicht gerendert. Bericht: ${pp.report}`, pp.report);
}

function finish(cfg: Config, run: RunPaths, p: Plan, v: ValidationResult, attempts: number, errorsPerAttempt: number[], tokens: LlmUsage, model: string): Plan {
  const pp = planPaths(run);
  writeJson(pp.plan, p);
  const byKind: Record<string, number> = {};
  for (const r of p.removed) byKind[r.kind] = round3((byKind[r.kind] ?? 0) + (r.raw_to_s - r.raw_from_s));
  const total = round3(p.removed.reduce((a, r) => a + (r.raw_to_s - r.raw_from_s), 0));
  const q: QualitySummary = {
    clip: p.source.clip,
    attempts,
    validator_errors_per_attempt: errorsPerAttempt,
    validator_errors_total: errorsPerAttempt.reduce((a, b) => a + b, 0),
    warnings: v.warnings.length,
    source_duration_s: v.stats.source_duration_s,
    out_duration_s: v.stats.out_duration_s,
    length_ratio: round3(v.stats.length_ratio),
    removed: { total_s: total, by_kind: byKind, speech_share: round3(v.stats.removed_speech_share) },
    counts: {
      segments: p.cut_segments.length,
      captions: p.captions.length,
      gold: p.captions.filter((c) => c.kind === "gold" && c.layout !== "stack_oben").length,
      zooms: p.zooms.length,
      broll: p.broll.length,
      sfx: p.sfx.length,
    },
    tokens,
    est_cost_usd: costUsd(cfg, model, tokens),
    selfcheck: null,
  };
  writeJson(pp.quality, q);
  log.info(
    `plan: ok nach ${attempts} Versuch(en); ${p.cut_segments.length} Segmente, ${de2(v.stats.out_duration_s)} s von ${de2(v.stats.source_duration_s)} s (${(v.stats.length_ratio * 100).toFixed(0)} %), ` +
      `${p.captions.length} Untertitel, ${p.zooms.length} Zooms, ${p.broll.length} B-Roll, ${p.sfx.length} SFX, ${v.warnings.length} Warnung(en), ~$${q.est_cost_usd}`,
  );
  return p;
}

function failureReport(run: string, clip: string, perAttempt: number[], feedback: string, v: ValidationResult | undefined, max: number, structuredError?: string): string {
  return [
    `# Fehlerbericht: Plan für Run "${run}" (Clip ${clip})`,
    "",
    `Der Plan hat den Validator nach ${max} Versuchen nicht bestanden. Es wurde **nicht gerendert**.`,
    "",
    `Fehler je Versuch: ${perAttempt.join(", ")}`,
    "",
    ...(structuredError ? ["Hinweis: Die Claude-API hat das erzwungene JSON-Format abgelehnt, Antworten kamen als freier Text. Meldung der API:", "", "    " + structuredError, ""] : []),
    "## Letzte Rückmeldung",
    "",
    feedback || "(keine)",
    "",
    v ? `## Warnungen des letzten Plans\n\n${v.warnings.map((w) => `- [${w.code}] ${w.message}`).join("\n") || "(keine)"}` : "",
    "",
    "Alle Versuche liegen in `plan-attempts/`, der letzte Plan (falls er gebaut werden konnte) in `plan.failed.json`.",
    "Den Plan von Hand korrigieren und mit `autocut validate` prüfen, oder `autocut plan` erneut starten.",
    "",
  ].join("\n");
}
