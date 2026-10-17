import type { Analysis } from "../schema/analysis.ts";
import type { ClipMeta } from "../schema/ingest.ts";
import type { StyleParams } from "../schema/style.ts";
import type { Transcript } from "../schema/transcript.ts";
import { Plan, type BrollSlot, type Sfx, type Zoom } from "../schema/plan.ts";
import type { PlanDraft } from "./draft.ts";
import { buildCuts, type RemovalSpec } from "./cuts.ts";
import { buildCaptions } from "./captions.ts";
import { buildTimeline, outDuration, quantize } from "./timeline.ts";
import { findSfx, type SfxEntry } from "../lib/sfxIndex.ts";
import { round3 } from "../lib/intervals.ts";
import { de2 } from "../util/fmt.ts";

export interface FinalizeInput {
  draft: PlanDraft;
  transcript: Transcript;
  analysis: Analysis;
  meta: ClipMeta;
  params: StyleParams;
  sfxIndex: SfxEntry[];
  style: string;
  video: string;
  force?: { transition?: "blitz_riser" | "hart"; hookLines?: [string, string] };
}

export interface FinalizeResult {
  plan?: Plan;
  /** Fehler im Entwurf (gehen als Rückmeldung an Claude) */
  issues: string[];
}

/** Baut aus dem Entwurf von Claude den vollständigen, regelkonformen Plan. */
export function finalize(inp: FinalizeInput): FinalizeResult {
  const { draft, transcript, analysis, meta, params } = inp;
  const words = transcript.words;
  const fps = meta.fps;
  const frame = 1 / fps;
  const issues: string[] = [];
  const notes: string[] = [...draft.notes];
  const precut = analysis.precut.effective;
  const inRange = (i: number, what: string) => {
    if (!Number.isInteger(i) || i < 0 || i >= words.length) {
      issues.push(`${what}: Wortindex ${i} existiert nicht (gültig 0–${words.length - 1})`);
      return false;
    }
    return true;
  };

  // ---- Hook ----
  const h = draft.hook;
  inRange(h.end_word_idx, "hook.end_word_idx");
  const lines = inp.force?.hookLines ?? h.lines;
  if (lines.length !== params.hook.zeilen) issues.push(`hook.lines: genau ${params.hook.zeilen} Zeilen erforderlich, nicht ${lines.length}`);
  const transition = inp.force?.transition ?? h.transition;

  // ---- Entfernungen ----
  const removals: RemovalSpec[] = [];
  if (precut && draft.removals.length) {
    issues.push("Das Material ist vorgeschnitten: keine Entfernungen erlaubt (removals muss leer sein). Nur der Hook-Schnittpunkt wird gesetzt.");
  } else {
    for (const [n, r] of draft.removals.entries()) {
      const ok = inRange(r.from_word_idx, `removals[${n}].from`) && inRange(r.to_word_idx, `removals[${n}].to`);
      if (!ok) continue;
      if (r.to_word_idx < r.from_word_idx) {
        issues.push(`removals[${n}]: to_word_idx ${r.to_word_idx} < from_word_idx ${r.from_word_idx}`);
        continue;
      }
      if (r.from_word_idx <= h.end_word_idx) {
        issues.push(`removals[${n}] (Wörter ${r.from_word_idx}–${r.to_word_idx}) liegt im Hook (bis Wort ${h.end_word_idx}). Der Hook bleibt ungeschnitten.`);
        continue;
      }
      if (r.kind === "wiederholung") {
        if (r.kept_from_word_idx === null || r.kept_to_word_idx === null) {
          issues.push(`removals[${n}]: bei "wiederholung" müssen kept_from_word_idx/kept_to_word_idx den behaltenen Take angeben`);
          continue;
        }
        if (!inRange(r.kept_from_word_idx, `removals[${n}].kept_from`) || !inRange(r.kept_to_word_idx, `removals[${n}].kept_to`)) continue;
      }
      removals.push({
        kind: r.kind,
        from: r.from_word_idx,
        to: r.to_word_idx,
        ...(r.kept_from_word_idx !== null && r.kept_to_word_idx !== null ? { kept: { from: r.kept_from_word_idx, to: r.kept_to_word_idx } } : {}),
        reason: r.reason,
        confidence: r.confidence,
      });
    }
    removals.sort((a, b) => a.from - b.from);
    for (let k = 1; k < removals.length; k++) {
      if (removals[k]!.from <= removals[k - 1]!.to) issues.push(`Entfernungen überlappen: Wörter ${removals[k - 1]!.from}–${removals[k - 1]!.to} und ${removals[k]!.from}–${removals[k]!.to}`);
    }
    for (const r of removals) {
      if (r.kept && r.kept.from >= r.from && r.kept.from <= r.to) issues.push(`Wiederholung ${r.from}–${r.to}: der behaltene Take (${r.kept.from}–${r.kept.to}) liegt in der entfernten Stelle`);
    }
  }
  if (issues.length) return { issues };

  // ---- Schnittliste ----
  const cuts = buildCuts({
    words,
    silences: analysis.silences,
    duration_s: meta.duration_s,
    fps,
    precut,
    hookEndIdx: h.end_word_idx,
    hookReason: { reason: h.reason, confidence: h.confidence },
    removals,
    sceneTimes: analysis.scene_changes.map((s) => s.t_s),
    params,
  });
  issues.push(...cuts.issues);
  if (cuts.segments.length < 2) {
    return { issues: issues.length ? issues : ["Schnittliste hat weniger als 2 Segmente"] };
  }
  const tl = buildTimeline(cuts.segments);
  const total = outDuration(tl);
  const flash = tl[1]!.out_from_s;
  const wordOut = (i: number) => {
    const w = words[i];
    if (!w) return null;
    const mid = (w.start_s + w.end_s) / 2;
    const seg = tl.find((s) => mid >= s.raw_in_s - 1e-6 && mid <= s.raw_out_s + 1e-6);
    if (!seg) return null;
    return { start: seg.out_from_s + Math.max(0, w.start_s - seg.raw_in_s), end: seg.out_from_s + Math.min(seg.raw_out_s, w.end_s) - seg.raw_in_s, seg };
  };

  // ---- Korrekturen / Captions ----
  const corrections = new Map<number, string>();
  for (const c of draft.text_corrections) if (inRange(c.word_idx, "text_corrections")) corrections.set(c.word_idx, c.text);
  const caps = buildCaptions({ words, keptIdx: cuts.keptIdx, timeline: tl, fps, corrections, draft, params });
  issues.push(...caps.issues);

  // ---- Zooms ----
  const zooms: Zoom[] = [];
  if (precut && draft.zooms.length) {
    notes.push(`Vorgeschnittenes Material: ${draft.zooms.length} Zoom-Vorschlag/-vorschläge verworfen (keine eigenen Zooms).`);
  } else {
    const usedSeg = new Set<number>();
    for (const [n, z] of draft.zooms.entries()) {
      if (!inRange(z.word_idx, `zooms[${n}]`)) continue;
      if (!params.zoom.erlaubte_werte.some((v) => Math.abs(v - z.to_scale) < 1e-6)) {
        issues.push(`zooms[${n}]: to_scale ${z.to_scale} nicht erlaubt (erlaubt: ${params.zoom.erlaubte_werte.join(", ")})`);
        continue;
      }
      const o = wordOut(z.word_idx);
      if (!o) {
        issues.push(`zooms[${n}]: Wort ${z.word_idx} bleibt nicht im Video`);
        continue;
      }
      if (o.seg.id === 0) {
        issues.push(`zooms[${n}]: Wort ${z.word_idx} liegt im Hook. Im Hook gibt es nur den Push, keinen Zoom.`);
        continue;
      }
      if (usedSeg.has(o.seg.id)) {
        notes.push(`Zoom bei Wort ${z.word_idx} verworfen: pro Segment höchstens ein Zoom (Segment ${o.seg.id} hat schon einen).`);
        continue;
      }
      const ramp = params.zoom.rampe_frames * frame;
      let start = o.start;
      let reason = z.reason;
      let conf = z.confidence;
      if (o.seg.out_to_s - start < ramp - 1e-9) {
        const shifted = o.seg.out_to_s - ramp;
        if (shifted < o.seg.out_from_s - 1e-9) {
          notes.push(`Zoom bei Wort ${z.word_idx} verworfen: Segment ${o.seg.id} ist kürzer als die Zoom-Rampe (${params.zoom.rampe_frames} Frames).`);
          continue;
        }
        start = shifted;
        reason += ` (Start auf ${de2(shifted)} s vorgezogen, damit die ${params.zoom.rampe_frames}-Frame-Rampe ins Segment passt)`;
        conf = conf === "hoch" ? "mittel" : conf;
      }
      usedSeg.add(o.seg.id);
      zooms.push({ segment_id: o.seg.id, start_s: quantize(start, fps), to_scale: z.to_scale, reason, confidence: conf });
    }
    // Zooms sollen selten sein: Mindestabstand und Höchstzahl, bei Überzahl bleiben die sichersten
    const rank = { hoch: 0, mittel: 1, niedrig: 2 } as const;
    zooms.sort((x, y) => rank[x.confidence] - rank[y.confidence] || x.start_s - y.start_s);
    const kept: Zoom[] = [];
    for (const zm of zooms) {
      if (kept.length >= params.zoom.anzahl.max) {
        notes.push(`Zoom bei ${de2(zm.start_s)} s verworfen: höchstens ${params.zoom.anzahl.max} Zooms pro Reel.`);
      } else if (kept.some((k) => Math.abs(k.start_s - zm.start_s) < params.zoom.mindestabstand_s)) {
        notes.push(`Zoom bei ${de2(zm.start_s)} s verworfen: weniger als ${params.zoom.mindestabstand_s} s Abstand zum nächsten Zoom.`);
      } else kept.push(zm);
    }
    zooms.length = 0;
    zooms.push(...kept.sort((x, y) => x.start_s - y.start_s));
  }

  // ---- B-Roll ----
  const broll: BrollSlot[] = [];
  for (const [n, b] of draft.broll.entries()) {
    if (!inRange(b.from_word_idx, `broll[${n}].from`) || !inRange(b.to_word_idx, `broll[${n}].to`)) continue;
    const a = wordOut(b.from_word_idx);
    const z = wordOut(b.to_word_idx);
    if (!a || !z) {
      issues.push(`broll[${n}]: Wörter ${b.from_word_idx}–${b.to_word_idx} bleiben nicht im Video`);
      continue;
    }
    if (a.start < flash - 1e-9) {
      issues.push(`broll[${n}] beginnt im Hook (Wort ${b.from_word_idx}). B-Roll gibt es erst nach dem Hook.`);
      continue;
    }
    const start = Math.max(a.seg.out_from_s, a.start - params.broll.vorlauf_frames * frame);
    const nextSame = z.seg.out_to_s - z.end > params.broll.nachlauf_s ? z.end + params.broll.nachlauf_s : z.seg.out_to_s;
    let end = Math.min(total, nextSame);
    if (end - start < params.captions.min_frames * frame) end = Math.min(total, start + params.captions.min_frames * frame);
    const longOk = b.lange_einblendung || b.covers_ai_error;
    if (!longOk && end - start > params.broll.max_s) {
      end = start + params.broll.max_s;
      notes.push(`B-Roll "${b.motif}" auf ${params.broll.max_s} s gekürzt (längere Einblendung nur als Ausnahme).`);
    }
    broll.push({
      id: broll.length,
      start_s: quantize(start, fps),
      end_s: quantize(end, fps),
      source: { kind: "offen", suche: b.motif },
      motif: b.motif,
      word_idx: Array.from({ length: Math.max(0, b.to_word_idx - b.from_word_idx + 1) }, (_, k) => b.from_word_idx + k),
      shade_alpha: params.broll.shade_alpha,
      covers_ai_error: b.covers_ai_error,
      long_ok: longOk,
      reason: b.reason,
      confidence: b.confidence,
    });
  }
  broll.sort((x, y) => x.start_s - y.start_s);
  broll.forEach((b, i) => (b.id = i));

  // ---- SFX ----
  const sfx: Sfx[] = [];
  const cue = params.sfx.cues;
  const lib = (name: string, what: string) => {
    const e = findSfx(inp.sfxIndex, name);
    if (!e) issues.push(`SFX "${name}" (${what}) ist nicht in der SFX-Library. Nur Dateien aus dem Index sind erlaubt.`);
    return e;
  };
  if (transition === "blitz_riser") {
    const riser = lib(cue.riser.file, "Riser");
    const shutter = lib(cue.shutter.file, "Camera Shutter");
    if (riser) {
      sfx.push({
        role: "riser",
        file: riser.file,
        at_s: round3(flash - cue.riser.peak_im_file_s),
        peak_at_s: round3(flash),
        trim_end_at_s: round3(flash + cue.riser.ende_nach_blitz_s),
        fade_out_ms: cue.riser.fade_out_ms,
        gain_db: cue.riser.gain_db,
        reason: "Riser: Peak auf dem Gold-Blitz, endet mit dem Camera Shutter (regeln.md MUSS 7)",
        confidence: "hoch",
      });
    }
    if (shutter) sfx.push({ role: "shutter", file: shutter.file, at_s: round3(flash + cue.shutter.versatz_s), gain_db: cue.shutter.gain_db, reason: "Camera Shutter am Gold-Blitz", confidence: "hoch" });
  }
  for (const [n, s] of draft.sfx.entries()) {
    if (!inRange(s.word_idx, `sfx[${n}]`)) continue;
    const o = wordOut(s.word_idx);
    if (!o) {
      issues.push(`sfx[${n}]: Wort ${s.word_idx} bleibt nicht im Video`);
      continue;
    }
    const c = cue[s.kind];
    const entry = lib(c.file, s.kind);
    if (!entry) continue;
    sfx.push({
      role: s.kind === "money" ? "money" : "fuwa",
      file: entry.file,
      at_s: round3(o.start + c.versatz_s),
      gain_db: c.gain_db,
      reason: s.reason,
      confidence: s.confidence,
    });
  }
  if (draft.cta) {
    const o = wordOut(draft.cta.keyword_word_idx);
    const entry = lib(cue.ding.file, "Ding");
    if (o && entry) sfx.push({ role: "ding", file: entry.file, at_s: round3(o.start + cue.ding.versatz_s), gain_db: cue.ding.gain_db, reason: "Ding auf dem CTA-Keyword", confidence: "hoch" });
  }
  sfx.sort((a, b) => a.at_s - b.at_s);

  if (issues.length) return { issues };

  const hookLines = lines.map((l) => l.trim().toUpperCase()) as [string, string];
  const plan = {
    schema_version: 1 as const,
    video: inp.video,
    role: meta.role,
    style: inp.style,
    source: { clip: meta.id, file: meta.source_path, fps, width: meta.width, height: meta.height, duration_s: meta.duration_s },
    precut,
    hook: {
      end_word_idx: h.end_word_idx,
      end_raw_s: words[h.end_word_idx]!.end_s,
      lines: hookLines,
      text_origin: inp.force?.hookLines ? ("user" as const) : ("generated" as const),
      transition,
      push: !precut,
      reason: inp.force?.transition ? `${h.reason} (Übergang per CLI vorgegeben: ${transition})` : h.reason,
      confidence: inp.force?.hookLines || inp.force?.transition ? ("hoch" as const) : h.confidence,
    },
    cut_segments: cuts.segments,
    removed: cuts.removed,
    text_corrections: draft.text_corrections,
    captions: caps.captions,
    zooms,
    sfx,
    overlays: [
      { type: "hook_box" as const, start_s: 0, end_s: flash, lines: hookLines, reason: "Hook-Box ab Frame 0 bis zum Hook-Ende (regeln.md MUSS 6)", confidence: "hoch" as const },
      { type: "ki_hinweis" as const, start_s: 0, end_s: flash, text: params.hook.ki_text, reason: "KI-Kennzeichnung, gleiche Dauer wie die Hook-Box (EU AI Act Art. 50)", confidence: "hoch" as const },
    ],
    broll,
    notes,
  };
  const parsed = Plan.safeParse(plan);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((i) => `Plan-Schema: ${i.path.join(".")}: ${i.message}`) };
  }
  return { plan: parsed.data, issues: [] };
}
