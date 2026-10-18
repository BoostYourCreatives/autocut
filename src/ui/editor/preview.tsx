import React from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { AbsoluteFill } from "remotion";
import { CaptionsLayer, type Layout } from "../../render/remotion/Captions.tsx";
import type { Plan } from "../../schema/plan.ts";
import { wordOffsets } from "../../steps/captionEdit.ts";

/** Daten, die der Server für die Live-Vorschau liefert (/api/runs/<name>/preview-data) */
export interface PreviewData {
  plan: Pick<Plan, "captions" | "overlays">;
  L: Layout;
  DY: number;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Schriftfamilie → Dateiname (liegt unter /api/fonts/<Datei>) */
  fonts: Record<string, string>;
}

interface Props {
  plan: PreviewData["plan"];
  L: Layout;
  DY: number;
  fonts: Record<string, string>;
}

const Texts: React.FC<Props> = (p) => (
  <AbsoluteFill>
    <CaptionsLayer plan={p.plan} L={p.L} DY={p.DY} fonts={p.fonts} />
  </AbsoluteFill>
);

export interface PreviewController {
  /** Text und/oder Zeiten eines Untertitels vorläufig ändern (null = zurück auf den gespeicherten Stand) */
  setEdit(id: number, edit: { text?: string; start_s?: number; end_s?: number } | null): void;
  /** Aktuelle Zeit des Videos übernehmen */
  /** Hook-Text vorläufig ändern (null = gespeicherter Stand) */
  setHook(lines: [string, string] | null): void;
  seek(t: number): void;
  destroy(): void;
}

async function loadFonts(fonts: Record<string, string>) {
  await Promise.all(
    Object.entries(fonts).map(async ([family, file]) => {
      const face = new FontFace(family, `url(/api/fonts/${encodeURIComponent(file)})`);
      await face.load();
      document.fonts.add(face);
    }),
  ).catch(() => undefined);
}

/** Legt die Text-Ebene als transparente Remotion-Vorschau über das Video und hält sie mit dem Video synchron. */
async function mount(host: HTMLElement, data: PreviewData, video: HTMLVideoElement): Promise<PreviewController> {
  await loadFonts(data.fonts);
  const ref = React.createRef<PlayerRef>();
  let edits: Record<number, { text?: string; start_s?: number; end_s?: number }> = {};
  let hook: [string, string] | null = null;
  const root = createRoot(host);
  const render = () => {
    const captions = data.plan.captions.map((c) => {
      const e = edits[c.id];
      if (!e) return c;
      const text = e.text ?? c.text;
      return { ...c, text, word_offsets_frames: e.text !== undefined ? wordOffsets(c, e.text) : c.word_offsets_frames, start_s: e.start_s ?? c.start_s, end_s: e.end_s ?? c.end_s };
    });
    root.render(
      <Player
        ref={ref}
        component={Texts}
        inputProps={{ plan: { captions, overlays: hook ? data.plan.overlays.map((o) => (o.type === "hook_box" ? { ...o, lines: hook! } : o)) : data.plan.overlays }, L: data.L, DY: data.DY, fonts: data.fonts }}
        compositionWidth={data.width}
        compositionHeight={data.height}
        fps={data.fps}
        durationInFrames={data.durationInFrames}
        controls={false}
        clickToPlay={false}
        style={{ width: "100%", height: "100%" }}
        acknowledgeRemotionLicense
      />,
    );
  };
  const frameOf = (t: number) => Math.max(0, Math.min(data.durationInFrames - 1, Math.round(t * data.fps)));
  const seek = (t: number) => ref.current?.seekTo(frameOf(t));
  let raf = 0;
  const tick = () => {
    seek(video.currentTime);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  render();
  return {
    setEdit(id, edit) {
      if (edit === null) {
        const { [id]: _drop, ...rest } = edits;
        edits = rest;
      } else edits = { ...edits, [id]: edit };
      render();
    },
    setHook(lines) {
      hook = lines ? (lines.map((l) => l.toUpperCase()) as [string, string]) : null;
      render();
    },
    seek,
    destroy() {
      cancelAnimationFrame(raf);
      root.unmount();
    },
  };
}

(window as unknown as { AutocutPreview: unknown }).AutocutPreview = { mount };
