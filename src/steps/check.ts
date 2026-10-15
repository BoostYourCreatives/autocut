import path from "node:path";
import fs from "node:fs";
import type { Config, Style } from "../config.ts";
import { Plan } from "../schema/plan.ts";
import { Analysis } from "../schema/analysis.ts";
import { Transcript } from "../schema/transcript.ts";
import { readJson, readJsonSchema } from "../util/files.ts";
import { validate, type ValidationResult } from "../validate/validate.ts";
import { buildSfxIndex } from "../lib/sfxIndex.ts";
import { checkChin, type ChinData } from "../lib/chin.ts";

/** Plan-Datei laden und mit Transkript/Analyse des Clips (Ordner daneben) streng prüfen. */
export function validatePlanFile(cfg: Config, style: Style, planFile: string): { plan: Plan; result: ValidationResult } {
  const plan = readJsonSchema(planFile, Plan);
  const clipDir = path.join(path.dirname(path.resolve(planFile)), "clips", plan.source.clip);
  const transcript = readJsonSchema(path.join(clipDir, "transcript.json"), Transcript);
  const analysis = readJsonSchema(path.join(clipDir, "analysis.json"), Analysis);
  const result = validate({ plan, transcript, analysis, params: style.params, sfxIndex: buildSfxIndex(cfg.sfxLibrary) });

  // Kinn-Abstand, sobald eine Messung vorliegt (sonst bleibt der Hinweis "nicht geprüft")
  const chinFile = path.join(clipDir, "chin.json");
  if (fs.existsSync(chinFile)) {
    const chin = readJson<ChinData>(chinFile);
    if (chin.frames.some((f) => f[1] !== null)) {
      result.notChecked = result.notChecked.filter((n) => !n.startsWith("Text mindestens 20 px"));
      const need = checkChin(plan, chin, style.params, 0);
      const ok = checkChin(plan, chin, style.params, need.requiredDy);
      if (ok.violations.length > 0) {
        result.errors.push({ severity: "fehler", code: "kinn_abstand", message: `Text kommt dem Kinn in ${ok.violations.length} Frames näher als ${style.params.layout.kinn.mindestabstand_px} px, auch mit der berechneten Verschiebung DY=${need.requiredDy}`, t_s: ok.violations[0]!.t_s });
        result.ok = false;
      }
    }
  }
  return { plan, result };
}
