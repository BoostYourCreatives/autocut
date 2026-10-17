import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption, Plan } from "../../schema/plan.ts";
import type { StyleParams } from "../../schema/style.ts";
import { layoutCaptions, type CaptionGeometry } from "../layout.ts";

export type Layout = StyleParams["layout"];

export function stackFor(L: Layout, key: "weiss" | "gold" | "ki", fonts: Record<string, string>) {
  const s = L.schrift[key];
  return fonts[s.familie] ? `"${s.familie}", ${s.fallback}` : s.fallback;
}

/** Animation der Einblendung → CSS (alle Werte aus layout.animation) */
function animate(c: Caption, rel: number, L: Layout): React.CSSProperties {
  const A = L.animation;
  const outQuad = Easing.out(Easing.quad);
  switch (c.animation) {
    case "mini": {
      const s = interpolate(rel, [0, A.mini.frames], [A.mini.scale_von, 1], { extrapolateRight: "clamp", easing: outQuad });
      return { transform: `translateY(-50%) scale(${s})` };
    }
    case "pop": {
      const s = interpolate(rel, A.pop.frames, A.pop.scale, { extrapolateRight: "clamp", easing: outQuad });
      const o = interpolate(rel, [0, 1], [A.pop.opacity_von, 1], { extrapolateRight: "clamp" });
      return { transform: `translateY(-50%) scale(${s})`, opacity: o };
    }
    case "slide": {
      const x = interpolate(rel, [0, A.slide.frames_x], [A.slide.x_von, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
      const o = interpolate(rel, [0, A.slide.frames_opacity], [0, 1], { extrapolateRight: "clamp" });
      return { transform: `translateY(-50%) translateX(${x}px)`, opacity: o };
    }
    case "rise": {
      const y = interpolate(rel, [0, A.rise.frames_y], [A.rise.y_von, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
      const o = interpolate(rel, [0, A.rise.frames_opacity], [0, 1], { extrapolateRight: "clamp" });
      return { transform: `translateY(calc(-50% + ${y}px))`, opacity: o };
    }
    case "wipe": {
      const pos = interpolate(rel, [0, L.wipe.frames], [-L.wipe.kante_prozent, 100], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
      const mask = `linear-gradient(90deg, #000 ${pos}%, transparent ${pos + L.wipe.kante_prozent}%)`;
      return { transform: "translateY(-50%)", WebkitMaskImage: mask, maskImage: mask };
    }
    default:
      return { transform: "translateY(-50%)" };
  }
}

const CaptionView: React.FC<{ c: Caption; g: CaptionGeometry; L: Layout; fonts: Record<string, string> }> = ({ c, g, L, fonts }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = Math.round(c.start_s * fps);
  const end = Math.round(c.end_s * fps);
  if (frame < start || frame >= end) return null;
  const rel = frame - start;
  const fk = g.font;
  const gold = c.kind === "gold" || c.kind === "cta";
  const base: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    top: g.yCenter,
    textAlign: "center",
    whiteSpace: "pre",
    lineHeight: 1,
    fontFamily: stackFor(L, fk, fonts),
    fontWeight: L.schrift[fk].gewicht,
    fontStyle: L.schrift[fk].kursiv ? "italic" : "normal",
    fontSize: g.size,
    letterSpacing: `${L.schrift[fk].letter_spacing_em}em`,
    color: c.color,
    textShadow: gold ? L.schatten.gold : L.schatten.weiss,
    WebkitFontSmoothing: "antialiased",
    textRendering: "geometricPrecision",
    ...(g.stroke ? { WebkitTextStroke: `${g.stroke}px ${c.color}`, paintOrder: "stroke fill" } : {}),
    ...animate(c, rel, L),
  };
  if (c.animation === "words" && c.word_offsets_frames) {
    return (
      <div style={base}>
        {c.word_offsets_frames.map(([w, off], i) => {
          const r = rel - off;
          const o = r < 0 ? 0 : interpolate(r, [0, 1], [L.animation.words.opacity_von, 1], { extrapolateRight: "clamp" });
          const s = r < 0 ? L.animation.words.scale_von : interpolate(r, [0, L.animation.words.frames], [L.animation.words.scale_von, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
          return (
            <span key={i} style={{ display: "inline-block", opacity: o, transform: `scale(${s})`, transformOrigin: "50% 60%", whiteSpace: "pre" }}>
              {w}
              {i < c.word_offsets_frames!.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    );
  }
  if (c.animation === "wipe") {
    // Maske mit Padding, damit Unterlängen nicht abgeschnitten werden (Fix Reel 36)
    return (
      <div style={{ ...base }}>
        <span style={{ display: "inline-block", padding: L.wipe.maske_padding, margin: "-0.4em -16px" }}>{c.text}</span>
      </div>
    );
  }
  return <div style={base}>{c.text}</div>;
};

const HookBox: React.FC<{ lines: string[]; L: Layout; fonts: Record<string, string> }> = ({ lines, L, fonts }) => {
  const H = L.hook_box;
  const [pt, pr, pb, pl] = H.padding;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: H.top, display: "flex", justifyContent: "center" }}>
      <div style={{ background: H.farbe_hintergrund, borderRadius: H.radius, padding: `${pt}px ${pr}px ${pb}px ${pl}px`, textAlign: "center" }}>
        {lines.map((l, i) => (
          <div key={i} style={{ fontFamily: stackFor(L, "weiss", fonts), fontWeight: L.schrift.weiss.gewicht, fontSize: H.size, lineHeight: H.zeilenhoehe, letterSpacing: `${H.letter_spacing_em}em`, color: H.farbe_text, textTransform: "uppercase", whiteSpace: "pre" }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
};


/** Alles, was über dem Bild liegt und Text ist: Untertitel, Hook-Box, KI-Hinweis. Eigene Ebene, damit Texte ohne neues Videorendern änderbar sind. */
export const CaptionsLayer: React.FC<{ plan: Pick<Plan, "captions" | "overlays">; L: Layout; DY: number; fonts: Record<string, string> }> = ({ plan, L, DY, fonts }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const geo = React.useMemo(() => layoutCaptions(plan.captions, { layout: L } as StyleParams, DY), [plan.captions, L, DY]);
  const hookBox = plan.overlays.find((o) => o.type === "hook_box");
  const ki = plan.overlays.find((o) => o.type === "ki_hinweis");
  const inRange = (a: number, b: number) => frame >= Math.round(a * fps) && frame < Math.round(b * fps);
  return (
    <>
      {plan.captions.map((c) => (
        <CaptionView key={c.id} c={c} g={geo.get(c.id)!} L={L} fonts={fonts} />
      ))}
      {hookBox && hookBox.type === "hook_box" && inRange(hookBox.start_s, hookBox.end_s) ? <HookBox lines={hookBox.lines} L={L} fonts={fonts} /> : null}
      {ki && ki.type === "ki_hinweis" && inRange(ki.start_s, ki.end_s) ? (
        <div
          style={{
            position: "absolute", left: 0, right: 0, top: L.ki_hinweis.y_mitte, transform: "translateY(-50%)", textAlign: "center", color: "#fff",
            fontFamily: stackFor(L, "ki", fonts), fontSize: L.ki_hinweis.size, letterSpacing: `${L.ki_hinweis.letter_spacing_em}em`, textShadow: L.schatten.ki, whiteSpace: "pre",
          }}
        >
          {ki.text}
        </div>
      ) : null}
    </>
  );
};
