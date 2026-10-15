import fs from "node:fs";
import path from "node:path";
import { readJson } from "../util/files.ts";
import { de1, de2 } from "../util/fmt.ts";
import type { RunLog } from "../util/runlog.ts";
import type { QualitySummary } from "./plan.ts";

const NAMES: Record<string, string> = {
  ingest: "Einlesen",
  transcribe: "Transkription",
  analyze: "Analyse (Stillen, Lautstärke)",
  chin: "Kinn-Messung",
  plan: "Plan (Claude)",
  "render-bundle": "Render: Vorbereitung",
  "render-video": "Render: Bild",
  "render-audio": "Render: Ton",
  "render-export": "Render: Export",
  selfcheck: "Selfcheck (Claude)",
};

export interface RunSummary {
  steps: { step: string; label: string; seconds: number; calls: number; cost_usd: number; errors: number }[];
  total_seconds: number;
  cost_usd: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  quality: (QualitySummary & Record<string, unknown>) | null;
}

/** Fasst das Schritt-Log eines Runs zusammen: Dauer je Schritt, API-Tokens, geschätzte Kosten, Qualität. */
export function summarizeRun(runDir: string): RunSummary | null {
  const logFile = path.join(runDir, "run.log.json");
  if (!fs.existsSync(logFile)) return null;
  const log = readJson<RunLog>(logFile);
  const by = new Map<string, RunSummary["steps"][number]>();
  for (const s of log.steps) {
    const e = by.get(s.step) ?? { step: s.step, label: NAMES[s.step] ?? s.step, seconds: 0, calls: 0, cost_usd: 0, errors: 0 };
    e.seconds += s.duration_ms / 1000;
    e.calls += 1;
    e.cost_usd += s.api?.est_cost_usd ?? 0;
    if (s.status === "error") e.errors += 1;
    by.set(s.step, e);
  }
  const qf = path.join(runDir, "quality.json");
  const t = log.totals;
  return {
    steps: [...by.values()],
    total_seconds: t.duration_ms / 1000,
    cost_usd: t.est_cost_usd,
    tokens: { input: t.input_tokens ?? 0, output: t.output_tokens ?? 0, cache_read: t.cache_read_tokens ?? 0, cache_write: t.cache_write_tokens ?? 0 },
    quality: fs.existsSync(qf) ? readJson(qf) : null,
  };
}

export function formatRunReport(name: string, s: RunSummary): string {
  const q = s.quality;
  const lines = [
    `# Laufbericht: ${name}`,
    "",
    `Gesamtdauer ${de1(s.total_seconds)} s, geschätzte Kosten **$${s.cost_usd.toFixed(2)}** pro Video (Schätzung aus Token-Preisen in der Config).`,
    "",
    "## Dauer und Kosten je Schritt",
    "",
    "| Schritt | Aufrufe | Dauer (s) | Kosten ($) |",
    "|---|---|---|---|",
    ...s.steps.map((x) => `| ${x.label}${x.errors ? ` (${x.errors} Fehler)` : ""} | ${x.calls} | ${de1(x.seconds)} | ${x.cost_usd ? x.cost_usd.toFixed(4) : "–"} |`),
    "",
    `Claude-Tokens: ${s.tokens.input} Eingabe, ${s.tokens.output} Ausgabe, ${s.tokens.cache_read} aus dem Cache gelesen, ${s.tokens.cache_write} in den Cache geschrieben.`,
  ];
  if (q) {
    lines.push(
      "",
      "## Qualität des Plans",
      "",
      `- Versuche bis der Validator bestand: ${q.attempts} (Fehler je Versuch: ${q.validator_errors_per_attempt.join(", ")})`,
      `- Warnungen im letzten Plan: ${q.warnings}`,
      `- Länge: ${de1(q.out_duration_s)} s von ${de1(q.source_duration_s)} s (${Math.round(q.length_ratio * 100)} %)`,
      `- Entfernt: ${de1(q.removed.total_s)} s ${JSON.stringify(q.removed.by_kind)}, davon gesprochener Text ${Math.round(q.removed.speech_share * 100)} %`,
      `- Inhalt: ${q.counts.segments} Segmente, ${q.counts.captions} Untertitel, ${q.counts.gold} Gold-Momente, ${q.counts.zooms} Zooms, ${q.counts.broll} B-Roll-Slots, ${q.counts.sfx} Soundeffekte`,
      `- Selfcheck: ${q.selfcheck === null ? "nicht gelaufen" : q.selfcheck.ok ? "ohne Fehlerbefund" : "mit Fehlerbefunden"}${q.selfcheck_befunde != null ? ` (${q.selfcheck_befunde} Befund(e) insgesamt)` : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function writeRunReport(runDir: string): string | null {
  const s = summarizeRun(runDir);
  if (!s) return null;
  const file = path.join(runDir, "laufbericht.md");
  fs.writeFileSync(file, formatRunReport(path.basename(runDir), s));
  void de2;
  return file;
}
