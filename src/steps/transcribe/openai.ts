import fs from "node:fs";
import path from "node:path";
import type { RawWord } from "../../lib/words.ts";
import { attachPunctuation } from "../../lib/words.ts";

export interface ProviderResult {
  provider: string;
  model: string;
  language: string;
  duration_s: number;
  text: string;
  words: RawWord[];
}

const MAX_BYTES = 24 * 1024 * 1024;

export async function transcribeOpenAI(wav: string, opts: { model: string; language: string; prompt?: string }): Promise<ProviderResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY fehlt (oder transcription.provider auf faster-whisper/file stellen).");
  const size = fs.statSync(wav).size;
  if (size > MAX_BYTES) {
    throw new Error(`${path.basename(wav)} ist ${(size / 1e6).toFixed(1)} MB; die Whisper-API erlaubt 25 MB. Längere Clips: provider "faster-whisper" nutzen (Chunking ist nicht eingebaut).`);
  }
  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "audio.wav");
  form.set("model", opts.model);
  form.set("language", opts.language);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (opts.prompt) form.set("prompt", opts.prompt);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper-API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = (await res.json()) as { text: string; duration?: number; words?: { word: string; start: number; end: number }[] };
  if (!j.words?.length && j.text?.trim()) throw new Error("Whisper-API lieferte keine Wortzeitstempel.");
  const words: RawWord[] = (j.words ?? []).map((w) => ({ word: w.word, start_s: w.start, end_s: w.end }));
  return {
    provider: "openai",
    model: opts.model,
    language: opts.language,
    duration_s: j.duration ?? words.at(-1)?.end_s ?? 0,
    text: j.text ?? "",
    words: attachPunctuation(words, j.text ?? ""),
  };
}
