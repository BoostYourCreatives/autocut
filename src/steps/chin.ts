import type { Config, Style } from "../config.ts";
import { ROOT } from "../config.ts";
import path from "node:path";
import fs from "node:fs";
import { exec } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths, selectClips } from "../util/run.ts";
import { timed } from "../util/runlog.ts";
import { median, type ChinData } from "../lib/chin.ts";
import { readJson } from "../util/files.ts";

/** Misst die Kinnhöhe (MediaPipe, Punkt 152) alle N Frames. Ohne mediapipe wird übersprungen (mit Warnung). */
export async function measureChin(cfg: Config, style: Style, runName: string, clipIds?: string[]): Promise<void> {
  const run = runPaths(cfg, runName);
  for (const clip of selectClips(loadManifest(run), clipIds)) {
    const p = run.clip(clip.id);
    await timed(run, "chin", clip.id, async () => {
      const r = await exec("python3", [path.join(ROOT, "tools", "chin.py"), p.proxy, p.chin, "--every", String(style.params.layout.kinn.messung_jedes_n_frame)]);
      if (r.code !== 0) {
        const hint = /No module named/.test(r.stderr) ? "pip install mediapipe opencv-python-headless" : r.stderr.split("\n").filter(Boolean).slice(-2).join(" | ");
        log.warn(`chin ${clip.id}: Messung nicht möglich (${hint}). Es gilt der Ersatzwert dy_ersatz_ohne_messung=${style.params.layout.kinn.dy_ersatz_ohne_messung}.`);
        return { value: null };
      }
      const d = readJson<ChinData>(p.chin);
      const ys = d.frames.map((f) => f[1]).filter((y): y is number => y !== null);
      const share = d.frames.length ? ys.length / d.frames.length : 0;
      if (ys.length === 0) {
        log.warn(`chin ${clip.id}: in keinem Frame ein Gesicht gefunden. Es gilt der Ersatzwert dy_ersatz_ohne_messung=${style.params.layout.kinn.dy_ersatz_ohne_messung}.`);
        return { value: d };
      }
      log.info(`chin ${clip.id}: Gesicht in ${(share * 100).toFixed(0)} % der Messpunkte, Kinn-y Median ${Math.round(median(ys))} px, max ${Math.max(...ys)} px`);
      if (share < 0.8) log.warn(`  ${clip.id}: Gesicht nur in ${(share * 100).toFixed(0)} % der Frames gefunden: Kinn-Prüfung unsicher`);
      return { value: d };
    });
  }
  void fs;
}
