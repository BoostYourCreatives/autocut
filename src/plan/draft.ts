import { z } from "zod";
import { Confidence } from "../schema/common.ts";

/**
 * PlanDraft = was Claude entscheidet. Alles, was sich aus den Regeln in style.json
 * berechnen lässt (Pausenschnitte, Caption-Gruppierung und -Timing, SFX-Zeitpunkte,
 * Riser/Shutter, Hook-Box-Dauer), baut danach deterministischer Code (finalize.ts).
 *
 * Alle Verweise sind Wortindizes aus transcript.json (Feld `i`).
 * Das Schema ist bewusst flach (nur Objekte, Arrays, Enums), damit es als
 * Structured-Output-Schema akzeptiert wird.
 */
const idx = z.number().int();
const decision = { reason: z.string(), confidence: Confidence };

export const DraftHook = z.object({
  end_word_idx: idx,
  /** Genau 2 Zeilen, zugespitzte These/Frage, NICHT der gesprochene Satz */
  lines: z.array(z.string()),
  transition: z.enum(["blitz_riser", "hart"]),
  ...decision,
});

export const DraftRemoval = z.object({
  kind: z.enum(["versprecher", "abbruch", "wiederholung", "fuellwort"]),
  from_word_idx: idx,
  to_word_idx: idx,
  /** Nur bei Wiederholung: der behaltene Take (sonst null) */
  kept_from_word_idx: idx.nullable(),
  kept_to_word_idx: idx.nullable(),
  ...decision,
});

export const DraftCorrection = z.object({ word_idx: idx, text: z.string(), ...decision });
export const DraftQuote = z.object({ from_word_idx: idx, to_word_idx: idx, ...decision });

export const DraftGold = z.object({
  style: z.enum(["pop", "wipe", "stack"]),
  /** Der goldene Teil */
  gold_from_word_idx: idx,
  gold_to_word_idx: idx,
  /** Nur stack: weiße Zeile oberhalb / unterhalb (sonst null) */
  above_from_word_idx: idx.nullable(),
  above_to_word_idx: idx.nullable(),
  below_from_word_idx: idx.nullable(),
  below_to_word_idx: idx.nullable(),
  ...decision,
});

export const DraftList = z.object({
  head_from_word_idx: idx,
  head_to_word_idx: idx,
  items: z.array(z.object({ from_word_idx: idx, to_word_idx: idx })),
  ...decision,
});

export const DraftZoom = z.object({ word_idx: idx, to_scale: z.number(), ...decision });

export const DraftBroll = z.object({
  from_word_idx: idx,
  to_word_idx: idx,
  /** Was wörtlich im Bild zu sehen ist */
  motif: z.string(),
  covers_ai_error: z.boolean(),
  /** Ausnahme: B-Roll darf länger als 3 s stehen (nur mit Grund in reason) */
  lange_einblendung: z.boolean().optional(),
  ...decision,
});

export const DraftSfx = z.object({
  word_idx: idx,
  kind: z.enum(["fuwa_stark", "fuwa_leise", "money"]),
  ...decision,
});

export const DraftCta = z.object({ keyword_word_idx: idx, ...decision });

export const PlanDraft = z.object({
  hook: DraftHook,
  removals: z.array(DraftRemoval),
  text_corrections: z.array(DraftCorrection),
  quotes: z.array(DraftQuote),
  gold: z.array(DraftGold),
  lists: z.array(DraftList),
  zooms: z.array(DraftZoom),
  broll: z.array(DraftBroll),
  sfx: z.array(DraftSfx),
  /** null, wenn Thorsten keinen CTA spricht */
  cta: DraftCta.nullable(),
  notes: z.array(z.string()),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

const UNSUPPORTED = new Set([
  "$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "default",
]);

/** JSON-Schema für output_config.format: nicht unterstützte Schlüsselwörter entfernen, additionalProperties:false. */
export function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (UNSUPPORTED.has(k)) continue;
        o[k] = walk(v);
      }
      if (o.type === "object" && o.properties) o.additionalProperties = false;
      return o;
    }
    return n;
  };
  return walk(raw) as Record<string, unknown>;
}
