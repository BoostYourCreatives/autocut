import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureFromExample, EX53, EX48 } from "../helpers/reel.ts";
import { finalize } from "../../src/plan/finalize.ts";
import { validate, formatIssuesForLlm } from "../../src/validate/validate.ts";
import { draftReel53 } from "../fixtures/draft-reel53.ts";
import { draftReel48 } from "../fixtures/draft-reel48.ts";
import { PlanDraft, toApiSchema } from "../../src/plan/draft.ts";
import type { Plan } from "../../src/schema/plan.ts";

const f53 = () => fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
const f48 = () => fixtureFromExample(EX48, { silencesFromCuts: false, precut: true });
const run53 = (draft = draftReel53, force?: Parameters<typeof finalize>[0]["force"]) => {
  const f = f53();
  const r = finalize({ draft, transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53", force });
  return { f, r };
};
const check = (f: ReturnType<typeof f53>, plan: unknown) => validate({ plan, transcript: f.transcript, analysis: f.analysis, params: f.params, sfxIndex: f.sfxIndex });

test("Reel 53: finalize reproduziert die manuellen Schnitte des Users (Toleranz 50 ms, außer Whisper-Ausreißer)", () => {
  const { f, r } = run53();
  assert.deepEqual(r.issues, []);
  const mine = r.plan!.cut_segments;
  const user = f.ex.cut_segments;
  assert.equal(mine.length, user.length);
  mine.forEach((s, i) => {
    const tolIn = i === 6 ? 0.6 : i === 0 ? 0.1 : 0.05; // Segment 6: User schneidet in "Ich" hinein (Whisper-Wortzeit 0,6 s lang)
    assert.ok(Math.abs(s.raw_in_s - user[i].raw_in_s) <= tolIn, `Segment ${i} in ${s.raw_in_s} vs ${user[i].raw_in_s}`);
    assert.ok(Math.abs(s.raw_out_s - user[i].raw_out_s) <= 0.05, `Segment ${i} out ${s.raw_out_s} vs ${user[i].raw_out_s}`);
  });
});

test("Reel 53: Plan besteht den Validator ohne Fehler", () => {
  const { f, r } = run53();
  const v = check(f, r.plan);
  assert.deepEqual(v.errors, []);
  assert.ok(v.stats.length_ratio > 0.85 && v.stats.length_ratio < 1);
  assert.equal(r.plan!.hook!.transition, "blitz_riser");
  assert.ok(r.plan!.sfx.some((s) => s.role === "riser") && r.plan!.sfx.some((s) => s.role === "shutter"));
});

test("Reel 53: Untertitel-Gruppen wie im Beispiel des Users", () => {
  const { r } = run53();
  const texts = r.plan!.captions.filter((c) => c.kind === "weiss" && c.layout === "solo").map((c) => c.text);
  for (const t of ["Die wirtschaftliche", "Zukunft", "spielt", "sich nicht mehr", "ausschließlich in", "ab.", "Besonders"]) {
    assert.ok(texts.includes(t), `Untertitel "${t}" fehlt: ${texts.slice(0, 12).join(" | ")}`);
  }
});

test("SFX-Zeiten folgen den Regeln (Beispiel 53: Riser startet vor dem Video, Peak auf Blitz)", () => {
  const { r } = run53();
  const flash = r.plan!.cut_segments[0]!.raw_out_s - r.plan!.cut_segments[0]!.raw_in_s;
  const riser = r.plan!.sfx.find((s) => s.role === "riser")!;
  assert.ok(Math.abs(riser.peak_at_s! - flash) < 0.01);
  assert.ok(Math.abs(riser.at_s - (flash - 3.81)) < 0.01);
  assert.ok(Math.abs(riser.trim_end_at_s! - (flash + 0.25)) < 0.01);
  assert.ok(Math.abs(r.plan!.sfx.find((s) => s.role === "shutter")!.at_s - (flash - 0.09)) < 0.01);
  assert.equal(r.plan!.sfx.filter((s) => s.role === "money").length, 1);
});

test("Übergang 'hart' per CLI: kein Riser, kein Shutter, Plan bleibt gültig", () => {
  const { f, r } = run53(draftReel53, { transition: "hart" });
  assert.equal(r.plan!.hook!.transition, "hart");
  assert.ok(!r.plan!.sfx.some((s) => s.role === "riser" || s.role === "shutter"));
  assert.deepEqual(check(f, r.plan).errors, []);
});

test("Reel 48 (vorgeschnitten): ein Schnitt am Szenenwechsel, keine Zooms, kein Push", () => {
  const f = f48();
  const r = finalize({ draft: draftReel48, transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_48" });
  assert.deepEqual(r.issues, []);
  const p = r.plan!;
  assert.equal(p.cut_segments.length, 2);
  assert.ok(Math.abs(p.cut_segments[0]!.raw_out_s - 5.3) < 0.001);
  assert.equal(p.cut_segments[0]!.raw_out_s, p.cut_segments[1]!.raw_in_s);
  assert.equal(p.zooms.length, 0);
  assert.ok(p.notes.some((n) => n.includes("Zoom")));
  assert.equal(p.hook!.push, false);
  assert.deepEqual(p.removed, []);
  const v = check(f, p);
  assert.deepEqual(v.errors, []);
});

test("Entwurf mit Entfernung im vorgeschnittenen Material wird abgelehnt", () => {
  const f = f48();
  const bad = { ...draftReel48, removals: [{ kind: "fuellwort" as const, from_word_idx: 50, to_word_idx: 50, kept_from_word_idx: null, kept_to_word_idx: null, reason: "ähm", confidence: "hoch" as const }] };
  const r = finalize({ draft: bad, transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "x" });
  assert.match(r.issues.join("\n"), /vorgeschnitten/);
});

test("Entfernung eines Versprechers: Segment geteilt, Grund im Plan, Validator ok", () => {
  const draft = { ...draftReel53, removals: [{ kind: "versprecher" as const, from_word_idx: 100, to_word_idx: 102, kept_from_word_idx: null, kept_to_word_idx: null, reason: "Abbruch „aber du solltest wissen“, danach neu angesetzt", confidence: "mittel" as const }] };
  const { f, r } = run53(draft);
  assert.deepEqual(r.issues, []);
  const rem = r.plan!.removed.find((x) => x.kind === "versprecher")!;
  assert.deepEqual(rem.word_idx, [100, 101, 102]);
  assert.equal(rem.confidence, "mittel");
  const v = check(f, r.plan);
  assert.ok(!v.errors.some((e) => e.code === "schnitt_im_wort" || e.code === "luecke_ohne_grund"), JSON.stringify(v.errors));
});

test("Entwurfsfehler gehen als Meldung zurück: Entfernung im Hook, falscher Zoom-Wert, Zoom im Hook, Stack über Schnittgrenze", () => {
  const draft = {
    ...draftReel53,
    removals: [{ kind: "fuellwort" as const, from_word_idx: 3, to_word_idx: 3, kept_from_word_idx: null, kept_to_word_idx: null, reason: "x", confidence: "hoch" as const }],
  };
  assert.match(run53(draft).r.issues.join("\n"), /liegt im Hook/);
  const d2 = { ...draftReel53, zooms: [{ ...draftReel53.zooms[0]!, to_scale: 1.18 }, { ...draftReel53.zooms[1]!, word_idx: 5 }] };
  const m = run53(d2).r.issues.join("\n");
  assert.match(m, /nicht erlaubt/);
  assert.match(m, /liegt im Hook/);
  // Stack über eine Pause hinweg (zwischen Wort 26 "Bedeutung." und 27 "Dort" schneidet der User)
  const d3 = { ...draftReel53, gold: [{ ...draftReel53.gold[1]!, above_from_word_idx: 24, above_to_word_idx: 30 }] };
  assert.match(run53(d3).r.issues.join("\n"), /Schnittgrenze/);
});

test("Zweiter Zoom im selben Segment wird verworfen und vermerkt", () => {
  const d = { ...draftReel53, zooms: [{ ...draftReel53.zooms[1]!, word_idx: 49 }, { ...draftReel53.zooms[1]!, word_idx: 51 }] };
  const { r } = run53(d);
  assert.equal(r.plan!.zooms.length, 1);
  assert.ok(r.plan!.notes.some((n) => n.includes("höchstens ein Zoom")));
});

// ---------------- Validator: gezielte Fehler ----------------
const mutate = (fn: (p: Plan) => void) => {
  const { f, r } = run53();
  const p: Plan = structuredClone(r.plan!);
  fn(p);
  return check(f, p);
};
const codes = (v: ReturnType<typeof check>) => v.errors.map((e) => e.code);

test("Validator: Schnitt mitten im Wort", () => assert.ok(codes(mutate((p) => (p.cut_segments[2]!.raw_out_s = 12.0))).includes("schnitt_im_wort")));
test("Validator: Segmente überlappen im Rohmaterial", () => assert.ok(codes(mutate((p) => (p.cut_segments[3]!.raw_in_s = 14.0))).includes("ueberlappung_roh")));
test("Validator: Lücke ohne Begründung", () => assert.ok(codes(mutate((p) => (p.removed = p.removed.filter((r) => r.kind !== "pause")))).includes("luecke_ohne_grund")));
test("Validator: Untertitel weicht vom Transkript ab", () => assert.ok(codes(mutate((p) => (p.captions[1]!.text = "Wirtschaft"))).includes("caption_text")));
test("Validator: fehlender Untertitel", () => assert.ok(codes(mutate((p) => p.captions.splice(3, 1))).includes("caption_fehlt")));
test("Validator: falsche Schrift und verbotene Farbe", () => {
  const c = codes(mutate((p) => { p.captions[0]!.font = "SegoePro-BoldItalic"; p.captions[2]!.color = "#0000ff"; }));
  assert.ok(c.includes("schrift") && c.includes("farbe") && c.includes("farbe_verboten"), c.join());
});
test("Validator: Emoji im Untertitel", () => assert.ok(codes(mutate((p) => (p.captions[0]!.text = "Die wirtschaftliche 🚀"))).includes("emoji")));
test("Validator: SFX nicht in Library / verboten / zu laut", () => {
  const c = codes(mutate((p) => { p.sfx[2]!.file = "Boom.mp3"; p.sfx[3]!.file = "Swish_Whoosh_Large.mp3"; p.sfx[4]!.gain_db = -3; }));
  assert.ok(c.includes("sfx_nicht_in_library") && c.includes("sfx_verboten") && c.includes("sfx_zu_laut"), c.join());
});
test("Validator: Riser läuft über den Shutter hinaus", () => assert.ok(codes(mutate((p) => (p.sfx.find((s) => s.role === "riser")!.trim_end_at_s! += 1))).includes("riser_ende")));
test("Validator: Übergang hart, aber Riser vorhanden", () => assert.ok(codes(mutate((p) => (p.hook!.transition = "hart"))).includes("uebergang_sfx")));
test("Validator: zwei Zooms im Segment, Zoom im Hook, unerlaubter Wert", () => {
  const c = codes(mutate((p) => { p.zooms.push({ ...p.zooms[0]! }); p.zooms.push({ ...p.zooms[1]!, segment_id: 0, start_s: 1 }); p.zooms[2]!.to_scale = 1.18; }));
  assert.ok(c.includes("zoom_pro_segment") && c.includes("zoom_im_hook") && c.includes("zoom_wert"), c.join());
});
test("Validator: Zoom ohne Platz für die Rampe", () => assert.ok(codes(mutate((p) => { const s = p.cut_segments[2]!; p.zooms[0] = { ...p.zooms[0]!, segment_id: 2, start_s: 8.367 + (s.raw_out_s - s.raw_in_s) - 0.3 }; })).includes("zoom_rampe")));
test("Validator: B-Roll im Hook / zu kurz / Überlappung", () => {
  const c = codes(mutate((p) => { p.broll[0]!.start_s = 1; p.broll[1]!.end_s = p.broll[1]!.start_s + 0.1; }));
  assert.ok(c.includes("broll_im_hook") && c.includes("broll_kurz"), c.join());
});
test("Validator: Hook-Box fehlt, KI-Hinweis falsch, Hook nicht in Versalien", () => {
  const c = codes(mutate((p) => { p.overlays = p.overlays.filter((o) => o.type !== "hook_box"); const k = p.overlays.find((o) => o.type === "ki_hinweis")!; if (k.type === "ki_hinweis") k.text = "Made with AI"; p.hook!.lines = ["Warum Europa", "zurückfallen"]; }));
  assert.ok(c.includes("hook_box_anzahl") && c.includes("ki_text") && c.includes("hook_versalien"), c.join());
});
test("Validator: Länge unplausibel (zu viel Material fehlt)", () => {
  const c = codes(mutate((p) => { p.cut_segments = p.cut_segments.slice(0, 4); p.captions = []; p.zooms = []; p.broll = []; p.sfx = []; }));
  assert.ok(c.includes("laenge_unplausibel"), c.join());
});
test("Validator: Ding ohne CTA und CTA ohne Ding", () => {
  assert.ok(codes(mutate((p) => (p.sfx = p.sfx.filter((s) => s.role !== "ding")))).includes("ding_fehlt"));
  assert.ok(codes(mutate((p) => (p.captions = p.captions.filter((c) => c.kind !== "cta")))).includes("ding_ohne_cta"));
});
test("Validator: Schemafehler (reason fehlt) wird gemeldet", () => assert.ok(codes(mutate((p) => { delete (p.cut_segments[0] as any).reason; })).includes("schema")));
test("Validator: Tonsprung an lauter Schnittkante", () => {
  const { f, r } = run53();
  f.analysis.loudness.fine_series_db = f.analysis.loudness.fine_series_db.map(() => -10);
  const v = check(f, r.plan);
  assert.ok(codes(v).includes("tonsprung"));
});
test("formatIssuesForLlm nennt Code, Zeit und Text", () => {
  const v = mutate((p) => (p.captions[1]!.text = "Wirtschaft"));
  assert.match(formatIssuesForLlm(v), /\[caption_text\] @0:0/);
});

test("Entwurfsschema → API-Schema: nur erlaubte Schlüsselwörter, additionalProperties false", () => {
  const s = JSON.stringify(toApiSchema(PlanDraft));
  assert.ok(!/minItems|maxItems|minimum|"pattern"|\$schema/.test(s));
  assert.ok(s.includes('"additionalProperties":false'));
  assert.ok(PlanDraft.safeParse(draftReel53).success);
});

test("Regression (echtes Reel_53_kurz): Schnitt-Ein liegt am Ende der Stille, nicht am (zu späten) Whisper-Wortanfang", () => {
  // Whisper meldet "Besonders" bei 4,32 s, hörbar beginnt es mit dem Ende der Stille bei 4,196 s
  const { f, r } = run53();
  void r;
  const words = f.transcript.words.map((w) => ({ ...w }));
  const a = words[13]!;
  const b = words[14]!;
  a.end_s = 3.887;
  b.start_s = 4.32;
  const transcript = { ...f.transcript, words };
  const analysis = { ...f.analysis, silences: [{ start_s: 3.887, end_s: 4.013, duration_s: 0.126 }, { start_s: 4.051, end_s: 4.196, duration_s: 0.145 }] };
  const out = finalize({ draft: draftReel53, transcript, analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "x" });
  const seg1 = out.plan!.cut_segments[1]!;
  assert.ok(seg1.raw_in_s <= 4.196, `Schnitt-Ein ${seg1.raw_in_s} liegt im Wort (Sprache beginnt bei 4,196)`);
  assert.ok(Math.abs(out.plan!.cut_segments[0]!.raw_out_s - 3.907) < 0.04);
});
