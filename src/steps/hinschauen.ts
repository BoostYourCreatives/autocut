import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../schema/plan.ts";
import type { ValidationResult } from "../validate/validate.ts";
import type { SelfcheckFile } from "./selfcheck.ts";
import { buildTimeline } from "../plan/timeline.ts";
import { mmssShort } from "../util/fmt.ts";
import { writeJson } from "../util/files.ts";

export interface AttentionItem {
  t_s: number;
  text: string;
  quelle: "plan" | "validator" | "selfcheck";
  /** Sortierung: niedrig vor mittel */
  gewicht: number;
}

const W = { niedrig: 0, mittel: 1, hoch: 2 } as const;

/**
 * "Hier genauer hinschauen": alle Entscheidungen mit mittlerer oder niedriger Confidence,
 * dazu Warnungen des Validators und Befunde des Selfchecks, mit Zeitpunkt im fertigen Video.
 * Keine Freigabehürde, nur ein Hinweis fürs Anschauen.
 */
export function attentionItems(plan: Plan, validation: ValidationResult | null, selfcheck: SelfcheckFile | null): AttentionItem[] {
  const tl = buildTimeline(plan.cut_segments);
  const items: AttentionItem[] = [];
  const add = (t_s: number, text: string, gewicht: number, quelle: AttentionItem["quelle"] = "plan") => items.push({ t_s, text: text.replace(/\s+/g, " ").trim(), quelle, gewicht });
  const low = (c: "hoch" | "mittel" | "niedrig") => c !== "hoch";

  // Zeitpunkt eines entfernten Stücks im fertigen Video = Schnittstelle davor
  const cutTime = (rawFrom: number) => {
    const before = [...tl].reverse().find((s) => s.raw_out_s <= rawFrom + 0.05);
    return before ? before.out_to_s : 0;
  };

  for (const r of plan.removed) {
    if (r.kind === "pause" || r.kind === "leerlauf_anfang" || r.kind === "leerlauf_ende") continue;
    if (low(r.confidence)) add(cutTime(r.raw_from_s), `${labelOf(r.kind)}: ${r.reason}`, W[r.confidence]);
  }
  if (plan.hook) {
    if (plan.hook.text_origin === "generated") add(0, `Hook-Text von Claude formuliert („${plan.hook.lines.join(" / ")}“), bei Bedarf tauschen`, 1.5);
    if (low(plan.hook.confidence)) add(tl[1]?.out_from_s ?? 0, `Hook-Übergang (${plan.hook.transition === "blitz_riser" ? "Blitz mit Riser" : "harter Schnitt"}): ${plan.hook.reason}`, W[plan.hook.confidence]);
  }
  for (const c of plan.captions) if (low(c.confidence) && c.layout !== "stack_oben" && c.layout !== "stack_unten" && c.layout !== "liste_kopf") add(c.start_s, `Hervorhebung „${c.text}“: ${c.reason}`, W[c.confidence]);
  for (const c of plan.text_corrections) if (low(c.confidence)) {
    const cap = plan.captions.find((x) => x.word_idx.includes(c.word_idx));
    add(cap?.start_s ?? 0, `Wort korrigiert zu „${c.text}“: ${c.reason}`, W[c.confidence]);
  }
  for (const z of plan.zooms) if (low(z.confidence)) add(z.start_s, `Zoom auf ${z.to_scale.toString().replace(".", ",")}: ${z.reason}`, W[z.confidence]);
  for (const b of plan.broll) {
    if (b.source.kind === "offen") add(b.start_s, `B-Roll „${b.motif}“ hat noch keine Quelle${b.covers_ai_error ? " (deckt einen KI-Fehler ab, muss ergänzt werden)" : ""}`, b.covers_ai_error ? -1 : 0.5);
    else if (low(b.confidence)) add(b.start_s, `B-Roll „${b.motif}“: ${b.reason}`, W[b.confidence]);
  }
  for (const s of plan.sfx) if (low(s.confidence)) add(Math.max(0, s.at_s), `Soundeffekt ${s.file}: ${s.reason}`, W[s.confidence]);

  for (const w of validation?.warnings ?? []) {
    if (["broll_quelle_offen", "gold_anzahl", "zoom_anzahl", "broll_anzahl", "fuwa_stark_anzahl", "fuwa_leise_anzahl", "money_anzahl"].includes(w.code)) {
      if (w.code !== "broll_quelle_offen") add(0, `Abweichung von der Regel: ${w.message}`, 0.8, "validator");
      continue;
    }
    add(w.t_s ?? 0, w.message, 0.8, "validator");
  }
  for (const b of selfcheck?.result?.befunde ?? []) add(b.t_s, `Selfcheck (${b.art.replace("_", " ")}): ${b.beschreibung}`, b.schwere === "fehler" ? -2 : 0.2, "selfcheck");

  return items.sort((a, b) => a.t_s - b.t_s || a.gewicht - b.gewicht);
}

function labelOf(kind: string): string {
  return ({ versprecher: "Versprecher entfernt", abbruch: "Abbruch entfernt", wiederholung: "Wiederholung entfernt", fuellwort: "Füllwort entfernt", atmer: "Atmer entfernt" } as Record<string, string>)[kind] ?? kind;
}

export function formatAttention(video: string, items: AttentionItem[], max = 30): string {
  const lines = items.slice(0, max).map((i) => `- ${mmssShort(i.t_s)} – ${i.text}`);
  const rest = items.length - lines.length;
  return [
    `# Hier genauer hinschauen: ${video}`,
    "",
    items.length ? "Das sind Stellen, bei denen die Pipeline unsicher war oder etwas auffiel. Keine Freigabe nötig, nur ein Hinweis fürs Anschauen." : "Keine auffälligen Stellen.",
    "",
    ...lines,
    ...(rest > 0 ? ["", `… und ${rest} weitere (siehe plan.json, Felder confidence).`] : []),
    "",
  ].join("\n");
}

export function writeAttention(outDir: string, video: string, items: AttentionItem[]): string {
  const file = path.join(outDir, `${video}.hinschauen.md`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, formatAttention(video, items));
  writeJson(path.join(outDir, `${video}.hinschauen.json`), items);
  return file;
}
