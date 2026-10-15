import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle, type Config } from "../../src/config.ts";
import { startServer } from "../../src/ui/server.ts";
import { runPaths, saveManifest } from "../../src/util/run.ts";
import { summarizeRun, formatRunReport } from "../../src/steps/report.ts";
import { writeJson } from "../../src/util/files.ts";
import { timed } from "../../src/util/runlog.ts";

const TMP = path.join(ROOT, "tests", ".tmp", "ui");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "sfx"), { recursive: true });
const cfg: Config = { ...loadConfig(), runsPath: path.join(TMP, "runs"), sfxLibrary: path.join(TMP, "sfx") };
const style = loadStyle(cfg);
const srv = await startServer({ cfg, style, port: 0 });
after(() => srv.server.close());
const get = async (p: string) => {
  const r = await fetch(srv.url + p);
  return { status: r.status, body: await r.text(), type: r.headers.get("content-type") ?? "" };
};

test("UI: Startseite und System-Check", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Neues Reel/);
  const h = JSON.parse((await get("/api/health")).body);
  assert.ok(h.items.some((i: { key: string }) => i.key === "ffmpeg"));
  const sfx = h.items.find((i: { key: string }) => i.key === "sfx");
  assert.equal(sfx.ok, false, "leere SFX-Library muss als fehlend gemeldet werden");
});

test("UI: unbekannter Run und Pfad-Ausbruch werden abgewiesen", async () => {
  assert.equal((await get("/api/runs/gibt-es-nicht")).status, 404);
  assert.equal((await get("/api/runs/..%2F..%2Fetc")).status, 404);
  assert.equal((await get("/media/x/..%2F..%2F..%2Fpackage.json")).status, 404);
});

test("UI: Lauf erscheint in der Liste, Detail zeigt Schritte, ungültiger Plan wird mit Meldung abgelehnt", async () => {
  const run = runPaths(cfg, "demo");
  saveManifest(run, { name: "demo", created_at: new Date().toISOString(), style: "thorsten", clips: [{ id: "reel", role: "reel", source_path: "/x.mp4", precut: "auto" }] });
  await timed(run, "ingest", "reel", async () => ({ value: 1 }));
  await timed(run, "plan", "reel", async () => ({ value: 1, api: { provider: "anthropic", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 500, est_cost_usd: 0.05 } }));
  const runs = JSON.parse((await get("/api/runs")).body);
  assert.deepEqual(runs.map((r: { name: string }) => r.name), ["demo"]);
  const d = JSON.parse((await get("/api/runs/demo")).body);
  assert.deepEqual(d.steps.map((s: { key: string; status: string }) => [s.key, s.status]), [["ingest", "ok"], ["transcribe", "pending"], ["analyze", "pending"], ["chin", "pending"], ["plan", "ok"], ["render", "pending"]]);
  assert.equal(d.summary.cost_usd, 0.05);
  const bad = await fetch(`${srv.url}/api/runs/demo/plan/check`, { method: "POST", body: "{kaputt" });
  assert.equal(bad.status, 422);
  assert.match(JSON.stringify(await bad.json()), /Kein gültiges JSON/);
  const schema = await fetch(`${srv.url}/api/runs/demo/plan/check`, { method: "POST", body: JSON.stringify({ foo: 1 }) });
  assert.equal(schema.status, 422);
});

test("Laufbericht: Dauer, Tokens und Kosten je Schritt", () => {
  const s = summarizeRun(runPaths(cfg, "demo").dir)!;
  assert.equal(s.tokens.input, 1000);
  assert.equal(s.tokens.output, 500);
  const md = formatRunReport("demo", s);
  assert.match(md, /Plan \(Claude\)/);
  assert.match(md, /\$0\.05/);
  writeJson(path.join(TMP, "x.json"), {});
});
