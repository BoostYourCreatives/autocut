import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

/** Legt einen neuen Editing-Stil als Kopie eines bestehenden an (z. B. für einen weiteren Kunden). Gibt den neuen Ordner zurück. */
export function createStyle(cfg: Config, name: string, from = cfg.style): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Der Name darf nur aus Kleinbuchstaben, Ziffern und Bindestrichen bestehen (z. B. \"max-muster\").");
  const root = path.dirname(cfg.stylePath);
  const src = path.join(root, from), dest = path.join(root, name);
  if (!fs.existsSync(src)) throw new Error(`Der Stil "${from}" existiert nicht (gesucht in ${root}).`);
  if (fs.existsSync(dest)) throw new Error(`Der Stil "${name}" gibt es schon.`);
  fs.cpSync(src, dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, "NEUER-STIL.md"),
    `# Stil "${name}"\n\nAngelegt als Kopie von "${from}". Noch nichts hier ist auf den neuen Kunden angepasst.\n\n## Das musst du ersetzen\n\n1. **regeln.md**: die Regeln des neuen Kunden (MUSS / STANDARD / VERBOTEN), in eigenen Worten, mit Begründung.\n2. **style.json**: die maschinenlesbare Fassung (Schriften, Farben, Untertitel, Zooms, B-Roll, Übergänge).\n3. **params.json**: alle Zahlen, die der Code liest (Layout, Zoom, Sound, Export). Die Felder \`_quelle\` und \`_todo\` zeigen, woher ein Wert kommt.\n4. **beispiel-plan_*.json**: ein bis zwei fertige Schnitte des Kunden als Beispiel für Claude (sehr wichtig für die Qualität).\n5. Schriften in assets/fonts und Sounds in der SFX-Library bereitstellen.\n\nStarten mit diesem Stil: Umgebungsvariable \`AUTOCUT_STYLE=${name}\` setzen (Railway: Variables) oder in config/autocut.config.json \`"style": "${name}"\`.\nOffene Platzhalter anzeigen: \`AUTOCUT_STYLE=${name} npx tsx src/cli.ts todos\`.\n`,
  );
  return dest;
}
