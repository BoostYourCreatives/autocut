# autocut

Prototyp einer KI-gestützten Video-Editing-Pipeline. Rohmaterial rein, geschnittenes Video raus, ohne Freigabeschritt.
Aktuell nur für **Thorsten Wittmann**, Fokus: **Reels** (ein Rohvideo rein, ein Reel raus). Ads mit mehreren Hooks + Body (`variants`) sind vorerst ausgeklammert. Alle kundenspezifischen Werte liegen in `style/<kunde>/`.

```
ingest → transcribe → analyze → plan → validate (≤3 Retries) → render → selfcheck   
 M1      M1           M1        M2     M2                      M3       M3            M4
```

## Stand: M1

Fertig: Projektstruktur, zod-Schemas (inkl. Plan), `ingest`, `transcribe`, `analyze`, Schritt-Log.

```bash
npm install
cp .env.example .env            # OPENAI_API_KEY für transcribe (provider "openai")

# Einzelnes Reel
npx tsx src/cli.ts run reel53 --reel /pfad/Reel_53_raw.mp4
# Jeder Schritt einzeln wiederholbar
npx tsx src/cli.ts transcribe reel53 --provider faster-whisper
npx tsx src/cli.ts analyze reel53

# (--hook/--body für Ads ist eingebaut, aber ungenutzt und ungetestet für die weitere Pipeline)
npx tsx src/cli.ts status reel53   # Dateien + Dauer/Kosten je Schritt
npx tsx src/cli.ts todos        # offene Platzhalter
npm test                        # Unit- und M1-Integrationstests (synthetisches Material)
```

Vorgeschnittenes Material (Zooms/Schnitte schon vom User): `--precut ja`. Standard `auto` erkennt es an harten Szenenwechseln.

## Projektordner eines Runs

```
runs/<run>/
  run.json                 Manifest (Clips, Rollen, precut)
  run.log.json             Dauer je Schritt, API-Nutzung, geschätzte Kosten
  clips/<clip-id>/
    meta.json              ffprobe-Metadaten, Warnungen
    proxy.mp4              x264 CRF 14, GOP 15, ohne Ton
    audio_16k.wav          Mono, für Transkription/Analyse
    audio_48k.wav          Stereo, für späteren Ton-Schnitt
    transcript.raw.json    Providerausgabe unverändert
    transcript.json        Wortzeitstempel, an Stillen angepasst (raw-Zeit des Clips)
    analysis.json          Stillen, Atmer-Kandidaten, Lautstärke, Szenenwechsel
```

## Stil und Konfiguration

- `style/thorsten/style.json`, `regeln.md`, `beispiel-plan_*.json`: Quelle der Wahrheit (vom User geliefert).
- `style/thorsten/params.json`: maschinenlesbare Zahlen daraus (jeder Wert nennt seine Quelle; `TODO(style)` = Annahme).
- `config/autocut.config.json`: Pfade (SFX-/Musik-Library, Stock-B-Roll), Transkriptions-Provider, Modelle. Env-Overrides: siehe `.env.example`.

Transkription: `openai` (Whisper-API, `whisper-1`, Standard), `faster-whisper` (lokal, Einstellungen wie in `regeln.md`, braucht `pip install faster-whisper`), `file` (Wörter aus JSON, für Tests/manuelle Korrekturen).
