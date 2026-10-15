import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config, Style } from "../config.ts";
import { AnthropicLlm, costUsd, type LlmClient } from "../llm/client.ts";
import { toApiSchema } from "../plan/draft.ts";
import { Plan } from "../schema/plan.ts";
import { Transcript } from "../schema/transcript.ts";
import { buildTimeline, outDuration } from "../plan/timeline.ts";
import { execOk } from "../util/exec.ts";
import { de2, mmss } from "../util/fmt.ts";
import { ensureDir, readJsonSchema, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import { timed } from "../util/runlog.ts";
import type { RunPaths } from "../util/run.ts";

export const SelfcheckResult = z.object({
  urteil: z.enum(["ok", "auffaelligkeiten"]),
  befunde: z.array(
    z.object({
      t_s: z.number(),
      art: z.enum(["caption_lesbarkeit", "caption_korrektheit", "sync", "hook_beginn", "gesicht_verdeckt", "bildfehler", "sonstiges"]),
      schwere: z.enum(["hinweis", "fehler"]),
      beschreibung: z.string(),
    }),
  ),
  zusammenfassung: z.string(),
});
export type SelfcheckResult = z.infer<typeof SelfcheckResult>;

export interface SelfcheckFile {
  skipped?: string;
  result?: SelfcheckResult;
  frames?: { t_s: number; file: string }[];
  est_cost_usd?: number;
}

/** Zeitpunkte der Kontrollbilder: fester Abstand plus Hook-Anfang, Hook-Ende, Blitz und Schluss. */
export function selfcheckTimes(total: number, hookEnd: number | null, step: number, max: number): number[] {
  const set = new Set<number>();
  const add = (t: number) => {
    if (t >= 0 && t < total) set.add(Math.round(t * 100) / 100);
  };
  add(0.05);
  if (hookEnd) [hookEnd - 0.15, hookEnd + 0.05, hookEnd + 0.2].forEach(add);
  for (let t = step; t < total; t += step) add(t);
  add(total - 0.1);
  const all = [...set].sort((a, b) => a - b);
  if (all.length <= max) return all;
  const keep = new Set(all.slice(0, 1).concat(all.slice(-1)));
  const stride = (all.length - keep.size) / (max - keep.size);
  for (let i = 0; i < max - keep.size; i++) keep.add(all[1 + Math.floor(i * stride)]!);
  return [...keep].sort((a, b) => a - b);
}

/** Was laut Plan in diesem Moment zu sehen sein soll. */
function expectation(plan: Plan, t: number): string {
  const act = plan.captions.filter((c) => c.start_s <= t && t < c.end_s).map((c) => `"${c.text}" (${c.kind})`);
  const hook = plan.overlays.find((o) => o.type === "hook_box");
  const parts: string[] = [];
  if (hook && t >= hook.start_s && t < hook.end_s) parts.push("Hook-Box + KI-Hinweis sichtbar");
  parts.push(act.length ? `Einblendungen: ${act.join(", ")}` : "keine Einblendung");
  const b = plan.broll.filter((x) => x.start_s <= t && t < x.end_s).map((x) => x.motif);
  if (b.length) parts.push(`B-Roll: ${b.join(", ")}`);
  return parts.join("; ");
}

/** Wörter des fertigen Videos mit Ausgabezeit (aus Transkript und Schnittliste). */
function finalTranscript(plan: Plan, transcript: Transcript): string {
  const tl = buildTimeline(plan.cut_segments);
  const corr = new Map(plan.text_corrections.map((c) => [c.word_idx, c.text]));
  const removed = new Set(plan.removed.flatMap((r) => r.word_idx));
  const out: string[] = [];
  for (const w of transcript.words) {
    if (removed.has(w.i)) continue;
    const mid = (w.start_s + w.end_s) / 2;
    const seg = tl.find((s) => mid >= s.raw_in_s && mid <= s.raw_out_s);
    if (!seg) continue;
    out.push(`${(seg.out_from_s + w.start_s - seg.raw_in_s).toFixed(1)}s ${corr.get(w.i) ?? w.word}`);
  }
  return out.join(" | ");
}

const SYSTEM = `Du prüfst ein fertig gerendertes Reel (9:16) nach dem Render. Du bekommst Standbilder aus dem fertigen Video in festen Abständen, den Plan (was zu sehen sein soll) und das Transkript des fertigen Videos mit Zeiten. Ton hörst du nicht.

Prüfe NUR, was du an den Bildern wirklich sehen kannst:
- caption_lesbarkeit: Ist die Einblendung gut lesbar (Kontrast, Größe, nichts abgeschnitten, nichts überlappt)?
- caption_korrektheit: Stimmt der Text im Bild mit dem überein, was laut Transkript zu dieser Zeit gesagt wird (Tippfehler, falsches Wort)?
- sync: Passt die Einblendung zeitlich zum gesprochenen Wort (Transkript-Zeit ± 0,4 s)? Nur melden, wenn es klar abweicht.
- hook_beginn: Ist das erste Bild sauber (Hook-Box vollständig, KI-Hinweis unten, kein halber Text)?
- gesicht_verdeckt: Verdeckt Text oder B-Roll Mund, Kinn oder Gesicht der Person? Das ist verboten.
- bildfehler: Schwarzes Bild, Artefakte, abgeschnittenes Gesicht beim Zoom, offensichtlich falsches B-Roll.
Melde nur echte Befunde mit Zeitpunkt (t_s, Sekunden im fertigen Video). Erfinde nichts, rate nicht bei unscharfen Bildern. Wenn alles in Ordnung ist: urteil "ok" und leere befunde. schwere "fehler" = muss korrigiert werden, "hinweis" = Mensch sollte hinsehen. Schreibe kurz und konkret auf Deutsch.`;

export async function selfcheck(
  cfg: Config,
  style: Style,
  run: RunPaths,
  planFile: string,
  videoFile: string,
  opts: { llm?: LlmClient } = {},
): Promise<SelfcheckFile> {
  const plan = readJsonSchema(planFile, Plan);
  const clipDir = path.join(path.dirname(path.resolve(planFile)), "clips", plan.source.clip);
  const transcript = readJsonSchema(path.join(clipDir, "transcript.json"), Transcript);
  const total = outDuration(buildTimeline(plan.cut_segments));
  const S = style.params.selfcheck;
  const hookEnd = plan.overlays.find((o) => o.type === "hook_box")?.end_s ?? null;
  const times = selfcheckTimes(total, hookEnd, S.frame_abstand_s, S.max_bilder);
  const dir = ensureDir(path.join(path.dirname(videoFile), "selfcheck-frames"));

  const frames: { t_s: number; file: string }[] = [];
  for (const t of times) {
    const file = path.join(dir, `${path.basename(videoFile, ".mp4")}_${t.toFixed(2)}.jpg`);
    await execOk("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-ss", String(t), "-i", videoFile, "-frames:v", "1", "-vf", `scale=${S.bildbreite_px}:-2`, "-q:v", "4", file]);
    frames.push({ t_s: t, file });
  }

  const content: unknown[] = [
    {
      type: "text",
      text: `Plan: ${plan.video}, ${de2(total)} s, Hook endet bei ${hookEnd === null ? "?" : de2(hookEnd)} s, Übergang ${plan.hook?.transition ?? "-"}.\n\nTranskript des fertigen Videos:\n${finalTranscript(plan, transcript)}\n\nIm Folgenden ${frames.length} Standbilder. Vor jedem steht der Zeitpunkt und was laut Plan zu sehen sein soll.`,
    },
  ];
  for (const f of frames) {
    content.push({ type: "text", text: `Bild bei ${f.t_s.toFixed(2)} s (${mmss(f.t_s)}). Laut Plan: ${expectation(plan, f.t_s)}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(f.file).toString("base64") } });
  }
  content.push({ type: "text", text: "Gib dein Ergebnis im vorgegebenen JSON-Schema zurück." });

  const llm = opts.llm ?? new AnthropicLlm();
  const model = cfg.llm.selfcheckModel;
  const turn = await timed(run, "selfcheck", plan.source.clip, async () => {
    const t = await llm.complete({ model, system: SYSTEM, messages: [{ role: "user", content }], schema: toApiSchema(SelfcheckResult), effort: S.modell_effort, maxTokens: 8000 });
    return {
      value: t,
      api: { provider: "anthropic", model, input_tokens: t.usage.input_tokens, output_tokens: t.usage.output_tokens, cache_read_tokens: t.usage.cache_read_tokens, cache_write_tokens: t.usage.cache_write_tokens, est_cost_usd: costUsd(cfg, model, t.usage) },
    };
  });
  const parsed = SelfcheckResult.parse(JSON.parse(turn.text));
  const out: SelfcheckFile = { result: parsed, frames, est_cost_usd: costUsd(cfg, model, turn.usage) };
  writeJson(path.join(path.dirname(videoFile), `${path.basename(videoFile, ".mp4")}.selfcheck.json`), out);
  log.info(`selfcheck: ${parsed.urteil}, ${parsed.befunde.length} Befund(e) (${frames.length} Bilder)`);
  return out;
}
