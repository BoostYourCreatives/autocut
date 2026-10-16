#!/usr/bin/env python3
"""Wortzeiten nachschärfen (CTC-Forced-Alignment mit wav2vec2).

Whisper liefert den Text gut, die Wortzeiten aber oft 0,1 s zu spät oder zu früh. Hier wird der Text von Whisper
gegen das Audio ausgerichtet; das Modell sieht dabei nur Laute, keine Sprache oder Satzbau.
Eingabe: transcript-JSON von tr.py. Ausgabe: gleiche Datei mit neuen start_s/end_s (Originalzeiten in orig_*).
Wörter ohne ausrichtbare Buchstaben (Zahlen, Symbole) und starke Ausreißer behalten die Whisper-Zeit.
"""
import argparse
import json
import os
import re

import numpy as np
import soundfile as sf
import torch
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

ap = argparse.ArgumentParser()
ap.add_argument("wav")
ap.add_argument("transcript")
ap.add_argument("out")
ap.add_argument("--model", default="jonatasgrosman/wav2vec2-large-xlsr-53-german")
ap.add_argument("--max-shift", type=float, default=0.6)
a = ap.parse_args()

torch.set_num_threads(int(os.environ.get("AUTOCUT_THREADS", "4")))
tr = json.load(open(a.transcript, encoding="utf-8"))
words = tr["words"]

proc = Wav2Vec2Processor.from_pretrained(a.model)
model = Wav2Vec2ForCTC.from_pretrained(a.model).eval()
vocab = proc.tokenizer.get_vocab()
BLANK = vocab["<pad>"]
SEP = vocab["|"]

audio, sr = sf.read(a.wav, dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
assert sr == 16000, f"16 kHz erwartet, bekam {sr}"
x = proc(audio, sampling_rate=16000, return_tensors="pt").input_values
with torch.no_grad():
    logp = torch.log_softmax(model(x).logits[0], dim=-1).numpy()
T = logp.shape[0]
frame_s = len(audio) / 16000 / T


def norm(w: str):
    w = w.lower().replace("ß", "ss")
    return [vocab[c] for c in re.sub(r"[^a-zäöüíó'\-]", "", w) if c in vocab]


# Token-Folge: Wörter durch | getrennt; Wörter ohne Buchstaben werden übersprungen
seq, owner = [], []
for i, w in enumerate(words):
    ids = norm(w["word"])
    if not ids:
        continue
    if seq:
        seq.append(SEP)
        owner.append(-1)
    for t in ids:
        seq.append(t)
        owner.append(i)

# CTC-Viterbi
S = len(seq)
ext = [BLANK]
for t in seq:
    ext += [t, BLANK]
L = len(ext)
NEG = -1e30
dp = np.full((T, L), NEG, dtype=np.float32)
bp = np.zeros((T, L), dtype=np.int8)
dp[0, 0] = logp[0, BLANK]
if L > 1:
    dp[0, 1] = logp[0, ext[1]]
for t in range(1, T):
    for s_off, ok in ((0, None),):
        pass
    stay = dp[t - 1]
    prev1 = np.concatenate(([NEG], dp[t - 1, :-1]))
    prev2 = np.concatenate(([NEG, NEG], dp[t - 1, :-2]))
    allow2 = np.zeros(L, dtype=bool)
    for s in range(2, L):
        allow2[s] = ext[s] != BLANK and ext[s] != ext[s - 2]
    prev2 = np.where(allow2, prev2, NEG)
    stack = np.stack([stay, prev1, prev2])
    best = stack.argmax(axis=0)
    dp[t] = stack.max(axis=0) + logp[t, ext]
    bp[t] = best
end = L - 1 if dp[T - 1, L - 1] >= dp[T - 1, L - 2] else L - 2
path = [0] * T
s = end
for t in range(T - 1, -1, -1):
    path[t] = s
    s -= int(bp[t, s])

first, last = {}, {}
for t, s in enumerate(path):
    if s % 2 == 1:
        i = owner[(s - 1) // 2]
        if i >= 0:
            first.setdefault(i, t)
            last[i] = t

moved = kept = 0
for i, w in enumerate(words):
    if i in first:
        ns, ne = first[i] * frame_s, (last[i] + 1) * frame_s
        if abs(ns - w["start_s"]) <= a.max_shift and abs(ne - w["end_s"]) <= a.max_shift and ne > ns:
            w["orig_start_s"], w["orig_end_s"] = w["start_s"], w["end_s"]
            w["start_s"], w["end_s"] = round(ns, 3), round(ne, 3)
            moved += 1
            continue
    kept += 1
# CTC markiert nur den Kern eines Lauts: Wortende etwas nach hinten ziehen, aber nie in das nächste Wort
for i, w in enumerate(words):
    if "orig_start_s" in w:
        nxt = words[i + 1]["start_s"] if i + 1 < len(words) else w["end_s"] + 0.05
        w["end_s"] = round(min(w["end_s"] + 0.04, max(nxt, w["end_s"])), 3)
tr["alignment"] = {"model": a.model, "aligned": moved, "kept_whisper_time": kept}
json.dump(tr, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"aligned={moved} kept={kept}")
