import fs from "node:fs";
import path from "node:path";
import { log } from "../util/log.ts";

const BASE = "https://api.higgsfield.ai";

/** Zugang aus der Umgebungsvariable HIGGSFIELD_API_KEY ("<id>:<secret>"), nie im Code oder Repo. */
export function higgsfieldKey(): string | null {
  const k = (process.env.HIGGSFIELD_API_KEY ?? "").trim();
  return k.includes(":") ? k : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ImageRequest {
  prompt: string;
  /** z. B. "9:16" (Hochformat), "3:4", "1:1" */
  aspect?: string;
  /** Modellpfad, Standard: Soul V2 */
  model?: string;
}

/** Erzeugt ein Bild bei Higgsfield und speichert es unter `out`. Wirft bei Fehlern mit verständlicher Meldung. */
export async function generateImage(req: ImageRequest, out: string): Promise<string> {
  const key = higgsfieldKey();
  if (!key) throw new Error("HIGGSFIELD_API_KEY fehlt (Railway: Variables, Format <id>:<secret>).");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const model = req.model ?? "higgsfield-ai/soul/v2/standard";
  const body: Record<string, unknown> = { prompt: req.prompt, ...(req.aspect ? { aspect_ratio: req.aspect } : {}) };
  const sub = await fetch(`${BASE}/${model}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!sub.ok) throw new Error(`Higgsfield lehnt die Anfrage ab (${sub.status}): ${(await sub.text()).slice(0, 300)}`);
  const job = (await sub.json()) as { request_id: string; status_url?: string };
  const statusUrl = job.status_url ?? `${BASE}/requests/${job.request_id}/status`;
  const t0 = Date.now();
  for (;;) {
    await sleep(2500);
    const r = await fetch(statusUrl, { headers });
    if (!r.ok) throw new Error(`Higgsfield Status ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const s = (await r.json()) as { status: string; images?: { url: string }[] };
    if (s.status === "completed") {
      const url = s.images?.[0]?.url;
      if (!url) throw new Error("Higgsfield hat kein Bild geliefert.");
      const img = await fetch(url);
      if (!img.ok) throw new Error(`Bild konnte nicht geladen werden (${img.status}).`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()));
      log.info(`higgsfield: Bild erzeugt in ${Math.round((Date.now() - t0) / 1000)} s → ${path.basename(out)}`);
      return out;
    }
    if (["failed", "nsfw", "canceled"].includes(s.status)) throw new Error(`Higgsfield: Bild nicht erzeugt (${s.status}).`);
    if (Date.now() - t0 > 180000) throw new Error("Higgsfield: Zeitüberschreitung beim Erzeugen des Bildes.");
  }
}
