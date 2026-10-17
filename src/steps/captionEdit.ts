import type { Plan } from "../schema/plan.ts";

export interface CaptionEdit {
  id: number;
  text: string;
}

/** Ändert nur den Text einzelner Untertitel. Zeiten, Animation und Layout bleiben; bei Wort-Animation werden die Wort-Einsätze angepasst. */
export function applyCaptionEdits(plan: Plan, edits: CaptionEdit[]): { plan: Plan; changed: number } {
  let changed = 0;
  for (const e of edits) {
    const c = plan.captions.find((x) => x.id === e.id);
    const text = e.text.replace(/\s+/g, " ").trim();
    if (!c || !text || text === c.text) continue;
    c.text = text;
    c.edited = true;
    c.word_offsets_frames = wordOffsets(c, text);
    changed++;
  }
  return { plan, changed };
}

/** Wort-Einsätze für einen geänderten Text: gleiche Wortzahl = Einsätze behalten, sonst gleichmäßig zwischen erstem und letztem Einsatz verteilen. */
export function wordOffsets(c: { word_offsets_frames?: [string, number][] }, text: string): [string, number][] | undefined {
  const old = c.word_offsets_frames;
  if (!old?.length) return old;
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const last = old[old.length - 1]![1];
  return words.map((w, i) => [w, words.length === old.length ? old[i]![1] : words.length === 1 ? 0 : Math.round((last * i) / (words.length - 1))] as [string, number]);
}
