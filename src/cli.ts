#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { collectTodos, loadConfig, loadStyle } from "./config.ts";
import { ingest } from "./steps/ingest.ts";
import { transcribe } from "./steps/transcribe/index.ts";
import { analyze } from "./steps/analyze.ts";
import { loadManifest, runPaths } from "./util/run.ts";
import { readRunLog } from "./util/runlog.ts";
import { log } from "./util/log.ts";

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

program
  .command("run <run>")
  .description("Alle bisher implementierten Schritte nacheinander (M1: ingest, transcribe, analyze)")
  .option("--reel <datei>", "Einzelnes Reel", collect)
  .option("--hook <datei>", "Hook-Clip", collect)
  .option("--body <datei>", "Gemeinsamer Body")
  .option("--precut <auto|ja|nein>", "Vorgeschnittenes Material? (Standard: auto)")
  .option("--provider <openai|faster-whisper|file>", "Überschreibt transcription.provider")
  .option("--from-file <datei>", "Wörter aus JSON statt Transkription (provider=file)")
  .action(async (runName: string, o) => {
    const cfg = loadConfig();
    const style = loadStyle(cfg);
    await ingest(cfg, style, runName, { reels: o.reel ?? [], hooks: o.hook ?? [], body: o.body, precut: parsePrecut(o.precut) });
    const provider = o.fromFile ? "file" : o.provider;
    await transcribe(cfg, style, runName, { provider, fromFile: o.fromFile ? { "*": path.resolve(o.fromFile) } : undefined });
    await analyze(cfg, style, runName);
    printStatus(runName);
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
