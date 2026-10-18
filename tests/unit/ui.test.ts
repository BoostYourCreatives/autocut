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
  assert.deepEqual(d.steps.map((s: { key: string; status: string }) => [s.key, s.status]), [["ingest", "ok"], ["transcribe", "pending"], ["analyze", "pending"], ["chin", "pending"], ["plan", "ok"], ["broll", "pending"], ["render", "pending"]]);
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

// ---------------- öffentlicher Betrieb: Passwort, Assets, Upload-Limit ----------------
const cfg2: Config = { ...cfg, runsPath: path.join(TMP, "runs2"), sfxLibrary: path.join(TMP, "sfx2"), fontsDir: path.join(TMP, "fonts2") };
const pub = await startServer({ cfg: cfg2, style, port: 0, password: "geheim123", maxUploadMb: 1 });
after(() => pub.server.close());
const raw = (p: string, init?: RequestInit) => fetch(pub.url + p, { redirect: "manual", ...init });

test("Öffentlich: ohne Anmeldung kein Zugriff (API 401, Seite leitet auf /login), /healthz bleibt offen", async () => {
  assert.equal((await raw("/api/runs")).status, 401);
  const home = await raw("/");
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/login");
  assert.equal((await raw("/healthz")).status, 200);
  assert.equal((await raw("/media/x/y.mp4")).status, 401);
});

test("Öffentlich: falsches Passwort wird abgelehnt, richtiges setzt ein HttpOnly-Cookie und gibt Zugriff", async () => {
  const bad = await raw("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=falsch" });
  assert.equal(bad.status, 401);
  assert.ok(!bad.headers.get("set-cookie"));
  const ok = await raw("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=geheim123" });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const c = cookie.split(";")[0]!;
  const runs = await raw("/api/runs", { headers: { cookie: c } });
  assert.equal(runs.status, 200);
  // manipuliertes Cookie
  const forged = await raw("/api/runs", { headers: { cookie: c.slice(0, -2) + "00" } });
  assert.equal(forged.status, 401);
});

test("Öffentlich: nach 10 Fehlversuchen wird gesperrt (auch mit richtigem Passwort)", async () => {
  const hdr = { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "9.9.9.9" };
  for (let i = 0; i < 10; i++) await raw("/login", { method: "POST", headers: hdr, body: "password=x" });
  const locked = await raw("/login", { method: "POST", headers: hdr, body: "password=geheim123" });
  assert.equal(locked.status, 429);
});

async function session() {
  const ok = await raw("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "1.2.3.4" }, body: "password=geheim123" });
  return ok.headers.get("set-cookie")!.split(";")[0]!;
}

test("Öffentlich: Fremde Herkunft (CSRF) wird bei schreibenden Anfragen abgelehnt", async () => {
  const c = await session();
  const r = await raw("/api/runs/x/replan", { method: "POST", headers: { cookie: c, origin: "https://boese.example" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("Assets: Soundeffekte und Schriften hochladen, listen, Fehlendes wird angezeigt, falsche Dateitypen und Pfade werden abgewiesen", async () => {
  const c = await session();
  const up = (kind: string, name: string, body: string) => raw(`/api/assets?kind=${kind}&filename=${encodeURIComponent(name)}`, { method: "POST", headers: { cookie: c }, body });
  assert.equal((await up("sfx", "Riser.mp3", "abc")).status, 200);
  assert.equal((await up("fonts", "Helvetica-Bold.ttf", "abc")).status, 200);
  assert.equal((await up("sfx", "virus.exe", "abc")).status, 415);
  assert.equal((await up("fonts", "Riser.mp3", "abc")).status, 415);
  // Pfad im Namen wird auf den Dateinamen reduziert und landet nicht außerhalb
  assert.equal((await up("sfx", "../../evil.mp3", "abc")).status, 200);
  assert.ok(fs.existsSync(path.join(cfg2.sfxLibrary, "evil.mp3")));
  assert.ok(!fs.existsSync(path.join(TMP, "evil.mp3")));
  const list = await (await raw("/api/assets", { headers: { cookie: c } })).json();
  assert.ok(list.sfx.some((f: { file: string }) => f.file === "Riser.mp3"));
  assert.ok(list.missing.sfx.includes("Fuwa.mp3") && !list.missing.sfx.includes("Riser.mp3"));
  assert.ok(list.missing.fonts.includes("SegoePro-BoldItalic.ttf") && !list.missing.fonts.includes("Helvetica-Bold.ttf"));
});

test("Upload-Limit: zu großes Video wird abgewiesen, kein Run bleibt zurück; falscher Dateityp ebenso", async () => {
  const c = await session();
  const big = Buffer.alloc(2 * 1024 * 1024, 1);
  const r = await raw(`/api/upload?filename=x.mp4&o=${encodeURIComponent("{}")}`, { method: "POST", headers: { cookie: c }, body: big });
  assert.equal(r.status, 413);
  const t = await raw(`/api/upload?filename=x.txt&o=${encodeURIComponent("{}")}`, { method: "POST", headers: { cookie: c }, body: "hallo" });
  assert.equal(t.status, 415);
  const runs = await (await raw("/api/runs", { headers: { cookie: c } })).json();
  assert.deepEqual(runs, []);
});

test("UI: Abnahme löscht Rohmaterial, behält fertiges Video und Plan; Lauf löschen entfernt alles", async () => {
  const run = runPaths(cfg, "abn");
  saveManifest(run, { name: "abn", created_at: new Date().toISOString(), style: "thorsten", clips: [{ id: "reel", role: "reel", source_path: "/x.mp4", precut: "auto" }] });
  const w = (f: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x".repeat(1000)); };
  w(path.join(run.dir, "input", "roh.mp4"));
  w(path.join(run.dir, "render", "video.mp4"));
  w(path.join(run.dir, "clips", "reel", "proxy.mp4"));
  w(path.join(run.dir, "clips", "reel", "audio_16k.wav"));
  w(path.join(run.dir, "clips", "reel", "transcript.json"));
  w(path.join(run.dir, "plan.json"));
  const noVideo = await fetch(`${srv.url}/api/runs/abn/approve`, { method: "POST" });
  assert.equal(noVideo.status, 409);
  w(path.join(run.dir, "out", "TW_Reel_abn.mp4"));
  w(path.join(run.dir, "out", "f1.png"));
  const ok = await fetch(`${srv.url}/api/runs/abn/approve`, { method: "POST" });
  assert.equal(ok.status, 200);
  for (const gone of ["input", "render", "clips/reel/proxy.mp4", "clips/reel/audio_16k.wav", "out/f1.png"]) assert.ok(!fs.existsSync(path.join(run.dir, gone)), gone);
  for (const kept of ["plan.json", "clips/reel/transcript.json", "out/TW_Reel_abn.mp4", "approved.json"]) assert.ok(fs.existsSync(path.join(run.dir, kept)), kept);
  const del = await fetch(`${srv.url}/api/runs/abn`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(run.dir));
});

test("Untertitel-Editor: geänderter Text wird übernommen, Validator akzeptiert ihn, leerer Text wird ignoriert", async () => {
  const { applyCaptionEdits } = await import("../../src/steps/captionEdit.ts");
  const { fixtureFromExample, EX53 } = await import("../helpers/reel.ts");
  const { finalize } = await import("../../src/plan/finalize.ts");
  const { draftReel53 } = await import("../fixtures/draft-reel53.ts");
  const { validate } = await import("../../src/validate/validate.ts");
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const r = finalize({ draft: structuredClone(draftReel53), transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53" });
  const plan = r.plan!;
  const c = plan.captions.find((x) => x.kind === "weiss")!;
  const before = validate({ plan, transcript: f.transcript, analysis: f.analysis, params: f.params, sfxIndex: f.sfxIndex });
  const out = applyCaptionEdits(plan, [{ id: c.id, text: "  Völlig anderer Text " }, { id: 9999, text: "x" }, { id: plan.captions[0]!.id, text: "   " }]);
  assert.equal(out.changed, 1);
  assert.equal(c.text, "Völlig anderer Text");
  const after = validate({ plan, transcript: f.transcript, analysis: f.analysis, params: f.params, sfxIndex: f.sfxIndex });
  assert.equal(after.errors.filter((e) => e.code === "caption_text").length, 0);
  assert.equal(before.errors.length, after.errors.length);
});

test("Text-Ebene: Bildbereiche für geänderte Untertitel (mit Gruppe, zusammengelegt)", async () => {
  const { captionFrameRanges } = await import("../../src/steps/render.ts");
  const mk = (id: number, s: number, e: number, group: string | null = null) => ({ id, start_s: s, end_s: e, group }) as never;
  const plan = { captions: [mk(0, 0, 1), mk(1, 1, 2, "g"), mk(2, 2, 3, "g"), mk(3, 10, 11)] } as never;
  assert.deepEqual(captionFrameRanges(plan, [3], 25, 400), [[249, 276]]);
  // Gruppe: Änderung an 1 betrifft auch 2, beide Bereiche grenzen aneinander und werden zusammengelegt
  assert.deepEqual(captionFrameRanges(plan, [1], 25, 400), [[24, 76]]);
  assert.deepEqual(captionFrameRanges(plan, null, 25, 400), [[0, 399]]);
});

test("Untertitel-Zeiten: Verschieben wird auf Bilder gerundet, alter Bereich gemerkt, Sync-Prüfung entfällt, Überlappung bleibt verboten", async () => {
  const { applyCaptionEdits } = await import("../../src/steps/captionEdit.ts");
  const { fixtureFromExample, EX53 } = await import("../helpers/reel.ts");
  const { finalize } = await import("../../src/plan/finalize.ts");
  const { draftReel53 } = await import("../fixtures/draft-reel53.ts");
  const { validate } = await import("../../src/validate/validate.ts");
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const mk = () => finalize({ draft: structuredClone(draftReel53), transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53" }).plan!;
  const v = (plan: unknown) => validate({ plan, transcript: f.transcript, analysis: f.analysis, params: f.params, sfxIndex: f.sfxIndex });

  const plan = mk();
  const fps = plan.source.fps;
  const c = plan.captions.find((x) => x.kind === "weiss")!;
  const [s0, e0] = [c.start_s, c.end_s];
  const r = applyCaptionEdits(plan, [{ id: c.id, start_s: s0 + 0.081, end_s: e0 - 0.01 }]);
  assert.equal(r.changed, 1);
  assert.deepEqual(r.oldRangesS, [[s0, e0]]);
  assert.ok(Math.abs(c.start_s * fps - Math.round(c.start_s * fps)) < 1e-6, "auf ganze Bilder gerundet");
  assert.ok(c.edited);
  // 0,08 s Verschiebung wäre ohne "edited" ein Sync-Fehler; mit manueller Änderung nicht
  assert.equal(v(plan).errors.filter((e) => e.code === "caption_zu_spaet" || e.code === "caption_zu_frueh").length, 0);

  const plan2 = mk();
  const d = plan2.captions.find((x) => x.kind === "weiss" && x.layout === "solo")!;
  const next = plan2.captions.filter((x) => x.start_s > d.start_s).sort((a, b) => a.start_s - b.start_s)[0]!;
  applyCaptionEdits(plan2, [{ id: d.id, end_s: next.start_s + 0.2 }]);
  assert.ok(v(plan2).errors.some((e) => e.code === "caption_ueberlappung" || e.code === "caption_ueber_schnitt"), "Überlappung muss abgelehnt werden");
});

test("Wellenform: Hüllkurve eines Testtons, 100 Werte pro Sekunde", async () => {
  const { waveformPeaks } = await import("../../src/lib/waveform.ts");
  const { ffmpeg } = await import("../../src/util/exec.ts");
  const dir = path.join(TMP, "wave");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1", "-t", "2", f]);
  const w = await waveformPeaks(f);
  assert.equal(w.peaksPerSec, 100);
  assert.ok(Math.abs(w.peaks.length - 200) <= 2);
  assert.ok(w.peaks[50]! > 200 && w.peaks[150]! < 5, "laut in der ersten, still in der zweiten Sekunde");
});

test("Hook-Text ändern: Versalien, Plan und Hook-Box gleichzeitig, Zeitbereich der Box", async () => {
  const { applyHookEdit } = await import("../../src/steps/captionEdit.ts");
  const { fixtureFromExample, EX53 } = await import("../helpers/reel.ts");
  const { finalize } = await import("../../src/plan/finalize.ts");
  const { draftReel53 } = await import("../fixtures/draft-reel53.ts");
  const { validate } = await import("../../src/validate/validate.ts");
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const plan = finalize({ draft: structuredClone(draftReel53), transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53" }).plan!;
  const before = plan.hook!.lines.join("|");
  assert.equal(applyHookEdit(plan, [plan.hook!.lines[0], plan.hook!.lines[1]]), null, "unverändert = keine Änderung");
  const range = applyHookEdit(plan, ["warum europa", " zurückfallen könnte "]);
  assert.ok(range && range[1] > range[0]);
  assert.deepEqual(plan.hook!.lines, ["WARUM EUROPA", "ZURÜCKFALLEN KÖNNTE"]);
  const box = plan.overlays.find((o) => o.type === "hook_box")!;
  assert.deepEqual(box.type === "hook_box" ? box.lines : null, plan.hook!.lines);
  assert.notEqual(before, plan.hook!.lines.join("|"));
  assert.equal(validate({ plan, transcript: f.transcript, analysis: f.analysis, params: f.params, sfxIndex: f.sfxIndex }).errors.filter((e) => e.code.startsWith("hook")).length, 0);
});
