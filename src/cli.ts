#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { ROOT, collectTodos, loadConfig, loadStyle } from "./config.ts";
import { ingest } from "./steps/ingest.ts";
import { transcribe } from "./steps/transcribe/index.ts";
import { analyze } from "./steps/analyze.ts";
import { plan, planPaths, PlanFailedError } from "./steps/plan.ts";
import { validatePlanFile } from "./steps/check.ts";
import { measureChin } from "./steps/chin.ts";
import { renderPlan } from "./steps/render.ts";
import { deliver } from "./steps/deliver.ts";
import { buildSfxIndex } from "./lib/sfxIndex.ts";
import { mmss } from "./util/fmt.ts";
import { loadManifest, runPaths } from "./util/run.ts";
import { readRunLog } from "./util/runlog.ts";
import { log } from "./util/log.ts";

// .env im Projektordner laden (OPENAI_API_KEY, ANTHROPIC_API_KEY, Pfad-Overrides); vorhandene Umgebungsvariablen haben Vorrang
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* keine .env: Variablen kommen aus der Umgebung */
}

const program = new Command();
program.name("autocut").description("KI-gestützte Video-Editing-Pipeline (Prototyp, Kunde: Thorsten Wittmann)");

const collect = (v: string, prev: string[] = []) => [...prev, v];
const parsePrecut = (v?: string): "auto" | boolean => {
  if (v === undefined || v === "auto") return "auto";
  if (["ja", "true", "yes", "1"].includes(v)) return true;
  if (["nein", "false", "no", "0"].includes(v)) return false;
  throw new Error(`--precut erwartet auto|ja|nein, nicht "${v}"`);
};

program
  .command("ingest <run>")
  .description("Rohdateien einlesen, Proxy und Audio erzeugen, Metadaten speichern")
  .option("--reel <datei>", "Einzelnes Reel (Rohvideo)", collect)
  .option("--hook <datei>", "Hook-Clip (mehrfach angebbar)", collect)
  .option("--body <datei>", "Gemeinsamer Body für alle Hooks")
  .option("--precut <auto|ja|nein>", "Material vom User vorgeschnitten/gezoomt? (Standard: auto)")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    await ingest(cfg, style, runName, { reels: o.reel ?? [], hooks: o.hook ?? [], body: o.body, precut: parsePrecut(o.precut) });
  });

program
  .command("transcribe <run>")
  .description("Transkript mit Wortzeitstempeln erzeugen")
  .option("--clip <id>", "Nur diesen Clip (mehrfach angebbar)", collect)
  .option("--provider <openai|faster-whisper|file>", "Überschreibt transcription.provider")
  .option("--from-file <datei>", "Bei provider=file: Wörter aus dieser JSON-Datei (gilt für alle gewählten Clips)")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    const provider = o.fromFile ? "file" : o.provider;
    await transcribe(cfg, style, runName, { clips: o.clip, provider, fromFile: o.fromFile ? { "*": path.resolve(o.fromFile) } : undefined });
  });

program
  .command("analyze <run>")
  .description("Technische Analyse ohne KI (Stillen, Atmer, Lautstärke, Szenenwechsel)")
  .option("--clip <id>", "Nur diesen Clip (mehrfach angebbar)", collect)
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    await analyze(cfg, loadStyle(cfg), runName, o.clip);
  });

const parseTransition = (v?: string): "blitz_riser" | "hart" | undefined => {
  if (v === undefined || v === "auto") return undefined;
  if (v === "blitz" || v === "blitz_riser") return "blitz_riser";
  if (v === "hart") return "hart";
  throw new Error(`--uebergang erwartet blitz|hart|auto, nicht "${v}"`);
};
const parseHookText = (v?: string): [string, string] | undefined => {
  if (!v) return undefined;
  const parts = v.split("/").map((x) => x.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error('--hook-text erwartet genau 2 Zeilen, getrennt durch "/", z. B. "WARUM EUROPA / ZURÜCKFALLEN KÖNNTE"');
  return [parts[0]!, parts[1]!];
};

program
  .command("plan <run>")
  .description("Editing-Plan mit Claude erstellen und streng validieren (max. 3 Versuche); schreibt plan.json und quality.json")
  .option("--clip <id>", "Clip (Standard: das Reel des Runs)")
  .option("--uebergang <blitz|hart|auto>", "Hook-Übergang vorgeben (Standard: Claude entscheidet nach Inhalt)")
  .option("--hook-text <z1/z2>", "Hook-Text vorgeben, zwei Zeilen getrennt durch /")
  .option("--name <TW_Reel_NN>", "Videoname im Plan")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    try {
      await plan(cfg, style, runName, { clip: o.clip, transition: parseTransition(o.uebergang), hookLines: parseHookText(o.hookText), video: o.name });
      printQuality(runName);
    } catch (e) {
      if (e instanceof PlanFailedError) {
        log.error(e.message);
        process.exit(2);
      }
      throw e;
    }
  });

program
  .command("validate <run-oder-plan>")
  .description("Plan ohne KI prüfen (Run-Name oder Pfad zu plan.json); Exit-Code 1 bei Fehlern")
  .action((arg: string) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    const planFile = arg.endsWith(".json") ? path.resolve(arg) : planPaths(runPaths(cfg, arg)).plan;
    const { result: v } = validatePlanFile(cfg, style, planFile);
    for (const e of v.errors) console.log(`FEHLER   [${e.code}]${e.t_s !== undefined ? ` @${mmss(e.t_s)}` : ""} ${e.message}`);
    for (const w of v.warnings) console.log(`WARNUNG  [${w.code}]${w.t_s !== undefined ? ` @${mmss(w.t_s)}` : ""} ${w.message}`);
    for (const n of v.notChecked) console.log(`NICHT GEPRÜFT: ${n}`);
    console.log(`\n${v.ok ? "OK" : "NICHT OK"}: ${v.errors.length} Fehler, ${v.warnings.length} Warnung(en), Länge ${v.stats.out_duration_s.toFixed(1)} s (${(v.stats.length_ratio * 100).toFixed(0)} % der Quelle)`);
    process.exit(v.ok ? 0 : 1);
  });

program
  .command("chin <run>")
  .description("Kinnhöhe messen (MediaPipe), nötig für die Position der Untertitel")
  .option("--clip <id>", "Nur diesen Clip", collect)
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    await measureChin(cfg, loadStyle(cfg), runName, o.clip);
  });

program
  .command("render <run>")
  .description("Plan rendern (Bild + Ton + Export). --still 1.5,4 rendert nur Einzelbilder zur Kontrolle")
  .option("--still <sekunden>", "Kommagetrennte Zeitpunkte, rendert nur PNGs")
  .option("--force", "Auch rendern, wenn der Validator Fehler meldet")
  .option("--no-selfcheck", "Selfcheck überspringen")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    await renderCommand(cfg, loadStyle(cfg), planPaths(runPaths(cfg, runName)).plan, { still: o.still, force: o.force, selfcheck: o.selfcheck !== false });
  });

program
  .command("rerender <plan>")
  .description("Einen (manuell geänderten) Plan neu rendern, ohne ingest/transcribe/analyze/plan zu wiederholen")
  .option("--no-selfcheck", "Selfcheck überspringen")
  .option("--still <sekunden>", "Kommagetrennte Zeitpunkte, rendert nur PNGs")
  .option("--force", "Auch rendern, wenn der Validator Fehler meldet")
  .action(async (planFile: string, o) => {
    const cfg = loadConfig();
    await renderCommand(cfg, loadStyle(cfg), path.resolve(planFile), { still: o.still, force: o.force, selfcheck: o.selfcheck !== false });
  });

program
  .command("sfx-index")
  .description("Zeigt den Index der SFX-Library (nur diese Dateien darf der Plan nutzen)")
  .action(() => {
    const cfg = loadConfig();
    const idx = buildSfxIndex(cfg.sfxLibrary);
    for (const e of idx) console.log(e.file);
    console.log(`\n${idx.length} Dateien in ${cfg.sfxLibrary}`);
  });

program
  .command("run <run>")
  .description("Alles in einem Durchgang: ingest, transcribe, analyze, chin, plan+validate, render, selfcheck, hinschauen")
  .option("--reel <datei>", "Einzelnes Reel", collect)
  .option("--hook <datei>", "Hook-Clip", collect)
  .option("--body <datei>", "Gemeinsamer Body")
  .option("--precut <auto|ja|nein>", "Vorgeschnittenes Material? (Standard: auto)")
  .option("--provider <openai|faster-whisper|file>", "Überschreibt transcription.provider")
  .option("--from-file <datei>", "Wörter aus JSON statt Transkription (provider=file)")
  .option("--uebergang <blitz|hart|auto>", "Hook-Übergang vorgeben")
  .option("--hook-text <z1/z2>", "Hook-Text vorgeben")
  .option("--name <TW_Reel_NN>", "Videoname im Plan")
  .option("--no-render", "Nach plan+validate aufhören (kein Video)")
  .option("--no-selfcheck", "Selfcheck überspringen")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    await ingest(cfg, style, runName, { reels: o.reel ?? [], hooks: o.hook ?? [], body: o.body, precut: parsePrecut(o.precut) });
    const provider = o.fromFile ? "file" : o.provider;
    await transcribe(cfg, style, runName, { provider, fromFile: o.fromFile ? { "*": path.resolve(o.fromFile) } : undefined });
    await analyze(cfg, style, runName);
    await measureChin(cfg, style, runName);
    try {
      await plan(cfg, style, runName, { transition: parseTransition(o.uebergang), hookLines: parseHookText(o.hookText), video: o.name });
    } catch (e) {
      if (e instanceof PlanFailedError) {
        log.error(e.message);
        printStatus(runName);
        process.exit(2);
      }
      throw e;
    }
    if (o.render !== false) {
      const cfg2 = cfg;
      await renderCommand(cfg2, style, planPaths(runPaths(cfg2, runName)).plan, { force: false, selfcheck: o.selfcheck !== false });
    }
    printStatus(runName);
    printQuality(runName);
  });

program
  .command("status <run>")
  .description("Zeigt Clips, vorhandene Dateien und das Schritt-Log eines Runs")
  .action((runName: string) => printStatus(runName));

program
  .command("todos")
  .description("Listet alle TODO-Platzhalter in Stil- und Config-Dateien")
  .action(() => {
    const cfg = loadConfig();
    const todos = collectTodos(cfg);
    for (const t of todos) console.log(`- ${t.file}: ${t.text}`);
    console.log(`\n${todos.length} offene TODO-Marker.`);
  });

async function renderCommand(cfg: ReturnType<typeof loadConfig>, style: ReturnType<typeof loadStyle>, planFile: string, o: { still?: string; force?: boolean; selfcheck: boolean }): Promise<void> {
  const { result: v } = validatePlanFile(cfg, style, planFile);
  if (!v.ok) {
    for (const e of v.errors) console.log(`FEHLER   [${e.code}]${e.t_s !== undefined ? ` @${mmss(e.t_s)}` : ""} ${e.message}`);
    if (!o.force) {
      log.error(`Plan besteht den Validator nicht (${v.errors.length} Fehler). Es wird nicht gerendert. Mit --force trotzdem rendern.`);
      process.exit(1);
    }
    log.warn("--force: rendere trotz Validator-Fehlern");
  }
  const stills = o.still ? o.still.split(",").map((x) => parseFloat(x.trim())).filter((x) => Number.isFinite(x)) : undefined;
  if (stills) {
    const r = await renderPlan(cfg, style, planFile, { stills });
    for (const f of r.stills) console.log(f);
    for (const w of r.warnings) log.warn(w);
    return;
  }
  const d = await deliver(cfg, style, planFile, { selfcheck: o.selfcheck });
  console.log(`\nVideo:      ${d.render.videoFile}\nHinschauen: ${d.attentionFile}${d.selfcheck?.result ? `\nSelfcheck:  ${d.selfcheck.result.urteil}, ${d.selfcheck.result.befunde.length} Befund(e)` : ""}`);
}

function printQuality(runName: string): void {
  const cfg = loadConfig();
  const qf = planPaths(runPaths(cfg, runName)).quality;
  if (!fs.existsSync(qf)) return;
  const q = JSON.parse(fs.readFileSync(qf, "utf8"));
  console.log(
    `\nQualität: ${q.attempts} Versuch(e), Validator-Fehler je Versuch [${q.validator_errors_per_attempt.join(", ")}], ${q.warnings} Warnung(en)\n` +
      `  Länge ${q.out_duration_s.toFixed(1)} s von ${q.source_duration_s.toFixed(1)} s (${(q.length_ratio * 100).toFixed(0)} %), entfernt ${q.removed.total_s.toFixed(1)} s ${JSON.stringify(q.removed.by_kind)}\n` +
      `  ${q.counts.segments} Segmente, ${q.counts.captions} Untertitel, ${q.counts.zooms} Zooms, ${q.counts.broll} B-Roll, ${q.counts.sfx} SFX; ~$${q.est_cost_usd}`,
  );
}

function printStatus(runName: string): void {
  const cfg = loadConfig();
  const run = runPaths(cfg, runName);
  const m = loadManifest(run);
  console.log(`Run ${m.name} (${m.style}), Pfad: ${run.dir}`);
  for (const c of m.clips) {
    const p = run.clip(c.id);
    const has = (f: string) => (fs.existsSync(f) ? "ja" : "–");
    console.log(`  ${c.id.padEnd(22)} ${c.role.padEnd(5)} meta:${has(p.meta)} transcript:${has(p.transcript)} analysis:${has(p.analysis)}`);
  }
  const l = readRunLog(run);
  for (const s of l.steps) {
    console.log(`  ${s.step.padEnd(10)} ${(s.clip ?? "").padEnd(22)} ${(s.duration_ms / 1000).toFixed(1).padStart(6)} s  ${s.status}${s.api ? `  ~$${s.api.est_cost_usd}` : ""}`);
  }
  console.log(`  Summe: ${(l.totals.duration_ms / 1000).toFixed(1)} s, ~$${l.totals.est_cost_usd}`);
}

program.parseAsync().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
