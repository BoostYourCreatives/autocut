import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderFrames, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { ROOT, type Config, type Style } from "../config.ts";
import { Plan, type BrollSlot } from "../schema/plan.ts";
import { readJson, readJsonSchema, writeJson, ensureDir } from "../util/files.ts";
import { log } from "../util/log.ts";
import { timed } from "../util/runlog.ts";
import { renderConcurrency, threads, videoCacheBytes } from "../util/threads.ts";
import type { RunPaths } from "../util/run.ts";
import { buildTimeline, outDuration } from "../plan/timeline.ts";
import { anchorY, checkChin, type ChinData } from "../lib/chin.ts";
import { buildSfxIndex, findSfx } from "../lib/sfxIndex.ts";
import { renderAudio } from "../render/audio.ts";
import { exportFinal } from "../render/export.ts";
import { execOk } from "../util/exec.ts";
import type { ReelProps } from "../render/remotion/Reel.tsx";

export interface RenderOptions {
  /** Zielordner für Video und Begleitdateien (Standard: <run>/out) */
  outDir?: string;
  /** Statt des Videos nur Einzelbilder (Sekunden der Ausgabe-Timeline) als PNG rendern */
  stills?: number[];
  /**
   * Nur die Text-Ebene neu rendern (Bild und Ton bleiben aus dem letzten Lauf: render/base.mp4).
   * ids = geänderte Untertitel; null = alle Texte neu.
   */
  captionsPatch?: { ids: number[] | null; /** zusätzliche alte Zeitbereiche in Sekunden (verschobene Untertitel) */ extraRangesS?: [number, number][]; /** Ton neu mischen (Soundeffekte geändert), Bild bleibt */ remixAudio?: boolean };
}

/** Ordner mit den Text-Einzelbildern (PNG mit Transparenz), eines pro Videobild */
export const captionFramesDir = (runDir: string) => path.join(runDir, "render", "captions");
export const baseVideoFile = (runDir: string) => path.join(runDir, "render", "base.mp4");
export const hasLayeredRender = (runDir: string) => fs.existsSync(baseVideoFile(runDir)) && fs.existsSync(captionFramesDir(runDir)) && fs.existsSync(path.join(runDir, "render", "render-info.json"));

/** Bildbereiche (inklusive), in denen sich die Texte der geänderten Untertitel (und ihrer Gruppe) ändern können */
export function captionFrameRanges(plan: Plan, ids: number[] | null, fps: number, totalFrames: number, extraRangesS: [number, number][] = []): [number, number][] {
  if (ids === null) return [[0, totalFrames - 1]];
  const groups = new Set(plan.captions.filter((c) => ids.includes(c.id) && c.group).map((c) => c.group));
  const hit = plan.captions.filter((c) => ids.includes(c.id) || (c.group && groups.has(c.group)));
  const r: [number, number][] = hit
    .map((c) => [Math.max(0, Math.round(c.start_s * fps) - 1), Math.min(totalFrames - 1, Math.round(c.end_s * fps) + 1)] as [number, number])
    .concat(extraRangesS.map(([a, b]) => [Math.max(0, Math.round(a * fps) - 1), Math.min(totalFrames - 1, Math.round(b * fps) + 1)] as [number, number]))
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const x of r) {
    const last = merged[merged.length - 1];
    if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]);
    else merged.push([...x]);
  }
  return merged;
}

export interface RenderInfo {
  video: string;
  DY: number;
  AY: number;
  chin_measured: boolean;
  chin_violations: number;
  fonts_missing: string[];
  broll_open: number;
  out_duration_s: number;
}

export interface RenderResult {
  videoFile?: string;
  stills: string[];
  info: RenderInfo;
  warnings: string[];
  export?: { bitrate_kbps: number; size_mb: number };
}

/** Sucht ein Chromium: Konfiguration, dann Playwright-Installation. Sonst lädt Remotion selbst eines. */
export function findBrowser(cfg: Config): string | undefined {
  if (cfg.browserExecutable) return cfg.browserExecutable;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    // Remotion braucht den "headless shell"; das volle Chromium wird nur genutzt, wenn keiner da ist
    const dirs = fs.readdirSync(base);
    for (const [prefix, rels] of [["chromium_headless_shell-", ["chrome-linux/headless_shell"]], ["chromium-", ["chrome-linux/chrome", "chrome-linux64/chrome"]]] as const) {
      for (const d of dirs.filter((x) => x.startsWith(prefix)).sort().reverse()) {
        for (const rel of rels) {
          const p = path.join(base, d, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return undefined;
}

function place(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Rendert direkt aus einem (validierten) Plan. Braucht nur plan.json und den Clip-Ordner daneben
 * (proxy.mp4, audio_48k.wav, optional chin.json): ingest/transcribe/analyze/plan laufen nicht erneut.
 */
export async function renderPlan(cfg: Config, style: Style, planFile: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const P = style.params;
  const plan = readJsonSchema(planFile, Plan);
  const runDir = path.dirname(path.resolve(planFile));
  const clipDir = path.join(runDir, "clips", plan.source.clip);
  const proxy = path.join(clipDir, "proxy.mp4");
  const voice = path.join(clipDir, "audio_48k.wav");
  for (const f of [proxy, voice]) if (!fs.existsSync(f)) throw new Error(`Datei fehlt: ${f} (zuerst ingest für diesen Run ausführen)`);
  const runLike = { dir: runDir, log: path.join(runDir, "run.log.json") } as unknown as RunPaths;
  const warnings: string[] = [];
  const outDir = opts.outDir ?? path.join(runDir, "out");
  const work = ensureDir(path.join(runDir, "render"));
  const fps = plan.source.fps;
  const tl = buildTimeline(plan.cut_segments);
  const total = outDuration(tl);

  // ---- Kinn → DY, AY ----
  const chinFile = path.join(clipDir, "chin.json");
  const chin = fs.existsSync(chinFile) ? readJson<ChinData>(chinFile) : null;
  let DY = P.layout.kinn.dy_ersatz_ohne_messung;
  let AY = 960;
  let violations = 0;
  if (chin && chin.frames.some((f) => f[1] !== null)) {
    const need = checkChin(plan, chin, P, 0);
    DY = need.requiredDy;
    AY = need.anchorY;
    violations = checkChin(plan, chin, P, DY).violations.length;
    if (violations > 0) warnings.push(`Kinn-Prüfung: ${violations} Frames mit zu wenig Abstand trotz DY=${DY}`);
  } else {
    warnings.push(`Kinn nicht gemessen: Ersatzwert DY=${DY} px. Text könnte das Kinn berühren (pip install mediapipe opencv-python-headless, dann autocut chin).`);
  }

  if (opts.captionsPatch && fs.existsSync(path.join(work, "render-info.json"))) {
    // Das Bild wurde mit diesen Werten gerendert; die Texte müssen dazu passen
    const prev = readJson<RenderInfo>(path.join(work, "render-info.json"));
    DY = prev.DY;
    AY = prev.AY;
  }

  // ---- Schriften und B-Roll bereitstellen ----
  const pub = ensureDir(path.join(work, "public"));
  const fonts: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of ["weiss", "gold", "ki"] as const) {
    const s = P.layout.schrift[key];
    const src = path.join(cfg.fontsDir, s.datei);
    if (fs.existsSync(src)) {
      place(src, path.join(pub, "fonts", s.datei));
      fonts[s.familie] = s.datei;
    } else missing.push(s.datei);
  }
  if (missing.length) warnings.push(`Schriften fehlen in ${cfg.fontsDir}: ${missing.join(", ")}. Es wird die Ersatzschrift verwendet (Optik weicht ab).`);
  place(proxy, path.join(pub, "proxy.mp4"));

  const broll: Record<number, string> = {};
  let open = 0;
  for (const b of plan.broll as BrollSlot[]) {
    const src = b.source.kind === "user_clip" || b.source.kind === "stock_ordner" ? b.source.path : null;
    if (src && fs.existsSync(src)) {
      const name = `b${b.id}${path.extname(src)}`;
      place(src, path.join(pub, "broll", name));
      broll[b.id] = name;
    } else {
      open++;
      warnings.push(`B-Roll #${b.id} "${b.motif}" (${(b.start_s).toFixed(1)}–${b.end_s.toFixed(1)} s) hat keine Quelldatei: wird nicht gerendert.`);
    }
  }

  const props: ReelProps = {
    plan,
    params: { layout: P.layout, zoom: { hook_push_nach: P.zoom.hook_push_nach, rampe_frames: P.zoom.rampe_frames } },
    DY, AY, videoFile: "proxy.mp4", fonts, broll,
  };
  const info: RenderInfo = { video: plan.video, DY, AY, chin_measured: !!chin, chin_violations: violations, fonts_missing: missing, broll_open: open, out_duration_s: total };
  writeJson(path.join(work, "render-info.json"), info);

  const browserExecutable = findBrowser(cfg);
  const serveUrl = await timed(runLike, "render-bundle", undefined, async () => ({
    value: await bundle({ entryPoint: path.join(ROOT, "src", "render", "remotion", "index.ts"), publicDir: pub }),
  }));
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps: props as unknown as Record<string, unknown>, browserExecutable });

  if (opts.stills) {
    const files: string[] = [];
    ensureDir(path.join(outDir, "stills"));
    for (const t of opts.stills) {
      const out = path.join(outDir, "stills", `${plan.video}_${t.toFixed(2)}s.png`);
      await renderStill({ composition, serveUrl, output: out, frame: Math.min(composition.durationInFrames - 1, Math.round(t * fps)), inputProps: props as unknown as Record<string, unknown>, browserExecutable });
      files.push(out);
    }
    return { stills: files, info, warnings };
  }

  const sfxIndex = buildSfxIndex(cfg.sfxLibrary);
  const baseFile = baseVideoFile(runDir);
  const capDir = captionFramesDir(runDir);
  const patch = opts.captionsPatch;
  if (patch && !hasLayeredRender(runDir)) throw new Error("Für diesen Lauf gibt es noch kein getrenntes Bild. Bitte einmal komplett neu rendern.");
  const progress = (label: string, total: number, tStart: number, state: { rendered: number; lastPct: number }) => ({ progress, renderedFrames }: { progress: number; renderedFrames: number }) => {
    state.rendered = renderedFrames;
    const pct = Math.floor(progress * 20) * 5;
    if (pct !== state.lastPct) {
      state.lastPct = pct;
      const s = Math.round((Date.now() - tStart) / 1000);
      const eta = progress > 0.02 ? Math.round((s / progress) * (1 - progress)) : null;
      log.info(`${label}: ${pct} % (${renderedFrames}/${total} Bilder, ${s} s${eta !== null ? `, noch ca. ${eta} s` : ""})`);
    }
  };
  const common = {
    serveUrl, concurrency: renderConcurrency(), browserExecutable, timeoutInMilliseconds: 120000,
    // Speicher begrenzen: sonst rechnen Remotion/ffmpeg mit dem Speicher des ganzen Servers und der Container wird abgeschossen
    offthreadVideoCacheSizeInBytes: videoCacheBytes(), offthreadVideoThreads: threads(),
    onBrowserLog: (l: { type: string; text: string }) => {
      if (l.type === "error" || l.type === "warning") log.warn(`Browser: ${l.text.slice(0, 200)}`);
    },
  };

  /** Ton mischen (Stimme + Soundeffekte), normalisieren und mit dem Bild von videoSrc zu dest zusammenfügen */
  const buildSound = async (videoSrc: string, dest: string) => {
    const sfxPaths = plan.sfx.map((s) => {
      const e = findSfx(sfxIndex, s.file);
      if (!e) throw new Error(`SFX "${s.file}" nicht in der Library ${cfg.sfxLibrary}`);
      return path.join(cfg.sfxLibrary, e.file);
    });
    const finalWav = path.join(work, "audio.wav");
    const m = await timed(runLike, "render-audio", undefined, async () => ({ value: await renderAudio(plan, P, voice, sfxPaths, work, finalWav) }));
    log.info(`ton: Eingang ${m.measured.input_i} LUFS → Ziel ${P.export.lautheit.i} LUFS`);
    await timed(runLike, "render-basis", undefined, async () => {
      await execOk("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", videoSrc, "-i", finalWav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", P.export.final.audio_codec, "-b:a", `${P.export.final.audio_kbps}k`, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-shortest", dest]);
      fs.rmSync(finalWav, { force: true });
      return { value: null };
    });
  };

  if (!patch) {
    // ---- Bild (ohne Texte) ----
    const baseProps = { ...props, layer: "base" } as unknown as Record<string, unknown>;
    const baseComp = await selectComposition({ serveUrl, id: "Reel", inputProps: baseProps, browserExecutable });
    const silent = path.join(work, "base_silent.mp4");
    const st = { rendered: 0, lastPct: -1 };
    const t0 = Date.now();
    const beat = setInterval(() => log.info(`Bild rendern läuft seit ${Math.round((Date.now() - t0) / 1000)} s, bisher ${st.rendered} von ${baseComp.durationInFrames} Bildern`), 30000);
    try {
      await timed(runLike, "render-video", undefined, async () => {
        await renderMedia({ ...common, composition: baseComp, codec: "h264", crf: P.export.zwischen.crf, outputLocation: silent, muted: true, inputProps: baseProps, onProgress: progress("Bild rendern", baseComp.durationInFrames, t0, st) });
        return { value: null };
      });
    } finally {
      clearInterval(beat);
    }

    await buildSound(silent, baseFile);
    fs.rmSync(silent, { force: true });
  } else if (patch.remixAudio) {
    // Soundeffekte geändert: nur den Ton neu mischen und unter das vorhandene Bild legen
    const tmp = path.join(work, "base_new.mp4");
    await buildSound(baseFile, tmp);
    fs.renameSync(tmp, baseFile);
  }

  // ---- Texte (eigene Ebene, PNG mit Transparenz) ----
  const capProps = { ...props, layer: "captions" } as unknown as Record<string, unknown>;
  const capComp = await selectComposition({ serveUrl, id: "Reel", inputProps: capProps, browserExecutable });
  const ranges = captionFrameRanges(plan, patch ? patch.ids : null, fps, capComp.durationInFrames, patch?.extraRangesS);
  if (!patch) fs.rmSync(capDir, { recursive: true, force: true });
  ensureDir(capDir);
  await timed(runLike, "render-texte", undefined, async () => {
    for (const [a, b] of ranges) {
      const tmpDir = path.join(work, "captions-tmp");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const t0 = Date.now();
      const st = { rendered: 0, lastPct: -1 };
      const n = b - a + 1;
      await renderFrames({
        composition: capComp, serveUrl, outputDir: tmpDir, imageFormat: "png", inputProps: capProps, frameRange: [a, b], concurrency: renderConcurrency(), browserExecutable,
        timeoutInMilliseconds: 120000, onBrowserLog: common.onBrowserLog, onStart: () => undefined,
        onFrameUpdate: (done: number) => {
          st.rendered = done;
          const pct = Math.floor((done / n) * 20) * 5;
          if (pct !== st.lastPct) {
            st.lastPct = pct;
            log.info(`Texte rendern: ${pct} % (${done}/${n} Bilder, ${Math.round((Date.now() - t0) / 1000)} s)`);
          }
        },
      });
      for (const f of fs.readdirSync(tmpDir)) fs.renameSync(path.join(tmpDir, f), path.join(capDir, f));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return { value: null };
  });
  if (patch && ranges.length) log.info(`Texte: ${ranges.map(([a, b]) => `${(a / fps).toFixed(1)}–${(b / fps).toFixed(1)} s`).join(", ")} neu gerendert, Bild und Ton bleiben`);

  // ---- Export ----
  const outFile = path.join(outDir, `${plan.video}.mp4`);
  const exp = await timed(runLike, "render-export", undefined, async () => ({ value: await exportFinal(P, baseFile, { dir: capDir, fps }, total, outFile, work) }));
  if (exp.size_mb > P.export.final.max_mb) warnings.push(`Datei ist ${exp.size_mb} MB (Limit ${P.export.final.max_mb} MB)`);
  log.info(`render: ${outFile} (${total.toFixed(1)} s, ${exp.size_mb} MB, ${exp.bitrate_kbps} kbit/s)`);
  for (const w of warnings) log.warn(`  ${w}`);
  return { videoFile: outFile, stills: [], info, warnings, export: exp };
}
