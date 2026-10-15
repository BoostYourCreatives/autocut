import { test } from "node:test";
import assert from "node:assert/strict";
import { Plan } from "../../src/schema/plan.ts";

const base = () => ({
  schema_version: 1,
  video: "TW_Reel_X",
  role: "reel",
  style: "thorsten",
  source: { clip: "reel", file: "x.mp4", fps: 30, width: 1080, height: 1920, duration_s: 10 },
  precut: false,
  hook: { end_raw_s: 3, lines: ["ZEILE EINS", "ZEILE ZWEI"], text_origin: "generated", transition: "hart", push: true, reason: "Erster Satz endet bei 3 s", confidence: "hoch" },
  cut_segments: [
    { id: 0, raw_in_s: 0.3, raw_out_s: 3, reason: "Hook, ungeschnitten", confidence: "hoch" },
    { id: 1, raw_in_s: 3.2, raw_out_s: 9, reason: "Body", confidence: "hoch" },
  ],
  removed: [{ kind: "pause", raw_from_s: 3, raw_to_s: 3.2, reason: "Pause 0,2 s", confidence: "hoch" }],
  captions: [],
  zooms: [{ segment_id: 1, start_s: 4, to_scale: 1.1, reason: "Wendepunkt", confidence: "mittel" }],
  sfx: [],
  overlays: [],
  broll: [],
});

test("gültiger Plan wird akzeptiert", () => {
  assert.ok(Plan.safeParse(base()).success);
});

test("Hook-Übergang ist Pflichtfeld und nur blitz_riser oder hart", () => {
  const p: any = base();
  p.hook.transition = "riser";
  assert.ok(!Plan.safeParse(p).success);
  delete p.hook.transition;
  assert.ok(!Plan.safeParse(p).success);
  p.hook.transition = "blitz_riser";
  assert.ok(Plan.safeParse(p).success);
});

test("reason und confidence sind Pflicht", () => {
  const p: any = base();
  delete p.cut_segments[0].reason;
  assert.ok(!Plan.safeParse(p).success);
  const q: any = base();
  q.removed[0].confidence = "sicher";
  assert.ok(!Plan.safeParse(q).success);
});

test("Zoom auf unbekanntes Segment und doppelte Segment-IDs werden abgelehnt", () => {
  const p: any = base();
  p.zooms[0].segment_id = 7;
  assert.ok(!Plan.safeParse(p).success);
  const q: any = base();
  q.cut_segments[1].id = 0;
  assert.ok(!Plan.safeParse(q).success);
});
