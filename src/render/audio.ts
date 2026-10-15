import fs from "node:fs";
import path from "node:path";
import type { Plan } from "../schema/plan.ts";
import type { StyleParams } from "../schema/style.ts";
import { buildTimeline, outDuration } from "../plan/timeline.ts";
import { exec, execOk } from "../util/exec.ts";

const f = (n: number) => n.toFixed(4);

/**
 * ffmpeg-Filtergraph für den Ton: Stimme nach Schnittliste (8 ms Fade an harten Schnitten),
 * SFX mit Gain und Versatz, Riser an Blitz/Shutter abgeschnitten, amix ohne Normalisierung.
 * Eingang 0 = Stimme (48 kHz), Eingang k+1 = SFX k.
 */
export function buildAudioGraph(plan: Plan, P: StyleParams, sfxPaths: string[]): { inputs: string[]; filter: string } {
  const tl = buildTimeline(plan.cut_segments);
  const fade = P.schnitt.audio_fade_ms / 1000;
  const parts: string[] = [];
  tl.forEach((s, i) => {
    const dur = s.raw_out_s - s.raw_in_s;
    const prevJoin = i > 0 && s.raw_in_s - tl[i - 1]!.raw_out_s < 0.001;
    const nextJoin = i < tl.length - 1 && tl[i + 1]!.raw_in_s - s.raw_out_s < 0.001;
    const fx = [`atrim=start=${f(s.raw_in_s)}:end=${f(s.raw_out_s)}`, "asetpts=PTS-STARTPTS"];
    if (!prevJoin && fade > 0) fx.push(`afade=t=in:st=0:d=${f(fade)}`);
    if (!nextJoin && fade > 0) fx.push(`afade=t=out:st=${f(Math.max(0, dur - fade))}:d=${f(fade)}`);
    parts.push(`[0:a]${fx.join(",")}[v${i}]`);
  });
  parts.push(`${tl.map((_, i) => `[v${i}]`).join("")}concat=n=${tl.length}:v=0:a=1,aformat=sample_rates=48000:channel_layouts=stereo[voice]`);

  const labels = ["[voice]"];
  plan.sfx.forEach((s, k) => {
    const fx = ["aformat=sample_rates=48000:channel_layouts=stereo"];
    const skip = Math.max(0, -s.at_s);
    let keep = Infinity;
    if (s.trim_end_at_s !== undefined) keep = s.trim_end_at_s - s.at_s;
    if (skip > 0 || Number.isFinite(keep)) fx.push(`atrim=start=${f(skip)}${Number.isFinite(keep) ? `:end=${f(keep)}` : ""}`, "asetpts=PTS-STARTPTS");
    if (s.fade_out_ms && Number.isFinite(keep)) {
      const d = s.fade_out_ms / 1000;
      fx.push(`afade=t=out:st=${f(Math.max(0, keep - skip - d))}:d=${f(d)}`);
    }
    fx.push(`volume=${s.gain_db}dB`);
    const ms = Math.max(0, Math.round(s.at_s * 1000));
    if (ms > 0) fx.push(`adelay=${ms}|${ms}`);
    parts.push(`[${k + 1}:a]${fx.join(",")}[s${k}]`);
    labels.push(`[s${k}]`);
  });
  const total = outDuration(tl);
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${f(total)},asetpts=PTS-STARTPTS[out]`);
  return { inputs: sfxPaths, filter: parts.join(";") };
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export function parseLoudnormJson(stderr: string): LoudnormMeasure {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) throw new Error("loudnorm lieferte keine Messwerte");
  return JSON.parse(m[0]) as LoudnormMeasure;
}

/** Schneidet die Stimme, mischt SFX und normalisiert (zweistufiges loudnorm, linear). Gibt die Ausgabedatei zurück. */
export async function renderAudio(plan: Plan, P: StyleParams, voiceWav: string, sfxPaths: string[], workDir: string, outWav: string): Promise<{ measured: LoudnormMeasure }> {
  const { filter } = buildAudioGraph(plan, P, sfxPaths);
  const mixed = path.join(workDir, "audio_mix.wav");
  await execOk("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-i", voiceWav, ...sfxPaths.flatMap((p) => ["-i", p]),
    "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", mixed,
  ]);
  const L = P.export.lautheit;
  const probe = await exec("ffmpeg", ["-hide_banner", "-nostdin", "-i", mixed, "-af", `loudnorm=I=${L.i}:TP=${L.tp}:LRA=${L.lra}:print_format=json`, "-f", "null", "-"]);
  const m = parseLoudnormJson(probe.stderr);
  await execOk("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-i", mixed,
    "-af", `loudnorm=I=${L.i}:TP=${L.tp}:LRA=${L.lra}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar", "48000", "-c:a", "pcm_s16le", outWav,
  ]);
  fs.rmSync(mixed, { force: true });
  return { measured: m };
}
