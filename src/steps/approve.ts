import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../util/files.ts";

const dirSize = (p: string): number => {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((a, f) => a + dirSize(path.join(p, f)), 0);
};

export interface ApproveResult {
  freed_bytes: number;
}

/**
 * Abnahme: Das fertige Video bleibt, das Rohmaterial und alles Zwischenmaterial wird gelöscht
 * (Originalvideo, Proxy, Audio, Render-Ordner, Standbilder, B-Roll-Downloads). Plan, Transkript, Berichte bleiben.
 * Danach ist kein erneutes Rendern mehr möglich.
 */
export function approveRun(runDir: string): ApproveResult {
  let freed = 0;
  const rm = (p: string) => {
    freed += dirSize(p);
    fs.rmSync(p, { recursive: true, force: true });
  };
  rm(path.join(runDir, "input"));
  rm(path.join(runDir, "render"));
  rm(path.join(runDir, "broll"));
  const clips = path.join(runDir, "clips");
  if (fs.existsSync(clips)) {
    for (const c of fs.readdirSync(clips)) {
      const d = path.join(clips, c);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) if (/\.(wav|mp4|mov)$/i.test(f)) rm(path.join(d, f));
    }
  }
  const out = path.join(runDir, "out");
  if (fs.existsSync(out)) {
    rm(path.join(out, "stills"));
    for (const f of fs.readdirSync(out)) if (/\.(png|jpg)$/i.test(f)) rm(path.join(out, f));
  }
  writeJson(path.join(runDir, "approved.json"), { approved_at: new Date().toISOString(), freed_bytes: freed });
  return { freed_bytes: freed };
}
