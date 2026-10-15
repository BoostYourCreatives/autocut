import type { Config, Style } from "../config.ts";
import { detectScenes, detectSilences, measureLoudness, readPcm16, rmsSeries } from "../lib/audio.ts";
import { subtractSpans, withDuration, round3 } from "../lib/intervals.ts";
import { readJsonSchema, writeJson } from "../util/files.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths, selectClips } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import { Analysis } from "../schema/analysis.ts";
import { ClipMeta } from "../schema/ingest.ts";

/** Technische Analyse ohne KI: Stillen, Atmer-Kandidaten, Lautstärke, Szenenwechsel. */
export async function analyze(cfg: Config, style: Style, runName: string, clipIds?: string[]): Promise<void> {
  const run = runPaths(cfg, runName);
  const manifest = loadManifest(run);
  const A = style.params.analyze;

  for (const clip of selectClips(manifest, clipIds)) {
    const paths = run.clip(clip.id);
    const meta = readJsonSchema(paths.meta, ClipMeta);

    await timed(run, "analyze", clip.id, async () => {
      const sr = style.params.ingest.analyse_audio.sample_rate;
      const [silRaw, lowRaw, pcm, ebu, scenes] = await Promise.all([
        detectSilences(paths.audio16k, A.stille.noise_db, A.stille.min_s, meta.duration_s),
        detectSilences(paths.audio16k, A.leise_bereiche.noise_db, A.leise_bereiche.min_s, meta.duration_s),
        readPcm16(paths.audio16k, sr),
        measureLoudness(paths.audio48k),
        detectScenes(paths.proxy, A.szenenwechsel.schwelle),
      ]);

      const series = rmsSeries(pcm, sr, A.lautheit_fenster_s);
      const meanDb = (a: number, b: number) => {
        const i0 = Math.floor(a / A.lautheit_fenster_s);
        const i1 = Math.max(i0 + 1, Math.ceil(b / A.lautheit_fenster_s));
        const vals = series.slice(i0, i1);
        return vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10 : -120;
      };

      // Atmer-Kandidaten: leise Bereiche, die keine echte Stille sind
      const breath = subtractSpans(lowRaw, silRaw, 0.1).map((s) => ({ ...withDuration(s), mean_db: meanDb(s.start_s, s.end_s) }));

      const detected = scenes.length >= A.vorgeschnitten_ab_harten_schnitten.anzahl;
      const setting = clip.precut;
      const effective = setting === "auto" ? detected : setting;

      const analysis = Analysis.parse({
        clip: clip.id,
        duration_s: meta.duration_s,
        fps: meta.fps,
        params: {
          silence_noise_db: A.stille.noise_db,
          silence_min_s: A.stille.min_s,
          low_energy_noise_db: A.leise_bereiche.noise_db,
          low_energy_min_s: A.leise_bereiche.min_s,
          scene_threshold: A.szenenwechsel.schwelle,
        },
        silences: silRaw.map(withDuration),
        breath_candidates: breath,
        loudness: { ...ebu, window_s: A.lautheit_fenster_s, series_db: series },
        scene_changes: scenes,
        precut: { setting, detected, effective, hard_cuts: scenes.length },
      });
      writeJson(paths.analysis, analysis);

      const silTotal = round3(analysis.silences.reduce((a, s) => a + s.duration_s, 0));
      log.info(
        `analyze ${clip.id}: ${analysis.silences.length} Stillen (${silTotal} s von ${meta.duration_s.toFixed(1)} s), ` +
          `${breath.length} Atmer-Kandidaten, ${scenes.length} harte Schnitte, ` +
          `${ebu.integrated_lufs ?? "?"} LUFS, vorgeschnitten=${effective}${setting === "auto" ? " (auto)" : " (manuell)"}`,
      );
      return { value: analysis };
    });
  }
}
