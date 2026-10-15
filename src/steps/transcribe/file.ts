import fs from "node:fs";
import type { RawWord } from "../../lib/words.ts";
import type { ProviderResult } from "./openai.ts";

/**
 * Liest Wörter aus einer JSON-Datei. Akzeptiert:
 *  - [{word,start_s,end_s}] oder [{word,start,end}]
 *  - {words:[...]} oder {transcript_words:[...]} (z. B. ein Beispielplan)
 * Nützlich für Tests und für manuell korrigierte Transkripte.
 */
export function transcribeFromFile(file: string, language: string, durationHint: number): ProviderResult {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr: any[] = Array.isArray(j) ? j : (j.words ?? j.transcript_words);
  if (!Array.isArray(arr)) throw new Error(`${file}: weder Array noch {words|transcript_words}`);
  const words: RawWord[] = arr.map((w, idx) => {
    const start = w.start_s ?? w.start;
    const end = w.end_s ?? w.end;
    if (typeof w.word !== "string" || typeof start !== "number" || typeof end !== "number") {
      throw new Error(`${file}: Wort ${idx} hat nicht die Felder word/start_s/end_s`);
    }
    return { word: w.word, start_s: start, end_s: end };
  });
  return {
    provider: "file",
    model: file,
    language,
    duration_s: durationHint,
    text: words.map((w) => w.word).join(" "),
    words,
  };
}
