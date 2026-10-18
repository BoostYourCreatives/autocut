import { Plan } from "../schema/plan.ts";
import type { Analysis } from "../schema/analysis.ts";
import type { StyleParams } from "../schema/style.ts";
import type { Transcript } from "../schema/transcript.ts";
import { buildTimeline, outDuration } from "../plan/timeline.ts";
import { findSfx, type SfxEntry } from "../lib/sfxIndex.ts";
import { de2, mmss } from "../util/fmt.ts";

export interface Issue {
  severity: "fehler" | "warnung";
  code: string;
  message: string;
  /** Zeit im fertigen Video (s), falls zutreffend */
  t_s?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Prüfungen, die in dieser Ausbaustufe noch nicht laufen */
  notChecked: string[];
  stats: { out_duration_s: number; source_duration_s: number; length_ratio: number; removed_speech_share: number; segments: number };
}

export interface ValidateInput {
  plan: unknown;
  transcript: Transcript;
  analysis: Analysis;
  params: StyleParams;
  sfxIndex: SfxEntry[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Strenger Plan-Check ohne KI. Fehler blockieren das Rendern, Warnungen nicht.
 * Der Check läuft auf dem fertigen Plan, egal ob von Claude erzeugt oder von Hand geändert.
 */
export function validate(inp: ValidateInput): ValidationResult {
  const issues: Issue[] = [];
  const err = (code: string, message: string, t_s?: number) => issues.push({ severity: "fehler", code, message, ...(t_s !== undefined ? { t_s } : {}) });
  const warn = (code: string, message: string, t_s?: number) => issues.push({ severity: "warnung", code, message, ...(t_s !== undefined ? { t_s } : {}) });
  const P = inp.params;
  const V = P.validator;
  const notChecked = ["Text mindestens 20 px unter dem Kinn (MediaPipe-Messung kommt in M3)", "B-Roll passt wörtlich zur Stelle (inhaltlich, nur über Selfcheck/Mensch prüfbar)"];

  const parsed = Plan.safeParse(inp.plan);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err("schema", `${i.path.join(".") || "(root)"}: ${i.message}`);
    return result(issues, notChecked, null, inp);
  }
  const plan = parsed.data;
  const words = inp.transcript.words;
  const fps = plan.source.fps;
  const frame = 1 / fps;
  const tol = V.wortrand_toleranz_s;
  const tl = buildTimeline(plan.cut_segments);
  const total = outDuration(tl);
  const t = (x: number) => mmss(x);

  // ---------- Schnittliste ----------
  tl.forEach((s, i) => {
    if (s.raw_in_s < -1e-6 || s.raw_out_s > plan.source.duration_s + 0.01) err("segment_bereich", `Segment ${s.id}: ${de2(s.raw_in_s)}–${de2(s.raw_out_s)} s liegt außerhalb des Rohmaterials (0–${de2(plan.source.duration_s)} s)`, s.out_from_s);
    if (i > 0 && s.raw_in_s < tl[i - 1]!.raw_out_s - 1e-6) err("ueberlappung_roh", `Segmente ${tl[i - 1]!.id} und ${s.id} überlappen im Rohmaterial (${de2(s.raw_in_s)} < ${de2(tl[i - 1]!.raw_out_s)} s): Ton würde doppelt laufen`, s.out_from_s);
    const frames = (s.raw_out_s - s.raw_in_s) * fps;
    if (frames < P.schnitt.min_fragment_frames - 0.5) err("fragment_kurz", `Segment ${s.id} ist nur ${frames.toFixed(1)} Frames lang (Minimum ${P.schnitt.min_fragment_frames})`, s.out_from_s);
  });

  // Schnitt mitten im Wort, Tonsprung an den Kanten
  const fine = inp.analysis.loudness.fine_series_db;
  const fw = inp.analysis.loudness.fine_window_s;
  const edges: { raw: number; side: "aus" | "ein"; out: number }[] = [];
  tl.forEach((s, i) => {
    if (i > 0 && !plan.precut) edges.push({ raw: s.raw_in_s, side: "ein", out: s.out_from_s });
    if (i < tl.length - 1 && !plan.precut) edges.push({ raw: s.raw_out_s, side: "aus", out: s.out_to_s });
  });
  if (!plan.precut) {
    edges.push({ raw: tl[0]!.raw_in_s, side: "ein", out: 0 });
    edges.push({ raw: tl[tl.length - 1]!.raw_out_s, side: "aus", out: total });
  }
  for (const e of edges) {
    const w = words.find((w) => w.start_s + tol < e.raw && e.raw < w.end_s - tol);
    if (w) err("schnitt_im_wort", `Schnitt bei Rohzeit ${de2(e.raw)} s liegt mitten im Wort "${w.word}" (${de2(w.start_s)}–${de2(w.end_s)} s)`, e.out);
    if (fine.length) {
      // Fenster direkt an der Schnittkante, auf der Seite, die im Video bleibt
      const idx = e.side === "aus" ? Math.floor((e.raw - 0.001) / fw) : Math.floor((e.raw + 0.001) / fw);
      const lvl = fine[Math.min(Math.max(idx, 0), fine.length - 1)]!;
      if (lvl > V.tonsprung_fehler_db) err("tonsprung", `Schnittkante bei ${t(e.out)} liegt auf lauter Stelle (${lvl} dBFS): hörbarer Sprung`, e.out);
      else if (lvl > V.tonsprung_warn_db) warn("schnittkante_laut", `Schnittkante bei ${t(e.out)} ist ${lvl} dBFS laut (Schwelle ${V.tonsprung_warn_db}): Knackgefahr`, e.out);
    }
  }

  // Entfernte Wörter dürfen nicht mehr hörbar sein; jede Lücke braucht eine Begründung
  const removedWordIdx = new Set(plan.removed.flatMap((r) => r.word_idx));
  for (const i of removedWordIdx) {
    const w = words[i];
    if (!w) {
      err("entfernung_index", `Entfernung verweist auf unbekanntes Wort ${i}`);
      continue;
    }
    const overlap = tl.reduce((a, s) => a + Math.max(0, Math.min(w.end_s, s.raw_out_s) - Math.max(w.start_s, s.raw_in_s)), 0);
    if (overlap > 0.02) err("entferntes_wort_hoerbar", `Wort ${i} "${w.word}" ist als entfernt eingetragen, aber ${de2(overlap)} s davon laufen noch im Video`);
  }
  const gaps: [number, number][] = [];
  if (tl[0]!.raw_in_s > 0.02) gaps.push([0, tl[0]!.raw_in_s]);
  for (let i = 0; i < tl.length - 1; i++) if (tl[i + 1]!.raw_in_s - tl[i]!.raw_out_s > 0.02) gaps.push([tl[i]!.raw_out_s, tl[i + 1]!.raw_in_s]);
  const lastSeg = tl[tl.length - 1]!;
  if (plan.source.duration_s - lastSeg.raw_out_s > 0.02) gaps.push([lastSeg.raw_out_s, plan.source.duration_s]);
  for (const [g0, g1] of gaps) {
    // jeder Punkt der Lücke muss von einem removed-Eintrag abgedeckt sein (Toleranz 30 ms)
    let covered = g0;
    for (const r of [...plan.removed].sort((a, b) => a.raw_from_s - b.raw_from_s)) {
      if (r.raw_from_s <= covered + 0.03 && r.raw_to_s > covered) covered = r.raw_to_s;
    }
    if (covered < g1 - 0.03) err("luecke_ohne_grund", `Entferntes Rohmaterial ${de2(Math.max(g0, covered))}–${de2(g1)} s hat keinen Eintrag in "removed" (Grund fehlt)`);
  }
  if (plan.precut && gaps.length) err("vorgeschnitten_geschnitten", `Material ist vorgeschnitten, es wurden aber ${gaps.length} Stück(e) entfernt. Nichts weiter schneiden.`);

  // ---------- Hook ----------
  const hook = plan.hook;
  if (!hook) {
    err("hook_fehlt", "Reel ohne Hook: Hook-Box, KI-Hinweis und Hook-Ende sind Pflicht");
  } else {
    const hw = words[hook.end_word_idx];
    if (!hw) err("hook_index", `hook.end_word_idx ${hook.end_word_idx} existiert nicht`);
    else {
      if (Math.abs(hw.end_s - hook.end_raw_s) > 0.01) err("hook_ende_roh", `hook.end_raw_s (${de2(hook.end_raw_s)}) passt nicht zum Ende von Wort ${hook.end_word_idx} (${de2(hw.end_s)})`);
      const seg0 = tl[0]!;
      for (let i = 0; i <= hook.end_word_idx; i++) {
        const w = words[i]!;
        if (removedWordIdx.has(i)) err("hook_geschnitten", `Wort ${i} "${w.word}" im Hook ist entfernt: der Hook bleibt ungeschnitten`);
        else if (w.start_s < seg0.raw_in_s - tol || w.end_s > seg0.raw_out_s + tol) err("hook_nicht_im_segment0", `Hook-Wort ${i} "${w.word}" liegt nicht komplett in Segment 0`);
      }
      const nw = words[hook.end_word_idx + 1];
      if (nw && !plan.precut && nw.start_s - hw.end_s < P.hook.min_luecke_s) err("hook_ende_keine_luecke", `Zwischen Hook-Ende "${hw.word}" und "${nw.word}" ist keine Lücke (${de2(nw.start_s - hw.end_s)} s)`);
      if (tl.length < 2) err("hook_kein_body", "Nach dem Hook folgt kein weiteres Segment");
    }
    if (hook.lines.length !== P.hook.zeilen) err("hook_zeilen", `Hook-Box braucht genau ${P.hook.zeilen} Zeilen`);
    for (const l of hook.lines) {
      if (l !== l.toUpperCase()) err("hook_versalien", `Hook-Zeile "${l}" muss in Versalien stehen`);
      if (EMOJI.test(l)) err("hook_emoji", `Hook-Zeile "${l}" enthält ein Emoji (verboten)`);
      if (l.length > P.hook.max_zeichen_zeile) warn("hook_zeile_lang", `Hook-Zeile "${l}" hat ${l.length} Zeichen (Annahme: max ${P.hook.max_zeichen_zeile}), Box könnte überlaufen`);
    }
    if (hook.push !== !plan.precut) err("hook_push", plan.precut ? "Vorgeschnittenes Material: kein Hook-Push erlaubt" : "Eigener Schnitt: Hook-Push 100→106 % ist Standard (push=true)");
    const flash = tl[1]?.out_from_s ?? 0;
    const box = plan.overlays.filter((o) => o.type === "hook_box");
    const ki = plan.overlays.filter((o) => o.type === "ki_hinweis");
    if (box.length !== 1) err("hook_box_anzahl", `Genau eine Hook-Box erforderlich, gefunden: ${box.length}`);
    if (ki.length !== 1) err("ki_hinweis_anzahl", `Genau ein KI-Hinweis erforderlich, gefunden: ${ki.length}`);
    for (const o of [...box, ...ki]) {
      if (o.start_s > 0.001) err("overlay_start", `${o.type} muss bei Frame 0 beginnen (beginnt bei ${de2(o.start_s)} s)`);
      if (Math.abs(o.end_s - flash) > frame + 0.001) err("overlay_ende", `${o.type} muss mit dem Hook enden (${de2(flash)} s), endet bei ${de2(o.end_s)} s`);
    }
    for (const o of ki) if (o.type === "ki_hinweis" && o.text !== P.hook.ki_text) err("ki_text", `KI-Hinweis muss exakt "${P.hook.ki_text}" lauten`);

    // Übergang ↔ SFX
    const riser = plan.sfx.filter((s) => s.role === "riser");
    const shutter = plan.sfx.filter((s) => s.role === "shutter");
    if (hook.transition === "blitz_riser") {
      if (riser.length !== 1 || shutter.length !== 1) err("uebergang_sfx", `Übergang "blitz_riser" braucht genau 1 Riser und 1 Camera Shutter (gefunden: ${riser.length}/${shutter.length})`);
      else {
        const r = riser[0]!;
        const sh = shutter[0]!;
        if (Math.abs((r.peak_at_s ?? NaN) - flash) > 0.03) err("riser_peak", `Riser-Peak (${de2(r.peak_at_s ?? NaN)} s) muss auf dem Blitz (${de2(flash)} s) liegen`);
        if (Math.abs((r.trim_end_at_s ?? NaN) - (flash + P.sfx.cues.riser.ende_nach_blitz_s)) > 0.03) err("riser_ende", `Riser muss bei Blitz + ${de2(P.sfx.cues.riser.ende_nach_blitz_s)} s enden (mit dem Shutter), nicht bei ${de2(r.trim_end_at_s ?? NaN)} s`);
        if (Math.abs(sh.at_s - (flash + P.sfx.cues.shutter.versatz_s)) > 0.03) err("shutter_zeit", `Camera Shutter muss bei ${de2(flash + P.sfx.cues.shutter.versatz_s)} s liegen, liegt bei ${de2(sh.at_s)} s`);
      }
    } else if (riser.length || shutter.length) {
      err("uebergang_sfx", `Übergang "hart": kein Riser und kein Camera Shutter erlaubt`);
    }
  }

  // ---------- Untertitel ----------
  const keptWords = words.filter((w) => !removedWordIdx.has(w.i) && tl.some((s) => (w.start_s + w.end_s) / 2 >= s.raw_in_s && (w.start_s + w.end_s) / 2 <= s.raw_out_s));
  const corr = new Map(plan.text_corrections.map((c) => [c.word_idx, c.text]));
  const wordOut = (i: number) => {
    const w = words[i];
    if (!w) return null;
    const mid = (w.start_s + w.end_s) / 2;
    const seg = tl.find((s) => mid >= s.raw_in_s - 1e-6 && mid <= s.raw_out_s + 1e-6);
    return seg ? { start: seg.out_from_s + Math.max(0, w.start_s - seg.raw_in_s), seg } : null;
  };
  const coverage = new Map<number, number>();
  for (const c of plan.captions) {
    for (const i of c.word_idx) coverage.set(i, (coverage.get(i) ?? 0) + 1);
    const expected = c.word_idx.map((i) => corr.get(i) ?? words[i]?.word ?? "?").join(" ");
    if (c.word_idx.some((i) => !words[i])) err("caption_index", `Untertitel #${c.id} verweist auf unbekannte Wörter`, c.start_s);
    else if (!c.edited && norm(c.text) !== norm(expected)) err("caption_text", `Untertitel #${c.id} "${c.text}" weicht vom Transkript ab ("${expected}"). Korrekturen nur über text_corrections.`, c.start_s);
    if (c.word_idx.some((i) => removedWordIdx.has(i))) err("caption_entferntes_wort", `Untertitel #${c.id} "${c.text}" enthält entfernte Wörter`, c.start_s);
  }
  for (const w of keptWords) {
    const n = coverage.get(w.i) ?? 0;
    if (n === 0) err("caption_fehlt", `Wort ${w.i} "${w.word}" hat keinen Untertitel`, wordOut(w.i)?.start);
    else if (n > 1) err("caption_doppelt", `Wort ${w.i} "${w.word}" steckt in ${n} Untertiteln`, wordOut(w.i)?.start);
  }
  for (const [c, n] of plan.text_corrections.map((c) => [c, 1] as const)) if (!words[c.word_idx]) err("korrektur_index", `Korrektur verweist auf unbekanntes Wort ${c.word_idx}`, n);

  const allowedColors = new Set(P.farben.erlaubt.map((c) => c.toLowerCase()));
  for (const c of plan.captions) {
    const lastSeg = wordOut(c.word_idx[c.word_idx.length - 1]!)?.seg;
    const firstOut = wordOut(c.word_idx[0]!);
    if (c.end_s <= c.start_s) err("caption_dauer", `Untertitel #${c.id} "${c.text}": Ende vor Start`, c.start_s);
    if (c.end_s > total + 0.001 || c.start_s < -0.001) err("caption_bereich", `Untertitel #${c.id} liegt außerhalb des Videos (${de2(c.start_s)}–${de2(c.end_s)} s, Länge ${de2(total)} s)`, c.start_s);
    if ((c.end_s - c.start_s) * fps < P.captions.min_frames - 0.5) err("caption_kurz", `Untertitel #${c.id} "${c.text}" steht nur ${((c.end_s - c.start_s) * fps).toFixed(1)} Frames (Minimum ${P.captions.min_frames})`, c.start_s);
    if (c.kind !== "cta" && lastSeg && c.end_s > lastSeg.out_to_s + frame + 0.001) err("caption_ueber_schnitt", `Untertitel #${c.id} "${c.text}" läuft über das Segmentende (${de2(lastSeg.out_to_s)} s) hinaus`, c.start_s);
    if (firstOut && !c.edited) {
      const early = firstOut.start - c.start_s;
      if (early > (P.captions.timing.wipe_vorlauf_frames + 2) * frame + 0.001) err("caption_zu_frueh", `Untertitel #${c.id} "${c.text}" erscheint ${de2(early)} s vor dem gesprochenen Wort (Sync)`, c.start_s);
      if (early < -0.04) err("caption_zu_spaet", `Untertitel #${c.id} "${c.text}" erscheint ${de2(-early)} s nach dem gesprochenen Wort (Sync)`, c.start_s);
    }
    // Schrift, Farbe, Emojis
    const wantFont = P.schriften[c.kind];
    if (c.font !== wantFont) err("schrift", `Untertitel #${c.id} "${c.text}": Schrift ${c.font} nicht erlaubt für ${c.kind} (erlaubt: ${wantFont})`, c.start_s);
    const wantColor = c.kind === "gold" || c.kind === "cta" ? P.farben.gold : P.farben.weiss;
    if (c.color.toLowerCase() !== wantColor) err("farbe", `Untertitel #${c.id} "${c.text}": Farbe ${c.color} statt ${wantColor}`, c.start_s);
    if (!allowedColors.has(c.color.toLowerCase())) err("farbe_verboten", `Untertitel #${c.id}: Farbe ${c.color} ist keine erlaubte Farbe (nur ${P.farben.erlaubt.join(", ")})`, c.start_s);
    if (EMOJI.test(c.text)) err("emoji", `Untertitel #${c.id} "${c.text}" enthält ein Emoji (verboten)`, c.start_s);
    if (c.kind === "weiss" && c.layout === "solo" && c.word_idx.length > 1 && c.text.length > P.captions.merge.max_zeichen) {
      warn("caption_lang", `Untertitel #${c.id} "${c.text}" hat ${c.text.length} Zeichen (Merge-Grenze ${P.captions.merge.max_zeichen})`, c.start_s);
    }
    if (c.kind === "zitat" && !/[„“"]/.test(c.text)) warn("zitat_zeichen", `Zitat-Untertitel #${c.id} ohne „…“`, c.start_s);
  }
  // Überlappungen: Einzelzeilen untereinander, und Einzelzeilen gegen Gruppen
  const lane = plan.captions.filter((c) => c.kind !== "cta");
  for (let a = 0; a < lane.length; a++) {
    for (let b = a + 1; b < lane.length; b++) {
      const x = lane[a]!;
      const y = lane[b]!;
      if (x.group && x.group === y.group) continue;
      const overlap = Math.min(x.end_s, y.end_s) - Math.max(x.start_s, y.start_s);
      if (overlap > 0.001) err("caption_ueberlappung", `Untertitel #${x.id} "${x.text}" und #${y.id} "${y.text}" überlappen ${de2(overlap)} s`, Math.max(x.start_s, y.start_s));
    }
  }
  const goldCount = plan.captions.filter((c) => c.kind === "gold" && (c.layout === "solo" || c.layout === "stack_gold" || c.layout === "liste_eintrag")).length;
  if (goldCount < P.gold.anzahl.min || goldCount > P.gold.anzahl.max) warn("gold_anzahl", `${goldCount} Gold-Einblendungen (üblich ${P.gold.anzahl.min}–${P.gold.anzahl.max}; style.json: 10–16)`);

  // CTA
  const ctaCaps = plan.captions.filter((c) => c.kind === "cta");
  if (ctaCaps.length > 1) err("cta_anzahl", "Höchstens ein CTA-Keyword");
  const kommentier = words.find((w) => P.captions.cta.erkennung_woerter.some((k) => norm(w.word).startsWith(k)));
  if (kommentier && words[kommentier.i + 1] && norm(words[kommentier.i + 1]!.word) === "mit" && ctaCaps.length === 0) warn("cta_fehlt", `Thorsten sagt "${kommentier.word} mit …", aber es gibt kein CTA-Keyword`, wordOut(kommentier.i)?.start);
  for (const c of ctaCaps) {
    if (!/^".+"$/.test(c.text) || c.text !== c.text.toUpperCase()) err("cta_format", `CTA-Keyword muss in Versalien mit Anführungszeichen stehen: ${c.text}`, c.start_s);
    if (Math.abs(c.end_s - total) > frame + 0.001) err("cta_ende", "CTA-Keyword muss bis zum letzten Frame stehen", c.start_s);
  }

  // ---------- SFX ----------
  const banned = P.sfx.verboten_muster.map((m) => m.toLowerCase());
  for (const s of plan.sfx) {
    const entry = findSfx(inp.sfxIndex, s.file);
    if (!entry) err("sfx_nicht_in_library", `SFX "${s.file}" ist nicht in der SFX-Library. Nur Dateien aus dem Index sind erlaubt (nie generieren).`, s.at_s);
    if (banned.some((m) => s.file.toLowerCase().includes(m))) err("sfx_verboten", `SFX "${s.file}" ist verboten (zu laut/erschreckend)`, s.at_s);
    if (s.gain_db > -9) err("sfx_zu_laut", `SFX "${s.file}" mit ${s.gain_db} dB ist zu laut (Effekte klar unter der Stimme, max −9 dB)`, s.at_s);
    if (s.at_s < -P.sfx.cues.riser.peak_im_file_s - 1 || s.at_s > total + 0.5) err("sfx_bereich", `SFX "${s.file}" bei ${de2(s.at_s)} s liegt außerhalb des Videos`, s.at_s);
  }
  const countOf = (gain: number, role: string) => plan.sfx.filter((s) => s.role === role && Math.abs(s.gain_db - gain) < 0.5).length;
  const fs = P.sfx.cues.fuwa_stark;
  const fl = P.sfx.cues.fuwa_leise;
  const strong = countOf(fs.gain_db, "fuwa");
  const soft = countOf(fl.gain_db, "fuwa");
  if (plan.sfx.filter((s) => s.role === "fuwa").length !== strong + soft) warn("fuwa_gain", `Fuwa-Effekte mit unüblicher Lautstärke (üblich ${fs.gain_db} bzw. ${fl.gain_db} dB)`);
  if (strong < fs.anzahl.min || strong > fs.anzahl.max) warn("fuwa_stark_anzahl", `${strong}× Fuwa ${fs.gain_db} dB (üblich ${fs.anzahl.min}–${fs.anzahl.max})`);
  if (soft < fl.anzahl.min || soft > fl.anzahl.max) warn("fuwa_leise_anzahl", `${soft}× Fuwa ${fl.gain_db} dB (üblich ${fl.anzahl.min}–${fl.anzahl.max})`);
  const money = plan.sfx.filter((s) => s.role === "money").length;
  if (money !== 1) warn("money_anzahl", `Money_Caching kommt ${money}× vor (Standard: genau einmal)`);
  const ding = plan.sfx.filter((s) => s.role === "ding");
  if (ctaCaps.length && ding.length !== 1) err("ding_fehlt", "CTA-Keyword vorhanden: genau ein Ding erforderlich");
  if (!ctaCaps.length && ding.length) err("ding_ohne_cta", "Ding ohne CTA-Keyword: entfällt, wenn Thorsten keinen CTA spricht");

  // ---------- Zooms ----------
  if (plan.precut && plan.zooms.length) err("zoom_vorgeschnitten", "Vorgeschnittenes Material: keine eigenen Zooms");
  const zoomSeg = new Map<number, number>();
  for (const z of plan.zooms) {
    const seg = tl.find((s) => s.id === z.segment_id);
    zoomSeg.set(z.segment_id, (zoomSeg.get(z.segment_id) ?? 0) + 1);
    if (!P.zoom.erlaubte_werte.some((v) => Math.abs(v - z.to_scale) < 1e-6)) err("zoom_wert", `Zoom ${z.to_scale} nicht erlaubt (${P.zoom.erlaubte_werte.join(", ")})`, z.start_s);
    if (!seg) continue;
    if (seg.id === tl[0]!.id) err("zoom_im_hook", "Zoom im Hook-Segment: dort gilt nur der Hook-Push", z.start_s);
    if (z.start_s < seg.out_from_s - 0.001 || z.start_s > seg.out_to_s) err("zoom_ausserhalb", `Zoom startet bei ${de2(z.start_s)} s außerhalb seines Segments ${seg.id}`, z.start_s);
    else if (seg.out_to_s - z.start_s < P.zoom.rampe_frames * frame - 0.002) err("zoom_rampe", `Zoom bei ${t(z.start_s)}: bis Segmentende nur ${de2(seg.out_to_s - z.start_s)} s, die Rampe braucht ${P.zoom.rampe_frames} Frames (${de2(P.zoom.rampe_frames * frame)} s). Sonst springt der Zoom.`, z.start_s);
  }
  for (const [id, n] of zoomSeg) if (n > 1) err("zoom_pro_segment", `Segment ${id} hat ${n} Zooms (höchstens 1)`);
  if (!plan.precut && (plan.zooms.length < P.zoom.anzahl.min || plan.zooms.length > P.zoom.anzahl.max)) warn("zoom_anzahl", `${plan.zooms.length} Zooms (üblich ${P.zoom.anzahl.min}–${P.zoom.anzahl.max}, Zooms sollen selten sein)`);

  // ---------- B-Roll ----------
  const flashT = tl[1]?.out_from_s ?? 0;
  const br = [...plan.broll].sort((a, b) => a.start_s - b.start_s);
  br.forEach((b, i) => {
    if ((b.end_s - b.start_s) * fps < P.captions.min_frames - 0.5) err("broll_kurz", `B-Roll #${b.id} steht nur ${((b.end_s - b.start_s) * fps).toFixed(1)} Frames (Minimum ${P.captions.min_frames})`, b.start_s);
    if (b.start_s < flashT - 0.001) err("broll_im_hook", `B-Roll #${b.id} beginnt im Hook`, b.start_s);
    if (b.end_s > total + 0.001) err("broll_ende", `B-Roll #${b.id} endet nach dem Videoende`, b.start_s);
    if (i > 0 && b.start_s < br[i - 1]!.end_s - 0.001) err("broll_ueberlappung", `B-Roll #${br[i - 1]!.id} und #${b.id} überlappen`, b.start_s);
    if (![P.broll.shade_alpha, P.broll.shade_alpha_hell].some((a) => Math.abs(a - b.shade_alpha) < 1e-6)) warn("broll_shade", `B-Roll #${b.id}: Abdunklung ${b.shade_alpha} unüblich (${P.broll.shade_alpha} oder ${P.broll.shade_alpha_hell})`, b.start_s);
    if (!b.long_ok && b.end_s - b.start_s > P.broll.max_s + 0.05) warn("broll_lang", `B-Roll #${b.id} steht ${(b.end_s - b.start_s).toFixed(1)} s (üblich höchstens ${P.broll.max_s} s)`, b.start_s);
    if (b.source.kind === "offen") warn("broll_quelle_offen", `B-Roll #${b.id} "${b.motif}" hat noch keine Quelle (Upload-Funktion folgt)${b.covers_ai_error ? ": deckt einen KI-Fehler ab, Pflichtabdeckung!" : ""}`, b.start_s);
  });
  if (plan.broll.length < P.broll.anzahl.min || plan.broll.length > P.broll.anzahl.max) warn("broll_anzahl", `${plan.broll.length} B-Rolls (üblich ${P.broll.anzahl.min}–${P.broll.anzahl.max})`);

  // ---------- Länge und Anteil entfernt ----------
  const speechTotal = words.reduce((a, w) => a + (w.end_s - w.start_s), 0);
  const speechRemoved = [...removedWordIdx].reduce((a, i) => a + (words[i] ? words[i]!.end_s - words[i]!.start_s : 0), 0);
  const share = speechTotal ? speechRemoved / speechTotal : 0;
  const ratio = plan.source.duration_s ? total / plan.source.duration_s : 1;
  const minRatio = plan.precut ? V.min_laenge_verhaeltnis_vorgeschnitten : V.min_laenge_verhaeltnis;
  if (ratio < minRatio) err("laenge_unplausibel", `Das Video ist nur ${(ratio * 100).toFixed(0)} % so lang wie die Quelle (${de2(total)} von ${de2(plan.source.duration_s)} s, Minimum ${(minRatio * 100).toFixed(0)} %): auffällig viel Material fehlt`);
  if (share > V.max_entfernt_sprechanteil) err("zu_viel_gesprochenes_entfernt", `${(share * 100).toFixed(0)} % des gesprochenen Textes sind entfernt (Grenze ${(V.max_entfernt_sprechanteil * 100).toFixed(0)} %): Verdacht auf zu aggressives Streichen`);
  const lastWord = words[words.length - 1];
  if (lastWord && !plan.precut && Math.abs(lastSeg.raw_out_s - (lastWord.end_s + P.captions.ende_nach_letztem_wort_s)) > 0.15 && !removedWordIdx.has(lastWord.i)) {
    warn("ende", `Videoende liegt ${de2(lastSeg.raw_out_s - lastWord.end_s)} s nach dem letzten Wort (Standard ${de2(P.captions.ende_nach_letztem_wort_s)} s)`);
  }

  return result(issues, notChecked, { total, share, ratio, segments: tl.length }, inp);
}

function result(issues: Issue[], notChecked: string[], s: { total: number; share: number; ratio: number; segments: number } | null, inp: ValidateInput): ValidationResult {
  const errors = issues.filter((i) => i.severity === "fehler");
  const warnings = issues.filter((i) => i.severity === "warnung");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    notChecked,
    stats: {
      out_duration_s: s?.total ?? 0,
      source_duration_s: inp.analysis.duration_s,
      length_ratio: s?.ratio ?? 0,
      removed_speech_share: s?.share ?? 0,
      segments: s?.segments ?? 0,
    },
  };
}

/** Fehlertext für die Rückmeldung an Claude. */
export function formatIssuesForLlm(r: { errors: Issue[]; warnings: Issue[] }): string {
  const line = (i: Issue) => `- [${i.code}]${i.t_s !== undefined ? ` @${mmss(i.t_s)}` : ""} ${i.message}`;
  return r.errors.map(line).join("\n");
}
