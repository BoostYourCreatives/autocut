import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle, type Config } from "../../src/config.ts";
import { ffmpeg } from "../../src/util/exec.ts";
import { ingest } from "../../src/steps/ingest.ts";
import { transcribe } from "../../src/steps/transcribe/index.ts";
import { analyze } from "../../src/steps/analyze.ts";
import { runPaths } from "../../src/util/run.ts";
import { readJsonSchema } from "../../src/util/files.ts";
import { Analysis } from "../../src/schema/analysis.ts";
import { Transcript } from "../../src/schema/transcript.ts";
import { readRunLog } from "../../src/util/runlog.ts";

/**
 * Synthetisches Testmaterial (kein Sprachinhalt):
 *   Ton 0.0-1.0 | Stille 1.0-1.6 | Ton 1.6-2.6 | leise 2.6-2.9 (ca. -31 dBFS RMS, Atmer-Kandidat) | Ton 2.9-4.0
 *   Bild: blau bis 2.0 s, dann hart gelb (Szenenwechsel bei 2.0 s)
 */
const TMP = path.join(ROOT, "tests", ".tmp");
let cfg: Config;

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  cfg = { ...loadConfig(), runsPath: path.join(TMP, "runs") };
  const gen = path.join(TMP, "synthetic.mp4");
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=2",
    "-f", "lavfi", "-i", "color=c=yellow:s=1080x1920:r=30:d=2",
    "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1",
    "-f", "lavfi", "-i", "sine=f=300:r=48000:d=0.3",
    "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1.1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v];" +
      "[3:a]atrim=0:0.6,asetpts=N/SR/TB[sil];" +
      "[5:a]volume=-10dB[quiet];" +
      "[2:a][sil][4:a][quiet][6:a]concat=n=5:v=0:a=1[a]",
    "-map", "[v]", "-map", "[a]", "-t", "4", "-c:v", "libx264", "-c:a", "aac", gen,
  ]);
});

test("M1: ingest → transcribe(file) → analyze auf synthetischem Clip", async () => {
  const style = loadStyle(cfg);
  const run = await ingest(cfg, style, "t1", { reels: [path.join(TMP, "synthetic.mp4")], hooks: [], precut: "auto" });
  const p = run.clip("reel");
  for (const f of [p.meta, p.proxy, p.audio16k, p.audio48k]) assert.ok(fs.existsSync(f), `fehlt: ${f}`);

  const words = path.join(TMP, "words.json");
  fs.writeFileSync(words, JSON.stringify([
    { word: "Eins", start_s: 0.0, end_s: 1.3 },   // Ende liegt in der Stille ab 1.0
    { word: "zwei,", start_s: 1.5, end_s: 2.6 },  // Anfang liegt in der Stille bis 1.6
    { word: "drei", start_s: 2.9, end_s: 3.9 },
  ]));
  await transcribe(cfg, style, "t1", { provider: "file", fromFile: { "*": words } });
  const tr = readJsonSchema(p.transcript, Transcript);
  assert.equal(tr.words.length, 3);
  assert.ok(Math.abs(tr.words[0]!.end_s - 1.0) < 0.1, `Wortende ${tr.words[0]!.end_s}`);
  assert.ok(Math.abs(tr.words[1]!.start_s - 1.6) < 0.1, `Wortanfang ${tr.words[1]!.start_s}`);

  await analyze(cfg, style, "t1");
  const an = readJsonSchema(p.analysis, Analysis);
  const sil = an.silences.find((s) => s.start_s > 0.8 && s.start_s < 1.2);
  assert.ok(sil, "Stille bei ~1.0 s nicht gefunden");
  assert.ok(Math.abs(sil!.duration_s - 0.6) < 0.1);
  assert.ok(an.scene_changes.some((s) => Math.abs(s.t_s - 2.0) < 0.1), "Szenenwechsel bei 2.0 s fehlt");
  assert.ok(an.breath_candidates.some((b) => b.start_s > 2.4 && b.end_s < 3.1), "Atmer-Kandidat bei ~2.6-2.9 fehlt");
  assert.equal(an.precut.hard_cuts, 1);
  assert.equal(an.precut.effective, false); // 1 harter Schnitt < Schwelle 2
  assert.ok(an.loudness.integrated_lufs !== null);

  const log = readRunLog(runPaths(cfg, "t1"));
  assert.deepEqual(log.steps.map((s) => s.step), ["ingest", "transcribe", "analyze"]);
  assert.ok(log.steps.every((s) => s.status === "ok"));
});

test("--precut ja überstimmt die Erkennung; Hook/Body werden getrennt eingelesen", async () => {
  const style = loadStyle(cfg);
  const src = path.join(TMP, "synthetic.mp4");
  const run = await ingest(cfg, style, "t2", { reels: [], hooks: [src], body: src, precut: true });
  const manifest = JSON.parse(fs.readFileSync(run.manifest, "utf8"));
  assert.deepEqual(manifest.clips.map((c: any) => [c.id, c.role]), [["hook-synthetic", "hook"], ["body", "body"]]);
  await analyze(cfg, style, "t2", ["body"]);
  const an = readJsonSchema(run.clip("body").analysis, Analysis);
  assert.equal(an.precut.effective, true);
  assert.equal(an.precut.detected, false);
});
