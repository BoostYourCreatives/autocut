import type { Caption } from "../schema/plan.ts";
import type { StyleParams } from "../schema/style.ts";

export interface CaptionGeometry {
  id: number;
  size: number;
  baseline: number;
  yCenter: number;
  /** Oberkante des Textes (Näherung: Grundlinie − Faktor × Größe) */
  top: number;
  font: "weiss" | "gold";
  /** Konturdicke in px (nur CTA) */
  stroke: number;
}

const fontOf = (c: Caption): "weiss" | "gold" => (c.font === "Helvetica-Bold" ? "weiss" : "gold");

/** Schriftgröße für Gold-Pops nach Zeichenzahl (Staffel aus params.json). */
export function goldSize(text: string, L: StyleParams["layout"], base?: number): number {
  const n = text.replace(/["„“”]/g, "").length;
  let size = base ?? L.gold.size_standard;
  if (base === undefined) {
    for (const [maxChars, s] of L.gold.groessen_nach_zeichen) {
      if (n <= maxChars) {
        size = s;
        break;
      }
    }
  }
  return size;
}

/** Zeilenbreite (Näherung: 0,56 em je Zeichen + Laufweite); zu breite Zeilen werden proportional verkleinert. */
export function fitSize(text: string, size: number, letterSpacingEm: number, maxWidth: number): number {
  const w = text.length * size * (0.56 + letterSpacingEm);
  return w > maxWidth ? Math.floor((size * maxWidth) / w) : size;
}

/** Position und Größe aller Einblendungen. DY = Verschiebung nach unten aus der Kinn-Messung. */
export function layoutCaptions(captions: Caption[], P: StyleParams, DY: number): Map<number, CaptionGeometry> {
  const L = P.layout;
  const out = new Map<number, CaptionGeometry>();
  const itemIndex = new Map<string, number>();
  for (const c of captions) {
    const font = fontOf(c);
    const K = L.schrift[font].K;
    const ls = L.schrift[font].letter_spacing_em;
    let size = L.weiss.size;
    let baseline = L.weiss.baseline;
    let stroke = 0;
    switch (c.layout) {
      case "solo":
        if (c.kind === "weiss") {
          size = L.weiss.size;
          baseline = L.weiss.baseline;
        } else if (c.kind === "zitat") {
          size = L.zitat.size;
          baseline = L.weiss.baseline + L.zitat.baseline_zuschlag;
        } else if (c.kind === "cta") {
          size = L.cta.size;
          baseline = L.cta.baseline;
          stroke = L.cta.kontur_px;
        } else {
          size = goldSize(c.text, L);
          baseline = L.weiss.baseline + (c.animation === "wipe" ? 0 : L.gold.baseline_zuschlag);
        }
        break;
      case "stack_oben":
        size = L.weiss.size;
        baseline = L.stack.zeile1_baseline;
        break;
      case "stack_gold":
        size = Math.min(L.stack.gold_size_standard, goldSize(c.text, L));
        baseline = L.stack.gold_baseline;
        break;
      case "stack_unten":
        size = L.weiss.size;
        baseline = L.stack.zeile3_baseline + (/[gjpqyQ,;]/.test(c.text) ? L.stack.zeile3_unterlaenge_zuschlag : 0);
        break;
      case "liste_kopf":
        size = L.weiss.size;
        baseline = L.weiss.baseline;
        break;
      case "liste_eintrag": {
        const n = itemIndex.get(c.group ?? "") ?? 0;
        itemIndex.set(c.group ?? "", n + 1);
        size = L.liste.eintrag_size;
        baseline = L.weiss.baseline + (L.liste.eintrag_abstaende[Math.min(n, L.liste.eintrag_abstaende.length - 1)] ?? 0);
        break;
      }
    }
    size = fitSize(c.text, size, ls, L.max_breite_px);
    const b = baseline + DY;
    out.set(c.id, { id: c.id, size, baseline: b, yCenter: b - K * size, top: b - L.kinn.oberkante_faktor_cap * size, font, stroke });
  }
  return out;
}
