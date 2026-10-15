/** Zahlen im deutschen Format (Komma) für Begründungen und Meldungen. */
export const de1 = (n: number) => n.toFixed(1).replace(".", ",");
export const de2 = (n: number) => n.toFixed(2).replace(".", ",");
/** m:ss,s für Zeitpunkte in "Hier genauer hinschauen" */
export function mmss(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0").replace(".", ",")}`;
}

/** m:ss ohne Nachkommastelle, für die Hinweisliste */
export function mmssShort(t: number): string {
  const total = Math.max(0, Math.round(t));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
