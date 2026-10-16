# autocut veröffentlichen

autocut ist ein Dienst, der pro Reel mehrere Minuten rechnet (ffmpeg, Chrome für Remotion, Whisper). Er braucht deshalb einen **dauerhaft laufenden Server mit Festplatte**.
Reine „Serverless“-Anbieter (Vercel, Netlify) passen dafür nicht. Das Repo enthält ein `Dockerfile`, damit läuft es bei jedem Anbieter, der Container kann.

## Was der Server braucht
- mindestens 4 CPU-Kerne und 8 GB RAM (zum Vergleich: ein 24-Sekunden-Reel dauert auf 4 Kernen etwa 3 Minuten)
- eine Festplatte („Volume“) ab 20 GB, eingehängt unter `/data`
- Umgebungsvariablen: `APP_PASSWORD` (Pflicht), `ANTHROPIC_API_KEY` (Pflicht), `OPENAI_API_KEY` (optional, sonst läuft Whisper lokal auf dem Server)
- HTTPS (machen die Anbieter automatisch)

## Anbieter im Vergleich (Preise sind grobe Richtwerte, bitte auf der Preisseite prüfen)

| Anbieter | Aufwand | Preis grob | Passt, weil … | Aufpassen |
|---|---|---|---|---|
| **Railway** | gering: GitHub-Repo verbinden, Variablen eintragen | nutzungsabhängig, bei Dauerbetrieb eher 15–40 $/Monat | einfachster Einstieg, Dockerfile wird erkannt, Volume per Klick | Kosten steigen mit Rechenzeit |
| **Render** | gering | feste Pakete, für 4 CPU/8 GB eher 80–100 $/Monat | feste, planbare Preise | für diese Größe teurer als ein eigener Server |
| **Fly.io** | mittel (Kommandozeile) | nutzungsabhängig, Maschine kann bei Nichtnutzung stoppen | zahlt nur, wenn gerendert wird | Einrichtung und Volumes etwas fummeliger |
| **Hetzner Cloud (eigener Server)** | mittel: einmal Docker einrichten | ca. 15–30 €/Monat fest | mit Abstand die meiste Leistung pro Euro, Rechenzentren in Deutschland | du bist selbst für Updates und Backups zuständig |
| **Google Cloud Run / AWS** | hoch | nutzungsabhängig | skaliert stark | braucht Umbau (Dateispeicher, Hintergrund-Jobs), für den Start zu viel |

**Empfehlung:** Für den Start **Railway** (schnell online, wenig Technik). Wenn die Reels regelmäßig laufen und es dir zu teuer wird, auf einen **Hetzner-Server** umziehen. Das Image ist dasselbe.
Vercel kann später nur die Oberfläche hosten, das Rendern müsste trotzdem auf so einem Server laufen. Das lohnt sich erst, wenn mehrere Leute gleichzeitig arbeiten.

## Variante A: Railway
1. Auf railway.com mit GitHub anmelden, **New Project → Deploy from GitHub repo** und `BoostYourCreatives/autocut` wählen (Railway braucht dafür Zugriff auf die Organisation).
2. Beim Dienst unter **Settings → Source** den Branch `claude/gifted-curie-y1k1np` einstellen (oder den Code vorher nach `main` übernehmen). Railway liest `railway.json` und baut das `Dockerfile`, der erste Bau dauert ca. 10–15 Minuten.
3. **Volume** hinzufügen (Rechtsklick auf die Fläche oder **+ New → Volume**) und unter `/data` einhängen.
4. **Variables** eintragen: `APP_PASSWORD`, `ANTHROPIC_API_KEY`, optional `OPENAI_API_KEY`, optional `PEXELS_API_KEY` und `PIXABAY_API_KEY` (für Stock-B-Rolls). (Die anderen Werte stehen schon im Dockerfile.)
5. **Settings → Resources**: mindestens 4 vCPU und 8 GB RAM erlauben (dafür braucht es den Hobby- oder Pro-Tarif).
6. **Settings → Networking → Generate Domain**: das ist die öffentliche Adresse.
7. Adresse öffnen, mit dem Passwort anmelden, Soundeffekte und Schriften hochladen (siehe unten).

## Variante B: eigener Server (Hetzner)
```bash
# Server mit Ubuntu anlegen, dann:
curl -fsSL https://get.docker.com | sh
git clone https://github.com/BoostYourCreatives/autocut && cd autocut && git checkout claude/gifted-curie-y1k1np
docker build -t autocut .
docker run -d --name autocut --restart unless-stopped -p 3000:3000 -v autocut-data:/data \
  -e APP_PASSWORD='dein-langes-passwort' -e ANTHROPIC_API_KEY='…' autocut
```
Dann vor den Container einen Webserver mit HTTPS setzen (am einfachsten **Caddy**: `reverse_proxy localhost:3000` und die Domain, Zertifikat holt Caddy selbst). Ohne HTTPS nie ein Passwort über das Internet schicken.

## Nach dem ersten Start (einmalig)
1. Anmelden.
2. Links im Kasten **„Soundeffekte und Schriften“** die Dateien hochladen: `Riser`, `Camera_Shutter`, `Fuwa`, `Money_Caching`, `Ding` und die Schriften `Helvetica-Bold.ttf`, `SegoePro-BoldItalic.ttf`, `heros-regular.otf`.
3. Der **System-Check** darunter muss grün sein. Dann ein kurzes Reel hochladen.

## Sicherheit und Datenschutz
- Ein gemeinsames Passwort schützt alles. Nach 10 Fehlversuchen wird 15 Minuten gesperrt. Wähle ein langes Passwort. Wer es hat, kann auf deine Kosten Claude benutzen.
- Hochgeladene Videos und Ergebnisse liegen auf der Platte des Servers und werden nach `RETENTION_DAYS` (Standard 30) Tagen gelöscht. Bei Videos von Kunden: Server in der EU wählen und Thorsten informieren, dass Ton und Standbilder an Anthropic (und bei OpenAI-Transkription auch an OpenAI) gehen.
- API-Schlüssel stehen nur in den Umgebungsvariablen des Anbieters, nie im Code oder Image.
- Setze in den Konten von Anthropic und OpenAI ein **monatliches Ausgabenlimit**.

## Grenzen
- Es läuft immer nur ein Reel gleichzeitig; ein zweiter Start meldet „es läuft schon ein Lauf“. Eine Warteschlange gibt es noch nicht.
- Startet der Server neu, während ein Lauf rechnet, bricht dieser ab und muss neu gestartet werden.
- Es gibt ein gemeinsames Passwort, keine einzelnen Konten.
- Das `Dockerfile` ist geschrieben, aber noch **nicht gebaut und getestet** (in der Entwicklungsumgebung gab es keinen Docker-Dienst). Kleinere Anpassungen beim ersten Bauen sind möglich.
