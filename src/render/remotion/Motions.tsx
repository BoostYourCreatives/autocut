import React from "react";
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from "remotion";

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
/** Szenen: was zusätzlich zu den Untertiteln im Bild erscheint (siehe style/motions/regeln.md) */
export type MotionsScene =
  | { type: "fullscreen_image"; start_s: number; end_s: number; image: string; image_prompt?: string }
  | { type: "back_card"; start_s: number; end_s: number; image: string; image_prompt?: string }
  | { type: "image_row"; start_s: number; end_s: number; items: { image: string; tag?: string; image_prompt?: string }[]; title?: string; label?: string }
  | { type: "glass_panel"; start_s: number; end_s: number; text: string; label?: string }
  | { type: "number_item"; start_s: number; end_s: number; n: number; text: string; icon?: string };

export interface MotionsProps {
  chunks: MotionsChunk[];
  scenes: MotionsScene[];
  /** Hintergrundverlauf (zwei Farben), nur in der hinteren Ebene */
  bg: [string, string];
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
const SERIF_MAX = 150;
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

// ---------------------------------------------------------------------------------------------
// Szenen-Bausteine
// ---------------------------------------------------------------------------------------------
const INK = "#27346b";
const img = (n: string) => staticFile(`scene/${n}`);

/** Einblenden wie in den Inspos: aus der Unschärfe, mit leichtem Federn; kurzes Ausblenden */
function useEnter(a: number, b: number, delay = 0) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rel = frame - a - delay;
  const sp = spring({ frame: rel, fps, config: { damping: 15, stiffness: 140, mass: 0.7 } });
  const blur = interpolate(rel, [0, 9], [14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = interpolate(frame, [b - 5, b], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return { rel, sp, blur, op: Math.min(interpolate(rel, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), out), frame };
}

const glass: React.CSSProperties = {
  background: "linear-gradient(160deg, rgba(255,255,255,0.55), rgba(255,255,255,0.22))",
  border: "2px solid rgba(255,255,255,0.75)",
  boxShadow: "0 18px 50px rgba(40,60,120,0.28), inset 0 2px 6px rgba(255,255,255,0.9), inset 0 -6px 14px rgba(120,150,220,0.18)",
};

const Frame: React.FC<{ a: number; b: number; delay?: number; children: React.ReactNode; style?: React.CSSProperties; from?: number }> = ({ a, b, delay = 0, children, style, from = 40 }) => {
  const { sp, blur, op } = useEnter(a, b, delay);
  return (
    <div style={{ position: "absolute", opacity: op, filter: `blur(${blur}px)`, transform: `translateY(${(1 - sp) * from}px) scale(${0.9 + 0.1 * sp})`, ...style }}>{children}</div>
  );
};

const frames = (s: { start_s: number; end_s: number }, fps: number): [number, number] => [Math.round(s.start_s * fps), Math.round(s.end_s * fps)];

/** Glas-Feld: kleine Zeile oben, großes Wort in einem weißen Eingabefeld (wie "Full Service") */
const GlassPanel: React.FC<{ s: Extract<MotionsScene, { type: "glass_panel" }>; fps: number; y: number }> = ({ s, fps, y }) => {
  const [a, b] = frames(s, fps);
  const size = fit(s.text, `800 {s}px ${SANS}`, 74);
  return (
    <Frame a={a} b={b} style={{ left: 0, right: 0, top: y, display: "flex", justifyContent: "center" }}>
      <div style={{ ...glass, borderRadius: 38, padding: "18px 22px 22px", minWidth: 380, maxWidth: 940, textAlign: "center" }}>
        {s.label ? <div style={{ fontFamily: `${SERIF}, serif`, fontStyle: "italic", fontWeight: 700, fontSize: 40, color: INK, opacity: 0.85, textAlign: "left", padding: "0 10px 6px" }}>{s.label}</div> : null}
        <div style={{ background: "linear-gradient(180deg,#fff,#eef2ff)", borderRadius: 26, padding: "14px 34px", boxShadow: "inset 0 3px 10px rgba(80,100,180,0.25)" }}>
          <span style={{ fontFamily: `${SANS}, sans-serif`, fontWeight: 800, fontSize: Math.min(size, 74), color: "#5a74e8", textShadow: "0 0 18px rgba(110,140,255,0.55), 0 3px 0 rgba(255,255,255,0.9)", whiteSpace: "pre" }}>{s.text}</span>
        </div>
      </div>
    </Frame>
  );
};

/** Bilder-Reihe (1 bis 3 Karten) über dem Kopf, mit Preis-/Stichwort-Pillen unten und optionalem Glas-Titel */
const ImageRow: React.FC<{ s: Extract<MotionsScene, { type: "image_row" }>; fps: number }> = ({ s, fps }) => {
  const [a, b] = frames(s, fps);
  const n = s.items.length;
  const w = n === 1 ? 520 : n === 2 ? 380 : 290;
  const h = Math.round(w * 1.42);
  const gap = 26;
  const total = n * w + (n - 1) * gap;
  const x0 = (1080 - total) / 2;
  return (
    <>
      {s.title ? <GlassPanel s={{ type: "glass_panel", start_s: s.start_s, end_s: s.end_s, text: s.title, label: s.label }} fps={fps} y={120} /> : null}
      {s.items.map((it, i) => (
        <Frame key={i} a={a} b={b} delay={i * 3} from={70} style={{ left: x0 + i * (w + gap), top: s.title ? 400 : 230, width: w, height: h }}>
          <div style={{ width: w, height: h, borderRadius: 30, overflow: "hidden", border: "3px solid rgba(255,255,255,0.85)", boxShadow: "0 22px 55px rgba(30,40,90,0.35)", position: "relative", transform: `rotate(${n === 1 ? 0 : (i - (n - 1) / 2) * 2.2}deg)` }}>
            <Img src={img(it.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            {it.tag ? (
              <div style={{ position: "absolute", left: 18, right: 18, bottom: 18, ...glass, borderRadius: 22, padding: "8px 10px", textAlign: "center", fontFamily: `${SANS}, sans-serif`, fontWeight: 800, fontSize: 38, color: INK }}>{it.tag}</div>
            ) : null}
          </div>
        </Frame>
      ))}
    </>
  );
};

/** Nummerierter Glas-Streifen: Symbol-Kachel, Pfeil, Nummer und Text */
const NumberItem: React.FC<{ s: Extract<MotionsScene, { type: "number_item" }>; fps: number; y: number }> = ({ s, fps, y }) => {
  const [a, b] = frames(s, fps);
  const size = fit(s.text, `800 {s}px ${SANS}`, 46);
  return (
    <Frame a={a} b={b} style={{ left: 60, right: 60, top: y, display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ ...glass, borderRadius: 26, width: 112, height: 112, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 62 }}>{s.icon ?? "✦"}</div>
      <svg width="34" height="40" viewBox="0 0 34 40"><path d="M5 5 L29 20 L5 35 Z" fill="rgba(255,255,255,0.4)" stroke="#fff" strokeWidth="3" strokeLinejoin="round" /></svg>
      <div style={{ ...glass, borderRadius: 32, flex: 1, minHeight: 112, display: "flex", alignItems: "center", gap: 20, padding: "10px 26px 10px 14px" }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: "rgba(255,255,255,0.6)", boxShadow: "inset 0 2px 8px rgba(80,100,180,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: `${SANS}, sans-serif`, fontWeight: 800, fontSize: 52, color: "#5a74e8", flex: "none" }}>{s.n}</div>
        <div style={{ fontFamily: `${SANS}, sans-serif`, fontWeight: 800, fontSize: Math.min(size, 46), lineHeight: 1.15, color: INK }}>{s.text}</div>
      </div>
    </Frame>
  );
};

/** Vollbild-Bild (Zwischenschnitt): deckt Sprecher und Hintergrund ab, langsamer Zoom */
const Fullscreen: React.FC<{ s: Extract<MotionsScene, { type: "fullscreen_image" }>; fps: number }> = ({ s, fps }) => {
  const [a, b] = frames(s, fps);
  const frame = useCurrentFrame();
  if (frame < a || frame >= b) return null;
  const rel = frame - a;
  const op = interpolate(rel, [0, 4], [0, 1], { extrapolateRight: "clamp" }) * interpolate(frame, [b - 4, b], [1, 0], { extrapolateLeft: "clamp" });
  const zoom = 1 + 0.06 * (rel / Math.max(1, b - a));
  const blur = interpolate(rel, [0, 6], [12, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", inset: 0, opacity: op, overflow: "hidden", background: "#000" }}>
      <Img src={img(s.image)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${zoom})`, filter: `blur(${blur}px)` }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.0) 45%, rgba(0,0,0,0.35))" }} />
    </div>
  );
};

/** Große Bildkarte HINTER dem Sprecher (er ragt in sie hinein) */
const BackCard: React.FC<{ s: Extract<MotionsScene, { type: "back_card" }>; fps: number }> = ({ s, fps }) => {
  const [a, b] = frames(s, fps);
  return (
    <Frame a={a} b={b} from={60} style={{ left: 70, top: 120, width: 940, height: 760 }}>
      <div style={{ width: 940, height: 760, borderRadius: 44, overflow: "hidden", border: "4px solid rgba(255,255,255,0.9)", boxShadow: "0 26px 70px rgba(30,40,90,0.38)" }}>
        <Img src={img(s.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    </Frame>
  );
};

/** Hintere Ebene (deckend): Farbverlauf und Grafiken, die hinter dem Sprecher liegen */
export const MotionsBack: React.FC<MotionsProps> = ({ scenes, bg }) => {
  const { fps } = useVideoConfig();
  return (
    <div style={{ position: "absolute", inset: 0, background: `linear-gradient(165deg, ${bg[0]}, ${bg[1]})` }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 75%, rgba(255,255,255,0.45), rgba(255,255,255,0) 60%)" }} />
      {scenes.filter((s) => s.type === "back_card").map((s, i) => (
        <BackCard key={i} s={s as Extract<MotionsScene, { type: "back_card" }>} fps={fps} />
      ))}
    </div>
  );
};

/** Vordere Ebene (transparent): Zwischenschnitte, Karten, Glas-Felder, Untertitel */
export const MotionsFront: React.FC<MotionsProps> = ({ chunks, scenes, accent, y, fonts }) => {
  const { fps } = useVideoConfig();
  useFonts(fonts);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {scenes.map((s, i) => {
        switch (s.type) {
          case "fullscreen_image": return <Fullscreen key={i} s={s} fps={fps} />;
          case "image_row": return <ImageRow key={i} s={s} fps={fps} />;
          case "glass_panel": return <GlassPanel key={i} s={s} fps={fps} y={1130} />;
          case "number_item": return <NumberItem key={i} s={s} fps={fps} y={1130} />;
          default: return null;
        }
      })}
      {chunks.map((c, i) => (
        <ChunkView key={i} c={c} y={y} accent={accent} />
      ))}
    </div>
  );
};
