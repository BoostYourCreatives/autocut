import crypto from "node:crypto";
import { z } from "zod";
import type { MotionsScene } from "../render/remotion/Motions.tsx";

/** Flaches Schema für die Claude-Antwort (Structured Output kommt mit Unterscheidungs-Unions schlecht zurecht) */
export const SceneDraft = z.object({
  type: z.enum(["fullscreen_image", "back_card", "image_row", "glass_panel", "number_item"]),
  start_s: z.number(),
  end_s: z.number(),
  /** glass_panel: Hauptwort · number_item: Text */
  text: z.string().optional(),
  /** glass_panel: kleine Zeile darüber */
  label: z.string().optional(),
  /** image_row: Glas-Titel über den Karten */
  title: z.string().optional(),
  /** number_item: laufende Nummer */
  n: z.number().int().optional(),
  /** number_item: ein Emoji als Symbol */
  icon: z.string().optional(),
  /** fullscreen_image und back_card: englische Bildbeschreibung */
  image_prompt: z.string().optional(),
  /** image_row: 1 bis 3 Karten */
  items: z.array(z.object({ image_prompt: z.string(), tag: z.string().optional() })).optional(),
});
export type SceneDraft = z.infer<typeof SceneDraft>;

export const MotionsDraft = z.object({
  emphasis: z.array(z.object({ chunk: z.number().int(), word: z.number().int() })),
  scenes: z.array(SceneDraft),
});

export const imageName = (prompt: string) => `p${crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 10)}.png`;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Entwurf → Szenen. Ungültiges wird verworfen und in `dropped` begründet. */
export function buildScenes(draft: SceneDraft[], durationS: number): { scenes: MotionsScene[]; dropped: string[] } {
  const dropped: string[] = [];
  const out: MotionsScene[] = [];
  const topBusy: [number, number][] = [];
  const full: [number, number][] = [];
  const overlap = (list: [number, number][], a: number, b: number) => list.some(([x, y]) => a < y && b > x);
  for (const d of [...draft].sort((p, q) => p.start_s - q.start_s)) {
    const start_s = Math.max(0, r2(d.start_s));
    const end_s = Math.min(r2(durationS), r2(d.end_s));
    const why = (m: string) => dropped.push(`${d.type} ${start_s}–${end_s} s: ${m}`);
    if (end_s - start_s < 0.8) { why("kürzer als 0,8 s"); continue; }
    if (d.type === "fullscreen_image") {
      if (!d.image_prompt) { why("ohne Bildbeschreibung"); continue; }
      if (end_s - start_s > 3.5) { why("Zwischenschnitt länger als 3,5 s"); continue; }
      if (overlap(full, start_s, end_s) || overlap(topBusy, start_s, end_s)) { why("überlappt andere Bilder"); continue; }
      full.push([start_s, end_s]);
      out.push({ type: "fullscreen_image", start_s, end_s, image: imageName(d.image_prompt), image_prompt: d.image_prompt });
    } else if (d.type === "back_card") {
      if (!d.image_prompt) { why("ohne Bildbeschreibung"); continue; }
      if (overlap(topBusy, start_s, end_s) || overlap(full, start_s, end_s)) { why("oberer Bildbereich belegt"); continue; }
      topBusy.push([start_s, end_s]);
      out.push({ type: "back_card", start_s, end_s, image: imageName(d.image_prompt), image_prompt: d.image_prompt });
    } else if (d.type === "image_row") {
      const items = (d.items ?? []).slice(0, 3);
      if (!items.length) { why("ohne Karten"); continue; }
      if (overlap(topBusy, start_s, end_s) || overlap(full, start_s, end_s)) { why("oberer Bildbereich belegt"); continue; }
      topBusy.push([start_s, end_s]);
      out.push({ type: "image_row", start_s, end_s, title: d.title, label: d.label, items: items.map((i) => ({ image: imageName(i.image_prompt), image_prompt: i.image_prompt, tag: i.tag })) });
    } else if (d.type === "glass_panel") {
      if (!d.text) { why("ohne Text"); continue; }
      out.push({ type: "glass_panel", start_s, end_s, text: d.text, label: d.label });
    } else {
      if (!d.text || !d.n) { why("ohne Text oder Nummer"); continue; }
      out.push({ type: "number_item", start_s, end_s, n: d.n, text: d.text, icon: d.icon });
    }
  }
  // Mittlere Ebene (Glas-Felder und Nummern) darf sich nicht überlappen
  const mid: [number, number][] = [];
  const kept = out.filter((s) => {
    if (s.type !== "glass_panel" && s.type !== "number_item") return true;
    if (overlap(mid, s.start_s, s.end_s)) { dropped.push(`${s.type} ${s.start_s}–${s.end_s} s: überlappt anderes Glas-Feld`); return false; }
    mid.push([s.start_s, s.end_s]);
    return true;
  });
  return { scenes: kept, dropped };
}

/** Alle Bildbeschreibungen einer Szene (für die Bilderzeugung) */
export function scenePrompts(s: MotionsScene): string[] {
  if (s.type === "fullscreen_image" || s.type === "back_card") return s.image_prompt ? [s.image_prompt] : [];
  if (s.type === "image_row") return s.items.map((i) => i.image_prompt ?? "").filter(Boolean);
  return [];
}
