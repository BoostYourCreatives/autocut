import type { Plan } from "../schema/plan.ts";
import { buildTimeline } from "../plan/timeline.ts";

/** Cosine-Ease 0..1 (style.json: 0.5 - 0.5*cos(pi*x)) */
export const cosEase = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

export interface CameraParams {
  hookPushTo: number;
  zoomRampFrames: number;
}

/**
 * Kamera-Maßstab im Ausgabeframe `f`: Hook-Push 100→106 % über den Hook (Frame 1 bis Blitz),
 * Zoom: weiche Rampe (24 Frames) bis zum Wert, dann halten bis zum Segmentende; am nächsten
 * Segment hart zurück auf 100 %. Wird vom Renderer UND von der Kinn-Prüfung benutzt.
 */
export function cameraScale(plan: Pick<Plan, "cut_segments" | "zooms" | "hook">, fps: number, f: number, cam: CameraParams): number {
  const tl = buildTimeline(plan.cut_segments);
  const t = f / fps;
  const seg = tl.find((s) => t >= s.out_from_s - 1e-9 && t < s.out_to_s - 1e-9) ?? tl[tl.length - 1]!;
  if (seg.id === tl[0]!.id && plan.hook?.push) {
    const endF = Math.round(seg.out_to_s * fps);
    const x = (f - 1) / Math.max(1, endF - 1);
    return 1 + (cam.hookPushTo - 1) * cosEase(x);
  }
  const z = plan.zooms.find((zz) => zz.segment_id === seg.id);
  if (z) {
    const startF = Math.round(z.start_s * fps);
    if (f >= startF) return 1 + (z.to_scale - 1) * cosEase((f - startF) / cam.zoomRampFrames);
  }
  return 1;
}
