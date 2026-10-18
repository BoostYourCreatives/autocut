import type { Plan } from "../schema/plan.ts";

export interface CaptionEdit {
  id: number;
  text?: string;
  /** Neue Zeiten in Sekunden der Ausgabe (werden auf ganze Bilder gerundet) */
  start_s?: number;
  end_s?: number;
}

export interface CaptionEditResult {
  plan: Plan;
  changed: number;
  /** Alte Zeitbereiche (Sekunden) der geänderten Untertitel: dort muss die Text-Ebene ebenfalls neu gerendert werden */
  oldRangesS: [number, number][];
}

/** Ändert Text und/oder Zeiten einzelner Untertitel. Animation und Layout bleiben; bei Wort-Animation werden die Wort-Einsätze angepasst. */
export function applyCaptionEdits(plan: Plan, edits: CaptionEdit[]): CaptionEditResult {
  let changed = 0;
  const oldRangesS: [number, number][] = [];
  const fps = plan.source.fps;
  const q = (t: number) => Math.round(t * fps) / fps;
  for (const e of edits) {
    const c = plan.captions.find((x) => x.id === e.id);
    if (!c) continue;
    const before: [number, number] = [c.start_s, c.end_s];
    let did = false;
    const text = e.text === undefined ? undefined : e.text.replace(/\s+/g, " ").trim();
    if (text && text !== c.text) {
      c.text = text;
      c.word_offsets_frames = wordOffsets(c, text);
      did = true;
    }
    const s = e.start_s === undefined ? c.start_s : q(e.start_s);
    const en = e.end_s === undefined ? c.end_s : q(e.end_s);
    if (Math.abs(s - c.start_s) > 1e-6 || Math.abs(en - c.end_s) > 1e-6) {
      c.start_s = s;
      c.end_s = en;
      did = true;
    }
    if (did) {
      c.edited = true;
      oldRangesS.push(before);
      changed++;
    }
  }
  return { plan, changed, oldRangesS };
}

/** Wort-Einsätze für einen geänderten Text: gleiche Wortzahl = Einsätze behalten, sonst gleichmäßig zwischen erstem und letztem Einsatz verteilen. */
export function wordOffsets(c: { word_offsets_frames?: [string, number][] }, text: string): [string, number][] | undefined {
  const old = c.word_offsets_frames;
  if (!old?.length) return old;
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const last = old[old.length - 1]![1];
  return words.map((w, i) => [w, words.length === old.length ? old[i]![1] : words.length === 1 ? 0 : Math.round((last * i) / (words.length - 1))] as [string, number]);
}

/** Hook-Text ändern (2 Zeilen, in Versalien). Gibt den Zeitbereich der Hook-Box zurück, der neu gerendert werden muss, sonst null. */
export function applyHookEdit(plan: Plan, lines: [string, string]): [number, number] | null {
  if (!plan.hook) return null;
  const up = lines.map((l) => l.replace(/\s+/g, " ").trim().toUpperCase()) as [string, string];
  if (!up[0] || !up[1] || (up[0] === plan.hook.lines[0] && up[1] === plan.hook.lines[1])) return null;
  plan.hook.lines = up;
  plan.hook.text_origin = "user";
  const box = plan.overlays.find((o) => o.type === "hook_box");
  if (box && box.type === "hook_box") {
    box.lines = up;
    return [box.start_s, box.end_s];
  }
  return null;
}
