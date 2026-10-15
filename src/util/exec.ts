import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new Error(`${cmd} konnte nicht gestartet werden: ${e.message}`)));
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 }),
    );
  });
}

/** Führt aus und wirft bei Exit-Code != 0. */
export async function execOk(cmd: string, args: string[]): Promise<ExecResult> {
  const r = await exec(cmd, args);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}\nExit ${r.code}\n${r.stderr.split("\n").slice(-15).join("\n")}`);
  }
  return r;
}

export const ffmpeg = (args: string[]) => execOk("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args]);
