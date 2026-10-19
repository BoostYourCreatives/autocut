import React from "react";
import { Composition } from "remotion";
import { Reel, type ReelProps } from "./Reel.tsx";
import { MotionsBack, MotionsFront, type MotionsProps } from "./Motions.tsx";

/** Eine Composition "Reel": Länge, fps und Größe kommen aus dem Plan (inputProps). */
export const Root: React.FC = () => (
  <>
  <Composition
    id="MotionsBack"
    component={MotionsBack as unknown as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30}
    defaultProps={{} as Record<string, unknown>}
    calculateMetadata={({ props }) => {
      const p = props as unknown as MotionsProps & { fps: number; durationFrames: number };
      return { fps: p.fps, durationInFrames: Math.max(1, p.durationFrames) };
    }}
  />
  <Composition
    id="MotionsFront"
    component={MotionsFront as unknown as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30}
    defaultProps={{} as Record<string, unknown>}
    calculateMetadata={({ props }) => {
      const p = props as unknown as MotionsProps & { fps: number; durationFrames: number };
      return { fps: p.fps, durationInFrames: Math.max(1, p.durationFrames) };
    }}
  />
  <Composition
    id="Reel"
    component={Reel as unknown as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30}
    defaultProps={{} as Record<string, unknown>}
    calculateMetadata={({ props }) => {
      const p = props as unknown as ReelProps;
      const fps = p.plan.source.fps;
      const last = p.plan.cut_segments.reduce((a, s) => a + (s.raw_out_s - s.raw_in_s), 0);
      return { fps, width: p.plan.source.width, height: p.plan.source.height, durationInFrames: Math.max(1, Math.round(last * fps)) };
    }}
  />
  </>
);
