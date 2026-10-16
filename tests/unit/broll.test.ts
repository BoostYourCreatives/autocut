import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, type Config } from "../../src/config.ts";
import { fixtureFromExample, EX53 } from "../helpers/reel.ts";
import { finalize } from "../../src/plan/finalize.ts";
import { draftReel53 } from "../fixtures/draft-reel53.ts";
import { sourceBroll } from "../../src/steps/broll.ts";
import { runPaths } from "../../src/util/run.ts";
import { readJson, writeJson } from "../../src/util/files.ts";
import { Plan } from "../../src/schema/plan.ts";
import type { LlmClient } from "../../src/llm/client.ts";

const TMP = path.join(ROOT, "tests", ".tmp", "broll");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });
fs.writeFileSync(path.join(TMP, "lib", "baustelle-kran.mp4"), "x");
const cfg: Config = { ...loadConfig(), runsPath: path.join(TMP, "runs"), brollLibrary: path.join(TMP, "lib") };

function freshPlan(name: string) {
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const r = finalize({ draft: structuredClone(draftReel53), transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53" });
  const run = runPaths(cfg, name);
  fs.mkdirSync(run.dir, { recursive: true });
  const file = path.join(run.dir, "plan.json");
  writeJson(file, r.plan!);
  return { run, file, n: r.plan!.broll.length };
}
const llm = (ownFile: string | null): LlmClient => ({
  async complete(req) {
    const ids = [...req.messages[0]!.content.toString().matchAll(/id (\d+):/g)].map((m) => Number(m[1]));
    const slots = ids.map((id, i) => ({ id, eigene_datei: i === 0 ? ownFile : null, suchbegriff_englisch: "construction crane" }));
    return { text: JSON.stringify({ slots }), content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }, stopReason: "end_turn" };
  },
});
const fakeFetch = (async (url: string) => {
  const u = String(url);
  if (u.includes("pexels.com")) {
    return new Response(JSON.stringify({ videos: [{ duration: 30, url: "https://pexels.test/v", user: { name: "Max" }, video_files: [{ width: 1080, height: 1920, link: "https://cdn.test/a.mp4", file_type: "video/mp4" }] }] }));
  }
  if (u.includes("pixabay.com")) return new Response(JSON.stringify({ hits: [] }));
  return new Response("VIDEO", { status: 200 });
}) as unknown as typeof fetch;

test("B-Roll: nichts angehakt → Stellen werden aus dem Plan entfernt", async () => {
  const { run, file, n } = freshPlan("none");
  assert.ok(n > 0);
  await sourceBroll(cfg, run, file, { own: false, stock: false });
  assert.equal(Plan.parse(readJson(file)).broll.length, 0);
});

test("B-Roll: eigene Bibliothek zuerst, Stock nur für den Rest", async () => {
  process.env.PEXELS_API_KEY = "test";
  const { run, file, n } = freshPlan("both");
  const res = await sourceBroll(cfg, run, file, { own: true, stock: true, llm: llm("baustelle-kran.mp4"), fetch: fakeFetch });
  const p = Plan.parse(readJson(file));
  assert.equal(res.own, 1);
  assert.equal(res.stock, n - 1);
  assert.equal(p.broll[0]!.source.kind, "user_clip");
  if (n > 1) {
    const s = p.broll[1]!.source;
    assert.equal(s.kind, "stock_ordner");
    assert.ok(fs.existsSync((s as { path: string }).path));
    assert.match((s as { info?: string }).info ?? "", /Pexels, Max/);
  }
});

test("B-Roll: nur Stock, keine Treffer → Stelle bleibt offen, kein Abbruch", async () => {
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  const { run, file, n } = freshPlan("nokeys");
  const res = await sourceBroll(cfg, run, file, { own: false, stock: true, llm: llm(null), fetch: fakeFetch });
  assert.equal(res.open, n);
  assert.equal(Plan.parse(readJson(file)).broll[0]!.source.kind, "offen");
});
