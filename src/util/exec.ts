import { spawn } from "node:child_process";
import { threads } from "./threads.ts";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** ffmpeg mit begrenzter Thread-Zahl für Decoder, Filter und Encoder (sonst nutzt es alle Kerne des Servers). */
export function limitFfmpegThreads(args: string[], n = threads()): string[] {
  if (args.includes("-threads")) return args;
  const out: string[] = ["-filter_threads", String(n), "-filter_complex_threads", String(n)];
  args.forEach((a) => {
    if (a === "-i") out.push("-threads", String(n));
    out.push(a);
  });
  // letztes Argument ist die Ausgabe: Encoder-Threads davor
  out.splice(out.length - 1, 0, "-threads", String(n));
  return out;
}

export function exec(cmd: string, argsIn: string[]): Promise<ExecResult> {
  const args = cmd === "ffmpeg" ? limitFfmpegThreads(argsIn) : argsIn;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new Error(`${cmd} konnte nicht gestartet werden: ${e.message}`)));
    child.on("close", (code, signal) =>
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8") + (code === null ? `\n[Prozess vom System beendet: ${signal ?? "unbekannt"}]` : ""),
        code: code ?? -1,
      }),
    );
  });
}

/** Führt aus und wirft bei Exit-Code != 0. */
export async function execOk(cmd: string, args: string[]): Promise<ExecResult> {
  const r = await exec(cmd, args);
  if (r.code !== 0) {
    const killed = r.code === -1 ? "Der Prozess wurde vom System beendet, meist wegen zu wenig Arbeitsspeicher (Railway: Settings → Resources, Metrics prüfen). " : "";
    const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    const noSpace = /No space left on device|Disk quota exceeded/i.test(r.stderr);
    const hits = lines.filter((l) => /error|invalid|cannot|unable|failed|denied|no such|not found|space left|quota/i.test(l) && !/^\[libx26[45]/.test(l)).slice(-3);
    const why = noSpace ? "Der Speicherplatz auf dem Server ist voll (Railway: Volume vergrößern oder alte Läufe löschen). " : killed;
    throw new Error(`${why}${hits.length ? `${cmd}: ${hits.join(" | ")}\n` : ""}${cmd} ${args.slice(0, 12).join(" ")} …\nExit ${r.code}\n${lines.slice(-15).join("\n")}`);
  }
  return r;
}

export const ffmpeg = (args: string[]) => execOk("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args]);
