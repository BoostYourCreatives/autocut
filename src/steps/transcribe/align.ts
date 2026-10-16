import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.ts";
import type { RawWord } from "../../lib/words.ts";
import { execOk } from "../../util/exec.ts";
import { readJson, writeJson } from "../../util/files.ts";

/** Wortzeiten mit wav2vec2 gegen das Audio ausrichten (tools/align.py). Der Text bleibt, nur start/end ändern sich. */
export async function alignWords(wav: string, words: RawWord[], model: string, tmp: string): Promise<{ words: RawWord[]; aligned: number; kept: number }> {
  writeJson(tmp, { words });
  try {
    await execOk("python3", [path.join(ROOT, "tools", "align.py"), wav, tmp, tmp, "--model", model]);
    const j = readJson<{ words: RawWord[]; alignment: { aligned: number; kept_whisper_time: number } }>(tmp);
    return { words: j.words.map((w) => ({ word: w.word, start_s: w.start_s, end_s: w.end_s })), aligned: j.alignment.aligned, kept: j.alignment.kept_whisper_time };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
