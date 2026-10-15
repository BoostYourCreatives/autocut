import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { ensureDir, readJsonSchema, writeJson } from "./files.ts";
import { Manifest } from "../schema/ingest.ts";

export interface RunPaths {
  name: string;
  dir: string;
  manifest: string;
  log: string;
  clip(id: string): ClipPaths;
}
export interface ClipPaths {
  dir: string;
  meta: string;
  proxy: string;
  audio16k: string;
  audio48k: string;
  transcript: string;
  transcriptRaw: string;
  analysis: string;
}

export function runPaths(cfg: Config, name: string): RunPaths {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Ungültiger Run-Name: ${name}`);
  const dir = path.join(cfg.runsPath, name);
  return {
    name,
    dir,
    manifest: path.join(dir, "run.json"),
    log: path.join(dir, "run.log.json"),
    clip(id: string): ClipPaths {
      const d = path.join(dir, "clips", id);
      return {
        dir: d,
        meta: path.join(d, "meta.json"),
        proxy: path.join(d, "proxy.mp4"),
        audio16k: path.join(d, "audio_16k.wav"),
        audio48k: path.join(d, "audio_48k.wav"),
        transcript: path.join(d, "transcript.json"),
        transcriptRaw: path.join(d, "transcript.raw.json"),
        analysis: path.join(d, "analysis.json"),
      };
    },
  };
}

export function loadManifest(run: RunPaths): Manifest {
  if (!fs.existsSync(run.manifest)) throw new Error(`Run "${run.name}" existiert nicht (${run.manifest}). Zuerst: autocut ingest`);
  return readJsonSchema(run.manifest, Manifest);
}

export function saveManifest(run: RunPaths, m: Manifest): void {
  ensureDir(run.dir);
  writeJson(run.manifest, m);
}

/** Wählt Clips des Runs aus (alle oder per --clip). */
export function selectClips(m: Manifest, only?: string[]) {
  if (!only || only.length === 0) return m.clips;
  const missing = only.filter((id) => !m.clips.some((c) => c.id === id));
  if (missing.length) throw new Error(`Unbekannte Clips: ${missing.join(", ")} (vorhanden: ${m.clips.map((c) => c.id).join(", ")})`);
  return m.clips.filter((c) => only.includes(c.id));
}
