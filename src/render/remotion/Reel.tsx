import React from "react";
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from "remotion";
import type { Caption, Plan } from "../../schema/plan.ts";
import type { StyleParams } from "../../schema/style.ts";
import { buildTimeline } from "../../plan/timeline.ts";
import { cameraScale } from "../../lib/camera.ts";
import { layoutCaptions, type CaptionGeometry } from "../layout.ts";

type Layout = StyleParams["layout"];

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

function stackFor(L: Layout, key: "weiss" | "gold" | "ki", fonts: Record<string, string>) {
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

export const Reel: React.FC<ReelProps> = ({ plan, params, DY, AY, videoFile, fonts, broll }) => {
  useFonts(fonts);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const L = params.layout;
  const tl = buildTimeline(plan.cut_segments);
  const scale = cameraScale(plan, fps, frame, { hookPushTo: params.zoom.hook_push_nach, zoomRampFrames: params.zoom.rampe_frames });
  const geo = React.useMemo(() => layoutCaptions(plan.captions, { layout: L } as StyleParams, DY), [plan.captions, L, DY]);

  const hookBox = plan.overlays.find((o) => o.type === "hook_box");
  const ki = plan.overlays.find((o) => o.type === "ki_hinweis");
  const inRange = (a: number, b: number) => frame >= Math.round(a * fps) && frame < Math.round(b * fps);

  // Gold-Blitz am Hook-Ende (nur bei Übergang blitz_riser)
  const flashF = hookBox ? Math.round(hookBox.end_s * fps) : -999;
  const rel = frame - flashF;
  const B = L.blitz;
  const warm = plan.hook?.transition === "blitz_riser" ? interpolate(rel, B.warm_frames, B.warm_opacity, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) }) : 0;
  const white = plan.hook?.transition === "blitz_riser" ? interpolate(rel, B.weiss_frames, B.weiss_opacity, { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

  return (
    <AbsoluteFill style={{ background: "#000" }}>
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

      {warm > 0 ? <AbsoluteFill style={{ opacity: warm, background: B.warm_verlauf, mixBlendMode: "screen" }} /> : null}
      {white > 0 ? <AbsoluteFill style={{ opacity: white, background: B.weiss_verlauf }} /> : null}
    </AbsoluteFill>
  );
};
