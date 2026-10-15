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
  layout: z.object({
    schrift: z.object({
      weiss: z.object({ datei: z.string(), familie: z.string(), fallback: z.string(), K: z.number(), letter_spacing_em: z.number(), gewicht: z.number(), kursiv: z.boolean() }),
      gold: z.object({ datei: z.string(), familie: z.string(), fallback: z.string(), K: z.number(), letter_spacing_em: z.number(), gewicht: z.number(), kursiv: z.boolean() }),
      ki: z.object({ datei: z.string(), familie: z.string(), fallback: z.string() }),
    }),
    max_breite_px: z.number(),
    weiss: z.object({ size: z.number(), baseline: z.number() }),
    gold: z.object({ size_standard: z.number(), groessen_nach_zeichen: z.array(z.tuple([z.number(), z.number()])), baseline_zuschlag: z.number() }),
    zitat: z.object({ size: z.number(), baseline_zuschlag: z.number() }),
    stack: z.object({ zeile1_baseline: z.number(), gold_baseline: z.number(), zeile3_baseline: z.number(), zeile3_unterlaenge_zuschlag: z.number(), gold_size_standard: z.number() }),
    liste: z.object({ eintrag_abstaende: z.array(z.number()), eintrag_size: z.number() }),
    cta: z.object({ size: z.number(), baseline: z.number(), kontur_px: z.number() }),
    wipe: z.object({ frames: z.number(), maske_padding: z.string(), kante_prozent: z.number() }),
    animation: z.object({
      mini: z.object({ scale_von: z.number(), frames: z.number() }),
      pop: z.object({ frames: z.array(z.number()), scale: z.array(z.number()), opacity_von: z.number() }),
      slide: z.object({ x_von: z.number(), frames_x: z.number(), frames_opacity: z.number() }),
      rise: z.object({ y_von: z.number(), frames_y: z.number(), frames_opacity: z.number() }),
      words: z.object({ opacity_von: z.number(), scale_von: z.number(), frames: z.number() }),
    }),
    schatten: z.object({ weiss: z.string(), gold: z.string(), ki: z.string() }),
    hook_box: z.object({ top: z.number(), radius: z.number(), padding: z.array(z.number()), size: z.number(), zeilenhoehe: z.number(), letter_spacing_em: z.number(), farbe_text: z.string(), farbe_hintergrund: z.string() }),
    ki_hinweis: z.object({ size: z.number(), y_mitte: z.number(), letter_spacing_em: z.number() }),
    b_roll: z.object({ zoom_von: z.number(), zoom_bis: z.number(), origin: z.array(z.number()), shade_cy: z.number(), shade_ellipse: z.array(z.number()), shade_einblenden_frames: z.number() }),
    blitz: z.object({
      halbe_dauer_frames: z.number(),
      warm_frames: z.array(z.number()), warm_opacity: z.array(z.number()),
      weiss_frames: z.array(z.number()), weiss_opacity: z.array(z.number()),
      warm_verlauf: z.string(), weiss_verlauf: z.string(),
    }),
    kamera: z.object({ ease: z.string(), hook_push_ab_frame: z.number() }),
    kinn: z.object({ mindestabstand_px: z.number(), messung_jedes_n_frame: z.number().int(), oberkante_faktor_cap: z.number(), dy_ersatz_ohne_messung: z.number() }),
  }),
  export: z.object({
    zwischen: z.object({ codec: z.string(), crf: z.number() }),
    final: z.object({ codec: z.string(), bitrate_kbps: z.number(), pass: z.number(), preset: z.string(), tag: z.string(), audio_codec: z.string(), audio_kbps: z.number(), max_mb: z.number() }),
    lautheit: z.object({ i: z.number(), tp: z.number(), lra: z.number() }),
  }),
  selfcheck: z.object({ frame_abstand_s: z.number(), bildbreite_px: z.number().int(), max_bilder: z.number().int(), modell_effort: z.enum(["low", "medium", "high", "xhigh", "max"]) }),
  plan: z.object({ claude_effort: z.enum(["low", "medium", "high", "xhigh", "max"]), max_tokens: z.number().int() }),
  schnitt: z.object({
    min_pause_s: z.number().positive(),
    luft_rand_s: z.number().nonnegative(),
    audio_fade_ms: z.number().nonnegative(),
    min_fragment_frames: z.number().int().positive(),
  }),
});
export type StyleParams = z.infer<typeof StyleParams>;
