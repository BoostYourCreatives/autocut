import { exec } from "../util/exec.ts";

export const PEAKS_PER_SEC = 100;

/** Lautstärke-Hüllkurve des Tons einer Videodatei: 100 Werte pro Sekunde, 0–255 (auf den lautesten Wert normiert). */
export async function waveformPeaks(file: string): Promise<{ peaksPerSec: number; peaks: number[] }> {
  const rate = 4000;
  const r = await exec("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"]);
  if (r.code !== 0) throw new Error(`Ton konnte nicht gelesen werden: ${r.stderr.split("\n").slice(-2).join(" ")}`);
  const buf = r.stdout;
  const n = Math.floor(buf.length / 2);
  const win = rate / PEAKS_PER_SEC;
  const peaks: number[] = [];
  let max = 1;
  for (let i = 0; i < n; i += win) {
    let m = 0;
    for (let j = i; j < Math.min(n, i + win); j++) m = Math.max(m, Math.abs(buf.readInt16LE(j * 2)));
    peaks.push(m);
    if (m > max) max = m;
  }
  return { peaksPerSec: PEAKS_PER_SEC, peaks: peaks.map((p) => Math.round(Math.sqrt(p / max) * 255)) };
}
