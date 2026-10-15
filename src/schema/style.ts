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
  hook_uebergang: z.object({
    modus_standard: z.enum(["auto", "blitz_riser", "hart"]),
    erlaubt: z.array(z.enum(["blitz_riser", "hart"])),
  }),
  captions: z.object({
    merge: z.object({
      min_anzeige_s: z.number(),
      funktionswort_max_anzeige_s: z.number(),
      max_zeichen: z.number().int(),
      funktionswoerter: z.array(z.string()),
    }),
    timing: z.object({
      start_vorlauf_frames: z.number().int(),
      nachlauf_luecke_s: z.number(),
      nachlauf_s: z.number(),
      wipe_vorlauf_frames: z.number().int(),
    }),
    min_frames: z.number().int(),
    ende_nach_letztem_wort_s: z.number(),
    cta: z.object({ erkennung_woerter: z.array(z.string()) }),
  }),
  zoom: z.object({
    erlaubte_werte: z.array(z.number()),
    rampe_frames: z.number().int(),
    max_schritt_pro_frame: z.number(),
    anzahl: z.object({ min: z.number().int(), max: z.number().int() }),
    hook_push_nach: z.number(),
  }),
  sfx: z.object({
    verboten_muster: z.array(z.string()),
    cues: z.object({
      riser: z.object({ file: z.string(), gain_db: z.number(), peak_im_file_s: z.number(), ende_nach_blitz_s: z.number(), fade_out_ms: z.number() }),
      shutter: z.object({ file: z.string(), gain_db: z.number(), versatz_s: z.number() }),
      fuwa_stark: z.object({ file: z.string(), gain_db: z.number(), versatz_s: z.number(), anzahl: z.object({ min: z.number(), max: z.number() }) }),
      fuwa_leise: z.object({ file: z.string(), gain_db: z.number(), versatz_s: z.number(), anzahl: z.object({ min: z.number(), max: z.number() }) }),
      money: z.object({ file: z.string(), gain_db: z.number(), versatz_s: z.number(), anzahl: z.object({ min: z.number(), max: z.number() }) }),
      ding: z.object({ file: z.string(), gain_db: z.number(), versatz_s: z.number() }),
    }),
  }),
  broll: z.object({
    anzahl: z.object({ min: z.number().int(), max: z.number().int() }),
    shade_alpha: z.number(),
    shade_alpha_hell: z.number(),
    vorlauf_frames: z.number().int(),
    nachlauf_s: z.number(),
  }),
  hook: z.object({
    zeilen: z.number().int(),
    ki_text: z.string(),
    max_zeichen_zeile: z.number().int(),
    min_luecke_s: z.number(),
  }),
  farben: z.object({ weiss: z.string(), gold: z.string(), erlaubt: z.array(z.string()) }),
  schriften: z.object({ weiss: z.string(), gold: z.string(), zitat: z.string(), cta: z.string() }),
  gold: z.object({ anzahl: z.object({ min: z.number().int(), max: z.number().int() }) }),
  validator: z.object({
    tonsprung_warn_db: z.number(),
    tonsprung_fehler_db: z.number(),
    wortrand_toleranz_s: z.number(),
    max_entfernt_sprechanteil: z.number(),
    min_laenge_verhaeltnis: z.number(),
    min_laenge_verhaeltnis_vorgeschnitten: z.number(),
  }),
  plan: z.object({ claude_effort: z.enum(["low", "medium", "high", "xhigh", "max"]), max_tokens: z.number().int() }),
  schnitt: z.object({
    min_pause_s: z.number().positive(),
    luft_rand_s: z.number().nonnegative(),
    audio_fade_ms: z.number().nonnegative(),
    min_fragment_frames: z.number().int().positive(),
  }),
});
export type StyleParams = z.infer<typeof StyleParams>;
