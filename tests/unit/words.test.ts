import { test } from "node:test";
import assert from "node:assert/strict";
import { attachPunctuation, snapWords } from "../../src/lib/words.ts";
import { subtractSpans } from "../../src/lib/intervals.ts";
import { parseSilenceDetect, parseEbur128, parseSceneMetadata, rmsSeries } from "../../src/lib/audio.ts";

test("snapWords: Wortende in Stille rückt an Stillebeginn, Anfang ans Stilleende", () => {
  const out = snapWords(
    [
      { word: "Hallo", start_s: 0.0, end_s: 1.2 },
      { word: "Welt", start_s: 1.3, end_s: 2.0 },
    ],
    [{ start_s: 1.0, end_s: 1.4 }],
    0.04,
  );
  assert.equal(out[0]!.end_s, 1.0);
  assert.equal(out[1]!.start_s, 1.4);
  assert.ok(out[0]!.snapped && out[1]!.snapped);
});

test("snapWords: überlappende Wörter werden monoton (Fall aus Reel 48, 'wie'/'dein')", () => {
  const out = snapWords(
    [
      { word: "wie", start_s: 41.58, end_s: 41.64 },
      { word: "dein", start_s: 41.62, end_s: 41.8 },
    ],
    [],
    0.04,
  );
  assert.ok(out[1]!.start_s >= out[0]!.end_s);
});

test("snapWords: Wort komplett in Stille bleibt, wird aber als suspect markiert", () => {
  const out = snapWords([{ word: "Ähm", start_s: 2.0, end_s: 2.2 }], [{ start_s: 1.5, end_s: 3.0 }], 0.04);
  assert.equal(out[0]!.start_s, 2.0);
  assert.match(out[0]!.suspect ?? "", /Stille/);
});

test("attachPunctuation überträgt Satzzeichen aus dem Fließtext", () => {
  const w = attachPunctuation(
    [
      { word: "Wenn", start_s: 0, end_s: 0.1 },
      { word: "müsste", start_s: 0.1, end_s: 0.5 },
      { word: "würde", start_s: 0.6, end_s: 0.8 },
    ],
    "Wenn müsste, würde",
  );
  assert.deepEqual(w.map((x) => x.word), ["Wenn", "müsste,", "würde"]);
});

test("subtractSpans", () => {
  const r = subtractSpans([{ start_s: 0, end_s: 10 }], [{ start_s: 2, end_s: 3 }, { start_s: 9.95, end_s: 11 }], 0.1);
  assert.deepEqual(r, [{ start_s: 0, end_s: 2 }, { start_s: 3, end_s: 9.95 }]);
});

test("parseSilenceDetect inkl. offener Stille am Ende", () => {
  const s = parseSilenceDetect(
    "[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 2.5 | silence_duration: 1\n[silencedetect] silence_start: 9.0\n",
    10,
  );
  assert.deepEqual(s, [{ start_s: 1.5, end_s: 2.5 }, { start_s: 9, end_s: 10 }]);
});

test("parseEbur128 / parseSceneMetadata / rmsSeries", () => {
  const e = parseEbur128("noise\n  Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n  Loudness range:\n    LRA:         5.1 LU\n  True peak:\n    Peak:       -1.2 dBFS\n");
  assert.deepEqual(e, { integrated_lufs: -23.4, lra: 5.1, true_peak_dbfs: -1.2 });
  const sc = parseSceneMetadata("frame:0 pts:60 pts_time:2.4\nlavfi.scene_score=0.512345\n");
  assert.deepEqual(sc, [{ t_s: 2.4, score: 0.512 }]);
  const pcm = new Int16Array(1600).fill(16384); // 0.5 FS => -6 dB
  assert.equal(rmsSeries(pcm, 16000, 0.1)[0], -6);
});

import { limitFfmpegThreads } from "../../src/util/exec.ts";
test("ffmpeg-Threads werden für Eingang, Filter und Ausgabe begrenzt (Container melden sonst alle Kerne des Servers)", () => {
  const a = limitFfmpegThreads(["-hide_banner", "-y", "-i", "in.mp4", "-an", "-c:v", "libx264", "out.mp4"], 4);
  assert.deepEqual(a.slice(0, 4), ["-filter_threads", "4", "-filter_complex_threads", "4"]);
  assert.equal(a[a.indexOf("-i") - 2], "-threads");
  assert.deepEqual(a.slice(-3), ["-threads", "4", "out.mp4"]);
  // Nichts doppelt, wenn schon gesetzt
  assert.deepEqual(limitFfmpegThreads(["-threads", "2", "-i", "a", "b"]), ["-threads", "2", "-i", "a", "b"]);
});
