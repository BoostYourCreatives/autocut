import { z } from "zod";
import { decisionFields, seconds } from "./common.ts";
import { ClipRole } from "./ingest.ts";

/**
 * Editing-Plan. Wird immer als Datei gespeichert (runs/<run>/plan.json) und ist
 * die einzige Eingabe für den Render-Schritt ("rerender <plan>").
 *
 * Zeitbezüge:
 *  - raw_*  = Zeit im Rohmaterial (Sekunden)
 *  - sonst  = Zeit im fertigen Video (Ausgabe-Timeline, Sekunden)
 *  - word_idx verweist auf Wörter in transcript.json (Feld i)
 *
 * Layout (Position, Größe, Schatten, Farben) steht NICHT im Plan, sondern kommt
 * zur Renderzeit aus style.json / params.json.
 */

export const RemovalKind = z.enum([
  "pause",
  "atmer",
  "versprecher",
  "abbruch",
  "wiederholung",
  "fuellwort",
  "leerlauf_anfang",
  "leerlauf_ende",
]);
export type RemovalKind = z.infer<typeof RemovalKind>;

/** Behaltenes Stück Rohmaterial. Die Reihenfolge im Array ist die Reihenfolge im Video. */
export const CutSegment = z.object({
  id: z.number().int().nonnegative(),
  raw_in_s: seconds,
  raw_out_s: seconds,
  ...decisionFields,
});

/** Entferntes Stück Rohmaterial, mit Grund. */
export const Removal = z.object({
  kind: RemovalKind,
  raw_from_s: seconds,
  raw_to_s: seconds,
  word_idx: z.array(z.number().int().nonnegative()).default([]),
  /** Bei Wiederholung: welcher Take behalten wurde */
  kept_alternative: z
    .object({ raw_from_s: seconds, raw_to_s: seconds })
    .optional(),
  ...decisionFields,
});

export const Hook = z.object({
  /** Letztes Wort des Hooks (Index in transcript.json) */
  end_word_idx: z.number().int().nonnegative(),
  /** Ende des Hooks im Rohmaterial (= Ende des ersten Satzes bzw. gesetzter Schnittpunkt) */
  end_raw_s: seconds,
  /** Hook-Box: genau 2 Zeilen, wird im Render in Versalien gesetzt */
  lines: z.tuple([z.string().min(1), z.string().min(1)]),
  text_origin: z.enum(["user", "generated"]),
  /**
   * Übergang am Hook-Ende. "blitz_riser" = Gold-Blitz + Camera Shutter + Riser,
   * "hart" = harter Schnitt ohne Blitz/Shutter/Riser. Hook-Box und KI-Hinweis enden
   * in beiden Fällen am Hook-Ende.
   */
  transition: z.enum(["blitz_riser", "hart"]),
  /** Kamera-Push über die Hook-Dauer (false bei vorgeschnittenem Material) */
  push: z.boolean(),
  ...decisionFields,
});

export const CaptionKind = z.enum(["weiss", "gold", "zitat", "cta"]);
export const CaptionAnimation = z.enum(["mini", "words", "pop", "slide", "rise", "wipe"]);
export const CaptionLayout = z.enum([
  "solo",
  "stack_oben",
  "stack_gold",
  "stack_unten",
  "liste_kopf",
  "liste_eintrag",
]);

export const Caption = z.object({
  id: z.number().int().nonnegative(),
  text: z.string().min(1),
  kind: CaptionKind,
  animation: CaptionAnimation,
  layout: CaptionLayout.default("solo"),
  /** Gruppenname für zusammengehörige Einblendungen (Stack/Liste) */
  group: z.string().nullable().default(null),
  word_idx: z.array(z.number().int().nonnegative()).min(1),
  start_s: seconds,
  end_s: seconds,
  /** Schrift/Farbe sind aus kind abgeleitet; der Validator prüft die Kombination */
  font: z.enum(["Helvetica-Bold", "SegoePro-BoldItalic"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Nur animation "words": Frame-Offset je Wort relativ zum Start der Einblendung */
  word_offsets_frames: z.array(z.tuple([z.string(), z.number().int().nonnegative()])).optional(),
  ...decisionFields,
});

/** Korrektur eines Transkriptionsfehlers: der Untertitel zeigt `text` statt des Transkriptworts. */
export const TextCorrection = z.object({
  word_idx: z.number().int().nonnegative(),
  text: z.string().min(1),
  ...decisionFields,
});

export const Zoom = z.object({
  /** Segment, in dem gezoomt wird (max. 1 Zoom pro Segment) */
  segment_id: z.number().int().nonnegative(),
  start_s: seconds,
  to_scale: z.number().min(1.01).max(1.2),
  ...decisionFields,
});

export const SfxRole = z.enum(["riser", "shutter", "fuwa", "money", "ding", "sonstiges"]);
export const Sfx = z.object({
  role: SfxRole,
  /** Dateiname bzw. relativer Pfad innerhalb der SFX-Library (gegen den Index geprüft) */
  file: z.string().min(1),
  at_s: z.number().finite(),
  gain_db: z.number().max(0),
  /** Nur Riser */
  peak_at_s: seconds.optional(),
  trim_end_at_s: seconds.optional(),
  fade_out_ms: z.number().nonnegative().optional(),
  ...decisionFields,
});

export const Overlay = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hook_box"),
    start_s: seconds,
    end_s: seconds,
    lines: z.tuple([z.string(), z.string()]),
    ...decisionFields,
  }),
  z.object({
    type: z.literal("ki_hinweis"),
    start_s: seconds,
    end_s: seconds,
    text: z.string(),
    ...decisionFields,
  }),
]);

export const BrollSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_clip"), path: z.string() }),
  z.object({ kind: z.literal("stock_ordner"), path: z.string() }),
  z.object({ kind: z.literal("canva"), ref: z.string() }),
  z.object({ kind: z.literal("standbild_prompt"), prompt: z.string() }),
  /** Slot ist geplant, aber noch kein Clip gefunden (Prototyp: kein Auto-Sourcing) */
  z.object({ kind: z.literal("offen"), suche: z.string() }),
]);

export const BrollSlot = z.object({
  id: z.number().int().nonnegative(),
  start_s: seconds,
  end_s: seconds,
  source: BrollSource,
  /** Was wörtlich im Bild zu sehen sein soll (Regel: B-Roll passt wörtlich zur Stelle) */
  motif: z.string().min(2),
  word_idx: z.array(z.number().int().nonnegative()).default([]),
  shade_alpha: z.number().min(0).max(1),
  /** Deckt einen KI-Fehler im Rohvideo ab (Pflichtabdeckung) */
  covers_ai_error: z.boolean().default(false),
  ...decisionFields,
});

export const Plan = z
  .object({
    schema_version: z.literal(1),
    video: z.string(),
    role: ClipRole,
    style: z.string(),
    source: z.object({
      clip: z.string(),
      file: z.string(),
      fps: z.number().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      duration_s: seconds,
    }),
    /** Material vom User vorgeschnitten/gezoomt: keine eigenen Pausenschnitte/Zooms */
    precut: z.boolean(),
    hook: Hook.nullable(),
    cut_segments: z.array(CutSegment).min(1),
    removed: z.array(Removal),
    text_corrections: z.array(TextCorrection).default([]),
    captions: z.array(Caption),
    zooms: z.array(Zoom),
    sfx: z.array(Sfx),
    overlays: z.array(Overlay),
    broll: z.array(BrollSlot),
    notes: z.array(z.string()).default([]),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<number>();
    p.cut_segments.forEach((s, idx) => {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["cut_segments", idx, "id"], message: `Segment-ID ${s.id} doppelt` });
      }
      ids.add(s.id);
      if (s.raw_out_s <= s.raw_in_s) {
        ctx.addIssue({ code: "custom", path: ["cut_segments", idx], message: "raw_out_s muss größer als raw_in_s sein" });
      }
    });
    p.captions.forEach((c, idx) => {
      if (c.end_s <= c.start_s) {
        ctx.addIssue({ code: "custom", path: ["captions", idx], message: "end_s muss größer als start_s sein" });
      }
    });
    p.zooms.forEach((z, idx) => {
      if (!ids.has(z.segment_id)) {
        ctx.addIssue({ code: "custom", path: ["zooms", idx, "segment_id"], message: `Segment ${z.segment_id} existiert nicht` });
      }
    });
  });

export type Plan = z.infer<typeof Plan>;
export type CutSegment = z.infer<typeof CutSegment>;
export type Removal = z.infer<typeof Removal>;
export type Caption = z.infer<typeof Caption>;
export type Zoom = z.infer<typeof Zoom>;
export type Sfx = z.infer<typeof Sfx>;
export type BrollSlot = z.infer<typeof BrollSlot>;
export type Overlay = z.infer<typeof Overlay>;
export type Hook = z.infer<typeof Hook>;
