import fs from "node:fs";
import path from "node:path";
import type { StyleParams } from "../schema/style.ts";
import { execOk } from "../util/exec.ts";

/** Zielbitrate: 4400 kbit/s laut style.json, aber so gesenkt, dass die Datei unter dem Limit (30 MB) bleibt. */
export function targetBitrateKbps(P: StyleParams, durationS: number): number {
  const E = P.export.final;
  const budgetKbps = (E.max_mb * 0.94 * 8000) / Math.max(1, durationS) - E.audio_kbps;
  return Math.max(500, Math.floor(Math.min(E.bitrate_kbps, budgetKbps)));
}

/** Video (ohne Ton) + Ton → finale Datei: libx265 2-pass, hvc1, AAC, faststart. */
export async function exportFinal(P: StyleParams, videoMp4: string, audioWav: string, durationS: number, outFile: string, workDir: string): Promise<{ bitrate_kbps: number; size_mb: number }> {
  const E = P.export.final;
  let kbps = targetBitrateKbps(P, durationS);
  const stats = path.join(workDir, "x265_2pass");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", "-i", videoMp4, "-an", "-c:v", E.codec, "-b:v", `${kbps}k`, "-preset", E.preset,
      "-x265-params", `pass=1:stats=${stats}:log-level=error`, "-f", "null", "-",
    ]);
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", "-i", videoMp4, "-i", audioWav, "-map", "0:v", "-map", "1:a",
      "-c:v", E.codec, "-b:v", `${kbps}k`, "-preset", E.preset, "-tag:v", E.tag,
      "-x265-params", `pass=2:stats=${stats}:log-level=error`,
      "-c:a", E.audio_codec, "-b:a", `${E.audio_kbps}k`, "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", "-shortest", outFile,
    ]);
    const mb = fs.statSync(outFile).size / 1e6;
    if (mb <= E.max_mb || attempt === 1) return { bitrate_kbps: kbps, size_mb: Math.round(mb * 100) / 100 };
    kbps = Math.floor(kbps * (E.max_mb * 0.9) / mb);
  }
  throw new Error("unreachable");
}
