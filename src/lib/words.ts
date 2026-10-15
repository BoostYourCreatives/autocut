import type { Span } from "./intervals.ts";
import { round3 } from "./intervals.ts";
import type { TranscriptWord } from "../schema/transcript.ts";

export interface RawWord {
  word: string;
  start_s: number;
  end_s: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Whisper-API liefert Wörter ohne Satzzeichen, der Fließtext hat sie.
 * Überträgt Satzzeichen aus `text` auf die Wörter (greedy, tolerant bei Abweichungen).
 */
export function attachPunctuation(words: RawWord[], text: string): RawWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  let j = 0;
  return words.map((w) => {
    const target = norm(w.word);
    if (!target) return w;
    for (let k = j; k < Math.min(tokens.length, j + 3); k++) {
      if (norm(tokens[k]!) === target) {
        j = k + 1;
        return { ...w, word: tokens[k]! };
      }
    }
    return w;
  });
}

/**
 * Setzt Wortgrenzen an Stillen: ein Wortanfang in einer Stille rückt ans Stilleende,
 * ein Wortende in einer Stille rückt an den Stillebeginn. Danach wird die Zeitleiste
 * monoton gemacht (keine Überlappungen). Wörter, die dadurch kürzer als minWordS
 * würden, behalten ihre Originalzeit und werden ggf. als suspect markiert.
 */
export function snapWords(raw: RawWord[], silences: Span[], minWordS: number): TranscriptWord[] {
  const out: TranscriptWord[] = raw.map((w, i) => ({
    i,
    word: w.word.trim(),
    start_s: w.start_s,
    end_s: w.end_s,
  }));

  for (const w of out) {
    let s = w.start_s;
    let e = w.end_s;
    for (const sil of silences) {
      if (s >= sil.start_s && s < sil.end_s) s = sil.end_s;
      if (e > sil.start_s && e <= sil.end_s) e = sil.start_s;
    }
    if (e - s >= minWordS) {
      if (s !== w.start_s || e !== w.end_s) w.snapped = true;
      w.start_s = s;
      w.end_s = e;
    } else if (silences.some((sil) => w.start_s >= sil.start_s && w.end_s <= sil.end_s)) {
      w.suspect = "Wort liegt komplett in einer Stille (evtl. Halluzination des Transkribierers)";
    }
  }

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    if (cur.start_s < prev.end_s) {
      if (cur.start_s >= prev.start_s + minWordS) prev.end_s = cur.start_s;
      else cur.start_s = prev.end_s;
      if (cur.end_s < cur.start_s + minWordS) cur.end_s = cur.start_s + minWordS;
      prev.snapped = cur.snapped = true;
    }
  }

  for (const w of out) {
    w.start_s = round3(w.start_s);
    w.end_s = round3(w.end_s);
  }
  return out;
}
