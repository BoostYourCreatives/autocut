import type { CutSegment } from "../schema/plan.ts";
import { round3 } from "../lib/intervals.ts";

export interface TimedSegment {
  id: number;
  raw_in_s: number;
  raw_out_s: number;
  out_from_s: number;
  out_to_s: number;
}

/** Ausgabe-Timeline aus der Segmentliste (Reihenfolge = Reihenfolge im Video). */
export function buildTimeline(segments: Pick<CutSegment, "id" | "raw_in_s" | "raw_out_s">[]): TimedSegment[] {
  let t = 0;
  return segments.map((s) => {
    const dur = s.raw_out_s - s.raw_in_s;
    const seg = { id: s.id, raw_in_s: s.raw_in_s, raw_out_s: s.raw_out_s, out_from_s: round3(t), out_to_s: round3(t + dur) };
    t += dur;
    return seg;
  });
}

export const outDuration = (tl: TimedSegment[]) => (tl.length ? tl[tl.length - 1]!.out_to_s : 0);

/** Findet das Segment, das die Rohzeit enthält (Toleranz an den Rändern). */
export function segmentAtRaw(tl: TimedSegment[], raw: number, tol = 0.0005): TimedSegment | undefined {
  return tl.find((s) => raw >= s.raw_in_s - tol && raw <= s.raw_out_s + tol);
}

export function rawToOut(tl: TimedSegment[], raw: number): { out: number; seg: TimedSegment } | null {
  const seg = segmentAtRaw(tl, raw);
  if (!seg) return null;
  const clamped = Math.min(Math.max(raw, seg.raw_in_s), seg.raw_out_s);
  return { out: round3(seg.out_from_s + (clamped - seg.raw_in_s)), seg };
}

export const toFrame = (t: number, fps: number) => Math.round(t * fps);
export const quantize = (t: number, fps: number) => round3(Math.round(t * fps) / fps);
