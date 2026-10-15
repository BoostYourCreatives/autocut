import path from "node:path";
import fs from "node:fs";
import type { Config, Style } from "../config.ts";
import type { LlmClient } from "../llm/client.ts";
import { Plan } from "../schema/plan.ts";
import { readJson, readJsonSchema, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import type { RunPaths } from "../util/run.ts";
import { validatePlanFile } from "./check.ts";
import { renderPlan, type RenderResult } from "./render.ts";
import { selfcheck, type SelfcheckFile } from "./selfcheck.ts";
import { attentionItems, writeAttention } from "./hinschauen.ts";
import type { QualitySummary } from "./plan.ts";

export interface DeliverOptions {
  selfcheck: boolean;
  llm?: LlmClient;
}

export interface DeliverResult {
  render: RenderResult;
  selfcheck: SelfcheckFile | null;
  attentionFile: string;
}

/**
 * Plan → Video → Selfcheck → "Hier genauer hinschauen". Start nur mit plan.json und dem Clip-Ordner daneben,
 * deshalb auch für "rerender" geeignet. Der Validator muss vorher bestanden sein (prüft der Aufrufer).
 */
export async function deliver(cfg: Config, style: Style, planFile: string, opts: DeliverOptions): Promise<DeliverResult> {
  const plan = readJsonSchema(planFile, Plan);
  const runDir = path.dirname(path.resolve(planFile));
  const run = { dir: runDir, log: path.join(runDir, "run.log.json") } as unknown as RunPaths;
  const { result: validation } = validatePlanFile(cfg, style, planFile);

  const render = await renderPlan(cfg, style, planFile);
  const outDir = path.dirname(render.videoFile!);

  let sc: SelfcheckFile | null = null;
  if (opts.selfcheck) {
    try {
      sc = await selfcheck(cfg, style, run, planFile, render.videoFile!, { llm: opts.llm });
    } catch (e) {
      const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      log.warn(`selfcheck übersprungen: ${why}`);
      sc = { skipped: why };
      writeJson(path.join(outDir, `${plan.video}.selfcheck.json`), sc);
    }
  }

  const items = attentionItems(plan, validation, sc);
  const attentionFile = writeAttention(outDir, plan.video, items);
  log.info(`hinschauen: ${items.length} Stelle(n) → ${attentionFile}`);

  // Qualitätszusammenfassung um Render und Selfcheck ergänzen
  const qf = path.join(runDir, "quality.json");
  if (fs.existsSync(qf)) {
    const q = readJson<QualitySummary & Record<string, unknown>>(qf);
    q.selfcheck = sc?.result ? { ok: sc.result.urteil === "ok" && !sc.result.befunde.some((b) => b.schwere === "fehler") } : null;
    (q as Record<string, unknown>).selfcheck_befunde = sc?.result?.befunde.length ?? null;
    (q as Record<string, unknown>).render = { video: render.videoFile, size_mb: render.export?.size_mb, bitrate_kbps: render.export?.bitrate_kbps, warnings: render.warnings.length };
    q.est_cost_usd = Math.round((q.est_cost_usd + (sc?.est_cost_usd ?? 0)) * 10000) / 10000;
    writeJson(qf, q);
  }
  return { render, selfcheck: sc, attentionFile };
}
