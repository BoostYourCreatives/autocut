import fs from "node:fs";
import path from "node:path";
import type { Config, Style } from "../config.ts";
import { ffmpeg } from "../util/exec.ts";
import { ensureDir, writeJson } from "../util/files.ts";
import { loadManifest, runPaths, saveManifest, type RunPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import { probe, snapFps } from "../lib/probe.ts";
import { ClipMeta, Manifest, type ManifestClip } from "../schema/ingest.ts";
import { log } from "../util/log.ts";

export interface IngestInput {
  reels: string[];
  hooks: string[];
  body?: string;
  /** "auto" | true | false, gilt für alle in diesem Aufruf übergebenen Clips */
  precut: "auto" | boolean;
}

const slug = (file: string) =>
  path
    .basename(file, path.extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "clip";

/** Vergibt eindeutige Clip-IDs: reel / body / hook-<name>. */
export function assignClips(input: IngestInput, taken: Set<string> = new Set()): ManifestClip[] {
  const out: ManifestClip[] = [];
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  for (const f of input.reels) {
    out.push({ id: unique(input.reels.length === 1 ? "reel" : `reel-${slug(f)}`), role: "reel", source_path: path.resolve(f), precut: input.precut });
  }
  for (const f of input.hooks) {
    out.push({ id: unique(`hook-${slug(f)}`), role: "hook", source_path: path.resolve(f), precut: input.precut });
  }
  if (input.body) out.push({ id: unique("body"), role: "body", source_path: path.resolve(input.body), precut: input.precut });
  return out;
}

export async function ingest(cfg: Config, style: Style, runName: string, input: IngestInput): Promise<RunPaths> {
  const run = runPaths(cfg, runName);
  if (input.reels.length + input.hooks.length + (input.body ? 1 : 0) === 0) {
    throw new Error("Keine Eingabe: mindestens --reel oder --hook/--body angeben.");
  }
  if (input.reels.length > 0 && (input.hooks.length > 0 || input.body)) {
    throw new Error("--reel kann nicht mit --hook/--body gemischt werden (Reel = ein Stück, Ads = Hooks + gemeinsamer Body).");
  }
  if (input.hooks.length > 0 && !input.body) {
    log.warn("Hooks ohne --body: variants (M4) braucht einen gemeinsamen Body.");
  }
  for (const f of [...input.reels, ...input.hooks, ...(input.body ? [input.body] : [])]) {
    if (!fs.existsSync(f)) throw new Error(`Datei nicht gefunden: ${f}`);
  }

  ensureDir(run.dir);
  const existing: Manifest | null = fs.existsSync(run.manifest) ? loadManifest(run) : null;
  // Neuer Aufruf mit gleicher Rolle ersetzt den alten Clip derselben Quelle, sonst wird ergänzt
  const keep = (existing?.clips ?? []).filter((c) => !input.reels.concat(input.hooks, input.body ? [input.body] : []).some((f) => path.resolve(f) === c.source_path));
  const clips = assignClips(input, new Set(keep.map((c) => c.id)));
  const manifest: Manifest = {
    name: runName,
    created_at: existing?.created_at ?? new Date().toISOString(),
    style: cfg.style,
    clips: [...keep, ...clips],
  };
  saveManifest(run, manifest);

  for (const clip of clips) {
    await timed(run, "ingest", clip.id, async () => {
      const meta = await ingestClip(style, run, clip);
      log.info(`ingest ${clip.id}: ${meta.duration_s.toFixed(2)} s, ${meta.fps} fps, ${meta.width}x${meta.height}${meta.warnings.length ? ` (${meta.warnings.length} Warnung/en)` : ""}`);
      for (const w of meta.warnings) log.warn(`  ${clip.id}: ${w}`);
      return { value: meta };
    });
  }
  return run;
}

export async function ingestClip(style: Style, run: RunPaths, clip: ManifestClip): Promise<ClipMeta> {
  const P = style.params.ingest;
  const paths = run.clip(clip.id);
  ensureDir(paths.dir);

  const pr = await probe(clip.source_path);
  const warnings: string[] = [];

  const vfr = Math.abs(pr.r_frame_rate - pr.avg_frame_rate) > 0.5;
  const fps = snapFps(pr.avg_frame_rate || pr.r_frame_rate, P.erlaubte_fps);
  let fpsNote = `fps aus Quelle übernommen (${pr.avg_frame_rate.toFixed(3)})`;
  if (vfr) {
    fpsNote = `Quelle hat variable Framerate (r=${pr.r_frame_rate.toFixed(2)}, avg=${pr.avg_frame_rate.toFixed(2)}), Proxy mit konstanten ${fps} fps`;
    warnings.push(fpsNote);
  } else if (Math.abs(fps - pr.avg_frame_rate) > 0.01) {
    fpsNote = `fps ${pr.avg_frame_rate.toFixed(3)} auf ${fps} gerundet`;
  }

  const rotated = Math.abs(pr.rotation) % 180 === 90;
  const width = rotated ? pr.height : pr.width;
  const height = rotated ? pr.width : pr.height;
  const [tw, th] = P.soll_aufloesung;
  if (width !== tw || height !== th) {
    warnings.push(`Auflösung ${width}x${height} weicht von ${tw}x${th} ab (kein automatisches Skalieren in M1)`);
  }
  if (pr.duration_s < 1) warnings.push(`Clip ist nur ${pr.duration_s.toFixed(2)} s lang`);

  // Proxy: x264, GOP, ohne Ton. CFR nur erzwingen, wenn die Quelle VFR ist.
  await ffmpeg([
    "-i", clip.source_path, "-an",
    "-c:v", P.proxy.codec, "-crf", String(P.proxy.crf), "-g", String(P.proxy.gop),
    "-preset", "fast", "-pix_fmt", "yuv420p",
    ...(vfr ? ["-vf", `fps=${fps}`] : []),
    "-movflags", "+faststart", paths.proxy,
  ]);

  if (pr.audio) {
    await ffmpeg(["-i", clip.source_path, "-vn", "-ac", String(P.analyse_audio.channels), "-ar", String(P.analyse_audio.sample_rate), "-c:a", "pcm_s16le", paths.audio16k]);
    await ffmpeg(["-i", clip.source_path, "-vn", "-ac", String(P.master_audio.channels), "-ar", String(P.master_audio.sample_rate), "-c:a", "pcm_s16le", paths.audio48k]);
  } else {
    warnings.push("Quelle hat keine Tonspur: es wird Stille erzeugt");
    const mk = (file: string, sr: number, ch: number) =>
      ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=${sr}:cl=${ch === 1 ? "mono" : "stereo"}`, "-t", String(pr.duration_s), "-c:a", "pcm_s16le", file]);
    await mk(paths.audio16k, P.analyse_audio.sample_rate, P.analyse_audio.channels);
    await mk(paths.audio48k, P.master_audio.sample_rate, P.master_audio.channels);
  }

  const meta: ClipMeta = ClipMeta.parse({
    id: clip.id,
    role: clip.role,
    source_path: clip.source_path,
    duration_s: Math.round(pr.duration_s * 1000) / 1000,
    fps,
    fps_note: fpsNote,
    vfr,
    width,
    height,
    rotation: pr.rotation,
    video_codec: pr.video_codec,
    has_audio: !!pr.audio,
    audio: pr.audio,
    files: {
      proxy: path.relative(run.dir, paths.proxy),
      audio_16k: path.relative(run.dir, paths.audio16k),
      audio_48k: path.relative(run.dir, paths.audio48k),
    },
    warnings,
  });
  writeJson(paths.meta, meta);
  return meta;
}
