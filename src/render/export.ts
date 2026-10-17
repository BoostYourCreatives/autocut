import fs from "node:fs";
import path from "node:path";
import type { StyleParams } from "../schema/style.ts";
import { execOk } from "../util/exec.ts";
import { threads } from "../util/threads.ts";

/** Zielbitrate: 4400 kbit/s laut style.json, aber so gesenkt, dass die Datei unter dem Limit (30 MB) bleibt. */
export function targetBitrateKbps(P: StyleParams, durationS: number): number {
  const E = P.export.final;
  const budgetKbps = (E.max_mb * 0.94 * 8000) / Math.max(1, durationS) - E.audio_kbps;
  return Math.max(500, Math.floor(Math.min(E.bitrate_kbps, budgetKbps)));
}

/** Basis (Bild + Ton) + Text-Ebene (PNG-Folge mit Transparenz) → finale Datei: libx265 2-pass, hvc1, Ton unverändert, faststart. */
export async function exportFinal(P: StyleParams, baseMp4: string, overlay: { dir: string; fps: number }, durationS: number, outFile: string, workDir: string): Promise<{ bitrate_kbps: number; size_mb: number }> {
  const E = P.export.final;
  let kbps = targetBitrateKbps(P, durationS);
  const stats = path.join(workDir, "x265_2pass");
  const first = fs.readdirSync(overlay.dir).filter((f) => f.endsWith(".png")).sort()[0];
  if (!first) throw new Error("Keine Text-Bilder vorhanden");
  const m = /^(.*?)(\d+)\.png$/.exec(first)!;
  const pattern = path.join(overlay.dir, `${m[1]}%0${m[2]!.length}d.png`);
  const inputs = ["-i", baseMp4, "-framerate", String(overlay.fps), "-start_number", String(parseInt(m[2]!, 10)), "-i", pattern];
  const filter = ["-filter_complex", "[0:v][1:v]overlay=format=auto:shortest=1,format=yuv420p[v]"];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", ...inputs, ...filter, "-map", "[v]", "-an", "-c:v", E.codec, "-b:v", `${kbps}k`, "-preset", E.preset,
      "-x265-params", `pass=1:stats=${stats}:log-level=error:pools=${threads()}:frame-threads=2`, "-f", "null", "-",
    ]);
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", ...inputs, ...filter, "-map", "[v]", "-map", "0:a",
      "-c:v", E.codec, "-b:v", `${kbps}k`, "-preset", E.preset, "-tag:v", E.tag,
      "-x265-params", `pass=2:stats=${stats}:log-level=error:pools=${threads()}:frame-threads=2`,
      "-c:a", "copy",
      "-movflags", "+faststart", "-shortest", outFile,
    ]);
    const mb = fs.statSync(outFile).size / 1e6;
    if (mb <= E.max_mb || attempt === 1) return { bitrate_kbps: kbps, size_mb: Math.round(mb * 100) / 100 };
    kbps = Math.floor(kbps * (E.max_mb * 0.9) / mb);
  }
  throw new Error("unreachable");
}
