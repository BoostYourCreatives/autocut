import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { AnthropicLlm, costUsd, type LlmClient } from "../llm/client.ts";
import { toApiSchema } from "../plan/draft.ts";
import { MotionsDraft, buildScenes } from "./scenes.ts";
import { Transcript } from "../schema/transcript.ts";
import { extractJson } from "../steps/plan.ts";
import { readJson, readJsonSchema, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import type { MotionsChunk, MotionsScene } from "../render/remotion/Motions.tsx";

export interface MotionsPlan {
  style: "motions";
  video: string;
  clip: string;
  fps: number;
  duration_s: number;
  chunks: MotionsChunk[];
  /** Bilder, Karten, Glas-Felder, Zwischenschnitte (leer = nur Untertitel). Bildfelder verweisen auf Dateien in <run>/scene-images */
  scenes: MotionsScene[];
}

/** Eigenes Modell für diesen Stil (style/motions/motions.json, Feld "modell"); sonst das der Config */
export function motionsModel(cfg: Config): string {
  try {
    const f = path.join(cfg.stylePath, "..", "motions", "motions.json");
    const m = (readJson<{ modell?: string }>(f).modell ?? "").trim();
    return m || cfg.llm.planModel;
  } catch {
    return cfg.llm.planModel;
  }
}

export const motionsPlanFile = (runDir: string) => path.join(runDir, "motions-plan.json");

const strip = (w: string) => w.replace(/^[\s"„“(]+|[\s"“”).,;:!?…]+$/g, "");

/** Wörter → kurze Gruppen (1–3 Wörter), getrennt an Satzzeichen, Pausen und Länge. */
export function chunkWords(words: { word: string; start_s: number; end_s: number }[]): MotionsChunk[] {
  const out: MotionsChunk[] = [];
  let cur: { word: string; start_s: number; end_s: number }[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start_s: cur[0]!.start_s, end_s: cur[cur.length - 1]!.end_s, words: cur.map((w) => ({ text: strip(w.word) })) });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    if (prev && w.start_s - prev.end_s > 0.35) flush();
    cur.push(w);
    const ends = /[.!?…:;,]$/.test(w.word);
    const span = w.end_s - cur[0]!.start_s;
    const next = words[i + 1];
    const long = cur.length >= 3 || span > 1.5;
    // kurze Funktionswörter nicht allein stehen lassen: bis zu 2 Wörter zusammenhalten
    if (ends || long || (cur.length >= 2 && next && next.word.length > 6 && cur.reduce((a, x) => a + x.word.length, 0) > 8)) flush();
  });
  flush();
  // Halten bis kurz vor der nächsten Gruppe, damit nichts flackert
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const next = out[i + 1];
    const minEnd = c.start_s + 0.4;
    c.end_s = Math.max(c.end_s, next ? Math.min(minEnd, next.start_s) : minEnd);
    if (next && next.start_s - c.end_s < 0.25) c.end_s = next.start_s;
  }
  return out.filter((c) => c.words.some((w) => w.text));
}

/** Heuristik, falls Claude nicht erreichbar ist: jedes dritte Stück sein längstes Wort. */
function heuristicEmphasis(chunks: MotionsChunk[]): { chunk: number; word: number }[] {
  const res: { chunk: number; word: number }[] = [];
  chunks.forEach((c, i) => {
    if (i % 3 !== 1) return;
    let best = 0;
    c.words.forEach((w, k) => {
      if (w.text.length > c.words[best]!.text.length) best = k;
    });
    if (c.words[best]!.text.length >= 5) res.push({ chunk: i, word: best });
  });
  return res;
}

function systemPrompt(stylePath: string): string {
  let regeln = "";
  try {
    regeln = fs.readFileSync(path.join(stylePath, "regeln.md"), "utf8");
  } catch {
    /* ohne Regeltext */
  }
  return `Du bist Editor im Stil "motions" (Instagram-Reels, freigestellter Sprecher, Glas-Optik). Du bekommst das Transkript eines Talking-Head-Videos als nummerierte Untertitel-Gruppen mit Zeiten. Du entscheidest zwei Dinge:

1. emphasis: Welche Wörter in den Untertiteln groß, kursiv und golden betont werden. "chunk" = Index der Gruppe (ab 0), "word" = Index des Wortes in der Gruppe (ab 0). Höchstens ein Wort pro Gruppe, höchstens jede dritte Gruppe, nur Bedeutungsträger (Kernbegriffe, Zahlen, Gegensätze, Ergebnisse), mindestens 4 Buchstaben. Nie zwei Gruppen direkt hintereinander.
2. scenes: Welche Bildbausteine das Gesagte visuell tragen. Zeiten in Sekunden aus dem Transkript. Halte dich genau an die Regeln unten, besonders an Dichte und Überlappungen. Wähle die Bausteine nach Inhalt: Orte und Dinge → Zwischenschnitt oder Bildkarte, Aufzählung → Bilder-Reihe oder Nummern, Kernbegriff → Glas-Feld. Variiere die Bausteine, wiederhole nicht dreimal denselben.

Regeln des Stils:

${regeln}

Antworte nur mit dem JSON-Objekt.`;
}

export async function planMotions(cfg: Config, runName: string, opts: { llm?: LlmClient; video?: string; stylePath?: string } = {}): Promise<MotionsPlan> {
  const run = runPaths(cfg, runName);
  const manifest = loadManifest(run);
  const clip = manifest.clips.find((c) => c.role === "reel");
  if (!clip) throw new Error("Der Run enthält kein Reel");
  const paths = run.clip(clip.id);
  const meta = readJson<{ fps: number; duration_s: number }>(paths.meta);
  const transcript = readJsonSchema(paths.transcript, Transcript);
  const chunks = chunkWords(transcript.words);
  log.info(`motions-plan: ${chunks.length} Untertitel-Gruppen`);

  let picks: { chunk: number; word: number }[] = [];
  let sceneList: MotionsScene[] = [];
  try {
    const llm = opts.llm ?? new AnthropicLlm();
    const model = motionsModel(cfg);
    const list = chunks.map((c, i) => `${i}: ${c.words.map((w) => w.text).join(" ")}`).join("\n");
    const turn = await timed(run, "plan", clip.id, async () => {
      const t = await llm.complete({ model, system: systemPrompt(opts.stylePath ?? path.join(cfg.stylePath, "..", "motions")), messages: [{ role: "user", content: `Dauer: ${meta.duration_s.toFixed(1)} s\nGruppen:\n${list}` }], schema: toApiSchema(MotionsDraft), effort: "high", maxTokens: 24000 });
      return { value: t, api: { provider: "anthropic", model, input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, cache_read_tokens: t.usage.cache_read_tokens, cache_write_tokens: t.usage.cache_write_tokens, est_cost_usd: costUsd(cfg, model, t.usage) } };
    });
    const draft = MotionsDraft.parse(extractJson(turn.text));
    picks = draft.emphasis;
    const built = buildScenes(draft.scenes, meta.duration_s);
    sceneList = built.scenes;
    for (const d of built.dropped) log.warn(`motions-plan: Szene verworfen (${d})`);
  } catch (e) {
    log.warn(`motions-plan: Claude nicht nutzbar (${e instanceof Error ? e.message.split("\n")[0] : e}), einfache Auswahl der Betonungen`);
    picks = heuristicEmphasis(chunks);
  }
  let used = 0;
  for (const p of picks) {
    const w = chunks[p.chunk]?.words[p.word];
    if (!w || w.text.length < 4 || chunks[p.chunk]!.words.some((x) => x.emph)) continue;
    w.emph = true;
    used++;
  }
  log.info(`motions-plan: ${used} betonte Wörter`);
  const plan: MotionsPlan = { style: "motions", video: opts.video ?? `Reel_${runName}`, clip: clip.id, fps: meta.fps, duration_s: meta.duration_s, chunks, scenes: sceneList };
  log.info(`motions-plan: ${sceneList.length} Szenen (${sceneList.map((x) => x.type).join(", ") || "keine"})`);
  writeJson(motionsPlanFile(run.dir), plan);
  return plan;
}
