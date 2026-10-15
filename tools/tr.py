#!/usr/bin/env python3
"""Lokale Transkription mit Wortzeitstempeln (faster-whisper).

Einstellungen wie in style/thorsten/regeln.md (Arbeitsablauf 2):
medium, int8, Deutsch, word_timestamps, beam 5.
Ausgabe: JSON {language, duration_s, text, words:[{word,start_s,end_s}]}
"""
import argparse
import json

from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("wav")
ap.add_argument("out")
ap.add_argument("--model", default="medium")
ap.add_argument("--compute-type", default="int8")
ap.add_argument("--beam-size", type=int, default=5)
ap.add_argument("--language", default="de")
ap.add_argument("--prompt", default=None)
a = ap.parse_args()

model = WhisperModel(a.model, device="cpu", compute_type=a.compute_type)
segments, info = model.transcribe(
    a.wav,
    language=a.language,
    word_timestamps=True,
    beam_size=a.beam_size,
    initial_prompt=a.prompt,
    vad_filter=False,
)
words, texts = [], []
for seg in segments:
    texts.append(seg.text.strip())
    for w in seg.words or []:
        t = w.word.strip()
        if t:
            words.append({"word": t, "start_s": round(w.start, 3), "end_s": round(w.end, 3)})

with open(a.out, "w", encoding="utf-8") as f:
    json.dump(
        {"language": a.language, "duration_s": round(info.duration, 3), "text": " ".join(texts), "words": words},
        f, ensure_ascii=False, indent=2,
    )
