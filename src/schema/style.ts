import { z } from "zod";

/**
 * params.json: maschinenlesbare Stilwerte (siehe _meta in der Datei).
 * Die großen Dateien style.json / regeln.md werden NICHT streng validiert,
 * sie sind Quelle der Wahrheit und werden dem Plan-Prompt im Wortlaut mitgegeben.
 */
export const StyleParams = z.object({
  ingest: z.object({
    proxy: z.object({ codec: z.string(), crf: z.number(), gop: z.number(), audio: z.boolean() }),
    analyse_audio: z.object({ sample_rate: z.number(), channels: z.number() }),
    master_audio: z.object({ sample_rate: z.number(), channels: z.number() }),
    fps_regel: z.string(),
    erlaubte_fps: z.array(z.number()),
    soll_aufloesung: z.tuple([z.number(), z.number()]),
  }),
  analyze: z.object({
    stille: z.object({ noise_db: z.number(), min_s: z.number() }),
    leise_bereiche: z.object({ noise_db: z.number(), min_s: z.number() }),
    szenenwechsel: z.object({ schwelle: z.number() }),
    vorgeschnitten_ab_harten_schnitten: z.object({ anzahl: z.number().int() }),
    lautheit_fenster_s: z.number().positive(),
  }),
  transcribe: z.object({
    language: z.string(),
    wortgrenzen_an_stille_anpassen: z.boolean(),
    min_wortdauer_s: z.number().positive(),
    vokabel_hinweis: z.array(z.string()),
  }),
  schnitt: z.object({
    min_pause_s: z.number().positive(),
    luft_rand_s: z.number().nonnegative(),
    audio_fade_ms: z.number().nonnegative(),
    min_fragment_frames: z.number().int().positive(),
  }),
});
export type StyleParams = z.infer<typeof StyleParams>;
