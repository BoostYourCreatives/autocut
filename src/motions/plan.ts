import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { AnthropicLlm, costUsd, type LlmClient } from "../llm/client.ts";
import { toApiSchema } from "../plan/draft.ts";
import { Transcript } from "../schema/transcript.ts";
import { extractJson } from "../steps/plan.ts";
import { readJson, readJsonSchema, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import type { MotionsChunk } from "../render/remotion/Motions.tsx";

export interface MotionsPlan {
  style: "motions";
  video: string;
  clip: string;
  fps: number;
  duration_s: number;
  chunks: MotionsChunk[];
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

const Emphasis = z.object({ emphasis: z.array(z.object({ chunk: z.number().int(), word: z.number().int() })) });

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

const SYSTEM = `Du setzt Untertitel im Stil "motions" (Instagram-Reels mit freigestelltem Sprecher).
Die Untertitel erscheinen in kurzen Gruppen von 1 bis 3 Wörtern. In manchen Gruppen steht EIN Wort groß, kursiv und golden (Betonung), alle anderen Wörter klein, fett und weiß.
Deine Aufgabe: Wähle die Wörter, die betont werden.
Regeln:
- Betone nur Wörter, die Bedeutung tragen: Kernbegriffe, Zahlen, Gegensätze, Ergebnisse, emotionale Schlüsselwörter. Niemals Artikel, Präpositionen, Hilfsverben.
- Höchstens ein betontes Wort pro Gruppe, und höchstens jede dritte Gruppe bekommt eines. Im Zweifel weniger. Direkt aufeinanderfolgende Gruppen werden nicht beide betont.
- Das betonte Wort muss mindestens 4 Buchstaben haben.
- "chunk" ist der Index der Gruppe (ab 0), "word" der Index des Wortes in der Gruppe (ab 0).
Antworte nur mit dem JSON-Objekt.`;

export async function planMotions(cfg: Config, runName: string, opts: { llm?: LlmClient; video?: string } = {}): Promise<MotionsPlan> {
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
  try {
    const llm = opts.llm ?? new AnthropicLlm();
    const model = cfg.llm.planModel;
    const list = chunks.map((c, i) => `${i}: ${c.words.map((w) => w.text).join(" ")}`).join("\n");
    const turn = await timed(run, "plan", clip.id, async () => {
      const t = await llm.complete({ model, system: SYSTEM, messages: [{ role: "user", content: `Gruppen:\n${list}` }], schema: toApiSchema(Emphasis), effort: "low", maxTokens: 8000 });
      return { value: t, api: { provider: "anthropic", model, input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, cache_read_tokens: t.usage.cache_read_tokens, cache_write_tokens: t.usage.cache_write_tokens, est_cost_usd: costUsd(cfg, model, t.usage) } };
    });
    picks = Emphasis.parse(extractJson(turn.text)).emphasis;
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
  const plan: MotionsPlan = { style: "motions", video: opts.video ?? `Reel_${runName}`, clip: clip.id, fps: meta.fps, duration_s: meta.duration_s, chunks };
  writeJson(motionsPlanFile(run.dir), plan);
  return plan;
}
