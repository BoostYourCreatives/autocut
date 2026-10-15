import type { TranscriptWord } from "../schema/transcript.ts";
import type { StyleParams } from "../schema/style.ts";
import type { Caption } from "../schema/plan.ts";
import type { PlanDraft } from "./draft.ts";
import { quantize, type TimedSegment } from "./timeline.ts";
import { round3 } from "../lib/intervals.ts";

export interface CaptionInput {
  words: TranscriptWord[];
  keptIdx: Set<number>;
  timeline: TimedSegment[];
  fps: number;
  corrections: Map<number, string>;
  draft: Pick<PlanDraft, "quotes" | "gold" | "lists" | "cta">;
  params: StyleParams;
}

interface W {
  i: number;
  text: string;
  start: number; // Ausgabe-Timeline
  end: number;
  seg: TimedSegment;
  quote: boolean;
}

type Special =
  | { type: "pop" | "wipe"; members: { role: "gold"; from: number; to: number }[]; reason: string; confidence: Caption["confidence"] }
  | { type: "stack"; members: { role: "oben" | "gold" | "unten"; from: number; to: number }[]; reason: string; confidence: Caption["confidence"] }
  | { type: "liste"; members: { role: "kopf" | "eintrag"; from: number; to: number }[]; reason: string; confidence: Caption["confidence"] };

const endsSentence = (t: string) => /[.?!]["“”]?$/.test(t);

export function buildCaptions(inp: CaptionInput): { captions: Caption[]; issues: string[] } {
  const { fps, params } = inp;
  const C = params.captions;
  const frame = 1 / fps;
  const issues: string[] = [];
  const funcWords = new Set(C.merge.funktionswoerter.map((s) => s.toLowerCase()));
  const totalOut = inp.timeline.length ? inp.timeline[inp.timeline.length - 1]!.out_to_s : 0;

  // ---- Wörter in Ausgabezeit ----
  const quoteSet = new Set<number>();
  for (const q of inp.draft.quotes) for (let i = q.from_word_idx; i <= q.to_word_idx; i++) quoteSet.add(i);
  const W_: W[] = [];
  for (const w of inp.words) {
    if (!inp.keptIdx.has(w.i)) continue;
    const mid = (w.start_s + w.end_s) / 2;
    const seg = inp.timeline.find((s) => mid >= s.raw_in_s - 1e-6 && mid <= s.raw_out_s + 1e-6);
    if (!seg) {
      issues.push(`Wort ${w.i} ("${w.word}") liegt außerhalb aller Segmente`);
      continue;
    }
    const s = seg.out_from_s + Math.max(0, w.start_s - seg.raw_in_s);
    const e = seg.out_from_s + Math.min(seg.raw_out_s, w.end_s) - seg.raw_in_s;
    W_.push({ i: w.i, text: inp.corrections.get(w.i) ?? w.word, start: s, end: Math.max(e, s + 0.001), seg, quote: quoteSet.has(w.i) });
  }
  const byIdx = new Map(W_.map((w) => [w.i, w]));
  const order = W_.map((w) => w.i);
  const posOf = new Map(order.map((i, p) => [i, p]));

  // ---- Spezial-Einblendungen (Gold, Stack, Liste, CTA) aus dem Entwurf ----
  const specials: Special[] = [];
  for (const g of inp.draft.gold) {
    if (g.style === "stack") {
      const m: Extract<Special, { type: "stack" }>["members"] = [];
      if (g.above_from_word_idx !== null && g.above_to_word_idx !== null) m.push({ role: "oben", from: g.above_from_word_idx, to: g.above_to_word_idx });
      m.push({ role: "gold", from: g.gold_from_word_idx, to: g.gold_to_word_idx });
      if (g.below_from_word_idx !== null && g.below_to_word_idx !== null) m.push({ role: "unten", from: g.below_from_word_idx, to: g.below_to_word_idx });
      specials.push({ type: "stack", members: m, reason: g.reason, confidence: g.confidence });
    } else {
      specials.push({ type: g.style, members: [{ role: "gold", from: g.gold_from_word_idx, to: g.gold_to_word_idx }], reason: g.reason, confidence: g.confidence });
    }
  }
  for (const l of inp.draft.lists) {
    specials.push({
      type: "liste",
      members: [{ role: "kopf", from: l.head_from_word_idx, to: l.head_to_word_idx }, ...l.items.map((it) => ({ role: "eintrag" as const, from: it.from_word_idx, to: it.to_word_idx }))],
      reason: l.reason,
      confidence: l.confidence,
    });
  }

  const owner = new Map<number, number>(); // Wortindex -> Special-Nr
  const ctaIdx = inp.draft.cta?.keyword_word_idx ?? null;
  specials.forEach((sp, n) => {
    for (const m of sp.members) {
      if (m.to < m.from) issues.push(`Gold/Stack/Liste: to_word_idx ${m.to} liegt vor from_word_idx ${m.from}`);
      for (let i = m.from; i <= m.to; i++) {
        if (!byIdx.has(i)) {
          issues.push(`Gold/Stack/Liste verweist auf Wort ${i}, das nicht im Video bleibt (entfernt oder nicht vorhanden)`);
          continue;
        }
        if (owner.has(i) || i === ctaIdx) issues.push(`Wort ${i} ("${byIdx.get(i)!.text}") ist in mehreren Hervorhebungen/CTA enthalten`);
        owner.set(i, n);
      }
    }
    const all = sp.members.flatMap((m) => Array.from({ length: Math.max(0, m.to - m.from + 1) }, (_, k) => m.from + k)).filter((i) => byIdx.has(i));
    const segs = new Set(all.map((i) => byIdx.get(i)!.seg.id));
    if (segs.size > 1) {
      issues.push(`Hervorhebung "${all.map((i) => byIdx.get(i)!.text).join(" ")}" (Wörter ${Math.min(...all)}–${Math.max(...all)}) läuft über eine Schnittgrenze (Pause ⏸ dazwischen). Hervorhebungen und Stacks müssen innerhalb eines Abschnitts ohne ⏸ liegen.`);
    }
  });
  if (ctaIdx !== null && !byIdx.has(ctaIdx)) issues.push(`CTA-Keyword verweist auf Wort ${ctaIdx}, das nicht im Video bleibt`);

  // ---- Startzeit je Einblendung ----
  const wipeFirst = new Set<number>();
  specials.forEach((sp) => {
    if (sp.type === "wipe") wipeFirst.add(sp.members[0]!.from);
  });
  const lead = (idx: number) => (wipeFirst.has(idx) ? C.timing.wipe_vorlauf_frames : C.timing.start_vorlauf_frames) * frame;
  const unitStartForWord = (w: W) => Math.max(w.seg.out_from_s, w.start - lead(w.i));
  // Welches Wort ist der erste einer Spezial-Gruppe (Gruppenstart = frühestes Mitglied)?
  const groupFirst = new Map<number, number>();
  specials.forEach((sp, n) => {
    const idxs = sp.members.flatMap((m) => Array.from({ length: Math.max(0, m.to - m.from + 1) }, (_, k) => m.from + k)).filter((i) => byIdx.has(i));
    if (idxs.length) groupFirst.set(n, Math.min(...idxs));
  });

  const nextStartAfter = (idx: number, seg: TimedSegment): number => {
    const p = posOf.get(idx)!;
    for (let q = p + 1; q < order.length; q++) {
      const nw = byIdx.get(order[q]!)!;
      if (nw.seg.id !== seg.id) break;
      if (ctaIdx === nw.i) continue; // CTA-Keyword läuft auf eigener Ebene
      const sp = owner.get(nw.i);
      if (sp !== undefined && groupFirst.get(sp) !== nw.i && specials[sp]!.type !== "pop" && specials[sp]!.type !== "wipe") {
        continue; // Mitglieder einer Gruppe starten nicht neu
      }
      return unitStartForWord(nw);
    }
    return seg.out_to_s;
  };
  const endRule = (nextStart: number, lastWordEnd: number, seg: TimedSegment) => {
    const e = nextStart - lastWordEnd > C.timing.nachlauf_luecke_s ? lastWordEnd + C.timing.nachlauf_s : nextStart;
    return Math.min(e, seg.out_to_s);
  };

  // ---- Weiße Untertitel: Tokens, dann Merge-Regeln ----
  interface Tok { w: W; start: number; ownDur: number }
  const runs: Tok[][] = [];
  let curRun: Tok[] = [];
  const flushRun = () => {
    if (curRun.length) runs.push(curRun);
    curRun = [];
  };
  for (const idx of order) {
    const w = byIdx.get(idx)!;
    if (owner.has(idx) || idx === ctaIdx) {
      flushRun();
      continue;
    }
    const prevTok = curRun[curRun.length - 1];
    if (prevTok && (prevTok.w.seg.id !== w.seg.id || prevTok.w.quote !== w.quote)) flushRun();
    const start = unitStartForWord(w);
    const end = endRule(nextStartAfter(idx, w.seg), w.end, w.seg);
    curRun.push({ w, start, ownDur: end - start });
  }
  flushRun();

  interface Unit { toks: Tok[]; text: string }
  const mkText = (toks: Tok[]) => toks.map((t) => t.w.text).join(" ");
  const units: Unit[] = [];
  for (const run of runs) {
    const runUnits: Unit[] = [];
    for (const t of run) {
      const cur = runUnits[runUnits.length - 1];
      if (cur) {
        const last = cur.toks[cur.toks.length - 1]!;
        const lastShort =
          last.ownDur < C.merge.min_anzeige_s - 1e-9 ||
          (funcWords.has(last.w.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")) && last.ownDur < C.merge.funktionswort_max_anzeige_s - 1e-9);
        if (lastShort && !endsSentence(cur.text) && (cur.text + " " + t.w.text).length <= C.merge.max_zeichen) {
          cur.toks.push(t);
          cur.text = mkText(cur.toks);
          continue;
        }
      }
      runUnits.push({ toks: [t], text: t.w.text });
    }
    // Nachlauf-Merge: kurzes Einzelwort an die vorige Einblendung hängen
    for (let k = 1; k < runUnits.length; k++) {
      const u = runUnits[k]!;
      const p = runUnits[k - 1]!;
      if (u.toks.length === 1 && u.toks[0]!.ownDur < C.merge.min_anzeige_s - 1e-9 && !endsSentence(p.text) && (p.text + " " + u.text).length <= C.merge.max_zeichen) {
        p.toks.push(...u.toks);
        p.text = mkText(p.toks);
        runUnits.splice(k, 1);
        k--;
      }
    }
    units.push(...runUnits);
  }

  const fontOf = (kind: Caption["kind"]) => params.schriften[kind === "weiss" ? "weiss" : kind === "gold" ? "gold" : kind === "zitat" ? "zitat" : "cta"] as Caption["font"];
  const colorOf = (kind: Caption["kind"]) => (kind === "gold" || kind === "cta" ? params.farben.gold : params.farben.weiss);

  const caps: Omit<Caption, "id">[] = [];
  for (const u of units) {
    const first = u.toks[0]!;
    const last = u.toks[u.toks.length - 1]!;
    const seg = first.w.seg;
    const start = first.start;
    const end = endRule(nextStartAfter(last.w.i, seg), last.w.end, seg);
    const quote = first.w.quote;
    let text = u.text;
    if (quote) {
      // Zitat: „ am ersten, “ am letzten Wort der Zitatstelle
      if (inp.draft.quotes.some((qq) => qq.from_word_idx === first.w.i)) text = `„${text}`;
      if (inp.draft.quotes.some((qq) => qq.to_word_idx === last.w.i)) text = `${text}“`;
    }
    const kind: Caption["kind"] = quote ? "zitat" : "weiss";
    caps.push({
      text,
      kind,
      animation: "mini",
      layout: "solo",
      group: null,
      word_idx: u.toks.map((t) => t.w.i),
      start_s: start,
      end_s: end,
      font: fontOf(kind),
      color: colorOf(kind),
      reason: quote ? "Fremde Aussage als Zitat (Segoe Pro Bold Italic, weiß, mit „…“)" : "Untertitel nach Merge-Regeln aus style.json",
      confidence: quote ? (inp.draft.quotes.find((q) => q.from_word_idx <= first.w.i && q.to_word_idx >= first.w.i)?.confidence ?? "mittel") : "hoch",
    });
  }

  // ---- Gold, Stack, Liste ----
  specials.forEach((sp, n) => {
    const members = sp.members.filter((m) => byIdx.has(m.from) && byIdx.has(m.to) && m.to >= m.from);
    if (!members.length) return;
    const allIdx = members.flatMap((m) => Array.from({ length: m.to - m.from + 1 }, (_, k) => m.from + k)).filter((i) => byIdx.has(i));
    const lastW = byIdx.get(Math.max(...allIdx))!;
    const seg = lastW.seg;
    const groupEnd = endRule(nextStartAfter(lastW.i, seg), lastW.end, seg);
    const group = sp.type === "stack" || sp.type === "liste" ? `g${n}` : null;
    for (const m of members) {
      const ws = Array.from({ length: m.to - m.from + 1 }, (_, k) => byIdx.get(m.from + k)).filter((w): w is W => !!w);
      const firstW = ws[0]!;
      const text = ws.map((w) => w.text).join(" ");
      const role = (m as { role: string }).role;
      let kind: Caption["kind"] = "gold";
      let animation: Caption["animation"] = "pop";
      let layout: Caption["layout"] = "solo";
      if (sp.type === "wipe") animation = "wipe";
      if (sp.type === "stack") {
        layout = role === "oben" ? "stack_oben" : role === "gold" ? "stack_gold" : "stack_unten";
        if (role !== "gold") {
          kind = "weiss";
          animation = ws.length === 1 ? (role === "unten" ? "rise" : "mini") : "words";
        }
      }
      if (sp.type === "liste") {
        layout = role === "kopf" ? "liste_kopf" : "liste_eintrag";
        if (role === "kopf") {
          kind = "weiss";
          animation = "words";
        } else animation = "slide";
      }
      const start = unitStartForWord(firstW);
      const cap: Omit<Caption, "id"> = {
        text,
        kind,
        animation,
        layout,
        group,
        word_idx: ws.map((w) => w.i),
        start_s: start,
        end_s: group ? groupEnd : endRule(nextStartAfter(lastW.i, seg), lastW.end, seg),
        font: fontOf(kind),
        color: colorOf(kind),
        reason: sp.reason,
        confidence: sp.confidence,
      };
      if (animation === "words") cap.word_offsets_frames = ws.map((w) => [w.text, Math.max(0, Math.round((w.start - start) * fps))] as [string, number]);
      caps.push(cap);
    }
  });

  // ---- CTA-Keyword ----
  if (ctaIdx !== null && byIdx.has(ctaIdx)) {
    const w = byIdx.get(ctaIdx)!;
    const kw = w.text.replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();
    caps.push({
      text: `"${kw}"`,
      kind: "cta",
      animation: "pop",
      layout: "solo",
      group: null,
      word_idx: [ctaIdx],
      start_s: unitStartForWord(w),
      end_s: totalOut,
      font: fontOf("cta"),
      color: colorOf("cta"),
      reason: inp.draft.cta!.reason,
      confidence: inp.draft.cta!.confidence,
    });
  }

  // ---- Frames, Mindestdauer, Reihenfolge ----
  const minDur = C.min_frames * frame;
  const q = (t: number) => quantize(t, fps);
  caps.sort((a, b) => a.start_s - b.start_s || a.word_idx[0]! - b.word_idx[0]!);
  const solo = caps.filter((c) => c.layout === "solo" && c.kind !== "cta");
  for (let k = 0; k < solo.length; k++) {
    const c = solo[k]!;
    const nxt = solo[k + 1];
    let end = c.end_s;
    if (end - c.start_s < minDur - 1e-9) end = Math.min(nxt ? nxt.start_s : totalOut, c.start_s + minDur);
    c.end_s = end;
  }
  for (const c of caps) {
    c.start_s = q(c.start_s);
    c.end_s = q(Math.min(c.end_s, totalOut));
    if (c.end_s <= c.start_s) c.end_s = round3(c.start_s + frame);
  }
  // keine Überlappung von Einzelzeilen in derselben Ebene
  for (let k = 0; k < solo.length - 1; k++) {
    if (solo[k]!.end_s > solo[k + 1]!.start_s) solo[k]!.end_s = solo[k + 1]!.start_s;
  }
  const out: Caption[] = caps.map((c, id) => ({ ...c, id }));
  return { captions: out, issues };
}
