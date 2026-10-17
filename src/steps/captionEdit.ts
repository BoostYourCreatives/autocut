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
    if (c.word_offsets_frames?.length) {
      const words = text.split(" ");
      const old = c.word_offsets_frames;
      const last = old[old.length - 1]![1];
      c.word_offsets_frames = words.map((w, i) => {
        // gleiche Wortzahl: Einsätze behalten; sonst gleichmäßig zwischen erstem und letztem Einsatz verteilen
        const off = words.length === old.length ? old[i]![1] : words.length === 1 ? 0 : Math.round((last * i) / (words.length - 1));
        return [w, off] as [string, number];
      });
    }
    changed++;
  }
  return { plan, changed };
}
