import type { Config, Style } from "../../config.ts";
import { detectSilences } from "../../lib/audio.ts";
import { snapWords } from "../../lib/words.ts";
import { readJsonSchema, writeJson } from "../../util/files.ts";
import { log } from "../../util/log.ts";
import { loadManifest, runPaths, selectClips } from "../../util/run.ts";
import { timed, type StepApiUsage } from "../../util/runlog.ts";
import { ClipMeta } from "../../schema/ingest.ts";
import { Transcript } from "../../schema/transcript.ts";
import { transcribeOpenAI, type ProviderResult } from "./openai.ts";
import { transcribeFasterWhisper } from "./fasterWhisper.ts";
import { transcribeFromFile } from "./file.ts";

export interface TranscribeOptions {
  clips?: string[];
  provider?: Config["transcription"]["provider"];
  /** Für provider "file": clipId=Datei, oder eine Datei für den einzigen Clip */
  fromFile?: Record<string, string>;
}

export async function transcribe(cfg: Config, style: Style, runName: string, opts: TranscribeOptions = {}): Promise<void> {
  const run = runPaths(cfg, runName);
  const manifest = loadManifest(run);
  const provider = opts.provider ?? cfg.transcription.provider;
  const P = style.params.transcribe;
  const prompt = P.vokabel_hinweis.length ? P.vokabel_hinweis.join(", ") : undefined;

  for (const clip of selectClips(manifest, opts.clips)) {
    const paths = run.clip(clip.id);
    const meta = readJsonSchema(paths.meta, ClipMeta);

    await timed(run, "transcribe", clip.id, async () => {
      let res: ProviderResult;
      let api: StepApiUsage | undefined;
      if (provider === "openai") {
        res = await transcribeOpenAI(paths.audio16k, { model: cfg.transcription.openai.model, language: P.language, prompt });
        api = {
          provider: "openai",
          model: res.model,
          audio_seconds: meta.duration_s,
          est_cost_usd: Math.round((meta.duration_s / 60) * cfg.pricing.whisperUsdPerMinute * 10000) / 10000,
        };
      } else if (provider === "faster-whisper") {
        const fw = cfg.transcription.fasterWhisper;
        res = await transcribeFasterWhisper(paths.audio16k, paths.transcriptRaw, { ...fw, language: P.language, prompt });
      } else {
        const file = opts.fromFile?.[clip.id] ?? opts.fromFile?.["*"];
        if (!file) throw new Error(`provider "file": keine Datei für Clip ${clip.id} angegeben (--from-file)`);
        res = transcribeFromFile(file, P.language, meta.duration_s);
      }

      // Rohdaten des Providers aufheben, damit man das Snapping nachvollziehen kann
      writeJson(paths.transcriptRaw, res);

      let silencesUsed = 0;
      const words = res.words;
      let snapped;
      if (P.wortgrenzen_an_stille_anpassen) {
        const sil = await detectSilences(paths.audio16k, style.params.analyze.stille.noise_db, style.params.analyze.stille.min_s, meta.duration_s);
        silencesUsed = sil.length;
        snapped = snapWords(words, sil, P.min_wortdauer_s);
      } else {
        snapped = snapWords(words, [], P.min_wortdauer_s);
      }

      const transcript = Transcript.parse({
        clip: clip.id,
        language: res.language,
        provider: res.provider,
        model: res.model,
        duration_s: meta.duration_s,
        words: snapped,
        text: snapped.map((w) => w.word).join(" "),
      });
      writeJson(paths.transcript, transcript);

      const nSnap = transcript.words.filter((w) => w.snapped).length;
      const nSus = transcript.words.filter((w) => w.suspect).length;
      log.info(`transcribe ${clip.id}: ${transcript.words.length} Wörter (${provider}), ${nSnap} an ${silencesUsed} Stillen angepasst${nSus ? `, ${nSus} auffällig` : ""}`);
      if (transcript.words.length === 0) log.warn(`  ${clip.id}: leeres Transkript`);
      return { value: transcript, api };
    });
  }
}

