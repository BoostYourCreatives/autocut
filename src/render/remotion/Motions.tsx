import React from "react";
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from "remotion";

export interface MotionsWord {
  text: string;
  /** Betontes Wort: große kursive Serif in der Akzentfarbe */
  emph?: boolean;
}
export interface MotionsChunk {
  start_s: number;
  end_s: number;
  words: MotionsWord[];
}
export interface MotionsProps {
  chunks: MotionsChunk[];
  accent: string;
  /** y-Mitte des Untertitelblocks (Brust) */
  y: number;
  fonts: { sans: string; serif: string };
}

const SANS = "MotionsSans";
const SERIF = "MotionsSerif";

function useFonts(fonts: MotionsProps["fonts"]) {
  const [handle] = React.useState(() => delayRender("Schriften laden"));
  React.useEffect(() => {
    const css = `@font-face{font-family:${SANS};src:url(${staticFile("fonts/" + fonts.sans)}) format("woff2");font-weight:800}
@font-face{font-family:${SERIF};src:url(${staticFile("fonts/" + fonts.serif)}) format("woff2");font-style:italic;font-weight:700}`;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    Promise.all([document.fonts.load(`800 40px ${SANS}`), document.fonts.load(`italic 700 40px ${SERIF}`)])
      .catch(() => undefined)
      .finally(() => continueRender(handle));
    return () => el.remove();
  }, [fonts.sans, fonts.serif, handle]);
}

const SANS_SIZE = 60;
const SERIF_MAX = 200;
/** Nutzbare Breite für Text (links und rechts je 90 px Rand), damit nie etwas über den Bildrand läuft */
const MAX_W = 900;
let ctx: CanvasRenderingContext2D | null = null;
/** Schriftgröße, bei der der Text wirklich in MAX_W passt (gemessen mit der geladenen Schrift) */
function fit(text: string, font: string, size: number): number {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return size;
  ctx.font = `${font.replace("{s}", String(size))}`;
  const w = ctx.measureText(text).width;
  return w > MAX_W ? Math.floor((size * MAX_W) / w) : size;
}

const ChunkView: React.FC<{ c: MotionsChunk; y: number; accent: string }> = ({ c, y, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = Math.round(c.start_s * fps);
  const b = Math.max(a + 2, Math.round(c.end_s * fps));
  if (frame < a || frame >= b) return null;
  const rel = frame - a;
  const out = interpolate(frame, [b - 3, b], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pre: MotionsWord[] = [];
  const post: MotionsWord[] = [];
  let emph: MotionsWord | null = null;
  for (const w of c.words) {
    if (w.emph && !emph) emph = w;
    else (emph ? post : pre).push(w);
  }
  const serifSize = emph ? fit(emph.text, `italic 700 {s}px ${SERIF}`, SERIF_MAX) : 0;
  const sansSize = (ws: MotionsWord[]) => fit(ws.map((w) => w.text).join(" "), `800 {s}px ${SANS}`, SANS_SIZE);
  const ease = Easing.out(Easing.cubic);
  const wordStyle = (i: number): React.CSSProperties => {
    const r = rel - i * 2;
    const t = interpolate(r, [0, 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
    return { opacity: t, filter: `blur(${(1 - t) * 10}px)`, transform: `translateY(${(1 - t) * 14}px) scale(${0.92 + 0.08 * t})` };
  };
  const sans = (ws: MotionsWord[], off: number) =>
    ws.length ? (
      <div style={{ fontFamily: `${SANS}, sans-serif`, fontWeight: 800, fontSize: sansSize(ws), color: "#fff", lineHeight: 1.1, textShadow: "0 4px 18px rgba(0,0,0,0.35)", whiteSpace: "pre" }}>
        {ws.map((w, i) => (
          <span key={i} style={{ display: "inline-block", marginRight: i < ws.length - 1 ? 16 : 0, ...wordStyle(off + i) }}>{w.text}</span>
        ))}
      </div>
    ) : null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: y, transform: "translateY(-50%)", display: "flex", flexDirection: "column", alignItems: "center", opacity: out }}>
      {sans(pre, 0)}
      {emph ? (
        <div
          style={{
            fontFamily: `${SERIF}, serif`, fontStyle: "italic", fontWeight: 700, fontSize: serifSize, lineHeight: 1, color: accent, margin: "-6px 0",
            textShadow: `0 0 42px ${accent}8c, 0 6px 24px rgba(0,0,0,0.3)`, whiteSpace: "pre", ...wordStyle(pre.length),
          }}
        >
          {emph.text}
        </div>
      ) : null}
      {sans(post, pre.length + 1)}
    </div>
  );
};

/** Vordere Ebene (transparent): Untertitel im motions-Stil. */
export const MotionsFront: React.FC<MotionsProps> = ({ chunks, accent, y, fonts }) => {
  useFonts(fonts);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {chunks.map((c, i) => (
        <ChunkView key={i} c={c} y={y} accent={accent} />
      ))}
    </div>
  );
};
