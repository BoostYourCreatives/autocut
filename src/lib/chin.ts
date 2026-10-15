import type { Plan } from "../schema/plan.ts";
import type { StyleParams } from "../schema/style.ts";
import { layoutCaptions } from "../render/layout.ts";
import { cameraScale } from "./camera.ts";
import { buildTimeline } from "../plan/timeline.ts";

export interface ChinData {
  fps: number;
  width: number;
  height: number;
  every: number;
  /** [Rohframe, Kinn-y in px | null] */
  frames: [number, number | null][];
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

/** Anker AY = Median der gemessenen Kinn-y (style.json zooms_und_kamera.anker_AY). */
export function anchorY(chin: ChinData | null, fallback = 960): number {
  const ys = chin?.frames.map((f) => f[1]).filter((y): y is number => y !== null) ?? [];
  return ys.length ? Math.round(median(ys)) : fallback;
}

/** Kinn-y im Rohframe (letzte Messung davor, sonst nächste). */
function chinAtRaw(chin: ChinData, rawFrame: number): number | null {
  const i = Math.min(chin.frames.length - 1, Math.max(0, Math.floor(rawFrame / chin.every)));
  for (let k = i; k >= 0; k--) if (chin.frames[k]![1] !== null) return chin.frames[k]![1];
  for (let k = i + 1; k < chin.frames.length; k++) if (chin.frames[k]![1] !== null) return chin.frames[k]![1];
  return null;
}

export interface ChinCheck {
  /** Mindest-DY, damit in jedem Frame der Abstand eingehalten wird */
  requiredDy: number;
  /** Frames, in denen Text mit dem gegebenen DY zu nah am Kinn liegt */
  violations: { frame: number; t_s: number; captionId: number; gap_px: number }[];
  anchorY: number;
}

/**
 * Prüft Text gegen Kinn für jeden Ausgabeframe (Kinn mit Kamera-Zoom hochgerechnet) und
 * berechnet das kleinste DY, das den Mindestabstand einhält (regeln.md MUSS 1).
 */
export function checkChin(plan: Plan, chin: ChinData, P: StyleParams, dy: number): ChinCheck {
  const fps = plan.source.fps;
  const AY = anchorY(chin);
  const tl = buildTimeline(plan.cut_segments);
  const total = tl[tl.length - 1]!.out_to_s;
  const nFrames = Math.round(total * fps);
  const margin = P.layout.kinn.mindestabstand_px;
  const cam = { hookPushTo: P.zoom.hook_push_nach, zoomRampFrames: P.zoom.rampe_frames };
  const geo0 = layoutCaptions(plan.captions, P, 0);
  const geoDy = layoutCaptions(plan.captions, P, dy);
  const byStart = [...plan.captions].sort((a, b) => a.start_s - b.start_s);
  let required = 0;
  const violations: ChinCheck["violations"] = [];
  for (let f = 0; f < nFrames; f++) {
    const t = f / fps;
    const seg = tl.find((s) => t >= s.out_from_s - 1e-9 && t < s.out_to_s - 1e-9);
    if (!seg) continue;
    const rawFrame = Math.round((seg.raw_in_s + (t - seg.out_from_s)) * fps);
    const y = chinAtRaw(chin, rawFrame);
    if (y === null) continue;
    const s = cameraScale(plan, fps, f, cam);
    const chinOut = AY + (y - AY) * s;
    for (const c of byStart) {
      if (c.start_s > t + 1e-9) break;
      if (c.end_s <= t + 1e-9) continue;
      const g0 = geo0.get(c.id)!;
      required = Math.max(required, Math.ceil(chinOut + margin - g0.top));
      const gap = geoDy.get(c.id)!.top - chinOut;
      if (gap < margin - 0.5) violations.push({ frame: f, t_s: t, captionId: c.id, gap_px: Math.round(gap) });
    }
  }
  return { requiredDy: Math.max(0, required), violations, anchorY: AY };
}
