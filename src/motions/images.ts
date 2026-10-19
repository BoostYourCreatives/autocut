import fs from "node:fs";
import path from "node:path";
import { generateImage, higgsfieldKey } from "./higgsfield.ts";
import { imageName, scenePrompts } from "./scenes.ts";
import { log } from "../util/log.ts";
import type { MotionsScene } from "../render/remotion/Motions.tsx";

const ASPECT: Record<string, string> = { fullscreen_image: "9:16", back_card: "4:3", image_row: "3:4" };

const STYLE_SUFFIX = " Authentic photo, natural light, realistic, no text, no logos, no watermarks.";

/**
 * Erzeugt die Bilder aller Szenen (Higgsfield) und speichert sie unter dir. Schon vorhandene Dateien werden nicht neu erzeugt.
 * Szenen, deren Bild nicht entsteht (kein Schlüssel, kein Guthaben, Fehler), werden entfernt, damit das Video trotzdem fertig wird.
 */
export async function generateSceneImages(scenes: MotionsScene[], dir: string): Promise<{ scenes: MotionsScene[]; warnings: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const warnings: string[] = [];
  const failed = new Set<string>();
  const todo = new Map<string, string>();
  for (const s of scenes) for (const p of scenePrompts(s)) if (!fs.existsSync(path.join(dir, imageName(p)))) todo.set(p, s.type);
  if (todo.size && !higgsfieldKey()) warnings.push("HIGGSFIELD_API_KEY fehlt: Szenen mit Bildern werden weggelassen.");
  else {
    let i = 0;
    for (const [prompt, type] of todo) {
      i++;
      try {
        log.info(`bilder: ${i}/${todo.size} erzeugen …`);
        await generateImage({ prompt: prompt + STYLE_SUFFIX, aspect: ASPECT[type] ?? "3:4" }, path.join(dir, imageName(prompt)));
      } catch (e) {
        failed.add(prompt);
        const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        warnings.push(`Bild nicht erzeugt (${msg})`);
        if (/not_enough_credits|403/.test(msg)) break; // weitere Versuche wären sinnlos
      }
    }
  }
  const ok = (p: string) => fs.existsSync(path.join(dir, imageName(p)));
  const kept = scenes.filter((s) => {
    const ps = scenePrompts(s);
    if (!ps.length) return true;
    if (ps.every(ok)) return true;
    warnings.push(`Szene ${s.type} bei ${s.start_s} s entfällt (Bild fehlt).`);
    return false;
  });
  return { scenes: kept, warnings };
}
