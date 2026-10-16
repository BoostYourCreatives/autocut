#!/usr/bin/env python3
"""Kinn-Messung mit MediaPipe FaceLandmarker (Punkt 152), alle N Frames.

Ausgabe: JSON {fps, width, height, every, frames: [[frame, chin_y_px | null], ...]}
Das Modell (face_landmarker.task) wird beim ersten Lauf nach ~/.cache/autocut geladen.
"""
import argparse
import json
import os
import urllib.request

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("out")
ap.add_argument("--every", type=int, default=3)
a = ap.parse_args()

cache = os.environ.get("AUTOCUT_CACHE_DIR") or os.path.expanduser("~/.cache/autocut")
os.makedirs(cache, exist_ok=True)
model_path = os.path.join(cache, "face_landmarker.task")
if not os.path.exists(model_path):
    urllib.request.urlretrieve(MODEL_URL, model_path)

opts = vision.FaceLandmarkerOptions(
    base_options=mp_python.BaseOptions(model_asset_path=model_path),
    running_mode=vision.RunningMode.IMAGE,
    num_faces=1,
)
landmarker = vision.FaceLandmarker.create_from_options(opts)

cv2.setNumThreads(int(os.environ.get("AUTOCUT_THREADS", "4")))
cap = cv2.VideoCapture(a.video)
fps = cap.get(cv2.CAP_PROP_FPS)
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
frames = []
i = 0
while True:
    ok, bgr = cap.read()
    if not ok:
        break
    if i % a.every == 0:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        y = None
        if res.face_landmarks:
            y = round(res.face_landmarks[0][152].y * h, 1)
        frames.append([i, y])
    i += 1
cap.release()
landmarker.close()
with open(a.out, "w") as f:
    json.dump({"fps": fps, "width": w, "height": h, "every": a.every, "frames": frames}, f)
