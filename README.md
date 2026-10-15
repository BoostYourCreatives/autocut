# autocut

Prototyp einer KI-gestützten Video-Editing-Pipeline. Rohmaterial rein, geschnittenes Video raus, ohne Freigabeschritt.
Aktuell nur für **Thorsten Wittmann**, Fokus: **Reels** (ein Rohvideo rein, ein Reel raus). Ads mit mehreren Hooks + Body (`variants`) sind vorerst ausgeklammert. Alle kundenspezifischen Werte liegen in `style/<kunde>/`.

```
ingest → transcribe → analyze → plan → validate (≤3 Retries) → render → selfcheck   
 M1      M1           M1        M2     M2                      M3       M3            M4
```

## Stand: M2

Fertig: Projektstruktur, zod-Schemas, `ingest`, `transcribe`, `analyze`, `plan` (Claude) + `validate` mit Retry-Schleife, Schritt-Log, Qualitätszusammenfassung.
Noch offen: `render`, `selfcheck`, „Hier genauer hinschauen“-Liste, `rerender` (M3); Kosten-Gesamtlog, Testbefehl (M4).

```bash
npm install
cp .env.example .env            # OPENAI_API_KEY für transcribe (provider "openai")

# Einzelnes Reel
npx tsx src/cli.ts run reel53 --reel /pfad/Reel_53_raw.mp4
# Jeder Schritt einzeln wiederholbar
npx tsx src/cli.ts transcribe reel53 --provider faster-whisper
npx tsx src/cli.ts analyze reel53

# (--hook/--body für Ads ist eingebaut, aber ungenutzt und ungetestet für die weitere Pipeline)
npx tsx src/cli.ts plan reel53                      # Claude entwirft, Code finalisiert + validiert (max. 3 Versuche)
npx tsx src/cli.ts plan reel53 --uebergang hart     # Hook-Übergang vorgeben (blitz | hart | auto)
npx tsx src/cli.ts plan reel53 --hook-text "WARUM EUROPA / ZURÜCKFALLEN KÖNNTE"
npx tsx src/cli.ts validate reel53                  # Plan ohne KI prüfen (auch für von Hand geänderte Pläne)
npx tsx src/cli.ts sfx-index                        # Dateien der SFX-Library

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

## plan und validate (M2)

Claude liefert nur **Entscheidungen** (`PlanDraft`, `src/plan/draft.ts`): Hook-Ende und Hook-Text, Übergang, Versprecher/Wiederholungen/Füllwörter,
Gold-Momente, Zooms, B-Roll-Slots, SFX-Stellen, CTA, jeweils mit `reason` und `confidence`. Alles, was `style.json` als Regel festlegt, berechnet
Code (`src/plan/finalize.ts`): Pausenschnitte (≥ 0,15 s, 0,02 s Luft, volle Frames), Untertitel-Gruppierung und -Timing, SFX-Zeitpunkte,
Riser/Shutter, Hook-Box und KI-Hinweis. So muss Claude nichts nachrechnen, und der Plan folgt den Regeln.

`validate` (`src/validate/validate.ts`) prüft den fertigen Plan streng und ohne KI: Schnitt mitten im Wort, laute Schnittkanten, Lücken/Überlappungen,
Untertitel gegen Transkript, Schrift/Farbe/Emoji, SFX nur aus der Library (Whoosh verboten), Riser-Ende, Zoom-Regeln, B-Roll, Länge (zu viel Material weg),
Hook-Box/KI-Hinweis. Fehler gehen mit Text und Zeitpunkt zurück an Claude (max. 3 Versuche, Konversation wird nur verlängert, der Prompt-Prefix bleibt für das Caching gleich).
Danach wird nicht gerendert: `fehlerbericht.md`, `plan.failed.json`, Exit-Code 2.

Ergebnis in `runs/<run>/`: `plan.json`, `quality.json` (Versuche, Fehler je Versuch, entfernter Anteil, Tokens, Kosten), `plan-attempts/attempt-N.json`, `sfx-index.json`.

Lokal ohne Mac-Library testen: `AUTOCUT_SFX_LIBRARY=dev-assets/sfx` (Ordner `dev-assets/` ist gitignored, dort liegen die 5 CapCut-Sounds).
