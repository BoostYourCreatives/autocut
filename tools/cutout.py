#!/usr/bin/env python3
"""Person freistellen (Robust Video Matting). Schreibt ein Graustufen-Video mit dem Alpha-Kanal (weiß = Person).

Aufruf: cutout.py <video> <alpha.mp4> [--ratio 0.25] [--model mobilenetv3]
Das Modell lädt beim ersten Lauf von GitHub (ca. 15 MB) in den Cache (AUTOCUT_CACHE_DIR).
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.request

import cv2
import numpy as np
import torch

URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_{m}_fp32.torchscript"

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("out")
ap.add_argument("--ratio", type=float, default=0.25, help="Verkleinerung für das Netz (0.25 = Full-HD-Hochformat)")
ap.add_argument("--model", default="mobilenetv3", choices=["mobilenetv3", "resnet50"])
ap.add_argument("--max-seconds", type=float, default=0)
a = ap.parse_args()

torch.set_num_threads(int(os.environ.get("AUTOCUT_THREADS", "4")))
cache = os.environ.get("AUTOCUT_CACHE_DIR", os.path.expanduser("~/.cache/autocut"))
os.makedirs(cache, exist_ok=True)
w = os.path.join(cache, f"rvm_{a.model}_fp32.torchscript")
if not os.path.exists(w):
    print("Lade Modell …", file=sys.stderr)
    urllib.request.urlretrieve(URL.format(m=a.model), w + ".part")
    os.replace(w + ".part", w)
model = torch.jit.load(w, map_location="cpu").eval()

cap = cv2.VideoCapture(a.video)
fps = cap.get(cv2.CAP_PROP_FPS)
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
if a.max_seconds:
    n = min(n, int(a.max_seconds * fps))

ff = subprocess.Popen(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
     "-c:v", "libx264", "-crf", "10", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", a.out],
    stdin=subprocess.PIPE,
)
rec = [None] * 4
t0 = time.time()
i = 0
with torch.no_grad():
    while i < n:
        ok, bgr = cap.read()
        if not ok:
            break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        src = torch.from_numpy(rgb).permute(2, 0, 1).float().div(255).unsqueeze(0)
        fgr, pha, *rec = model(src, *rec, a.ratio)
        alpha = (pha[0, 0].clamp(0, 1) * 255).byte().numpy()
        ff.stdin.write(alpha.tobytes())
        i += 1
        if i % 25 == 0:
            print(f"{i}/{n} Bilder, {i / (time.time() - t0):.1f} Bilder/s", file=sys.stderr, flush=True)
ff.stdin.close()
ff.wait()
print(f"fertig: {i} Bilder in {time.time() - t0:.0f} s", file=sys.stderr)
