# autocut als Webdienst. Gebaut für einen Server mit mindestens 4 CPU-Kernen und 8 GB RAM
# (Rendern ist rechenintensiv). Daten (Läufe, Soundeffekte, Schriften, Modelle) liegen auf dem Volume /data.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg (mit x265), Python für Whisper und Kinn-Messung, Bibliotheken für Chrome (Remotion) und MediaPipe
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg python3 python3-pip libsndfile1 \
      fonts-liberation fonts-dejavu-core \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      libegl1 libgles2 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# av wird bewusst festgelegt: faster-whisper 1.2 läuft nicht mit neueren Versionen
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper "av==16.0.1" mediapipe opencv-python-headless
# Wortzeiten nachschärfen (CPU-Version von PyTorch)
RUN pip3 install --no-cache-dir --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --no-cache-dir --break-system-packages transformers soundfile

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Chrome Headless Shell für Remotion schon beim Bauen laden, nicht erst beim ersten Reel
RUN node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"

COPY . .

ENV HOST=0.0.0.0 \
    PORT=3000 \
    AUTOCUT_RUNS_DIR=/data/runs \
    AUTOCUT_SFX_LIBRARY=/data/sfx \
    AUTOCUT_FONTS_DIR=/data/fonts AUTOCUT_BROLL_LIBRARY=/data/broll \
    AUTOCUT_CACHE_DIR=/data/cache \
    HF_HOME=/data/cache/huggingface \
    AUTOCUT_THREADS=4 \
    AUTOCUT_CONCURRENCY=2 \
    OMP_NUM_THREADS=4 \
    RETENTION_DAYS=30 \
    MAX_UPLOAD_MB=500

# /data wird vom Anbieter als Volume eingehängt (Railway: im Dashboard anlegen; eigener Server: docker run -v)
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# APP_PASSWORD (und ANTHROPIC_API_KEY, OPENAI_API_KEY) werden beim Start als Umgebungsvariablen gesetzt, nie ins Image gebacken
CMD ["npx", "tsx", "src/cli.ts", "ui"]
