import { execOk } from "../util/exec.ts";

export interface ProbeResult {
  duration_s: number;
  width: number;
  height: number;
  rotation: number;
  video_codec: string;
  r_frame_rate: number;
  avg_frame_rate: number;
  audio: { codec: string; sample_rate: number; channels: number } | null;
}

const frac = (s: string | undefined): number => {
  if (!s) return 0;
  const [a, b] = s.split("/").map(Number);
  return b ? a! / b : a ?? 0;
};

export async function probe(file: string): Promise<ProbeResult> {
  const r = await execOk("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(r.stdout.toString("utf8"));
  const v = j.streams.find((s: any) => s.codec_type === "video");
  if (!v) throw new Error(`Keine Videospur in ${file}`);
  const a = j.streams.find((s: any) => s.codec_type === "audio");
  const rotTag = v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0;
  return {
    duration_s: parseFloat(j.format.duration ?? v.duration),
    width: v.width,
    height: v.height,
    rotation: Number(rotTag) || 0,
    video_codec: v.codec_name,
    r_frame_rate: frac(v.r_frame_rate),
    avg_frame_rate: frac(v.avg_frame_rate),
    audio: a ? { codec: a.codec_name, sample_rate: Number(a.sample_rate), channels: a.channels } : null,
  };
}

/** Nächster erlaubter fps-Wert, falls nah genug (Toleranz 0,6), sonst gerundeter Wert. */
export function snapFps(fps: number, allowed: number[]): number {
  let best = allowed[0]!;
  for (const a of allowed) if (Math.abs(a - fps) < Math.abs(best - fps)) best = a;
  return Math.abs(best - fps) <= 0.6 ? best : Math.round(fps);
}
