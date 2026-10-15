const stamp = () => new Date().toISOString().slice(11, 19);
export const log = {
  info: (m: string) => console.error(`[${stamp()}] ${m}`),
  warn: (m: string) => console.error(`[${stamp()}] WARNUNG ${m}`),
  error: (m: string) => console.error(`[${stamp()}] FEHLER ${m}`),
};
