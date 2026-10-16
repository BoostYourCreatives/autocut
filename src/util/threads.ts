import os from "node:os";

/**
 * Wie viele Rechenkerne die schweren Programme (ffmpeg, x265, Whisper, Chrome) nutzen dürfen.
 * In Containern melden die Programme oft ALLE Kerne des Servers (z. B. 60), starten entsprechend viele
 * Arbeitsschritte und überschreiten den Arbeitsspeicher. Deshalb gilt eine feste Obergrenze.
 * Einstellbar mit AUTOCUT_THREADS (Standard: Kerne des Rechners, höchstens 8).
 */
export function threads(): number {
  const env = parseInt(process.env.AUTOCUT_THREADS ?? "", 10);
  if (env > 0) return env;
  return Math.max(1, Math.min(8, os.cpus().length));
}

/** Parallele Chrome-Tabs beim Rendern (jeder braucht mehrere hundert MB). */
export function renderConcurrency(): number {
  const env = parseInt(process.env.AUTOCUT_CONCURRENCY ?? "", 10);
  if (env > 0) return env;
  return Math.max(1, Math.floor(threads() / 2));
}
