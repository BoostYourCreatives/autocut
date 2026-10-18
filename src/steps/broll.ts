import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnthropicLlm, costUsd, type LlmClient } from "../llm/client.ts";
import type { Config } from "../config.ts";
import { Plan, type BrollSlot } from "../schema/plan.ts";
import { toApiSchema } from "../plan/draft.ts";
import { extractJson } from "./plan.ts";
import { ensureDir, readJson, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import type { RunPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";

export interface BrollOptions {
  /** Eigene Bibliothek verwenden */
  own: boolean;
  /** Stock-Videos von Pexels / Pixabay holen */
  stock: boolean;
  llm?: LlmClient;
  fetch?: typeof fetch;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const Answer = z.object({
  slots: z.array(z.object({ id: z.number().int(), eigene_datei: z.string().nullable(), suchbegriff_englisch: z.string() })),
});

function listLibrary(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (VIDEO_EXT.test(e.name)) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

const words = (s: string) => s.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length > 3);

/** Notlösung ohne Claude: Wortüberschneidung zwischen Motiv und Dateiname. */
function keywordMatch(motif: string, files: string[]): string | null {
  const m = new Set(words(motif));
  let best: [number, string | null] = [0, null];
  for (const f of files) {
    const score = words(path.basename(f, path.extname(f))).filter((w) => m.has(w)).length;
    if (score > best[0]) best = [score, f];
  }
  return best[1];
}

interface Candidate {
  provider: "Pexels" | "Pixabay";
  url: string;
  duration: number;
  portrait: boolean;
  credit: string;
}

async function searchPexels(q: string, f: typeof fetch): Promise<Candidate[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const r = await f(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels antwortet mit ${r.status}`);
  const j = (await r.json()) as { videos?: { duration: number; url: string; user?: { name?: string }; video_files: { width: number; height: number; link: string; file_type: string }[] }[] };
  const out: Candidate[] = [];
  for (const v of j.videos ?? []) {
    const files = v.video_files.filter((x) => x.file_type === "video/mp4" && x.height >= x.width && x.height >= 1280).sort((a, b) => a.height - b.height);
    const any = v.video_files.filter((x) => x.file_type === "video/mp4").sort((a, b) => b.width - a.width);
    const pick = files[0] ?? any.find((x) => x.width <= 1920) ?? any[0];
    if (pick) out.push({ provider: "Pexels", url: pick.link, duration: v.duration, portrait: pick.height >= pick.width, credit: `Pexels, ${v.user?.name ?? "?"}, ${v.url}` });
  }
  return out;
}

async function searchPixabay(q: string, f: typeof fetch): Promise<Candidate[]> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const r = await f(`https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q.slice(0, 100))}&per_page=15&safesearch=true`);
  if (!r.ok) throw new Error(`Pixabay antwortet mit ${r.status}`);
  const j = (await r.json()) as { hits?: { duration: number; pageURL: string; user?: string; videos: Record<string, { url: string; width: number; height: number }> }[] };
  const out: Candidate[] = [];
  for (const h of j.hits ?? []) {
    const v = [h.videos.large, h.videos.medium, h.videos.small].find((x) => x && x.url && x.width > 0);
    if (v) out.push({ provider: "Pixabay", url: v.url, duration: h.duration, portrait: v.height >= v.width, credit: `Pixabay, ${h.user ?? "?"}, ${h.pageURL}` });
  }
  return out;
}

async function download(url: string, dest: string, f: typeof fetch) {
  const r = await f(url);
  if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (${r.status})`);
  const tmp = `${dest}.part`;
  const ws = fs.createWriteStream(tmp);
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!ws.write(value)) await new Promise((res) => ws.once("drain", res));
  }
  await new Promise<void>((res, rej) => ws.end((e: Error | null | undefined) => (e ? rej(e) : res())));
  fs.renameSync(tmp, dest);
}

const SYSTEM = `Du hilfst beim Belegen von B-Roll-Stellen in einem Instagram-Reel. Für jede Stelle bekommst du das Motiv (auf Deutsch, was wörtlich im Bild zu sehen sein soll). Antworte für jede Stelle mit:
- eigene_datei: der Dateiname aus der Liste der eigenen Videos, der das Motiv wörtlich und eindeutig zeigt, sonst null. Rate nicht: Im Zweifel null.
- suchbegriff_englisch: ein kurzer englischer Suchbegriff (2–4 Wörter) für eine Stock-Video-Suche, der genau das Motiv trifft.`;

/** Sucht bei Pexels und Pixabay ein Video (mindestens needS Sekunden, hochkant bevorzugt) und lädt es nach dest. */
export async function findStockClip(query: string, needS: number, dest: string, f: typeof fetch = fetch): Promise<{ path: string; info: string } | null> {
  try {
    const settled = await Promise.allSettled([searchPexels(query, f), searchPixabay(query, f)]);
    for (const s of settled) if (s.status === "rejected") log.warn(`B-Roll-Suche: ${(s.reason as Error).message}`);
    const cands = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).filter((c) => c.duration >= needS);
    const pick = cands.find((c) => c.portrait) ?? cands[0];
    if (!pick) return null;
    ensureDir(path.dirname(dest));
    await download(pick.url, dest, f);
    return { path: dest, info: `${pick.credit} (Suche: ${query})` };
  } catch (e) {
    log.warn(`Stock-Suche fehlgeschlagen (${(e as Error).message.split("\n")[0]})`);
    return null;
  }
}

export interface BrollResult {
  slots: number;
  own: number;
  stock: number;
  open: number;
}

/**
 * Belegt die B-Roll-Stellen im Plan mit Videos: erst aus der eigenen Bibliothek, dann (wenn erlaubt) von Pexels/Pixabay.
 * Ohne Auswahl werden die B-Roll-Stellen aus dem Plan entfernt.
 */
export async function sourceBroll(cfg: Config, run: RunPaths, planFile: string, opts: BrollOptions): Promise<BrollResult> {
  const plan = Plan.parse(readJson(planFile));
  const res: BrollResult = { slots: plan.broll.length, own: 0, stock: 0, open: 0 };
  if (!opts.own && !opts.stock) {
    if (plan.broll.length) {
      plan.broll = [];
      writeJson(planFile, plan);
      log.info("B-Roll: aus (keine Quelle gewählt), die geplanten Stellen werden weggelassen");
    }
    return res;
  }
  const todo = plan.broll.filter((b) => b.source.kind === "offen");
  if (!todo.length) return res;

  const library = opts.own ? listLibrary(cfg.brollLibrary) : [];
  if (opts.own && !library.length) log.warn("B-Roll: Eigene Bibliothek ist leer. Bitte Videos hochladen.");
  const f = opts.fetch ?? fetch;

  // Claude: passende eigene Datei + englischer Suchbegriff
  const queries = new Map<number, string>();
  const chosen = new Map<number, string | null>();
  const llm = opts.llm ?? (process.env.ANTHROPIC_API_KEY ? new AnthropicLlm() : undefined);
  if (llm) {
    try {
      const model = cfg.llm.selfcheckModel;
      const user = `Stellen:\n${todo.map((b) => `- id ${b.id}: ${b.motif} (${(b.end_s - b.start_s).toFixed(1)} s)`).join("\n")}\n\nEigene Videos:\n${library.length ? library.map((x) => `- ${x}`).join("\n") : "(keine)"}`;
      const t = await timed(run, "broll-auswahl", plan.source.clip, async () => {
        const turn = await llm.complete({ model, system: SYSTEM, messages: [{ role: "user", content: user }], schema: toApiSchema(Answer), effort: "low", maxTokens: 4000 });
        return { value: turn, api: { provider: "anthropic", model, input_tokens: turn.usage.input_tokens, output_tokens: turn.usage.output_tokens, cache_read_tokens: turn.usage.cache_read_tokens, cache_write_tokens: turn.usage.cache_write_tokens, est_cost_usd: costUsd(cfg, model, turn.usage) } };
      });
      for (const s of Answer.parse(extractJson(t.text)).slots) {
        queries.set(s.id, s.suchbegriff_englisch);
        chosen.set(s.id, s.eigene_datei && library.includes(s.eigene_datei) ? s.eigene_datei : null);
      }
    } catch (e) {
      log.warn(`B-Roll: Claude-Auswahl fehlgeschlagen (${(e as Error).message.split("\n")[0]}). Einfache Suche wird verwendet.`);
    }
  }

  const dir = ensureDir(path.join(run.dir, "broll"));
  for (const b of todo) {
    const slot = plan.broll.find((x) => x.id === b.id) as BrollSlot;
    const need = b.end_s - b.start_s;
    const own = opts.own ? (chosen.has(b.id) ? chosen.get(b.id)! : keywordMatch(b.motif, library)) : null;
    if (own) {
      slot.source = { kind: "user_clip", path: path.join(cfg.brollLibrary, own), info: `eigene Bibliothek: ${own}` };
      res.own++;
      log.info(`B-Roll #${b.id} "${b.motif}": eigenes Video ${own}`);
      continue;
    }
    if (opts.stock) {
      const q = queries.get(b.id) ?? b.motif;
      const hit = await findStockClip(q, need, path.join(dir, `stock-${b.id}.mp4`), f);
      if (hit) {
        slot.source = { kind: "stock_ordner", path: hit.path, info: hit.info };
        res.stock++;
        log.info(`B-Roll #${b.id} "${b.motif}": Stock-Video (Suche: ${q})`);
        continue;
      }
      log.warn(`B-Roll #${b.id} "${b.motif}": kein passendes Stock-Video gefunden (Suche: ${q})`);
    }
    res.open++;
  }
  writeJson(planFile, plan);
  log.info(`B-Roll: ${res.own} eigene, ${res.stock} Stock, ${res.open} ohne Video (von ${todo.length})`);
  return res;
}
