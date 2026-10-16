import fs from "node:fs";
import path from "node:path";
import type { Config, Style } from "../config.ts";

export type AssetKind = "sfx" | "fonts";

const EXT: Record<AssetKind, RegExp> = {
  sfx: /\.(mp3|wav|m4a|aif|aiff|flac|ogg)$/i,
  fonts: /\.(ttf|otf)$/i,
};
export const MAX_ASSET_MB = 50;

export const assetDir = (cfg: Config, kind: AssetKind) => (kind === "sfx" ? cfg.sfxLibrary : cfg.fontsDir);

/** Dateiname bereinigen: nur der Name, keine Pfade. */
export function safeAssetName(kind: AssetKind, name: string): string | null {
  const base = path.basename(name).replace(/[^A-Za-z0-9._ &()-]+/g, "_");
  return EXT[kind].test(base) && !base.startsWith(".") ? base : null;
}

function walk(dir: string, rel = ""): { file: string; size: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { file: string; size: number }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else out.push({ file: r, size: fs.statSync(path.join(dir, e.name)).size });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function listAssets(cfg: Config, style: Style) {
  const fonts = walk(cfg.fontsDir);
  const sfx = walk(cfg.sfxLibrary).filter((f) => EXT.sfx.test(f.file));
  const needFonts = (["weiss", "gold", "ki"] as const).map((k) => style.params.layout.schrift[k].datei);
  const needSfx = [...new Set(Object.values(style.params.sfx.cues).map((c) => c.file))];
  const hasSfx = (n: string) => sfx.some((s) => s.file.toLowerCase().endsWith(n.toLowerCase()));
  return {
    sfx,
    fonts: fonts.filter((f) => EXT.fonts.test(f.file)),
    missing: {
      sfx: needSfx.filter((n) => !hasSfx(n)),
      fonts: needFonts.filter((n) => !fonts.some((f) => f.file === n)),
    },
  };
}
