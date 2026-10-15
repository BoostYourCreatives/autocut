import path from "node:path";
import { ROOT } from "../../config.ts";
import { execOk } from "../../util/exec.ts";
import { readJson } from "../../util/files.ts";
import type { ProviderResult } from "./openai.ts";

/** Lokale Transkription wie in regeln.md (faster-whisper medium, int8, de, beam 5). */
export async function transcribeFasterWhisper(
  wav: string,
  outJson: string,
  opts: { model: string; computeType: string; beamSize: number; language: string; prompt?: string },
): Promise<ProviderResult> {
  await execOk("python3", [
    path.join(ROOT, "tools", "tr.py"), wav, outJson,
    "--model", opts.model, "--compute-type", opts.computeType, "--beam-size", String(opts.beamSize),
    "--language", opts.language, ...(opts.prompt ? ["--prompt", opts.prompt] : []),
  ]);
  const j = readJson<ProviderResult>(outJson);
  return { ...j, provider: "faster-whisper", model: opts.model };
}
