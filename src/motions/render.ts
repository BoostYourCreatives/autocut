import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderFrames, selectComposition } from "@remotion/renderer";
import { ROOT, type Config } from "../config.ts";
import { findBrowser } from "../steps/render.ts";
import { ensureDir, readJson } from "../util/files.ts";
import { execOk } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { renderConcurrency, threads, videoCacheBytes } from "../util/threads.ts";
import type { RunPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import { alphaFile } from "./cutout.ts";
import { motionsPlanFile, type MotionsPlan } from "./plan.ts";

export interface MotionsParams {
  akzent: string;
  untertitel_y: number;
  hintergruende: [string, string][];
  sprecher: { schatten_unschaerfe: number; schatten_versatz_y: number; schatten_staerke: number };
  ton: { lautheit_lufs: number; true_peak: number };
  video: { crf: number; preset: string; audio_kbps: number };
}

export const loadMotionsParams = (stylePath: string) => readJson<MotionsParams>(path.join(stylePath, "motions.json"));

const FONTS = {
  sans: { src: "node_modules/@fontsource/montserrat/files/montserrat-latin-800-normal.woff2", name: "sans.woff2" },
  serif: { src: "node_modules/@fontsource/playfair-display/files/playfair-display-latin-700-italic.woff2", name: "serif.woff2" },
};

const W = 1080;
const H = 1920;
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Rendert das Reel im motions-Stil: Hintergrund + freigestellter Sprecher (ffmpeg), Untertitel als Ebene (Remotion), Ton auf -14 LUFS. */
export async function renderMotions(cfg: Config, run: RunPaths, stylePath: string): Promise<{ videoFile: string; size_mb: number }> {
  const P = loadMotionsParams(stylePath);
  const plan = readJson<MotionsPlan>(motionsPlanFile(run.dir));
  const clipDir = run.clip(plan.clip).dir;
  const proxy = path.join(clipDir, "proxy.mp4");
  const voice = path.join(clipDir, "audio_48k.wav");
  const alpha = alphaFile(clipDir);
  for (const f of [proxy, voice, alpha]) if (!fs.existsSync(f)) throw new Error(`Datei fehlt: ${f}`);
  const work = ensureDir(path.join(run.dir, "render"));
  const fps = plan.fps;
  const frames = Math.max(1, Math.round(plan.duration_s * fps));

  // ---- Untertitel-Ebene (transparente PNG-Folge) ----
  const pub = ensureDir(path.join(work, "public", "fonts"));
  for (const f of Object.values(FONTS)) fs.copyFileSync(path.join(ROOT, f.src), path.join(pub, f.name));
  const props = { chunks: plan.chunks, accent: P.akzent, y: P.untertitel_y, fonts: { sans: FONTS.sans.name, serif: FONTS.serif.name }, fps, durationFrames: frames };
  const browserExecutable = findBrowser(cfg);
  const serveUrl = await timed(run, "render-bundle", undefined, async () => ({
    value: await bundle({ entryPoint: path.join(ROOT, "src", "render", "remotion", "index.ts"), publicDir: path.join(work, "public") }),
  }));
  const comp = await selectComposition({ serveUrl, id: "MotionsFront", inputProps: props as unknown as Record<string, unknown>, browserExecutable });
  const capDir = path.join(work, "motions-front");
  fs.rmSync(capDir, { recursive: true, force: true });
  await timed(run, "render-texte", undefined, async () => {
    const t0 = Date.now();
    let last = -1;
    await renderFrames({
      composition: comp, serveUrl, outputDir: capDir, imageFormat: "png", inputProps: props as unknown as Record<string, unknown>, concurrency: renderConcurrency(), browserExecutable,
      timeoutInMilliseconds: 120000, onStart: () => undefined,
      offthreadVideoCacheSizeInBytes: videoCacheBytes(), offthreadVideoThreads: threads(),
      onFrameUpdate: (done: number) => {
        const pct = Math.floor((done / frames) * 10) * 10;
        if (pct !== last) {
          last = pct;
          log.info(`Untertitel rendern: ${pct} % (${done}/${frames} Bilder, ${Math.round((Date.now() - t0) / 1000)} s)`);
        }
      },
      onBrowserLog: (l: { type: string; text: string }) => {
        if (l.type === "error") log.warn(`Browser: ${l.text.slice(0, 200)}`);
      },
    });
    return { value: null };
  });

  // ---- Zusammensetzen: Hintergrund, Schatten, Sprecher, Untertitel ----
  const [c0, c1] = P.hintergruende[hash(run.name) % P.hintergruende.length]!;
  const first = fs.readdirSync(capDir).filter((f) => f.endsWith(".png")).sort()[0]!;
  const m = /^(.*?)(\d+)\.png$/.exec(first)!;
  const pattern = path.join(capDir, `${m[1]}%0${m[2]!.length}d.png`);
  const S = P.sprecher;
  const filter = [
    `gradients=s=${W}x${H}:c0=${c0.replace("#", "0x")}:c1=${c1.replace("#", "0x")}:x0=0:y0=0:x1=${Math.round(W * 0.3)}:y1=${H}:speed=0.00001:r=${fps}[bg]`,
    `[0:v]format=rgb24[v]`,
    `[1:v]format=gray,split[m1][m2]`,
    `[v][m1]alphamerge[p]`,
    `[m2]gblur=sigma=${S.schatten_unschaerfe},lut=y='val*${S.schatten_staerke}'[sm]`,
    `color=c=black:s=${W}x${H}:r=${fps}[blk]`,
    `[blk][sm]alphamerge[sh]`,
    `[bg][sh]overlay=0:${S.schatten_versatz_y}:shortest=1[a]`,
    `[a][p]overlay=0:0:shortest=1[b]`,
    `[b][2:v]overlay=format=auto:shortest=1,format=yuv420p[out]`,
  ].join(";");
  const outFile = path.join(run.dir, "out", `${plan.video}.mp4`);
  ensureDir(path.dirname(outFile));
  await timed(run, "render-export", undefined, async () => {
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-i", proxy, "-i", alpha, "-framerate", String(fps), "-start_number", String(parseInt(m[2]!, 10)), "-i", pattern, "-i", voice,
      "-filter_complex", filter, "-map", "[out]", "-map", "3:a",
      "-af", `loudnorm=I=${P.ton.lautheit_lufs}:TP=${P.ton.true_peak}:LRA=11`,
      "-c:v", "libx264", "-crf", String(P.video.crf), "-preset", P.video.preset, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", `${P.video.audio_kbps}k`, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-shortest", outFile,
    ]);
    return { value: null };
  });
  const size_mb = Math.round((fs.statSync(outFile).size / 1e6) * 100) / 100;
  log.info(`render: ${outFile} (${plan.duration_s.toFixed(1)} s, ${size_mb} MB)`);
  return { videoFile: outFile, size_mb };
}
