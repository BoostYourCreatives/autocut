import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT, type Config, type Style } from "../config.ts";
import type { LlmClient } from "../llm/client.ts";
import { Plan } from "../schema/plan.ts";
import { validatePlanFile } from "../steps/check.ts";
import { planPaths } from "../steps/plan.ts";
import { summarizeRun } from "../steps/report.ts";
import { readRunLog } from "../util/runlog.ts";
import { runPaths } from "../util/run.ts";
import { health } from "./health.ts";
import { createAuth, loginPage } from "./auth.ts";
import { assetDir, listAssets, MAX_ASSET_MB, MAX_BROLL_MB, safeAssetName, type AssetKind } from "./assets.ts";
import { pruneModelCache } from "../util/modelCache.ts";
import { applyCaptionEdits } from "../steps/captionEdit.ts";
import { approveRun } from "../steps/approve.ts";
import { hasLayeredRender, baseVideoFile } from "../steps/render.ts";
import { JobRunner, STEP_ORDER, type JobOptions } from "./jobs.ts";

const STEP_LABEL: Record<string, string> = {
  ingest: "Einlesen",
  transcribe: "Transkription",
  analyze: "Analyse",
  chin: "Kinn-Messung",
  broll: "B-Rolls",
  plan: "Schnittplan",
  render: "Video bauen",
};

const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "reel";
const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage, max = 8e6): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) reject(new Error("Anfrage zu groß"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** Schreibt den Request-Body in eine Datei; bricht ab und löscht sie, wenn das Limit überschritten wird. Gibt true zurück bei Überschreitung. */
function saveLimited(req: http.IncomingMessage, dest: string, max: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let n = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max && !over) {
        over = true;
        req.unpipe(ws);
        ws.destroy();
        fs.rmSync(dest, { force: true });
        resolve(true);
      }
    });
    req.pipe(ws);
    ws.on("finish", () => !over && resolve(false));
    ws.on("error", (e) => (over ? undefined : reject(e)));
    req.on("error", reject);
  });
}

export interface ServerOptions {
  cfg: Config;
  style: Style;
  port?: number;
  host?: string;
  llm?: LlmClient;
  /** Gemeinsames Passwort; ohne Passwort ist die Oberfläche offen (nur lokal sinnvoll) */
  password?: string;
  /** Größtes erlaubtes Video in MB */
  maxUploadMb?: number;
  /** Läufe älter als so viele Tage werden automatisch gelöscht (0 = nie) */
  retentionDays?: number;
  /** Läufe ohne fertiges Video werden nach so vielen Tagen gelöscht (Standard 2) */
  unfinishedDays?: number;
}

export function startServer(o: ServerOptions): Promise<{ server: http.Server; url: string; jobs: JobRunner }> {
  const { cfg, style } = o;
  const jobs = new JobRunner(cfg, style, o.llm);
  const auth = createAuth(o.password);
  const maxUpload = (o.maxUploadMb ?? 500) * 1024 * 1024;
  const runDir = (name: string) => runPaths(cfg, name).dir;
  const validName = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n);

  const listRuns = () => {
    if (!fs.existsSync(cfg.runsPath)) return [];
    return fs
      .readdirSync(cfg.runsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(cfg.runsPath, d.name, "run.json")))
      .map((d) => {
        const dir = path.join(cfg.runsPath, d.name);
        const job = jobs.jobs.get(d.name);
        const hasVideo = fs.existsSync(path.join(dir, "out")) && fs.readdirSync(path.join(dir, "out")).some((f) => f.endsWith(".mp4"));
        const interrupted = !job && fs.existsSync(path.join(dir, "job.json"));
        const status = interrupted ? "error" : job?.status === "running" ? "running" : job?.status === "error" ? "error" : hasVideo ? "done" : fs.existsSync(path.join(dir, "fehlerbericht.md")) ? "error" : "idle";
        return { name: d.name, status, mtime: fs.statSync(path.join(dir, "run.json")).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  };

  const detail = (name: string) => {
    const dir = runDir(name);
    if (!fs.existsSync(path.join(dir, "run.json"))) return null;
    const job = jobs.jobs.get(name);
    const log = readRunLog(runPaths(cfg, name));
    const uiStep = (s: string) => (s.startsWith("render") || s === "selfcheck" ? "render" : s.startsWith("broll") ? "broll" : s);
    const steps = STEP_ORDER.map((key) => {
      const entries = log.steps.filter((s) => uiStep(s.step) === key);
      const last = entries[entries.length - 1];
      const secs = entries.reduce((a, e) => a + e.duration_ms / 1000, 0);
      const status = job?.status === "running" && job.current === key ? "running" : last ? (last.status === "error" ? "error" : "ok") : "pending";
      return { key, label: STEP_LABEL[key], status, seconds: Math.round(secs * 10) / 10 };
    });
    const out: Record<string, unknown> = { name, steps, job: job ? { status: job.status, current: job.current, error: job.error, kind: job.kind } : null };
    out.layered = hasLayeredRender(dir) && !fs.existsSync(path.join(dir, "approved.json"));
    if (fs.existsSync(path.join(dir, "approved.json"))) out.approved = JSON.parse(fs.readFileSync(path.join(dir, "approved.json"), "utf8"));
    if (!job && fs.existsSync(path.join(dir, "job.json"))) out.interrupted = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));

    const planFile = planPaths(runPaths(cfg, name)).plan;
    if (fs.existsSync(planFile)) {
      try {
        const plan = Plan.parse(JSON.parse(fs.readFileSync(planFile, "utf8")));
        const v = validatePlanFile(cfg, style, planFile).result;
        out.validation = { ok: v.ok, errors: v.errors, warnings: v.warnings, notChecked: v.notChecked, stats: v.stats };
        out.video = plan.video;
        out.hook = plan.hook ? { lines: plan.hook.lines, transition: plan.hook.transition, reason: plan.hook.reason, confidence: plan.hook.confidence, origin: plan.hook.text_origin } : null;
        const dec: { t_s: number; typ: string; text: string; reason: string; confidence: string }[] = [];
        const tlOut = (raw: number) => {
          let t = 0;
          for (const s of plan.cut_segments) {
            if (raw <= s.raw_out_s) return t;
            t += s.raw_out_s - s.raw_in_s;
          }
          return t;
        };
        for (const r of plan.removed) if (!["pause", "leerlauf_anfang", "leerlauf_ende"].includes(r.kind)) dec.push({ t_s: tlOut(r.raw_from_s), typ: r.kind, text: `${r.raw_from_s.toFixed(1)}–${r.raw_to_s.toFixed(1)} s Rohzeit entfernt`, reason: r.reason, confidence: r.confidence });
        for (const c of plan.captions) if (c.kind !== "weiss" && c.layout !== "stack_oben" && c.layout !== "stack_unten" && c.layout !== "liste_kopf") dec.push({ t_s: c.start_s, typ: c.kind === "gold" ? "Gold" : c.kind === "cta" ? "CTA" : "Zitat", text: c.text, reason: c.reason, confidence: c.confidence });
        for (const z of plan.zooms) dec.push({ t_s: z.start_s, typ: "Zoom", text: `auf ${z.to_scale}`, reason: z.reason, confidence: z.confidence });
        for (const b of plan.broll) dec.push({ t_s: b.start_s, typ: "B-Roll", text: b.motif + (b.source.kind === "offen" ? " (kein Video)" : "info" in b.source && b.source.info ? ` (${b.source.info})` : ""), reason: b.reason, confidence: b.confidence });
        for (const s of plan.sfx) if (!["riser", "shutter"].includes(s.role)) dec.push({ t_s: Math.max(0, s.at_s), typ: "Sound", text: s.file, reason: s.reason, confidence: s.confidence });
        out.captions = plan.captions.map((c) => ({ id: c.id, text: c.text, start_s: c.start_s, end_s: c.end_s, kind: c.kind }));
        out.decisions = dec.sort((a, b) => a.t_s - b.t_s);
        const outDir = path.join(runDir(name), "out");
        const j = (f: string) => (fs.existsSync(path.join(outDir, f)) ? JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")) : null);
        out.hinschauen = j(`${plan.video}.hinschauen.json`);
        out.selfcheck = j(`${plan.video}.selfcheck.json`);
        const mp4 = `${plan.video}.mp4`;
        if (fs.existsSync(path.join(outDir, mp4))) out.files = { video: `/media/${name}/${mp4}`, hinschauen: `/media/${name}/${plan.video}.hinschauen.md`, plan: `/api/runs/${name}/plan`, bericht: `/api/runs/${name}/report` };
      } catch (e) {
        out.planError = (e as Error).message.split("\n")[0];
      }
    }
    // Warum wurde der Plan abgelehnt? (letzte Versuche)
    const attDir = path.join(dir, "plan-attempts");
    if (fs.existsSync(attDir) && !out.validation) {
      const files = fs.readdirSync(attDir).filter((f) => f.endsWith(".json")).sort();
      out.attempts = files.map((f) => {
        const a = JSON.parse(fs.readFileSync(path.join(attDir, f), "utf8"));
        const lines: string[] = a.issues ?? (a.errors ? a.errors.map((e: { code: string; message: string }) => `[${e.code}] ${e.message}`) : a.feedback ? [a.feedback] : []);
        return { attempt: a.attempt, stage: a.stage, lines: lines.slice(0, 8), structured_error: a.structured_error ?? null };
      });
    }
    out.summary = summarizeRun(dir);
    return out;
  };

  let editorJs: Promise<string> | null = null;
  const editorBundle = () => (editorJs ??= import("esbuild").then(async (esbuild) => {
    const r = await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "ui", "editor", "preview.tsx")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2020",
      jsx: "automatic", minify: true, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    });
    return r.outputFiles[0]!.text;
  }));

  const cleanup = () => {
    if (!fs.existsSync(cfg.runsPath)) return;
    const limit = o.retentionDays ? Date.now() - o.retentionDays * 864e5 : 0;
    // Unfertige oder fehlgeschlagene Läufe (kein Video) räumen wir viel früher weg, sie belegen nur Platz
    const unfinishedLimit = Date.now() - (o.unfinishedDays ?? 2) * 864e5;
    for (const d of fs.readdirSync(cfg.runsPath, { withFileTypes: true })) {
      if (!d.isDirectory() || jobs.busyRun === d.name) continue;
      const dir = path.join(cfg.runsPath, d.name);
      const f = path.join(dir, "run.json");
      if (!fs.existsSync(f)) continue;
      const age = fs.statSync(f).mtimeMs;
      const outDir = path.join(dir, "out");
      const hasVideo = fs.existsSync(outDir) && fs.readdirSync(outDir).some((x) => x.endsWith(".mp4"));
      if ((limit && age < limit) || (!hasVideo && age < unfinishedLimit)) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  cleanup();
  try {
    pruneModelCache(cfg);
  } catch {
    /* nicht kritisch */
  }
  const cleanupTimer = setInterval(cleanup, 6 * 3600e3);
  cleanupTimer?.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const m = (re: RegExp) => p.match(re);

      // ---- offen: Gesundheitscheck der Plattform, Anmeldung ----
      if (p === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      if (p === "/login") {
        if (req.method === "POST") {
          const body = new URLSearchParams(await readBody(req, 4096));
          const r = auth.login(req, body.get("password") ?? "");
          if (r.ok) {
            res.writeHead(303, { location: "/", "set-cookie": r.cookie });
            return res.end();
          }
          res.writeHead(r.locked ? 429 : 401, { "content-type": "text/html; charset=utf-8" });
          return res.end(loginPage(r.locked ? "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen." : "Passwort falsch."));
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(loginPage());
      }
      if (p === "/logout" && req.method === "POST") {
        res.writeHead(303, { location: "/login", "set-cookie": auth.logoutCookie(req) });
        return res.end();
      }
      // ---- alles andere nur angemeldet ----
      if (!auth.isAuthed(req)) {
        if (p.startsWith("/api/") || p.startsWith("/media/")) return json(res, 401, { error: "Nicht angemeldet" });
        res.writeHead(303, { location: "/login" });
        return res.end();
      }
      if (req.method !== "GET" && !auth.sameOrigin(req)) return json(res, 403, { error: "Anfrage von fremder Seite abgelehnt" });

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(path.join(ROOT, "src", "ui", "index.html")));
      }
      if (req.method === "GET" && p === "/api/health") return json(res, 200, { items: await health(cfg, style), busy: jobs.busyRun, auth: auth.enabled });
      if (req.method === "GET" && p === "/api/runs") return json(res, 200, listRuns());

      if (req.method === "POST" && p === "/api/upload") {
        const filename = url.searchParams.get("filename") ?? "video.mp4";
        const opts = JSON.parse(url.searchParams.get("o") ?? "{}") as Omit<Partial<JobOptions>, "transition"> & { name?: string; hook1?: string; hook2?: string; transition?: string };
        let name = slug(opts.name || filename);
        for (let n = 2; fs.existsSync(runDir(name)); n++) name = `${slug(opts.name || filename)}-${n}`;
        const inDir = path.join(runDir(name), "input");
        fs.mkdirSync(inDir, { recursive: true });
        const dest = path.join(inDir, filename.replace(/[^A-Za-z0-9._-]+/g, "_"));
        if (!/\.(mp4|mov|m4v)$/i.test(dest)) {
          fs.rmSync(runDir(name), { recursive: true, force: true });
          return json(res, 415, { error: "Bitte ein Video als mp4 oder mov hochladen." });
        }
        if (Number(req.headers["content-length"] ?? 0) > maxUpload) {
          fs.rmSync(runDir(name), { recursive: true, force: true });
          return json(res, 413, { error: `Das Video ist größer als ${Math.round(maxUpload / 1048576)} MB.` });
        }
        const tooBig = await saveLimited(req, dest, maxUpload);
        if (tooBig) {
          fs.rmSync(runDir(name), { recursive: true, force: true });
          return json(res, 413, { error: `Das Video ist größer als ${Math.round(maxUpload / 1048576)} MB.` });
        }
        const jo: JobOptions = {
          precut: opts.precut === undefined ? "auto" : opts.precut,
          provider: opts.provider ?? "auto",
          selfcheck: opts.selfcheck !== false,
          brollOwn: opts.brollOwn === true,
          brollStock: opts.brollStock === true,
          transition: opts.transition === "blitz" ? "blitz_riser" : opts.transition === "hart" ? "hart" : undefined,
          hookLines: opts.hook1 && opts.hook2 ? [opts.hook1, opts.hook2] : undefined,
          video: `TW_Reel_${name}`,
        };
        try {
          jobs.start(name, "pipeline", jo, dest);
        } catch (e) {
          fs.rmSync(runDir(name), { recursive: true, force: true });
          return json(res, 409, { error: (e as Error).message });
        }
        return json(res, 200, { name });
      }

      let mm: RegExpMatchArray | null;
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)$/))) {
        const d = validName(mm[1]!) ? detail(mm[1]!) : null;
        return d ? json(res, 200, d) : json(res, 404, { error: "Run nicht gefunden" });
      }
      if (req.method === "GET" && p === "/editor.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(await editorBundle());
      }
      if (req.method === "GET" && (mm = m(/^\/api\/fonts\/([^/]+)$/))) {
        const file = path.basename(decodeURIComponent(mm[1]!));
        const f = path.join(cfg.fontsDir, file);
        if (!/\.(ttf|otf)$/i.test(file) || !fs.existsSync(f)) return json(res, 404, { error: "Schrift nicht gefunden" });
        res.writeHead(200, { "content-type": /\.otf$/i.test(file) ? "font/otf" : "font/ttf", "cache-control": "max-age=86400" });
        return fs.createReadStream(f).pipe(res);
      }
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)\/preview-data$/))) {
        const name = mm[1]!;
        const planFile = planPaths(runPaths(cfg, name)).plan;
        if (!validName(name) || !fs.existsSync(planFile) || !hasLayeredRender(runDir(name))) return json(res, 404, { error: "Keine Live-Vorschau für diesen Lauf" });
        const plan = Plan.parse(JSON.parse(fs.readFileSync(planFile, "utf8")));
        const info = JSON.parse(fs.readFileSync(path.join(runDir(name), "render", "render-info.json"), "utf8")) as { DY: number };
        const fonts: Record<string, string> = {};
        for (const key of ["weiss", "gold", "ki"] as const) {
          const sch = style.params.layout.schrift[key];
          if (fs.existsSync(path.join(cfg.fontsDir, sch.datei))) fonts[sch.familie] = sch.datei;
        }
        const total = plan.cut_segments.reduce((a, s) => a + (s.raw_out_s - s.raw_in_s), 0);
        return json(res, 200, {
          plan: { captions: plan.captions, overlays: plan.overlays }, L: style.params.layout, DY: info.DY, fps: plan.source.fps,
          width: plan.source.width, height: plan.source.height, durationInFrames: Math.max(1, Math.round(total * plan.source.fps)), fonts,
        });
      }
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)\/base$/))) {
        const name = mm[1]!;
        const file = baseVideoFile(runDir(name));
        if (!validName(name) || !fs.existsSync(file)) return json(res, 404, { error: "Keine Basis-Vorschau" });
        const size = fs.statSync(file).size;
        const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        if (range) {
          const start = range[1] ? parseInt(range[1]) : 0;
          const end = range[2] ? Math.min(parseInt(range[2]), size - 1) : size - 1;
          res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "POST" && (mm = m(/^\/api\/runs\/([^/]+)\/approve$/))) {
        const name = mm[1]!;
        if (!validName(name) || !fs.existsSync(path.join(runDir(name), "run.json"))) return json(res, 404, { error: "Run nicht gefunden" });
        if (jobs.busyRun === name) return json(res, 409, { error: "Der Lauf ist noch aktiv." });
        const mp4s = fs.existsSync(path.join(runDir(name), "out")) ? fs.readdirSync(path.join(runDir(name), "out")).filter((f) => f.endsWith(".mp4")) : [];
        if (!mp4s.length) return json(res, 409, { error: "Es gibt noch kein fertiges Video zum Abnehmen." });
        return json(res, 200, approveRun(runDir(name)));
      }
      if (req.method === "DELETE" && (mm = m(/^\/api\/runs\/([^/]+)$/))) {
        const name = mm[1]!;
        if (!validName(name) || !fs.existsSync(path.join(runDir(name), "run.json"))) return json(res, 404, { error: "Run nicht gefunden" });
        if (jobs.busyRun === name) return json(res, 409, { error: "Der Lauf ist noch aktiv." });
        fs.rmSync(runDir(name), { recursive: true, force: true });
        jobs.jobs.delete(name);
        return json(res, 200, { deleted: true });
      }
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)\/events$/))) {
        const job = jobs.jobs.get(mm[1]!);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        if (!job) return res.end();
        const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        job.events.forEach(send);
        if (job.status !== "running") return res.end();
        job.listeners.add(send);
        // Keep-alive: Proxys (Railway & Co.) schließen stille Verbindungen sonst nach kurzer Zeit
        const beat = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(beat);
          job.listeners.delete(send);
        });
        return;
      }
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)\/plan$/))) {
        const f = planPaths(runPaths(cfg, mm[1]!)).plan;
        if (!validName(mm[1]!) || !fs.existsSync(f)) return json(res, 404, { error: "Noch kein Plan" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="plan.json"` });
        return res.end(fs.readFileSync(f));
      }
      if (req.method === "GET" && (mm = m(/^\/api\/runs\/([^/]+)\/report$/))) {
        const f = path.join(runDir(mm[1]!), "laufbericht.md");
        if (!validName(mm[1]!) || !fs.existsSync(f)) return json(res, 404, { error: "Noch kein Bericht" });
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(fs.readFileSync(f));
      }
      if (req.method === "POST" && (mm = m(/^\/api\/runs\/([^/]+)\/plan\/(check|save)$/))) {
        const name = mm[1]!;
        if (!validName(name)) return json(res, 400, { error: "Ungültiger Name" });
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return json(res, 422, { ok: false, errors: [{ code: "json", message: `Kein gültiges JSON: ${(e as Error).message}` }], warnings: [] });
        }
        const tmp = path.join(runDir(name), "plan.edit.json");
        fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
        let v;
        try {
          v = validatePlanFile(cfg, style, tmp).result;
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          return json(res, 422, { ok: false, errors: [{ code: "schema", message: (e as Error).message.split("\n").slice(0, 6).join(" | ") }], warnings: [] });
        }
        if (mm[2] === "check" || !v.ok) {
          fs.rmSync(tmp, { force: true });
          return json(res, v.ok ? 200 : 422, { ok: v.ok, errors: v.errors, warnings: v.warnings });
        }
        // speichern (Sicherung der alten Fassung) und neu rendern
        const dest = planPaths(runPaths(cfg, name)).plan;
        if (fs.existsSync(dest)) fs.copyFileSync(dest, path.join(runDir(name), "plan.prev.json"));
        fs.renameSync(tmp, dest);
        const sc = url.searchParams.get("selfcheck") !== "0";
        try {
          jobs.start(name, "rerender", { precut: "auto", provider: "auto", selfcheck: sc });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true, started: true });
      }
      if (req.method === "POST" && (mm = m(/^\/api\/runs\/([^/]+)\/captions$/))) {
        const name = mm[1]!;
        if (!validName(name) || !fs.existsSync(path.join(runDir(name), "run.json"))) return json(res, 404, { error: "Run nicht gefunden" });
        if (fs.existsSync(path.join(runDir(name), "approved.json"))) return json(res, 409, { error: "Das Video ist schon abgenommen, das Rohmaterial ist gelöscht." });
        const planFile = planPaths(runPaths(cfg, name)).plan;
        if (!fs.existsSync(planFile)) return json(res, 404, { error: "Noch kein Plan" });
        let edits: { id: number; text: string }[];
        try {
          edits = (JSON.parse(await readBody(req)) as { edits: { id: number; text: string }[] }).edits;
          if (!Array.isArray(edits) || !edits.every((e) => Number.isInteger(e.id) && typeof e.text === "string")) throw new Error("edits fehlt");
        } catch {
          return json(res, 400, { error: "Bitte {edits:[{id,text}]} senden." });
        }
        const { plan, changed } = applyCaptionEdits(Plan.parse(JSON.parse(fs.readFileSync(planFile, "utf8"))), edits);
        if (!changed) return json(res, 200, { ok: true, started: false, changed: 0 });
        const tmp = path.join(runDir(name), "plan.edit.json");
        fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
        let v;
        try {
          v = validatePlanFile(cfg, style, tmp).result;
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          return json(res, 422, { ok: false, error: (e as Error).message.split("\n").slice(0, 3).join(" ") });
        }
        if (!v.ok) {
          fs.rmSync(tmp, { force: true });
          return json(res, 422, { ok: false, error: `Der geänderte Text verletzt eine Regel: ${v.errors.map((x) => x.message).slice(0, 3).join(" | ")}` });
        }
        fs.copyFileSync(planFile, path.join(runDir(name), "plan.prev.json"));
        fs.renameSync(tmp, planFile);
        // Mit getrennter Text-Ebene: nur die geänderten Texte neu rendern, Bild und Ton bleiben
        const layered = hasLayeredRender(runDir(name));
        try {
          jobs.start(name, layered ? "recaption" : "rerender", { precut: "auto", provider: "auto", selfcheck: false, captionIds: edits.map((e) => e.id) });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true, started: true, changed, fast: layered });
      }
      if (req.method === "POST" && (mm = m(/^\/api\/runs\/([^/]+)\/replan$/))) {
        const name = mm[1]!;
        const o2 = JSON.parse((await readBody(req)) || "{}") as { selfcheck?: boolean; transition?: string; hook1?: string; hook2?: string };
        try {
          jobs.start(name, "replan", {
            precut: "auto", provider: "auto", selfcheck: o2.selfcheck !== false, video: `TW_Reel_${name}`,
            transition: o2.transition === "blitz" ? "blitz_riser" : o2.transition === "hart" ? "hart" : undefined,
            hookLines: o2.hook1 && o2.hook2 ? [o2.hook1, o2.hook2] : undefined,
          });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
        return json(res, 200, { started: true });
      }

      if (p === "/api/assets") {
        const kind = url.searchParams.get("kind") as AssetKind | null;
        if (req.method === "GET") return json(res, 200, listAssets(cfg, style));
        if ((kind !== "sfx" && kind !== "fonts" && kind !== "broll") || !["POST", "DELETE"].includes(req.method ?? "")) return json(res, 400, { error: "kind=sfx|fonts|broll angeben" });
        const name = safeAssetName(kind, url.searchParams.get("filename") ?? "");
        if (!name) return json(res, 415, { error: kind === "sfx" ? "Nur Audiodateien (mp3, wav, m4a, aiff, flac, ogg)." : kind === "broll" ? "Nur Videodateien (mp4, mov, m4v, webm)." : "Nur Schriftdateien (ttf, otf)." });
        const dest = path.join(assetDir(cfg, kind), name);
        if (req.method === "DELETE") {
          fs.rmSync(dest, { force: true });
          return json(res, 200, listAssets(cfg, style));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const lim = kind === "broll" ? MAX_BROLL_MB : MAX_ASSET_MB;
        if (await saveLimited(req, dest, lim * 1048576)) return json(res, 413, { error: `Datei größer als ${lim} MB.` });
        return json(res, 200, listAssets(cfg, style));
      }

      if (req.method === "GET" && (mm = m(/^\/media\/([^/]+)\/(.+)$/))) {
        const base = path.join(runDir(mm[1]!), "out");
        const file = path.normalize(path.join(base, decodeURIComponent(mm[2]!)));
        if (!validName(mm[1]!) || !file.startsWith(base + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: "Datei nicht gefunden" });
        const size = fs.statSync(file).size;
        const type = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".md") ? "text/markdown; charset=utf-8" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
        const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        if (range) {
          const start = range[1] ? parseInt(range[1]) : 0;
          const end = range[2] ? Math.min(parseInt(range[2]), size - 1) : size - 1;
          res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
        return fs.createReadStream(file).pipe(res);
      }
      json(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(o.port ?? 3000, o.host ?? "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://${o.host ?? "127.0.0.1"}:${addr.port}`, jobs });
    });
  });
}
