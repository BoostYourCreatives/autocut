import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { log } from "./log.ts";

/**
 * Löscht Modelle im Hugging-Face-Cache, die autocut nicht (mehr) braucht (z. B. das alte Whisper "medium").
 * Nur wenn HF_HOME ausdrücklich gesetzt ist (Server mit eigenem Volume), nie im normalen Benutzer-Cache.
 */
export function pruneModelCache(cfg: Config): void {
  const home = process.env.HF_HOME;
  if (!home || process.env.AUTOCUT_PRUNE_MODELS === "0") return;
  const hub = path.join(home, "hub");
  if (!fs.existsSync(hub)) return;
  const keep = [`models--Systran--faster-whisper-${cfg.transcription.fasterWhisper.model}`, `models--${cfg.transcription.align.model.replace("/", "--")}`];
  for (const d of fs.readdirSync(hub)) {
    if (!d.startsWith("models--") || keep.includes(d)) continue;
    fs.rmSync(path.join(hub, d), { recursive: true, force: true });
    log.info(`Alte Modell-Dateien gelöscht: ${d}`);
  }
}
