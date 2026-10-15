import { z } from "zod";

export const Confidence = z.enum(["hoch", "mittel", "niedrig"]);
export type Confidence = z.infer<typeof Confidence>;

/** Jede Entscheidung im Plan trägt Grund und Confidence. */
export const decisionFields = {
  reason: z.string().min(3, "reason darf nicht leer sein"),
  confidence: Confidence,
};

export const seconds = z.number().finite().nonnegative();
