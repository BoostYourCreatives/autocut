import type { PlanDraft } from "../../src/plan/draft.ts";
const d = (reason: string, confidence: "hoch" | "mittel" | "niedrig" = "hoch") => ({ reason, confidence });
const nul = { above_from_word_idx: null, above_to_word_idx: null, below_from_word_idx: null, below_to_word_idx: null };

/** Vorgeschnittenes Material (Reel 48): keine Entfernungen, keine Zooms. */
export const draftReel48: PlanDraft = {
  hook: { end_word_idx: 18, lines: ["3 Fragen für jeden", "der investieren möchte"], transition: "blitz_riser", ...d("Hook endet mit „stellen.“, danach folgt „Erstens“: Abschnitt beginnt") },
  removals: [],
  text_corrections: [],
  quotes: [],
  gold: [
    { style: "pop", gold_from_word_idx: 7, gold_to_word_idx: 10, ...nul, ...d("Zeitraum im Hook") },
    { style: "pop", gold_from_word_idx: 16, gold_to_word_idx: 17, ...nul, ...d("Zahl der Fragen") },
    { style: "stack", gold_from_word_idx: 24, gold_to_word_idx: 24, above_from_word_idx: 20, above_to_word_idx: 23, below_from_word_idx: 25, below_to_word_idx: 27, ...d("Inflation als Kernbegriff") },
    { style: "wipe", gold_from_word_idx: 88, gold_to_word_idx: 88, ...nul, ...d("Kernbegriff Schwachstellen") },
  ],
  lists: [],
  zooms: [{ word_idx: 50, to_scale: 1.1, ...d("Wendepunkt") }],
  broll: [
    { from_word_idx: 30, to_word_idx: 37, motif: "Geldscheine verlieren an Wert, Kaufkraft", covers_ai_error: false, ...d("Wörtlich: Kaufkraftverlust", "mittel") },
    { from_word_idx: 44, to_word_idx: 49, motif: "Aktienkurs fällt, Immobilie", covers_ai_error: false, ...d("Wörtlich: Aktien oder Immobilien", "niedrig") },
  ],
  sfx: [
    { word_idx: 16, kind: "fuwa_stark", ...d("Gold im Hook") },
    { word_idx: 24, kind: "fuwa_leise", ...d("Stack") },
    { word_idx: 35, kind: "money", ...d("Kaufkraft") },
  ],
  cta: { keyword_word_idx: 122, ...d("Kommentier mit Freiheitstraining") },
  notes: [],
};
