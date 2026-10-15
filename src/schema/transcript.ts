import { z } from "zod";
import { seconds } from "./common.ts";

export const TranscriptWord = z.object({
  i: z.number().int().nonnegative(),
  start_s: seconds,
  end_s: seconds,
  word: z.string().min(1),
  /** true, wenn start/end an eine Stille angepasst wurde */
  snapped: z.boolean().optional(),
  /** Hinweis, wenn das Wort auffällig ist (z. B. komplett in einer Stille) */
  suspect: z.string().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.object({
  clip: z.string(),
  language: z.string(),
  provider: z.string(),
  model: z.string(),
  duration_s: seconds,
  words: z.array(TranscriptWord),
  text: z.string(),
});
export type Transcript = z.infer<typeof Transcript>;
