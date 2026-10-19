import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderFrames, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
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

export const sceneImagesDir = (runDir: string) => path.join(runDir, "scene-images");

interface Prepared {
  plan: MotionsPlan;
  P: MotionsParams;
  work: string;
  proxy: string;
  alpha: string;
  voice: string;
  fps: number;
  frames: number;
  props: Record<string, unknown>;
  serveUrl: string;
  browserExecutable: string | undefined;
  bg: [string, string];
}

async function prepare(cfg: Config, run: RunPaths, stylePath: string): Promise<Prepared> {
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
  const pub = path.join(work, "public");
  fs.rmSync(pub, { recursive: true, force: true });
  ensureDir(path.join(pub, "fonts"));
  for (const f of Object.values(FONTS)) fs.copyFileSync(path.join(ROOT, f.src), path.join(pub, "fonts", f.name));
  const imgDir = sceneImagesDir(run.dir);
  if (fs.existsSync(imgDir)) {
    ensureDir(path.join(pub, "scene"));
    for (const f of fs.readdirSync(imgDir)) fs.copyFileSync(path.join(imgDir, f), path.join(pub, "scene", f));
  }
  const bg = P.hintergruende[hash(run.name) % P.hintergruende.length]!;
  const props = { chunks: plan.chunks, scenes: plan.scenes ?? [], bg, accent: P.akzent, y: P.untertitel_y, fonts: { sans: FONTS.sans.name, serif: FONTS.serif.name }, fps, durationFrames: frames };
  const browserExecutable = findBrowser(cfg);
  const serveUrl = await timed(run, "render-bundle", undefined, async () => ({ value: await bundle({ entryPoint: path.join(ROOT, "src", "render", "remotion", "index.ts"), publicDir: pub }) }));
  return { plan, P, work, proxy, alpha, voice, fps, frames, props, serveUrl, browserExecutable, bg };
}

const PERSON_SCALE = 0.7;
const personFilters = (fps: number, P: MotionsParams) => {
  const S = P.sprecher;
  const pw = Math.round(W * PERSON_SCALE), ph = Math.round(H * PERSON_SCALE), px = Math.round((W - pw) / 2), py = H - ph;
  return { px, py, filters: [
    `[0:v]format=rgb24,scale=${pw}:${ph}[v]`,
    `[1:v]format=gray,scale=${pw}:${ph},split[m1][m2]`,
    `[v][m1]alphamerge[p]`,
    `[m2]gblur=sigma=${S.schatten_unschaerfe},lut=y='val*${S.schatten_staerke}'[sm]`,
    `color=c=black:s=${pw}x${ph}:r=${fps}[blk]`,
    `[blk][sm]alphamerge[sh]`,
  ] };
};

/** Einzelbilder zum Prüfen des Looks: Sekunden → fertiges Bild (Hintergrund, Sprecher, Szenen, Untertitel) */
export async function motionsStills(cfg: Config, run: RunPaths, stylePath: string, times: number[], outDir: string): Promise<string[]> {
  const t = await prepare(cfg, run, stylePath);
  ensureDir(outDir);
  const out: string[] = [];
  const { px, py, filters } = personFilters(t.fps, t.P);
  for (const sec of times) {
    const frame = Math.min(t.frames - 1, Math.round(sec * t.fps));
    const base = path.join(outDir, `t${sec.toFixed(1)}`);
    const pr = { composition: undefined as never, serveUrl: t.serveUrl, frame, inputProps: t.props, browserExecutable: t.browserExecutable, imageFormat: "png" as const };
    const back = await selectComposition({ serveUrl: t.serveUrl, id: "MotionsBack", inputProps: t.props, browserExecutable: t.browserExecutable });
    const front = await selectComposition({ serveUrl: t.serveUrl, id: "MotionsFront", inputProps: t.props, browserExecutable: t.browserExecutable });
    await renderStill({ ...pr, composition: back, output: `${base}_back.png` });
    await renderStill({ ...pr, composition: front, output: `${base}_front.png`, imageFormat: "png" });
    // Kein -ss an den Eingängen: bei zwei Eingängen verrutscht sonst der Alpha-Kanal. Stattdessen im Filter auf ein Bild kürzen.
    const one = (i: number) => `[${i}:v]select='eq(n,${frame})',setpts=PTS-STARTPTS`;
    await execOk("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", t.proxy, "-i", t.alpha, "-i", `${base}_back.png`, "-i", `${base}_front.png`,
      "-filter_complex", [`${one(0)}[v0]`, `${one(1)}[m0]`, ...filters.map((f) => f.replace("[0:v]", "[v0]").replace("[1:v]", "[m0]")), `[2:v]format=rgba[bg]`, `[bg][sh]overlay=${px}:${py + t.P.sprecher.schatten_versatz_y}[a]`, `[a][p]overlay=${px}:${py}[b]`, `[b][3:v]overlay=format=auto,format=rgb24[out]`].join(";"),
      "-map", "[out]", "-frames:v", "1", `${base}.png`]);
    out.push(`${base}.png`);
  }
  return out;
}

/** Rendert das Reel im motions-Stil: hintere Ebene (Verlauf, Grafiken hinter dem Sprecher), freigestellter Sprecher, vordere Ebene (Karten, Untertitel), Ton auf -14 LUFS. */
export async function renderMotions(cfg: Config, run: RunPaths, stylePath: string): Promise<{ videoFile: string; size_mb: number }> {
  const t = await prepare(cfg, run, stylePath);
  const { plan, P, work, fps, frames } = t;
  const common = { serveUrl: t.serveUrl, concurrency: renderConcurrency(), browserExecutable: t.browserExecutable, timeoutInMilliseconds: 120000, onBrowserLog: (l: { type: string; text: string }) => { if (l.type === "error") log.warn(`Browser: ${l.text.slice(0, 200)}`); } };
  const progress = (label: string) => { let last = -1; const t0 = Date.now(); return (done: number) => { const pct = Math.floor((done / frames) * 10) * 10; if (pct !== last) { last = pct; log.info(`${label}: ${pct} % (${done}/${frames} Bilder, ${Math.round((Date.now() - t0) / 1000)} s)`); } }; };

  // ---- hintere Ebene als Video (deckend) ----
  const backFile = path.join(work, "motions-back.mp4");
  await timed(run, "render-video", undefined, async () => {
    const comp = await selectComposition({ ...common, id: "MotionsBack", inputProps: t.props });
    const pb = progress("Hintergrund rendern");
    await renderMedia({ ...common, composition: comp, codec: "h264", crf: 14, outputLocation: backFile, muted: true, inputProps: t.props, offthreadVideoCacheSizeInBytes: videoCacheBytes(), offthreadVideoThreads: threads(), onProgress: ({ renderedFrames }: { renderedFrames: number }) => pb(renderedFrames) });
    return { value: null };
  });

  // ---- vordere Ebene (transparente PNG-Folge) ----
  const capDir = path.join(work, "motions-front");
  fs.rmSync(capDir, { recursive: true, force: true });
  await timed(run, "render-texte", undefined, async () => {
    const comp = await selectComposition({ ...common, id: "MotionsFront", inputProps: t.props });
    const pf = progress("Untertitel und Karten rendern");
    await renderFrames({ ...common, composition: comp, outputDir: capDir, imageFormat: "png", inputProps: t.props, onStart: () => undefined, offthreadVideoCacheSizeInBytes: videoCacheBytes(), offthreadVideoThreads: threads(), onFrameUpdate: pf });
    return { value: null };
  });

  // ---- zusammensetzen ----
  const first = fs.readdirSync(capDir).filter((f) => f.endsWith(".png")).sort()[0]!;
  const m = /^(.*?)(\d+)\.png$/.exec(first)!;
  const pattern = path.join(capDir, `${m[1]}%0${m[2]!.length}d.png`);
  const { px, py, filters } = personFilters(fps, P);
  const filter = [...filters, `[2:v]format=rgba[bg]`, `[bg][sh]overlay=${px}:${py + P.sprecher.schatten_versatz_y}:shortest=1[a]`, `[a][p]overlay=${px}:${py}:shortest=1[b]`, `[b][3:v]overlay=format=auto:shortest=1,format=yuv420p[out]`].join(";");
  const outFile = path.join(run.dir, "out", `${plan.video}.mp4`);
  ensureDir(path.dirname(outFile));
  await timed(run, "render-export", undefined, async () => {
    await execOk("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-i", t.proxy, "-i", t.alpha, "-i", backFile, "-framerate", String(fps), "-start_number", String(parseInt(m[2]!, 10)), "-i", pattern, "-i", t.voice,
      "-filter_complex", filter, "-map", "[out]", "-map", "4:a",
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
