import { z } from "zod";
import { seconds } from "./common.ts";

const Interval = z.object({ start_s: seconds, end_s: seconds, duration_s: seconds });
export type Interval = z.infer<typeof Interval>;

export const Analysis = z.object({
  clip: z.string(),
  duration_s: seconds,
  fps: z.number().positive(),
  params: z.object({
    silence_noise_db: z.number(),
    silence_min_s: z.number(),
    low_energy_noise_db: z.number(),
    low_energy_min_s: z.number(),
    scene_threshold: z.number(),
  }),
  /** Stillen laut silencedetect (Schwellen aus params.json) */
  silences: z.array(Interval),
  /** Kandidaten für Atmer: leise, aber nicht still (Stillen abgezogen) */
  breath_candidates: z.array(Interval.extend({ mean_db: z.number() })),
  loudness: z.object({
    integrated_lufs: z.number().nullable(),
    lra: z.number().nullable(),
    true_peak_dbfs: z.number().nullable(),
    window_s: z.number(),
    /** RMS in dBFS je Fenster, auf 0.1 dB gerundet */
    series_db: z.array(z.number()),
    /** Feinere Reihe (20 ms) für die Prüfung der Schnittkanten */
    fine_window_s: z.number(),
    fine_series_db: z.array(z.number()),
  }),
  scene_changes: z.array(z.object({ t_s: seconds, score: z.number() })),
  precut: z.object({
    setting: z.union([z.literal("auto"), z.boolean()]),
    detected: z.boolean(),
    effective: z.boolean(),
    hard_cuts: z.number().int().nonnegative(),
  }),
});
export type Analysis = z.infer<typeof Analysis>;
