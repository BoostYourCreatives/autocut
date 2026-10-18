---
name: editing-thorsten-wittmann
description: Thorsten Wittmanns Meta-Ads-Reels (Talking Head, Finanzthemen) automatisch schneiden und mit Untertiteln, Gold-Hervorhebungen, Hook-Box, Zooms, B-Rolls und Soundeffekten fertig rendern, im autocut-Tool. Nutzen bei "Thorsten-Stil", "TW-Reel", "Reel für Thorsten schneiden", "Editing-Stil Thorsten" oder wenn ein Rohvideo von Thorsten hochgeladen wird. Erklärt Stilregeln, Bedienung des Editors und wie man einen weiteren Editing-Stil anlegt.
---

# Editing-Stil: Thorsten Wittmann (Reels)

Rohvideo rein, fertig geschnittenes Reel raus. Ein Mensch schaut nur das fertige Video an und korrigiert im Editor, was nicht passt. Alles läuft im Projekt **autocut** (dieses Repository).

## Wo die Wahrheit liegt

| Was | Datei |
|---|---|
| Regeln in Worten (MUSS / STANDARD / VERBOTEN, mit Begründung) | `style/thorsten/regeln.md` |
| Maschinenlesbarer Stil (Schriften, Farben, Untertitel, Zooms, B-Roll) | `style/thorsten/style.json` |
| Alle Zahlen, die der Code liest (Layout, Zoom, Sound, Export, Prüfgrenzen) | `style/thorsten/params.json` (`_quelle` und `_todo` zeigen die Herkunft) |
| Fertige Beispielschnitte als Vorbild für Claude | `style/thorsten/beispiel-plan_*.json` |
| Pfade, Modelle, Preise | `config/autocut.config.json` |

Bei Widerspruch gilt `regeln.md`, außer in der Liste "Spätere Vorgaben" weiter unten.

## Der Stil in Kürze

- **Format:** 1080×1920, Reel unter 30 MB, gleiche fps wie das Rohmaterial, Ausgabe `TW_Reel_<Nr>.mp4`, −17 LUFS.
- **Untertitel:** ein Wort pro Einblendung, weiß in Helvetica Bold. Gold (#fab926) und das CTA-Keyword in Segoe Pro Bold Italic. Weicher schwarzer Schatten, keine Kontur, kein Blau. Mindestens 6 Frames Standzeit.
- **Immer unter dem Kinn:** Oberkante mindestens 20 px unter dem Kinnpunkt (MediaPipe Punkt 152), nie Text über Gesicht, Mund oder Kinn.
- **Hook:** weiße Hook-Box (2 Zeilen, Versalien) und KI-Hinweis ab Frame 0 bis zum Hook-Ende. Hook-Push 100→106 %. Hook-Text ist eine zugespitzte These oder Frage, nicht der gesprochene Satz.
- **Übergang am Hook-Ende:** optional, Claude entscheidet nach Inhalt: Gold-Blitz mit Camera Shutter und Riser (Peak auf dem Blitz, Ende mit dem Shutter) oder harter Schnitt.
- **Zooms:** weich über 24 Frames, gezoomt bleiben bis zum Segmentende, am Schnitt hart zurück. Höchstens einer pro Segment.
- **B-Rolls:** nur wenn das Bild wörtlich zur Stelle passt. Nie im Hook. Keine Klischee-Motive.
- **Sound:** keine Musik. Nur Effekte aus der eigenen Library, klar unter der Stimme. Niemals Sounds oder Musik generieren.
- **Verboten:** Emojis, Logos, Wasserzeichen, Progressbar, Endkarte, Kapitel-Titel, laute Whoosh-Effekte, Blau, Kontur um Untertitel.

## Spätere Vorgaben (gelten vor regeln.md)

- **Zooms selten:** höchstens 3 pro Reel, mindestens 6 s Abstand, nur bei echter Betonung (regeln.md nennt noch fünf).
- **B-Rolls kurz:** höchstens ca. 3 s. Länger nur als begründete Ausnahme oder wenn ein KI-Fehler im Rohvideo abgedeckt wird.
- **Nur Reels.** Ads mit mehreren Hooks und gemeinsamem Body sind nicht umgesetzt.

## So läuft ein Reel

1. Im Browser (Tool unter der Railway-Adresse) oben auf **Neues Reel**, Rohvideo hineinziehen. Optional Hook-Text, Übergang, B-Roll-Quelle (eigene Bibliothek und/oder Stock von Pexels und Pixabay, nichts angehakt = keine B-Rolls).
2. Das Tool arbeitet die Schritte ab: Einlesen, Text erkennen (faster-whisper large-v3, Wortzeiten mit wav2vec2 nachgeschärft), Analysieren, Gesicht messen, Schnittplan (Claude Sonnet), B-Rolls beschaffen, Prüfen (strenger Validator ohne KI, höchstens 3 Versuche, sonst Abbruch ohne Render), Rendern, optional Selfcheck durch Claude.
3. Im **Editor** nachbessern (siehe unten), dann **Abnahme**: das Rohmaterial und alle Zwischendateien werden gelöscht, das fertige Video bleibt.

Kommandozeile: `npx tsx src/cli.ts ui` (Oberfläche), `run`, `rerender <plan>`, `status`, `todos`. Tests: `npm test`, End-to-End: `npm run test:e2e`.

## Der Editor

Alles in einer Ansicht: links das Video mit Live-Vorschau der Texte, rechts Hook-Text und die Auswahl, darunter die Zeitleiste mit fünf Zeilen (Ton, Untertitel, Sound, B-Roll, Zoom).

| Was ändern | Wie | Was neu gebaut wird |
|---|---|---|
| Untertitel-Text und -Zeiten, Hook-Text | Textfeld, Block ziehen, Rand ziehen, Pfeiltasten, "Jetzt" | nur die Text-Ebene (ca. 1,5 Min) |
| Soundeffekte (verschieben, tauschen, Lautstärke, neu, entfernen) | Block ziehen, Auswahl rechts | Ton neu mischen, schnell |
| B-Rolls (Zeiten, Beschreibung, eigenes Video oder Stock-Suche, neu, entfernen) | Block ziehen, Auswahl rechts | Bild komplett (einige Minuten) |
| Zooms (Zeit, Stärke, neu, entfernen) | Marke ziehen | Bild komplett |

Gesperrt: Riser und Camera Shutter (gehören zum Hook-Übergang). Der Validator lehnt Änderungen ab, die gegen Regeln verstoßen (z. B. Zoom im Hook, überlappende B-Rolls), mit klarer Meldung.

## Betrieb (Railway)

- Docker (siehe `Dockerfile`, `docs/DEPLOY.md`). Volume unter `/data` mit mindestens 10 GB.
- Variablen: `APP_PASSWORD`, `ANTHROPIC_API_KEY` (Pflicht), `PIXABAY_API_KEY` und/oder `PEXELS_API_KEY` (Stock-B-Rolls), optional `OPENAI_API_KEY` (wird für die Transkription nicht benutzt).
- Pro Reel liegen bis zur Abnahme etwa 100 bis 200 MB auf dem Volume. Nach jedem fertigen Reel abnehmen.
- Unfertige Läufe ohne Video werden nach 2 Tagen gelöscht (`UNFINISHED_DAYS`).

## Einen weiteren Editing-Stil anlegen

Das Tool ist stilunabhängig, alles Kundenspezifische liegt in `style/<name>/`.

1. `npx tsx src/cli.ts new-style <name> --from thorsten` legt `style/<name>/` als Kopie an, samt Checkliste `NEUER-STIL.md`.
2. `regeln.md`, `style.json`, `params.json` und die Beispielpläne für den neuen Kunden ersetzen. Schriften und Sounds bereitstellen.
3. Umgebungsvariable `AUTOCUT_STYLE=<name>` setzen (Railway: Variables) und neu starten. Die Oberfläche zeigt oben den aktiven Stil.
4. `AUTOCUT_STYLE=<name> npx tsx src/cli.ts todos` listet offene Platzhalter.

Der Prompt für Claude (`src/plan/prompt.ts`) liest die Regeln und Beispiele aus dem Stilordner. Kundenspezifisches steht dort nicht im Code.
