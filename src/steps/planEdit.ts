import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../schema/plan.ts";
import type { StyleParams } from "../schema/style.ts";
import { buildTimeline, outDuration, quantize } from "../plan/timeline.ts";
import { findSfx, type SfxEntry } from "../lib/sfxIndex.ts";

export interface SfxEdits {
  change?: { index: number; at_s?: number; gain_db?: number; file?: string }[];
  remove?: number[];
  add?: { file: string; at_s: number; gain_db?: number }[];
}
export interface BrollEdits {
  change?: { id: number; start_s?: number; end_s?: number; motif?: string; source?: SourcePick }[];
  remove?: number[];
  add?: { start_s: number; end_s: number; motif: string; source?: SourcePick }[];
}
/** Quelle eines B-Rolls: aus der eigenen Bibliothek (Dateiname) oder ein vorher heruntergeladener Stock-Clip (Dateiname im Lauf-Ordner broll/) */
export type SourcePick = { lib: string } | { stock: string; info?: string };
export interface ZoomEdits {
  change?: { index: number; start_s?: number; to_scale?: number }[];
  remove?: number[];
  add?: { start_s: number; to_scale: number }[];
}

export interface EditContext {
  params: StyleParams;
  sfxIndex: SfxEntry[];
  brollLibrary: string;
  /** Lauf-Ordner (für heruntergeladene Stock-Clips in <run>/broll) */
  runDir: string;
}

const LOCKED = new Set(["riser", "shutter"]);
const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

function resolveSource(src: SourcePick, ctx: EditContext) {
  if ("lib" in src) {
    const rel = path.normalize(src.lib).replace(/^(\.\.[\\/])+/, "");
    const full = path.join(ctx.brollLibrary, rel);
    if (rel.startsWith("..") || !full.startsWith(ctx.brollLibrary + path.sep) || !fs.existsSync(full)) throw new Error(`B-Roll-Video "${src.lib}" nicht in der eigenen Bibliothek gefunden.`);
    return { kind: "user_clip" as const, path: full, info: `eigene Bibliothek: ${src.lib}` };
  }
  const file = path.basename(src.stock);
  const full = path.join(ctx.runDir, "broll", file);
  if (!fs.existsSync(full)) throw new Error("Der gewählte Stock-Clip ist nicht mehr vorhanden. Bitte neu suchen.");
  return { kind: "stock_ordner" as const, path: full, info: src.info ?? "Stock-Video" };
}

export function applySfxEdits(plan: Plan, e: SfxEdits, ctx: EditContext): boolean {
  let changed = false;
  const total = outDuration(buildTimeline(plan.cut_segments));
  const cues = ctx.params.sfx.cues;
  const entry = (file: string) => {
    const x = findSfx(ctx.sfxIndex, file);
    if (!x) throw new Error(`Soundeffekt "${file}" ist nicht in deiner Library. Es gibt nur Sounds aus deiner eigenen Sammlung.`);
    return x;
  };
  const locked = (i: number) => {
    const s = plan.sfx[i];
    if (!s) throw new Error(`Soundeffekt ${i} gibt es nicht.`);
    if (LOCKED.has(s.role)) throw new Error("Riser und Camera Shutter gehören zum Hook-Übergang und lassen sich hier nicht ändern.");
    return s;
  };
  for (const c of e.change ?? []) {
    const s = locked(c.index);
    let did = false;
    if (num(c.at_s)) { s.at_s = Math.round(Math.max(-1, Math.min(total, c.at_s!)) * 1000) / 1000; did = true; }
    if (num(c.gain_db)) { s.gain_db = Math.min(-9, Math.max(-40, Math.round(c.gain_db! * 10) / 10)); did = true; }
    if (c.file) { s.file = entry(c.file).file; did = true; }
    if (did) { changed = true; s.reason = "Von Hand geändert"; s.confidence = "hoch"; }
  }
  for (const i of [...(e.remove ?? [])].sort((a, b) => b - a)) { locked(i); plan.sfx.splice(i, 1); changed = true; }
  for (const a of e.add ?? []) {
    const f = entry(a.file);
    const same = (c: { file: string }) => f.name.toLowerCase() === path.basename(c.file).toLowerCase();
    const role = same(cues.money) ? "money" : same(cues.fuwa_stark) ? "fuwa" : "sonstiges";
    plan.sfx.push({ role, file: f.file, at_s: Math.round(Math.max(0, Math.min(total, a.at_s)) * 1000) / 1000, gain_db: num(a.gain_db) ? Math.min(-9, a.gain_db!) : role === "money" ? cues.money.gain_db : cues.fuwa_stark.gain_db, reason: "Von Hand hinzugefügt", confidence: "hoch" });
    changed = true;
  }
  plan.sfx.sort((a, b) => a.at_s - b.at_s);
  return changed;
}

export function applyBrollEdits(plan: Plan, e: BrollEdits, ctx: EditContext): boolean {
  let changed = false;
  const fps = plan.source.fps;
  const total = outDuration(buildTimeline(plan.cut_segments));
  const q = (t: number) => Math.max(0, Math.min(total, quantize(t, fps)));
  for (const c of e.change ?? []) {
    const b = plan.broll.find((x) => x.id === c.id);
    if (!b) throw new Error(`B-Roll ${c.id} gibt es nicht.`);
    if (num(c.start_s)) b.start_s = q(c.start_s!);
    if (num(c.end_s)) b.end_s = q(c.end_s!);
    if (c.motif?.trim()) { b.motif = c.motif.trim(); if (b.source.kind === "offen") b.source = { kind: "offen", suche: b.motif }; }
    if (c.source) b.source = resolveSource(c.source, ctx);
    if (b.end_s - b.start_s > ctx.params.broll.max_s + 0.05) b.long_ok = true;
    b.reason = "Von Hand geändert"; b.confidence = "hoch";
    changed = true;
  }
  for (const id of e.remove ?? []) {
    const i = plan.broll.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`B-Roll ${id} gibt es nicht.`);
    plan.broll.splice(i, 1); changed = true;
  }
  for (const a of e.add ?? []) {
    const id = plan.broll.reduce((m, x) => Math.max(m, x.id), -1) + 1;
    const start = q(a.start_s), end = q(a.end_s);
    plan.broll.push({
      id, start_s: start, end_s: end, source: a.source ? resolveSource(a.source, ctx) : { kind: "offen", suche: a.motif }, motif: a.motif.trim() || "B-Roll",
      word_idx: [], shade_alpha: ctx.params.broll.shade_alpha, covers_ai_error: false, long_ok: end - start > ctx.params.broll.max_s + 0.05, reason: "Von Hand hinzugefügt", confidence: "hoch",
    });
    changed = true;
  }
  plan.broll.sort((a, b) => a.start_s - b.start_s);
  return changed;
}

export function applyZoomEdits(plan: Plan, e: ZoomEdits): boolean {
  let changed = false;
  const fps = plan.source.fps;
  const tl = buildTimeline(plan.cut_segments);
  const segAt = (t: number) => tl.find((s) => t >= s.out_from_s - 1e-6 && t < s.out_to_s) ?? tl[tl.length - 1]!;
  for (const c of e.change ?? []) {
    const z = plan.zooms[c.index];
    if (!z) throw new Error(`Zoom ${c.index} gibt es nicht.`);
    if (num(c.start_s)) { z.start_s = quantize(c.start_s!, fps); z.segment_id = segAt(z.start_s).id; }
    if (num(c.to_scale)) z.to_scale = c.to_scale!;
    z.reason = "Von Hand geändert"; z.confidence = "hoch"; changed = true;
  }
  for (const i of [...(e.remove ?? [])].sort((a, b) => b - a)) {
    if (!plan.zooms[i]) throw new Error(`Zoom ${i} gibt es nicht.`);
    plan.zooms.splice(i, 1); changed = true;
  }
  for (const a of e.add ?? []) {
    const start = quantize(a.start_s, fps);
    plan.zooms.push({ segment_id: segAt(start).id, start_s: start, to_scale: a.to_scale, reason: "Von Hand hinzugefügt", confidence: "hoch" });
    changed = true;
  }
  plan.zooms.sort((a, b) => a.start_s - b.start_s);
  return changed;
}
