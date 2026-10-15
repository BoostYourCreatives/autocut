import { z } from "zod";
import { seconds } from "./common.ts";

export const ClipRole = z.enum(["reel", "hook", "body"]);
export type ClipRole = z.infer<typeof ClipRole>;

export const ManifestClip = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  role: ClipRole,
  source_path: z.string(),
  /** "auto" = per Szenenwechsel erkennen, true/false = Aussage des Users */
  precut: z.union([z.literal("auto"), z.boolean()]).default("auto"),
});
export type ManifestClip = z.infer<typeof ManifestClip>;

export const Manifest = z.object({
  name: z.string(),
  created_at: z.string(),
  style: z.string(),
  clips: z.array(ManifestClip),
});
export type Manifest = z.infer<typeof Manifest>;

export const ClipMeta = z.object({
  id: z.string(),
  role: ClipRole,
  source_path: z.string(),
  duration_s: seconds,
  fps: z.number().positive(),
  fps_note: z.string(),
  vfr: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.number(),
  video_codec: z.string(),
  has_audio: z.boolean(),
  audio: z
    .object({ codec: z.string(), sample_rate: z.number(), channels: z.number() })
    .nullable(),
  files: z.object({
    proxy: z.string(),
    audio_16k: z.string(),
    audio_48k: z.string(),
  }),
  warnings: z.array(z.string()),
});
export type ClipMeta = z.infer<typeof ClipMeta>;
