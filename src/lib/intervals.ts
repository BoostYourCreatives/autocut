export interface Span {
  start_s: number;
  end_s: number;
}
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function withDuration<T extends Span>(s: T): T & { duration_s: number } {
  return { ...s, start_s: round3(s.start_s), end_s: round3(s.end_s), duration_s: round3(s.end_s - s.start_s) };
}

/** Zieht `cut` von `base` ab. Ergebnis: Reststücke von `base`, die ≥ minLen lang sind. */
export function subtractSpans(base: Span[], cut: Span[], minLen = 0): Span[] {
  const sortedCut = [...cut].sort((a, b) => a.start_s - b.start_s);
  const out: Span[] = [];
  for (const b of base) {
    let pieces: Span[] = [{ start_s: b.start_s, end_s: b.end_s }];
    for (const c of sortedCut) {
      const next: Span[] = [];
      for (const p of pieces) {
        if (c.end_s <= p.start_s || c.start_s >= p.end_s) {
          next.push(p);
          continue;
        }
        if (c.start_s > p.start_s) next.push({ start_s: p.start_s, end_s: c.start_s });
        if (c.end_s < p.end_s) next.push({ start_s: c.end_s, end_s: p.end_s });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out.filter((p) => p.end_s - p.start_s >= minLen);
}
