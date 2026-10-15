import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Liest und validiert eine JSON-Datei, mit lesbarer Fehlermeldung. */
export function readJsonSchema<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  if (!fs.existsSync(file)) throw new Error(`Datei fehlt: ${file}`);
  const r = schema.safeParse(readJson(file));
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${file} entspricht nicht dem Schema:\n${issues}`);
  }
  return r.data;
}
