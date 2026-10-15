import type { TranscriptWord } from "../schema/transcript.ts";
import type { Interval } from "../schema/analysis.ts";
import type { StyleParams } from "../schema/style.ts";
import type { CutSegment, Removal } from "../schema/plan.ts";
import { round3 } from "../lib/intervals.ts";
import { de1, de2 } from "../util/fmt.ts";

export interface RemovalSpec {
  kind: "versprecher" | "abbruch" | "wiederholung" | "fuellwort";
  from: number;
  to: number;
  kept?: { from: number; to: number };
  reason: string;
  confidence: "hoch" | "mittel" | "niedrig";
}

export interface CutInput {
  words: TranscriptWord[];
  silences: Interval[];
  duration_s: number;
  fps: number;
  precut: boolean;
  hookEndIdx: number;
  hookReason: { reason: string; confidence: "hoch" | "mittel" | "niedrig" };
  removals: RemovalSpec[];
  /** Szenenwechsel (nur bei vorgeschnittenem Material für den Hook-Schnittpunkt) */
  sceneTimes: number[];
  params: StyleParams;
}

export interface CutResult {
  segments: CutSegment[];
  removed: Removal[];
  /** Wörter, die im Video bleiben (Indizes) */
  keptIdx: Set<number>;
  issues: string[];
}

/**
 * Schnittliste aus Wortzeiten, Stillen und den Entfernungen von Claude.
 * Regeln (style.json schnitt_rhythmus): jede Stille >= 0,15 s nach dem Hook wird
 * geschnitten, 0,02 s Luft an beiden Rändern; Hook ungeschnitten; führende Stille
 * weg; Ende = letztes Wort + 0,05 s; Segmentlängen auf volle Frames.
 */
export function buildCuts(inp: CutInput): CutResult {
  const { words, silences, duration_s: dur, fps, precut, hookEndIdx, params } = inp;
  const S = params.schnitt;
  const air = S.luft_rand_s;
  const issues: string[] = [];
  const frame = 1 / fps;

  const removedIdx = new Set<number>();
  for (const r of inp.removals) for (let i = r.from; i <= r.to; i++) removedIdx.add(i);
  const kept = words.filter((w) => !removedIdx.has(w.i));
  const keptIdx = new Set(kept.map((w) => w.i));
  if (kept.length === 0) return { segments: [], removed: [], keptIdx, issues: ["Alle Wörter entfernt"] };

  const hookPos = kept.findIndex((w) => w.i === hookEndIdx);
  if (hookPos < 0) return { segments: [], removed: [], keptIdx, issues: [`Hook-Ende (Wort ${hookEndIdx}) ist entfernt oder existiert nicht`] };
  if (hookPos >= kept.length - 1) return { segments: [], removed: [], keptIdx, issues: ["Nach dem Hook folgt kein Wort mehr"] };

  const next = (w: TranscriptWord) => words[w.i + 1];
  const prev = (w: TranscriptWord) => words[w.i - 1];

  interface Cut {
    a: TranscriptWord;
    b: TranscriptWord;
    kind: "pause" | "removal" | "hook";
    outS: number;
    inS: number;
  }
  const cuts: Cut[] = [];

  for (let k = 0; k < kept.length - 1; k++) {
    const a = kept[k]!;
    const b = kept[k + 1]!;
    const hasRemoval = b.i - a.i > 1;
    const isHookCut = k === hookPos;
    const inHook = k < hookPos;
    let kind: Cut["kind"] | null = null;
    let lo = a.end_s;
    let hi = b.start_s;

    if (isHookCut) kind = "hook";
    else if (hasRemoval) kind = "removal";
    else if (!precut && !inHook) {
      // Pausenschnitt nur, wenn eine erkannte Stille >= min_pause_s in der Lücke liegt
      let best = 0;
      for (const s of silences) {
        const s0 = Math.max(s.start_s, a.end_s);
        const s1 = Math.min(s.end_s, b.start_s);
        if (s1 - s0 > best) {
          best = s1 - s0;
          lo = s0;
          hi = s1;
        }
      }
      if (best >= S.min_pause_s - 1e-9) kind = "pause";
    }
    if (kind === null) continue;

    if (precut) {
      // Vorgeschnittenes Material: nichts entfernen. Schnittpunkt am Szenenwechsel in der Lücke, sonst Lückenmitte.
      const inGap = inp.sceneTimes.find((t) => t >= a.end_s && t <= b.start_s);
      const t = inGap ?? (a.end_s + b.start_s) / 2;
      cuts.push({ a, b, kind, outS: t, inS: t });
      continue;
    }

    // Normalfall: Luft an beiden Rändern, aber nie in ein Nachbarwort hinein
    const wAfterA = next(a)!;
    const wBeforeB = prev(b)!;
    const airOut = Math.min(air, Math.max(0, (wAfterA.start_s - a.end_s) / 2));
    const airIn = Math.min(air, Math.max(0, (b.start_s - wBeforeB.end_s) / 2));
    let outS = Math.max(a.end_s, lo) + airOut;
    let inS = Math.min(b.start_s, hi) - airIn;
    if (inS < outS) {
      const mid = (outS + inS) / 2;
      outS = inS = mid;
    }
    if (kind === "hook" && b.start_s - a.end_s < params.hook.min_luecke_s) {
      issues.push(
        `Hook-Ende nach Wort ${a.i} ("${a.word}"): zwischen "${a.word}" und "${b.word}" liegt nur ${de2(b.start_s - a.end_s)} s Lücke, kein sauberer Schnittpunkt. Hook bis zum nächsten Satzende verlängern, wo eine Lücke vorhanden ist.`,
      );
    }
    cuts.push({ a, b, kind, outS, inS });
  }

  // Segmentgrenzen
  const first = kept[0]!;
  const last = kept[kept.length - 1]!;
  const startRaw = precut ? 0 : Math.max(0, first.start_s - air);
  const endRaw = precut ? dur : Math.min(dur, last.end_s + params.captions.ende_nach_letztem_wort_s);

  interface Seg {
    in: number;
    out: number;
    firstKept: TranscriptWord;
    lastKept: TranscriptWord;
    isHook: boolean;
  }
  let segs: Seg[] = [];
  let curIn = startRaw;
  let curFirst = first;
  for (const c of cuts) {
    segs.push({ in: curIn, out: c.outS, firstKept: curFirst, lastKept: c.a, isHook: segs.length === 0 });
    curIn = c.inS;
    curFirst = c.b;
  }
  segs.push({ in: curIn, out: endRaw, firstKept: curFirst, lastKept: last, isHook: segs.length === 0 });

  // Zu kurze Segmente (< min_fragment_frames): angrenzenden Pausenschnitt wieder schließen
  const minFrag = S.min_fragment_frames * frame;
  const cutKinds = cuts.map((c) => c.kind);
  const cutList = [...cuts];
  let changed = true;
  while (changed && !precut) {
    changed = false;
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i]!;
      if (s.out - s.in >= minFrag - 1e-9) continue;
      // Kandidaten: Schnitt links (i-1) oder rechts (i) – nur Pausenschnitte dürfen geschlossen werden
      const left = cutKinds[i - 1] === "pause" ? i - 1 : -1;
      const right = i < cutKinds.length && cutKinds[i] === "pause" ? i : -1;
      const gap = (ci: number) => (ci < 0 ? Infinity : cutList[ci]!.inS - cutList[ci]!.outS);
      const ci = gap(left) <= gap(right) ? left : right;
      if (ci < 0) continue;
      // Segmente ci und ci+1 verschmelzen
      const A = segs[ci]!;
      const B = segs[ci + 1]!;
      segs.splice(ci, 2, { in: A.in, out: B.out, firstKept: A.firstKept, lastKept: B.lastKept, isHook: A.isHook });
      cutKinds.splice(ci, 1);
      cutList.splice(ci, 1);
      changed = true;
      break;
    }
  }

  // Auf volle Frames bringen (Dauer), ohne in ein Nachbarwort hineinzulaufen
  const quant = (sg: Seg, i: number): Seg => {
    const rawDur = sg.out - sg.in;
    const frames = Math.round(rawDur * fps);
    let outQ = sg.in + frames / fps;
    const limit = i === segs.length - 1 ? dur : (next(sg.lastKept)?.start_s ?? dur) - 0.003;
    const floorOut = sg.in + Math.floor(rawDur * fps + 1e-6) / fps;
    if (outQ > limit) outQ = floorOut;
    if (outQ < sg.lastKept.end_s - 0.003) outQ = sg.out; // sonst Wortende abgeschnitten: lieber nicht frame-genau
    return { ...sg, out: round3(outQ), in: round3(sg.in) };
  };
  if (!precut) segs = segs.map(quant);

  const segments: CutSegment[] = segs.map((s, i) => ({
    id: i,
    raw_in_s: round3(s.in),
    raw_out_s: round3(s.out),
    reason: i === 0 ? `Hook: erster Satz bis Wort ${hookEndIdx} ungeschnitten. ${inp.hookReason.reason}` : `Gesprochener Abschnitt (Wörter ${s.firstKept.i}–${s.lastKept.i})`,
    confidence: i === 0 ? inp.hookReason.confidence : "hoch",
  }));

  // Entfernte Stücke dokumentieren
  const removed: Removal[] = [];
  if (!precut && startRaw > 0.1) {
    removed.push({ kind: "leerlauf_anfang", raw_from_s: 0, raw_to_s: round3(startRaw), word_idx: [], reason: `Führende Stille ${de2(startRaw)} s vor dem ersten Wort`, confidence: "hoch" });
  }
  if (!precut && dur - endRaw > 0.1) {
    removed.push({ kind: "leerlauf_ende", raw_from_s: round3(endRaw), raw_to_s: round3(dur), word_idx: [], reason: `Nachlauf ${de2(dur - endRaw)} s nach dem letzten Wort`, confidence: "hoch" });
  }
  for (const r of inp.removals) {
    removed.push({
      kind: r.kind,
      raw_from_s: round3(words[r.from]!.start_s),
      raw_to_s: round3(words[r.to]!.end_s),
      word_idx: Array.from({ length: r.to - r.from + 1 }, (_, n) => r.from + n),
      ...(r.kept ? { kept_alternative: { raw_from_s: round3(words[r.kept.from]!.start_s), raw_to_s: round3(words[r.kept.to]!.end_s) } } : {}),
      reason: r.reason,
      confidence: r.confidence,
    });
  }
  // Rest der Schnittlücken (nicht von Wort-Entfernungen abgedeckt) als Pause eintragen
  if (!precut) {
    const wordRemovals = removed.filter((r) => r.word_idx.length > 0);
    for (let i = 0; i < segments.length - 1; i++) {
      const gFrom = segments[i]!.raw_out_s;
      const gTo = segments[i + 1]!.raw_in_s;
      let pieces: [number, number][] = [[gFrom, gTo]];
      for (const w of wordRemovals) {
        pieces = pieces.flatMap(([p0, p1]) => {
          if (w.raw_to_s <= p0 || w.raw_from_s >= p1) return [[p0, p1] as [number, number]];
          const out: [number, number][] = [];
          if (w.raw_from_s > p0) out.push([p0, w.raw_from_s]);
          if (w.raw_to_s < p1) out.push([w.raw_to_s, p1]);
          return out;
        });
      }
      for (const [p0, p1] of pieces) {
        if (p1 - p0 < 0.02) continue;
        removed.push({ kind: "pause", raw_from_s: round3(p0), raw_to_s: round3(p1), word_idx: [], reason: `Stille ${de2(p1 - p0 + 2 * air)} s ≥ ${de2(S.min_pause_s)} s, mit ${de2(air)} s Luft geschnitten`, confidence: "hoch" });
      }
    }
  }
  removed.sort((a, b) => a.raw_from_s - b.raw_from_s);

  void de1;
  return { segments, removed, keptIdx, issues };
}
