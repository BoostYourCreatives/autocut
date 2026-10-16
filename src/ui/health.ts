import fs from "node:fs";
import path from "node:path";
import type { Config, Style } from "../config.ts";
import { exec } from "../util/exec.ts";
import { buildSfxIndex, findSfx } from "../lib/sfxIndex.ts";
import { findBrowser } from "../steps/render.ts";

export interface HealthItem {
  key: string;
  label: string;
  ok: boolean;
  /** true = nur eine Einschränkung, kein Abbruchgrund */
  optional?: boolean;
  detail: string;
}

export async function health(cfg: Config, style: Style): Promise<HealthItem[]> {
  const items: HealthItem[] = [];
  const add = (i: HealthItem) => items.push(i);

  const ff = await exec("ffmpeg", ["-hide_banner", "-encoders"]).catch(() => null);
  add({ key: "ffmpeg", label: "ffmpeg (mit x265)", ok: !!ff && ff.code === 0 && /libx265/.test(ff.stdout.toString()), detail: ff && ff.code === 0 ? (/libx265/.test(ff.stdout.toString()) ? "gefunden" : "ffmpeg ohne libx265") : "nicht gefunden (brew install ffmpeg)" });

  const br = findBrowser(cfg);
  add({ key: "browser", label: "Chrome/Chromium für das Rendern", ok: true, optional: true, detail: br ? br : "wird beim ersten Rendern von Remotion geladen" });

  const mp = await exec("python3", ["-c", "import mediapipe"]).catch(() => null);
  add({ key: "mediapipe", label: "Kinn-Messung (MediaPipe)", ok: !!mp && mp.code === 0, optional: true, detail: mp && mp.code === 0 ? "gefunden" : "fehlt: pip install mediapipe opencv-python-headless. Ohne sie wird mit festem Ersatzwert gerendert" });

  const fw = await exec("python3", ["-c", "import faster_whisper"]).catch(() => null);
  const hasFw = !!fw && fw.code === 0;
  const hasOpenai = !!process.env.OPENAI_API_KEY;
  add({ key: "transcribe", label: "Transkription", ok: hasOpenai || hasFw, detail: hasOpenai ? "OpenAI Whisper (Schlüssel gesetzt)" : hasFw ? "lokal mit faster-whisper" : "weder OPENAI_API_KEY noch faster-whisper (pip install faster-whisper)" });

  const hasClaude = !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  add({ key: "anthropic", label: "Claude (Plan und Selfcheck)", ok: hasClaude, detail: hasClaude ? "Schlüssel gesetzt" : "ANTHROPIC_API_KEY fehlt (in .env eintragen)" });

  const stockKeys = [process.env.PEXELS_API_KEY ? "Pexels" : null, process.env.PIXABAY_API_KEY ? "Pixabay" : null].filter(Boolean);
  add({ key: "stock", label: "Stock-B-Rolls", ok: stockKeys.length > 0, optional: true, detail: stockKeys.length ? `Zugang: ${stockKeys.join(", ")}` : "PEXELS_API_KEY / PIXABAY_API_KEY fehlen: Stock-B-Rolls sind nicht möglich" });

  try {
    fs.mkdirSync(cfg.runsPath, { recursive: true });
    const st = fs.statfsSync(cfg.runsPath);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    const totalGb = (st.blocks * st.bsize) / 1e9;
    add({ key: "disk", label: "Speicherplatz", ok: freeGb >= 2, optional: freeGb >= 0.5, detail: `${freeGb.toFixed(1)} GB frei von ${totalGb.toFixed(1)} GB${freeGb < 2 ? ". Zu wenig: Volume bei Railway vergrößern oder alte Läufe löschen" : ""}` });
  } catch {
    /* statfs nicht verfügbar */
  }

  const missingFonts = (["weiss", "gold", "ki"] as const).map((k) => style.params.layout.schrift[k].datei).filter((f) => !fs.existsSync(path.join(cfg.fontsDir, f)));
  add({ key: "fonts", label: "Original-Schriften", ok: missingFonts.length === 0, optional: true, detail: missingFonts.length ? `fehlen in ${cfg.fontsDir}: ${missingFonts.join(", ")}` : "vorhanden" });

  try {
    const idx = buildSfxIndex(cfg.sfxLibrary);
    const need = Object.values(style.params.sfx.cues).map((c) => c.file);
    const missing = [...new Set(need)].filter((f) => !findSfx(idx, f));
    add({ key: "sfx", label: "SFX-Library", ok: missing.length === 0, detail: missing.length ? `${idx.length} Dateien, es fehlen: ${missing.join(", ")}` : `${idx.length} Dateien in ${cfg.sfxLibrary}` });
  } catch (e) {
    add({ key: "sfx", label: "SFX-Library", ok: false, detail: (e as Error).message.split("\n")[0]! });
  }
  return items;
}
