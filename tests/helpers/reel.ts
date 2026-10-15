import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle } from "../../src/config.ts";
import type { Analysis } from "../../src/schema/analysis.ts";
import type { ClipMeta } from "../../src/schema/ingest.ts";
import type { Transcript } from "../../src/schema/transcript.ts";
import { snapWords } from "../../src/lib/words.ts";
import type { SfxEntry } from "../../src/lib/sfxIndex.ts";

export const EX53 = path.join(ROOT, "style/thorsten/beispiel-plan_reel53_eigener-schnitt.json");
export const EX48 = path.join(ROOT, "style/thorsten/beispiel-plan_reel48_vorgeschnitten.json");

export function loadExample(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Baut Transkript, Analyse und Meta aus einem Beispielplan des Users (echte Wortzeiten).
 * Stillen = Lücken zwischen den Wörtern, die der User tatsächlich geschnitten hat
 * (Schnittfenster aus cut_segments, je 0,02 s aufgeweitet) bzw. bei vorgeschnittenem Material keine.
 */
export function fixtureFromExample(file: string, opts: { silencesFromCuts: boolean; precut: boolean }) {
  const ex = loadExample(file);
  const params = loadStyle(loadConfig()).params;
  const words = snapWords(
    ex.transcript_words.map((w: any) => ({ word: w.word, start_s: w.start_s, end_s: w.end_s })),
    [],
    params.transcribe.min_wortdauer_s,
  );
  const duration = file === EX53 ? 51.2 : ex.total_s;
  const segs = ex.cut_segments;
  const silences = opts.silencesFromCuts
    ? segs.slice(0, -1).map((s: any, i: number) => {
        const a = s.raw_out_s - 0.02;
        const b = segs[i + 1].raw_in_s + 0.02;
        return { start_s: a, end_s: b, duration_s: +(b - a).toFixed(3) };
      })
    : [];
  const fineN = Math.ceil(duration / 0.02);
  const transcript: Transcript = {
    clip: "reel", language: "de", provider: "file", model: path.basename(file), duration_s: duration, words,
    text: words.map((w) => w.word).join(" "),
  };
  const analysis: Analysis = {
    clip: "reel", duration_s: duration, fps: 30,
    params: { silence_noise_db: -35, silence_min_s: 0.12, low_energy_noise_db: -28, low_energy_min_s: 0.15, scene_threshold: 0.2 },
    silences, breath_candidates: [],
    loudness: { integrated_lufs: -20, lra: 5, true_peak_dbfs: -3, window_s: 0.1, series_db: [], fine_window_s: 0.02,
      // Alles leise, nur die Wörter laut: so liegen Schnittkanten in Lücken, wie in echtem Material
      fine_series_db: Array.from({ length: fineN }, (_, i) => {
        const t = i * 0.02 + 0.01;
        return words.some((w) => t >= w.start_s && t <= w.end_s) ? -22 : -60;
      }) },
    scene_changes: opts.precut ? [{ t_s: 5.3, score: 0.6 }] : [],
    precut: { setting: "auto", detected: opts.precut, effective: opts.precut, hard_cuts: opts.precut ? 2 : 0 },
  };
  const meta: ClipMeta = {
    id: "reel", role: "reel", source_path: "/x/Reel.mp4", duration_s: duration, fps: 30, fps_note: "", vfr: false,
    width: 1080, height: 1920, rotation: 0, video_codec: "h264", has_audio: true,
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
    files: { proxy: "p", audio_16k: "a", audio_48k: "b" }, warnings: [],
  };
  const sfxIndex: SfxEntry[] = ["Riser.mp3", "Camera_Shutter.mp3", "Fuwa.mp3", "Money_Caching.mp3", "Ding.mp3", "Swish_Whoosh_Large.mp3"].map((n) => ({ file: n, name: n, folder: "" }));
  return { ex, params, transcript, analysis, meta, sfxIndex };
}
