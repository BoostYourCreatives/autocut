/**
 * Ein Befehl für den kompletten Durchlauf auf allen Beispielvideos in tests/videos/:
 *   npm run test:e2e [-- --dry] [-- --no-render] [-- --no-selfcheck] [-- --provider faster-whisper] [-- --videos <ordner>]
 * Ergebnis: Tabelle in der Konsole und tests/e2e/report.md. Exit-Code 1, wenn ein Video scheitert.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle } from "../../src/config.ts";
import { ingest } from "../../src/steps/ingest.ts";
import { transcribe } from "../../src/steps/transcribe/index.ts";
import { analyze } from "../../src/steps/analyze.ts";
import { measureChin } from "../../src/steps/chin.ts";
import { plan, PlanFailedError, type QualitySummary } from "../../src/steps/plan.ts";
import { deliver } from "../../src/steps/deliver.ts";
import { validatePlanFile } from "../../src/steps/check.ts";
import { summarizeRun, writeRunReport } from "../../src/steps/report.ts";
import { runPaths } from "../../src/util/run.ts";
import { readJson } from "../../src/util/files.ts";

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* keine .env */
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = path.resolve(opt("videos") ?? path.join(ROOT, "tests", "videos"));
const videos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)).sort() : [];
if (videos.length === 0) {
  console.error(`Keine Videos in ${dir}. 2–3 Beispielvideos dort ablegen (siehe tests/videos/README.md).`);
  process.exit(2);
}

const cfg = loadConfig();
const style = loadStyle(cfg);
const provider = (opt("provider") as "openai" | "faster-whisper" | undefined) ?? (process.env.OPENAI_API_KEY ? "openai" : "faster-whisper");

interface Row {
  video: string;
  ok: boolean;
  stage: string;
  detail: string;
  seconds: number;
  attempts?: number;
  errors?: number;
  length?: string;
  cost?: number;
  selfcheck?: string;
  hinweise?: number;
}
const rows: Row[] = [];

for (const f of videos) {
  const name = `e2e-${f.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const run = runPaths(cfg, name);
  fs.rmSync(run.dir, { recursive: true, force: true });
  const t0 = Date.now();
  const row: Row = { video: f, ok: false, stage: "ingest", detail: "", seconds: 0 };
  console.error(`\n=== ${f} (Run ${name}) ===`);
  try {
    await ingest(cfg, style, name, { reels: [path.join(dir, f)], hooks: [], precut: "auto" });
    row.stage = "transcribe";
    await transcribe(cfg, style, name, { provider });
    row.stage = "analyze";
    await analyze(cfg, style, name);
    row.stage = "chin";
    await measureChin(cfg, style, name);
    if (flag("dry")) {
      row.ok = true;
      row.stage = "dry";
      row.detail = "nur Vorverarbeitung";
    } else {
      row.stage = "plan";
      await plan(cfg, style, name, { video: `TW_Reel_${name}` });
      const planFile = path.join(run.dir, "plan.json");
      const q = readJson<QualitySummary>(path.join(run.dir, "quality.json"));
      row.attempts = q.attempts;
      row.errors = q.validator_errors_total;
      row.length = `${q.out_duration_s.toFixed(1)}/${q.source_duration_s.toFixed(1)} s`;
      if (!flag("no-render")) {
        row.stage = "render";
        const v = validatePlanFile(cfg, style, planFile).result;
        if (!v.ok) throw new Error(`Validator: ${v.errors[0]?.message}`);
        const d = await deliver(cfg, style, planFile, { selfcheck: !flag("no-selfcheck") });
        row.selfcheck = d.selfcheck?.result ? `${d.selfcheck.result.urteil} (${d.selfcheck.result.befunde.length})` : d.selfcheck?.skipped ? "übersprungen" : "–";
        row.hinweise = JSON.parse(fs.readFileSync(d.attentionFile.replace(/\.md$/, ".json"), "utf8")).length;
        row.detail = path.basename(d.render.videoFile!);
      }
      row.ok = true;
      row.stage = "fertig";
    }
  } catch (e) {
    row.detail = (e instanceof PlanFailedError ? "Plan scheitert am Validator" : (e as Error).message).split("\n")[0]!.slice(0, 160);
  }
  row.seconds = Math.round((Date.now() - t0) / 1000);
  row.cost = summarizeRun(run.dir)?.cost_usd ?? 0;
  writeRunReport(run.dir);
  rows.push(row);
}

const lines = [
  `# E2E-Testlauf (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
  "",
  `Videos: ${videos.length}, Transkription: ${provider}${flag("dry") ? ", nur Vorverarbeitung" : ""}`,
  "",
  "| Video | Ergebnis | Stufe | Versuche | Validator-Fehler | Länge | Selfcheck | Hinweise | Dauer | Kosten | Details |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.video} | ${r.ok ? "OK" : "FEHLER"} | ${r.stage} | ${r.attempts ?? "–"} | ${r.errors ?? "–"} | ${r.length ?? "–"} | ${r.selfcheck ?? "–"} | ${r.hinweise ?? "–"} | ${r.seconds} s | $${(r.cost ?? 0).toFixed(2)} | ${r.detail} |`),
  "",
  `Summe: ${rows.filter((r) => r.ok).length}/${rows.length} OK, geschätzte Kosten $${rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(2)}.`,
  "",
];
fs.writeFileSync(path.join(ROOT, "tests", "e2e", "report.md"), lines.join("\n"));
console.log("\n" + lines.join("\n"));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
