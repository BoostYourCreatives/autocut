import { exec, execOk } from "../util/exec.ts";
import type { Span } from "./intervals.ts";
import { round3 } from "./intervals.ts";

/** Parst die stderr-Ausgabe von ffmpeg silencedetect. `duration` schließt eine offene Stille am Ende. */
export function parseSilenceDetect(stderr: string, duration: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) {
      open = Math.max(0, parseFloat(s[1]!));
      continue;
    }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e) {
      const end = parseFloat(e[1]!);
      out.push({ start_s: open ?? 0, end_s: end });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start_s: open, end_s: duration });
  return out.filter((s) => s.end_s > s.start_s);
}

export async function detectSilences(wav: string, noiseDb: number, minS: number, duration: number): Promise<Span[]> {
  const r = await execOk("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", wav,
    "-af", `silencedetect=noise=${noiseDb}dB:d=${minS}`,
    "-f", "null", "-",
  ]);
  return parseSilenceDetect(r.stderr, duration);
}

/** RMS in dBFS je Fenster (fensterweise aus 16-kHz-Mono-PCM). */
export function rmsSeries(pcm: Int16Array, sampleRate: number, windowS: number): number[] {
  const win = Math.max(1, Math.round(sampleRate * windowS));
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += win) {
    const end = Math.min(pcm.length, i + win);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const v = pcm[j]! / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    out.push(Math.round(Math.max(-120, 20 * Math.log10(rms || 1e-6)) * 10) / 10);
  }
  return out;
}

export async function readPcm16(wav: string, sampleRate: number): Promise<Int16Array> {
  const r = await execOk("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", wav, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-",
  ]);
  const buf = r.stdout;
  // Kopie auf ausgerichteten Speicher
  const copy = new Uint8Array(buf.length - (buf.length % 2));
  copy.set(buf.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

export interface EbuR128 {
  integrated_lufs: number | null;
  lra: number | null;
  true_peak_dbfs: number | null;
}

export function parseEbur128(stderr: string): EbuR128 {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = summary.match(re);
    return m ? parseFloat(m[1]!) : null;
  };
  return {
    integrated_lufs: num(/I:\s*(-?[\d.]+)\s*LUFS/),
    lra: num(/LRA:\s*(-?[\d.]+)\s*LU/),
    true_peak_dbfs: num(/Peak:\s*(-?[\d.]+)\s*dBFS/),
  };
}

export async function measureLoudness(wav: string): Promise<EbuR128> {
  const r = await exec("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", wav, "-af", "ebur128=peak=true", "-f", "null", "-",
  ]);
  // Bei komplett stillen Dateien liefert ffmpeg "-inf": als null behandeln
  return parseEbur128(r.stderr);
}

export interface SceneChange {
  t_s: number;
  score: number;
}

/** Parst die Ausgabe von `select=gt(scene,x),metadata=print:file=-`. */
export function parseSceneMetadata(stdout: string): SceneChange[] {
  const out: SceneChange[] = [];
  let t: number | null = null;
  for (const line of stdout.split("\n")) {
    const pt = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (pt) {
      t = parseFloat(pt[1]!);
      continue;
    }
    const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && t !== null) {
      out.push({ t_s: round3(t), score: Math.round(parseFloat(sc[1]!) * 1000) / 1000 });
      t = null;
    }
  }
  return out;
}

export async function detectScenes(video: string, threshold: number): Promise<SceneChange[]> {
  const r = await execOk("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", video, "-an",
    "-vf", `select='gt(scene,${threshold})',metadata=print:file=-`,
    "-f", "null", "-",
  ]);
  return parseSceneMetadata(r.stdout.toString("utf8"));
}
