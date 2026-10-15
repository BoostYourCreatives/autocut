import fs from "node:fs";
import path from "node:path";

export interface SfxEntry {
  /** Pfad relativ zur Library, z. B. "Impact & Hit/Riser.mp3" */
  file: string;
  name: string;
  folder: string;
}

const EXT = new Set([".mp3", ".wav", ".m4a", ".aif", ".aiff", ".flac", ".ogg"]);

/** Index aller Audiodateien der SFX-Library (rekursiv). Nur diese Dateien dürfen im Plan vorkommen. */
export function buildSfxIndex(dir: string): SfxEntry[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(
      `SFX-Library nicht gefunden: ${dir}\nPfad in config/autocut.config.json (sfxLibrary) oder per AUTOCUT_SFX_LIBRARY setzen.`,
    );
  }
  const out: SfxEntry[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXT.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        out.push({ file: rel, name: e.name, folder: path.dirname(rel) === "." ? "" : path.dirname(rel) });
      }
    }
  };
  walk(dir);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** Findet einen Eintrag über relativen Pfad oder Dateinamen (ohne Beachtung von Groß/Klein). */
export function findSfx(index: SfxEntry[], nameOrPath: string): SfxEntry | undefined {
  const n = nameOrPath.toLowerCase();
  return index.find((e) => e.file.toLowerCase() === n) ?? index.find((e) => e.name.toLowerCase() === n);
}
