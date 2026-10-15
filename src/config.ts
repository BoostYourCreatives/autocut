import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readJson } from "./util/files.ts";
import { StyleParams } from "./schema/style.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ConfigSchema = z.object({
  style: z.string(),
  styleDir: z.string(),
  runsDir: z.string(),
  sfxLibrary: z.string(),
  musicLibrary: z.string(),
  stockBrollDir: z.string().nullable(),
  transcription: z.object({
    provider: z.enum(["openai", "faster-whisper", "file"]),
    openai: z.object({ model: z.string() }),
    fasterWhisper: z.object({ model: z.string(), computeType: z.string(), beamSize: z.number().int() }),
  }),
  llm: z.object({
    planModel: z.string(),
    selfcheckModel: z.string(),
    maxPlanAttempts: z.number().int().min(1).max(3),
  }),
  pricing: z.object({ whisperUsdPerMinute: z.number() }),
});
export type Config = z.infer<typeof ConfigSchema> & {
  /** Absoluter Pfad zum Stilordner (z. B. <root>/style/thorsten) */
  stylePath: string;
  /** Absoluter Pfad zum Runs-Ordner */
  runsPath: string;
};

export function loadConfig(file = path.join(ROOT, "config", "autocut.config.json")): Config {
  const parsed = ConfigSchema.parse(readJson(file));
  const env = process.env;
  const cfg = {
    ...parsed,
    sfxLibrary: env.AUTOCUT_SFX_LIBRARY ?? parsed.sfxLibrary,
    musicLibrary: env.AUTOCUT_MUSIC_LIBRARY ?? parsed.musicLibrary,
    stockBrollDir: env.AUTOCUT_STOCK_BROLL_DIR ?? parsed.stockBrollDir,
    runsDir: env.AUTOCUT_RUNS_DIR ?? parsed.runsDir,
  };
  return {
    ...cfg,
    stylePath: path.resolve(ROOT, cfg.styleDir, cfg.style),
    runsPath: path.resolve(ROOT, cfg.runsDir),
  };
}

export interface Style {
  params: StyleParams;
  /** Inhalt von style.json und regeln.md, unverändert (für den Plan-Prompt in M2) */
  styleJson: unknown;
  regelnMd: string;
  dir: string;
}

export function loadStyle(cfg: Config): Style {
  const p = (f: string) => path.join(cfg.stylePath, f);
  for (const f of ["style.json", "regeln.md", "params.json"]) {
    if (!fs.existsSync(p(f))) throw new Error(`Stil-Datei fehlt: ${p(f)}`);
  }
  const params = StyleParams.parse(readJson(p("params.json")));
  return {
    params,
    styleJson: readJson(p("style.json")),
    regelnMd: fs.readFileSync(p("regeln.md"), "utf8"),
    dir: cfg.stylePath,
  };
}

/** Findet alle TODO-Marker in Stil- und Config-Dateien (für `autocut todos`). */
export function collectTodos(cfg: Config): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const files = [
    path.join(cfg.stylePath, "params.json"),
    path.join(ROOT, "config", "autocut.config.json"),
  ];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const walk = (v: unknown, key = ""): void => {
      if (typeof v === "string" && (/^TODO\(/.test(v) || key === "_todo")) out.push({ file: rel, text: v });
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(readJson(f));
  }
  return out;
}
