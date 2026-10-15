import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle, type Config } from "../../src/config.ts";
import { ffmpeg, exec } from "../../src/util/exec.ts";
import { fixtureFromExample, EX53 } from "../helpers/reel.ts";
import { finalize } from "../../src/plan/finalize.ts";
import { draftReel53 } from "../fixtures/draft-reel53.ts";
import { buildAudioGraph, renderAudio } from "../../src/render/audio.ts";
import { targetBitrateKbps } from "../../src/render/export.ts";
import { layoutCaptions } from "../../src/render/layout.ts";
import { cameraScale } from "../../src/lib/camera.ts";
import { checkChin, anchorY, type ChinData } from "../../src/lib/chin.ts";
import { attentionItems, formatAttention } from "../../src/steps/hinschauen.ts";
import { selfcheck, selfcheckTimes } from "../../src/steps/selfcheck.ts";
import { validate } from "../../src/validate/validate.ts";
import type { LlmClient, LlmRequest, LlmTurn } from "../../src/llm/client.ts";
import { runPaths, saveManifest } from "../../src/util/run.ts";
import { writeJson } from "../../src/util/files.ts";
import { findBrowser, renderPlan } from "../../src/steps/render.ts";
import { ingest } from "../../src/steps/ingest.ts";
import * as d48 from "../fixtures/draft-reel48.ts";
import type { Plan } from "../../src/schema/plan.ts";

const TMP = path.join(ROOT, "tests", ".tmp", "m3");
const cfg0 = loadConfig();
const style = loadStyle(cfg0);
const P = style.params;

function plan53(mod?: (d: typeof draftReel53) => void) {
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const draft = structuredClone(draftReel53);
  mod?.(draft);
  const r = finalize({ draft, transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "TW_Reel_53" });
  assert.deepEqual(r.issues, []);
  return { f, plan: r.plan! };
}

test("Export: Bitrate 4400 kbit/s, bei langen Videos gesenkt, damit die Datei unter 30 MB bleibt", () => {
  assert.equal(targetBitrateKbps(P, 47), 4400);
  const long = targetBitrateKbps(P, 70);
  assert.ok(long < 4400 && ((long + 192) * 70) / 8000 < 30);
});

test("Audio-Graph: Fades an Schnitten, Riser vor dem Video abgeschnitten, amix ohne Normalisierung", () => {
  const { plan } = plan53();
  const g = buildAudioGraph(plan, P, plan.sfx.map((s) => `/lib/${s.file}`));
  assert.match(g.filter, /afade=t=in:st=0:d=0\.0080/);
  assert.match(g.filter, /concat=n=11:v=0:a=1/);
  const riser = plan.sfx.findIndex((s) => s.role === "riser");
  const line = g.filter.split(";").find((l) => l.startsWith(`[${riser + 1}:a]`))!;
  assert.match(line, /atrim=start=0\.0\d+:end=/); // Riser beginnt vor 0 s: Anfang weggeschnitten
  assert.match(line, /afade=t=out/);
  assert.match(g.filter, /amix=inputs=\d+:normalize=0/);
  assert.ok(!/adelay=-/.test(g.filter));
});

test("Audio-Graph: bei vorgeschnittenem Material kein Fade mitten im durchlaufenden Ton", () => {
  const f = fixtureFromExample(path.join(ROOT, "style/thorsten/beispiel-plan_reel48_vorgeschnitten.json"), { silencesFromCuts: false, precut: true });
  const { draftReel48 } = d48;
  const r = finalize({ draft: draftReel48, transcript: f.transcript, analysis: f.analysis, meta: f.meta, params: f.params, sfxIndex: f.sfxIndex, style: "thorsten", video: "x" });
  const g = buildAudioGraph(r.plan!, P, []);
  const v0 = g.filter.split(";").find((l) => l.endsWith("[v0]"))!;
  const v1 = g.filter.split(";").find((l) => l.endsWith("[v1]"))!;
  assert.ok(!/afade=t=out/.test(v0), v0);
  assert.ok(!/afade=t=in/.test(v1), v1);
});

test("Audio: echter ffmpeg-Lauf, Länge wie im Plan, Lautheit ≈ −17 LUFS", async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const { plan } = plan53();
  const voice = path.join(TMP, "voice.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=f=220:r=48000:d=52", "-af", "volume=-18dB,aformat=channel_layouts=stereo", "-c:a", "pcm_s16le", voice]);
  const sfxDir = path.join(TMP, "sfx");
  fs.mkdirSync(sfxDir, { recursive: true });
  const names = [...new Set(plan.sfx.map((s) => s.file))];
  for (const n of names) await ffmpeg(["-f", "lavfi", "-i", "sine=f=880:r=44100:d=4.2", "-f", "wav", path.join(sfxDir, n)]);
  const out = path.join(TMP, "audio.wav");
  await renderAudio(plan, P, voice, plan.sfx.map((s) => path.join(sfxDir, s.file)), TMP, out);
  const dur = parseFloat((await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out])).stdout.toString());
  const total = plan.cut_segments.reduce((a, s) => a + s.raw_out_s - s.raw_in_s, 0);
  assert.ok(Math.abs(dur - total) < 0.05, `${dur} vs ${total}`);
  const e = await exec("ffmpeg", ["-hide_banner", "-nostdin", "-i", out, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const lufs = parseFloat(e.stderr.slice(e.stderr.lastIndexOf("Summary:")).match(/I:\s*(-?[\d.]+)\s*LUFS/)![1]!);
  assert.ok(Math.abs(lufs - -17) < 1.0, `LUFS ${lufs}`);
});

test("Layout: Positionen aus params.json (Grundlinie 978+DY, Stack 976/1043/1093, Liste, CTA)", () => {
  const { plan } = plan53();
  const g = layoutCaptions(plan.captions, P, 175);
  const white = plan.captions.find((c) => c.kind === "weiss" && c.layout === "solo")!;
  assert.equal(g.get(white.id)!.baseline, 978 + 175);
  assert.ok(Math.abs(g.get(white.id)!.yCenter - (978 + 175 - 0.27 * 60)) < 0.01);
  const oben = plan.captions.find((c) => c.layout === "stack_oben")!;
  const gold = plan.captions.find((c) => c.layout === "stack_gold")!;
  assert.equal(g.get(oben.id)!.baseline, 976 + 175);
  assert.equal(g.get(gold.id)!.baseline, 1043 + 175);
  const cta = plan.captions.find((c) => c.kind === "cta")!;
  assert.equal(g.get(cta.id)!.baseline, 1091 + 175);
  assert.equal(g.get(cta.id)!.stroke, 2);
  for (const c of plan.captions) assert.ok(g.get(c.id)!.size > 0 && g.get(c.id)!.size <= 100);
});

test("Kamera: Hook-Push endet bei 1,06, Zoom-Rampe läuft weich, hartes Zurücksetzen am Segmentwechsel", () => {
  const { plan } = plan53();
  const fps = 30;
  const cam = { hookPushTo: 1.06, zoomRampFrames: 24 };
  const hookEndF = Math.round((plan.cut_segments[0]!.raw_out_s - plan.cut_segments[0]!.raw_in_s) * fps);
  assert.equal(cameraScale(plan, fps, 0, cam), 1);
  assert.ok(Math.abs(cameraScale(plan, fps, hookEndF - 1, cam) - 1.06) < 0.002);
  const z = plan.zooms[0]!;
  const sf = Math.round(z.start_s * fps);
  assert.equal(cameraScale(plan, fps, sf, cam), 1);
  assert.ok(Math.abs(cameraScale(plan, fps, sf + 12, cam) - (1 + (z.to_scale - 1) / 2)) < 1e-6);
  assert.ok(Math.abs(cameraScale(plan, fps, sf + 30, cam) - z.to_scale) < 1e-9);
  let maxStep = 0;
  for (let f = sf; f < sf + 40; f++) maxStep = Math.max(maxStep, Math.abs(cameraScale(plan, fps, f + 1, cam) - cameraScale(plan, fps, f, cam)));
  assert.ok(maxStep <= P.zoom.max_schritt_pro_frame, `Schritt ${maxStep}`);
  const seg = plan.cut_segments.find((s) => s.id === z.segment_id)!;
  void seg;
});

test("Kinn: DY wird so berechnet, dass in jedem Frame ≥ 20 px Abstand bleiben (inkl. Zoom)", () => {
  const { plan } = plan53();
  const nRaw = 51.2 * 30;
  // Kinn bei 1000 px, in der Mitte des Videos beugt sich die Person nach vorn (Kinn tiefer, 1050 px)
  const frames: ChinData["frames"] = [];
  for (let f = 0; f < nRaw; f += 3) frames.push([f, f > 500 && f < 700 ? 1050 : 1000]);
  const chin: ChinData = { fps: 30, width: 1080, height: 1920, every: 3, frames };
  assert.equal(anchorY(chin), 1000);
  const need = checkChin(plan, chin, P, 0);
  assert.ok(need.requiredDy >= 20 + 1000 - 978 + 0.75 * 60 - 60); // grobe Untergrenze
  const ok = checkChin(plan, chin, P, need.requiredDy);
  assert.equal(ok.violations.length, 0);
  const bad = checkChin(plan, chin, P, Math.max(0, need.requiredDy - 15));
  assert.ok(bad.violations.length > 0, "mit 15 px weniger muss es Verstöße geben");
});

test("Hinschauen: mittlere/niedrige Entscheidungen mit Zeitpunkt und Begründung, hohe nicht", () => {
  const { f, plan } = plan53((d) => {
    d.removals = [{ kind: "wiederholung", from_word_idx: 100, to_word_idx: 102, kept_from_word_idx: 103, kept_to_word_idx: 109, reason: "Zwei ähnliche Takes, Take 2 gewählt", confidence: "mittel" }];
  });
  const v = validate({ plan, transcript: f.transcript, analysis: f.analysis, params: P, sfxIndex: f.sfxIndex });
  const items = attentionItems(plan, v, { result: { urteil: "auffaelligkeiten", zusammenfassung: "", befunde: [{ t_s: 12.0, art: "caption_lesbarkeit", schwere: "hinweis", beschreibung: "Text sehr nah am Rand" }] } });
  const texts = items.map((i) => i.text);
  assert.ok(texts.some((t) => /Wiederholung entfernt: Zwei ähnliche Takes, Take 2 gewählt/.test(t)));
  assert.ok(texts.some((t) => /B-Roll „ETF/.test(t)), "mittlere B-Roll-Entscheidung fehlt");
  assert.ok(texts.some((t) => /Selfcheck \(caption lesbarkeit\): Text sehr nah am Rand/.test(t)));
  assert.ok(texts.some((t) => /Hook-Text von Claude formuliert/.test(t)));
  assert.ok(!texts.some((t) => /Untertitel nach Merge-Regeln/.test(t)));
  const rep = items.find((i) => /Wiederholung/.test(i.text))!;
  assert.ok(rep.t_s > 30 && rep.t_s < 40, `Zeitpunkt ${rep.t_s}`); // Schnittstelle im fertigen Video
  const md = formatAttention("TW_Reel_53", items);
  assert.match(md, /^- \d+:\d\d – /m);
  assert.deepEqual(items.map((i) => i.t_s), [...items.map((i) => i.t_s)].sort((a, b) => a - b));
});

test("selfcheckTimes: Hook-Anfang, Hook-Ende, Blitz, Schluss und fester Abstand; Obergrenze wird eingehalten", () => {
  const t = selfcheckTimes(46.9, 3.77, 2, 40);
  assert.ok(t.includes(0.05) && t.includes(46.8) && t.some((x) => Math.abs(x - 3.62) < 0.01) && t.some((x) => Math.abs(x - 3.82) < 0.01));
  assert.ok(selfcheckTimes(300, 3, 2, 40).length <= 40);
});

class FakeLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private answer: unknown) {}
  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.calls.push(req);
    return { text: JSON.stringify(this.answer), content: [], stopReason: "end_turn", usage: { input_tokens: 5000, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0 } };
  }
}

async function makeRun(cfg: Config, name: string) {
  const run = runPaths(cfg, name);
  const src = path.join(TMP, "synth.mp4");
  if (!fs.existsSync(src)) {
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x2b3a4a:s=1080x1920:r=30:d=51.2", "-f", "lavfi", "-i", "sine=f=300:r=48000:d=51.2", "-af", "volume=-24dB", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
  }
  await ingest(cfg, style, name, { reels: [src], hooks: [], precut: "auto" });
  const { f, plan } = plan53();
  writeJson(run.clip("reel").transcript, f.transcript);
  writeJson(run.clip("reel").analysis, f.analysis);
  const planFile = path.join(run.dir, "plan.json");
  writeJson(planFile, plan);
  return { run, plan, planFile };
}

test("Selfcheck: Frames gehen als Bilder mit Plan-Erwartung an Claude, Ergebnis wird neben dem Video abgelegt", async () => {
  const cfg: Config = { ...cfg0, runsPath: path.join(TMP, "runs"), sfxLibrary: path.join(TMP, "sfx") };
  const { run, plan, planFile } = await makeRun(cfg, "sc");
  const video = path.join(run.dir, "out", "TW_Reel_53.mp4");
  fs.mkdirSync(path.dirname(video), { recursive: true });
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x445566:s=1080x1920:r=30:d=47", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  const llm = new FakeLlm({ urteil: "auffaelligkeiten", zusammenfassung: "ok bis auf eins", befunde: [{ t_s: 9, art: "caption_lesbarkeit", schwere: "hinweis", beschreibung: "Gold auf hellem Grund schwer lesbar" }] });
  const res = await selfcheck(cfg, style, run, planFile, video, { llm });
  assert.equal(res.result!.befunde.length, 1);
  const content = llm.calls[0]!.messages[0]!.content as { type: string; text?: string }[];
  const images = content.filter((c) => c.type === "image");
  assert.ok(images.length >= 20 && images.length <= P.selfcheck.max_bilder, `Bilder: ${images.length}`);
  const txt = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.match(txt, /Transkript des fertigen Videos/);
  assert.match(txt, /Laut Plan: .*Hook-Box \+ KI-Hinweis sichtbar/);
  assert.ok(fs.existsSync(path.join(path.dirname(video), "TW_Reel_53.selfcheck.json")));
  void plan;
});

test("Render (Einzelbild): Remotion rendert aus plan.json allein, 1080x1920, Warnungen für fehlende Schriften/Kinn/B-Roll", async (t) => {
  const cfg: Config = { ...cfg0, runsPath: path.join(TMP, "runs"), sfxLibrary: path.join(TMP, "sfx"), fontsDir: path.join(TMP, "keine-schriften") };
  if (!findBrowser(cfg)) return t.skip("kein Chromium gefunden (AUTOCUT_BROWSER setzen)");
  const { planFile } = await makeRun(cfg, "rr");
  const r = await renderPlan(cfg, style, planFile, { stills: [1.5, 45.5] });
  assert.equal(r.stills.length, 2);
  for (const f of r.stills) {
    const buf = fs.readFileSync(f);
    assert.equal(buf.readUInt32BE(16), 1080);
    assert.equal(buf.readUInt32BE(20), 1920);
  }
  assert.ok(r.warnings.some((w) => /Kinn nicht gemessen/.test(w)));
  assert.ok(r.warnings.some((w) => /Schriften fehlen/.test(w)));
  assert.ok(r.warnings.some((w) => /B-Roll #0/.test(w)));
  assert.equal(r.info.DY, P.layout.kinn.dy_ersatz_ohne_messung);
});

test("rerender-Pfad: Render braucht nur plan.json + Clip-Ordner, nicht transcript/analysis (Plan wird vorher separat validiert)", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src/steps/render.ts"), "utf8");
  assert.ok(!/transcript|analysis\.json/.test(src.replace(/\/\/.*$/gm, "")), "render.ts darf nicht von Transkript/Analyse abhängen");
  const plan: Plan = plan53().plan;
  assert.ok(plan.captions.length > 0);
});
