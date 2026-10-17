import React from "react";
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from "remotion";
import type { Plan } from "../../schema/plan.ts";
import type { StyleParams } from "../../schema/style.ts";
import { buildTimeline } from "../../plan/timeline.ts";
import { cameraScale } from "../../lib/camera.ts";
import { CaptionsLayer, type Layout } from "./Captions.tsx";


export interface ReelProps {
  plan: Plan;
  /** Nur der Layout-Teil von params.json plus Kamera-Werte: alle Maße kommen aus dem Stil, nicht aus dem Code */
  params: { layout: Layout; zoom: { hook_push_nach: number; rampe_frames: number } };
  DY: number;
  AY: number;
  /** Dateiname des Proxys in public/ */
  videoFile: string;
  /** Schriftdateien in public/fonts, die wirklich vorhanden sind: familie → Datei */
  fonts: Record<string, string>;
  /** B-Roll-Slot-ID → Datei in public/broll (nur Slots mit aufgelöster Quelle) */
  broll: Record<number, string>;
  /** "base" = Bild ohne Texte, "captions" = nur Texte auf transparentem Grund, Standard "all" */
  layer?: "all" | "base" | "captions";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function useFonts(fonts: Record<string, string>) {
  const [handle] = React.useState(() => delayRender("Schriften laden"));
  React.useEffect(() => {
    Promise.all(
      Object.entries(fonts).map(async ([family, file]) => {
        const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`);
        await face.load();
        document.fonts.add(face);
      }),
    )
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [fonts, handle]);
}

export const Reel: React.FC<ReelProps> = ({ plan, params, DY, AY, videoFile, fonts, broll, layer = "all" }) => {
  useFonts(fonts);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const L = params.layout;
  const tl = buildTimeline(plan.cut_segments);
  const scale = cameraScale(plan, fps, frame, { hookPushTo: params.zoom.hook_push_nach, zoomRampFrames: params.zoom.rampe_frames });

  const hookBox = plan.overlays.find((o) => o.type === "hook_box");

  // Gold-Blitz am Hook-Ende (nur bei Übergang blitz_riser)
  const flashF = hookBox ? Math.round(hookBox.end_s * fps) : -999;
  const rel = frame - flashF;
  const B = L.blitz;
  const warm = plan.hook?.transition === "blitz_riser" ? interpolate(rel, B.warm_frames, B.warm_opacity, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }) : 0;
  const white = plan.hook?.transition === "blitz_riser" ? interpolate(rel, B.weiss_frames, B.weiss_opacity, { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

  return (
    <AbsoluteFill style={{ background: layer === "captions" ? undefined : "#000" }}>
      {layer !== "captions" ? (
        <>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `540px ${AY}px` }}>
        {tl.map((s) => {
          const from = Math.round(s.out_from_s * fps);
          const dur = Math.max(1, Math.round(s.out_to_s * fps) - from);
          return (
            <Sequence key={s.id} from={from} durationInFrames={dur}>
              <OffthreadVideo src={staticFile(videoFile)} startFrom={Math.round(s.raw_in_s * fps)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </Sequence>
          );
        })}
      </AbsoluteFill>

      {plan.broll.map((b) => {
        const file = broll[b.id];
        if (!file) return null; // Quelle noch offen: nichts rendern
        const from = Math.round(b.start_s * fps);
        const dur = Math.max(1, Math.round(b.end_s * fps) - from);
        const z = interpolate(frame - from, [0, dur], [L.b_roll.zoom_von, L.b_roll.zoom_bis], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const fade = interpolate(frame - from, [0, L.b_roll.shade_einblenden_frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const [ew, eh] = L.b_roll.shade_ellipse;
        const a = b.shade_alpha;
        return (
          <Sequence key={`b${b.id}`} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ transform: `scale(${z})`, transformOrigin: `${L.b_roll.origin[0]}px ${L.b_roll.origin[1]}px` }}>
              <OffthreadVideo src={staticFile(`broll/${file}`)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </AbsoluteFill>
            <AbsoluteFill style={{ opacity: fade, background: `radial-gradient(ellipse ${ew}px ${eh}px at 540px ${L.b_roll.shade_cy + DY}px, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${a * 0.6}) 55%, rgba(0,0,0,0) 100%)` }} />
          </Sequence>
        );
      })}
        </>
      ) : null}

      {layer !== "base" ? <CaptionsLayer plan={plan} L={L} DY={DY} fonts={fonts} /> : null}

      {layer !== "captions" && warm > 0 ? <AbsoluteFill style={{ opacity: warm, background: B.warm_verlauf, mixBlendMode: "screen" }} /> : null}
      {layer !== "captions" && white > 0 ? <AbsoluteFill style={{ opacity: white, background: B.weiss_verlauf }} /> : null}
    </AbsoluteFill>
  );
};
