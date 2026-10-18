import fs from "node:fs";
import path from "node:path";
import { ROOT, type Config } from "../config.ts";
import { exec } from "../util/exec.ts";
import { log } from "../util/log.ts";
import { loadManifest, runPaths } from "../util/run.ts";
import { timed } from "../util/runlog.ts";

export const alphaFile = (clipDir: string) => path.join(clipDir, "alpha.mp4");

/** Schritt "Freistellen": Person vom Hintergrund lösen (Robust Video Matting), Ergebnis = Graustufen-Video mit dem Alpha-Kanal. */
export async function cutout(cfg: Config, runName: string): Promise<string> {
  const run = runPaths(cfg, runName);
  const clip = loadManifest(run).clips.find((c) => c.role === "reel");
  if (!clip) throw new Error("Der Run enthält kein Reel");
  const p = run.clip(clip.id);
  const out = alphaFile(p.dir);
  if (fs.existsSync(out)) {
    log.info("freistellen: vorhanden, übersprungen");
    return out;
  }
  await timed(run, "cutout", clip.id, async () => {
    const tmp = `${out}.part.mp4`;
    const r = await exec("python3", [path.join(ROOT, "tools", "cutout.py"), p.proxy, tmp]);
    if (r.code !== 0) {
      const hint = /No module named/.test(r.stderr) ? "pip install torch opencv-python-headless" : r.stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
      throw new Error(`Freistellen fehlgeschlagen: ${hint}`);
    }
    fs.renameSync(tmp, out);
    log.info(r.stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "freistellen fertig");
    return { value: null };
  });
  return out;
}
