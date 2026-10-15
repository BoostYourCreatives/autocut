import type { PlanDraft } from "../../src/plan/draft.ts";

const d = (reason: string, confidence: "hoch" | "mittel" | "niedrig" = "hoch") => ({ reason, confidence });
const nul = { above_from_word_idx: null, above_to_word_idx: null, below_from_word_idx: null, below_to_word_idx: null };

/** Entwurf, wie Claude ihn für Reel 53 liefern sollte (orientiert an der Beispiel-Datei des Users). */
export const draftReel53: PlanDraft = {
  hook: { end_word_idx: 13, lines: ["Warum Europa wirtschaftlich", "zurückfallen könnte"], transition: "blitz_riser", ...d("Erster Satz endet bei „ab.“, danach Pause; geschlossene These, neuer Abschnitt folgt") },
  removals: [],
  text_corrections: [],
  quotes: [],
  gold: [
    { style: "pop", gold_from_word_idx: 9, gold_to_word_idx: 12, ...nul, ...d("Länder im Hook als Schlagwort") },
    { style: "stack", gold_from_word_idx: 31, gold_to_word_idx: 31, above_from_word_idx: 27, above_to_word_idx: 30, below_from_word_idx: 32, below_to_word_idx: 33, ...d("Kernaussage Investitionen") },
    { style: "pop", gold_from_word_idx: 45, gold_to_word_idx: 45, ...nul, ...d("Schlagwort") },
    { style: "stack", gold_from_word_idx: 56, gold_to_word_idx: 57, above_from_word_idx: 53, above_to_word_idx: 55, below_from_word_idx: 58, below_to_word_idx: 58, ...d("Kernaussage Kapitalströme") },
    { style: "pop", gold_from_word_idx: 64, gold_to_word_idx: 65, ...nul, ...d("Frage an den Zuschauer") },
    { style: "pop", gold_from_word_idx: 74, gold_to_word_idx: 78, ...nul, ...d("Länder-Nennung") },
    { style: "stack", gold_from_word_idx: 85, gold_to_word_idx: 85, above_from_word_idx: 81, above_to_word_idx: 84, below_from_word_idx: null, below_to_word_idx: null, ...d("ETF als Kernbegriff") },
    { style: "wipe", gold_from_word_idx: 105, gold_to_word_idx: 105, ...nul, ...d("Kernbegriff Wirtschaftsregionen", "mittel") },
  ],
  lists: [],
  zooms: [
    { word_idx: 23, to_scale: 1.1, ...d("Wendepunkt: Süden gewinnt Bedeutung") },
    { word_idx: 48, to_scale: 1.1, ...d("Folgerung") },
    { word_idx: 59, to_scale: 1.12, ...d("Gegenfrage: Was bedeutet das für dein Vermögen") },
    { word_idx: 94, to_scale: 1.1, ...d("Einordnung") },
    { word_idx: 117, to_scale: 1.15, ...d("Stärkste Aussage im CTA") },
  ],
  broll: [
    { from_word_idx: 27, to_word_idx: 37, motif: "Baustelle mit Kränen, neue Infrastruktur", covers_ai_error: false, ...d("Wörtlich: Infrastruktur und Produktionsanlagen") },
    { from_word_idx: 81, to_word_idx: 85, motif: "ETF-Kursverlauf auf einem Bildschirm", covers_ai_error: false, ...d("Wörtlich: ETF", "mittel") },
  ],
  sfx: [
    { word_idx: 12, kind: "fuwa_stark", ...d("Gold-Moment im Hook") },
    { word_idx: 27, kind: "fuwa_stark", ...d("Beginn B-Roll/Stack") },
    { word_idx: 49, kind: "fuwa_stark", ...d("Folgerung") },
    { word_idx: 75, kind: "fuwa_stark", ...d("Länder") },
    { word_idx: 43, kind: "fuwa_leise", ...d("Nebenmoment") },
    { word_idx: 58, kind: "fuwa_leise", ...d("Nebenmoment") },
    { word_idx: 92, kind: "fuwa_leise", ...d("Nebenmoment") },
    { word_idx: 72, kind: "money", ...d("Geld/Investments") },
  ],
  cta: { keyword_word_idx: 112, ...d("Thorsten sagt „Kommentier mit Freiheitstraining“") },
  notes: [],
};
