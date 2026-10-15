const stamp = () => new Date().toISOString().slice(11, 19);

type Level = "info" | "warn" | "error";
/** Zusätzliche Empfänger für Log-Zeilen (die Web-Oberfläche zeigt sie live an). */
export const logListeners = new Set<(level: Level, msg: string) => void>();

const emit = (level: Level, m: string) => {
  const line = `[${stamp()}] ${level === "warn" ? "WARNUNG " : level === "error" ? "FEHLER " : ""}${m}`;
  console.error(line);
  for (const l of logListeners) l(level, m);
};

export const log = {
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
