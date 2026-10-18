# Regeln: Editing-Stil Thorsten Wittmann (Reels)

Stand: 15.10.2026. Das hier stammt aus dem Chat zu den Reels TW_Reel_33 bis 54. Die TW_CCC-Ads mit Hooks und gemeinsamem Body wurden in diesem Chat nicht geschnitten (siehe Teil 4). Wo der User etwas korrigiert hat, steht hier nur die korrigierte Fassung, die Korrektur selbst ist unter VERBOTEN vermerkt.

---

## MUSS (nie davon abweichen)

1. **Untertitel liegen immer unter dem Kinn.** Wenn eine Einblendung (Untertitel, Stack, Liste, CTA) gesetzt wird, dann liegt ihre Oberkante in jedem Frame mindestens 20 px unter dem Kinnpunkt. Weil: Der User hat am 30.09. festgelegt, dass Gesicht, Mund und Kinn nie verdeckt werden dürfen, auch nicht kurz bei einem Zoom oder Nicken.
   So geht's:
   - Kinn messen mit MediaPipe, Punkt 152, alle 3 Frames.
   - Den ganzen Textblock gemeinsam um DY nach unten schieben.
   - Danach mit `chin_check.py` prüfen.

2. **Zoom-Regel (05.10.).** Wenn gezoomt wird, dann so:
   - weich rein: Cosine-Ease über 24 Frames (800 ms), nie mehr als ~1 % Maßstab pro Frame,
   - gezoomt bleiben bis zum Ende des Schnitt-Segments,
   - am nächsten Schnitt hart zurück auf 100 %.

   Weil: Der User hat mehrfach korrigiert. Zuerst waren die Zooms abrupt (Reel 38), dann zoomten sie kurz rein und gleich wieder raus („sieht billig aus“, Reel 32), dann gab es ein langsames Rauszoomen. Richtig ist nur rein, halten, harter Schnitt.

3. **Höchstens ein Zoom pro Schnitt-Segment.** Wenn zwei Zooms im selben Segment landen würden, dann den zweiten weglassen. Weil: Der zweite startet sonst bei 100 % und springt sichtbar zurück.

4. **Fonts und Farbe:**
   - weiße Texte in Helvetica Bold,
   - alles Goldene und das CTA-Keyword in Segoe Pro Bold Italic,
   - Gold ist immer #fab926.

   Weil: Das sind die Vorgaben des Users ab Reel 34, die Fontdateien kamen von ihm. Fetter wirkt hochwertiger, Regular wirkte billig (Reel 32).

5. **Schatten weich und schwarz, ohne Kontur, ohne Blau.** Weil: Nach Reel 32 v1 kam die Korrektur „wie vom Kindergarten“ (blaue Kontur, blauer Schatten, dunkelblaue Hook-Schrift).

6. **Hook-Box und KI-Hinweis:**
   - Die Hook-Box ist weiß mit schwarzer Helvetica Bold in Versalien und steht ab Frame 0 bis zum Gold-Blitz.
   - Der KI-Hinweis „Info: Dieses Video wurde mit KI erstellt.“ steht genauso lange.

   Weil: Das ist die Referenz TW_Reel_34. Der Hinweis dient der Kennzeichnung nach EU AI Act Art. 50.

7. **Gold-Blitz am Hook-Ende:**
   - Der Blitz kommt mit Camera Shutter.
   - Der Riser ist so gelegt, dass sein Peak auf den Blitz fällt, und er endet zusammen mit dem Shutter (bei Blitz + 0,25 s, Fade-out 80 ms).

   Weil: Die Referenz arbeitet so. Den Riser-Schluss hat der User am 07.10. korrigiert („zu lange, soll gleichzeitig mit dem Camera Shutter enden“).

8. **Sound:**
   - Keine Musik.
   - Nur Sounds aus der eigenen Library des Users.
   - Die Effekte liegen klar unter der Stimme.
   - Integrierte Lautheit −17 LUFS.

   Weil: Das sind Vorgabe und Branding. Ein lauter Whoosh hat den User einmal erschreckt, das nannte er „fatal“.

9. **B-Rolls passen wörtlich zur Stelle.** Wenn ein Begriff kein eindeutiges Bild hat, dann kein B-Roll. Weil: Der User hat unpassende Clips wieder rausnehmen lassen:
   - Reel 33: Handy-Nahaufnahme bei „Einlagen des Bankensystems“,
   - Reel 38: Flugzeug,
   - Reel 40: Handschlag bei „Auslandskonto“, Kommentar „passt gar nicht“.

10. **KI-Fehler im Rohvideo werden mit B-Roll abgedeckt.** Gemeint sind z. B. ein Ring am Finger (Reel 41/42) oder eine fehlende Hand (Reel 51). Danach per Skript prüfen, dass jeder betroffene Frame abgedeckt ist. Weil: Diese Fehler verraten den KI-Klon.

11. **Alle Einblendungen und Bildfragmente stehen mindestens 6 Frames.**
    - Kein Text steht kürzer als 6 Frames.
    - Kein Bildausschnitt und kein B-Roll steht kürzer als 6 Frames.
    - Keine Überlappung von zwei Untertiteln in derselben Zeile.

    Weil: In Reel 33 v1 hat ein einzelner Frame aufgeblitzt. Die Minizoom-Logik braucht mindestens 3 Frames.

12. **Offene Fragen vor dem Start stellen**, wenn etwas fehlt, z. B. der Hook-Text. **Ausnahme:** Der User sagt ausdrücklich „einfach loslegen“ oder „Text Hooks kannst du dir selbst ausdenken“. Dann selbst entscheiden und das in der Antwort sagen.

13. **Ausgabe:** TW_Reel_<Nr>.mp4, unter 30 MB, 1080×1920, gleiche fps wie das Rohmaterial.

14. **Korrigierte Wörter gelten.** Wenn der User ein Wort korrigiert (z. B. „eines“ statt „ein“, Reel 39), dann steht im Untertitel exakt das, was Thorsten sagt. Das gilt auch dann, wenn der User das Gesagte in seiner Nachricht leicht anders zitiert (Reel 49). Diesen Unterschied in der Antwort erwähnen.

15. **Fremde Aussagen als Zitat.** Wenn Thorsten Sätze anderer wiedergibt, die nicht seine Meinung sind, dann stehen diese Untertitel kursiv in weißer Segoe Pro Bold Italic, 64 px, mit „…“. Weil: Vorgabe des Users vom 05.10. (Reel 39). Man soll sofort sehen, dass es ein Zitat ist.

---

## STANDARD (normalerweise so)

1. **Schnitt:**
   - Jede Pause ab 0,15 s wird geschnitten (0,02 s Luft an den Rändern).
   - Der erste Satz (Hook) bleibt ungeschnitten.
   - Führende Stille am Anfang fällt weg.

   Weil: In der Referenz werden Pausen eng geschnitten. Seit 14.10. schneidet der User nicht mehr selbst.

   **Ausnahme:** Rohvideos, die der User schon geschnitten und gezoomt hat (Reel 45–50, 54). Dann nichts weiter schneiden und keine eigenen Zooms. Es gibt nur einen Schnittpunkt für den Blitz am vorhandenen Szenenwechsel bzw. an der Hook-Pause. Ob vorgeschnitten wurde, erkennt man an harten Szenenwechseln (ffmpeg scene > 0.2) und daran, dass der User „Zooms hab ich schon gemacht“ schreibt.

2. **Hook-Ende:**
   - Der Hook endet, wo der erste Satz endet.
   - Folgt danach keine Pause, dann manuell einen Schnitt in die nächste kleine Lücke setzen (Reel 53).
   - Gibt es gar keine, dann den Hook bis zum nächsten Satzende verlängern (Reel 51).

3. **Hook-Push:** 100 → 106 % über die ganze Hook-Dauer, Anker auf Kinnhöhe.
   - **Ausnahme:** bei vorgezoomtem Material kein Push.
   - Der Wert ist im Code 1,06. In älteren Notizen stand 107–109 % (siehe Teil 4).

4. **Fünf Zooms pro Reel** auf 1,10 / 1,10 / 1,12 / 1,10 / 1,15, gesetzt auf den Beginn inhaltlicher Wendepunkte. 1,15 bekommt die stärkste Aussage, oft kurz vor oder im CTA.

5. **Untertitel und Gold:**
   - Ein Wort pro Einblendung, nach den Merge-Regeln aus style.json gruppiert.
   - Minizoom 0,1 s, so wie der User es in CapCut immer einstellt.

6. **Gold-Momente pro Reel:**
   - 1–2 im Hook (Zahl oder Schlagwort),
   - mindestens 1 Stack (weiß/Gold/weiß),
   - 1 Wipe auf einem Kernbegriff,
   - 1 Liste, wenn Thorsten aufzählt,
   - dazu Pops auf Zahlen, Ländern und Schlagworten.

   Kernaussagen als 2–3-Wort-Gruppe, die länger stehen bleibt. Weil: Das ist der Wunsch des Users ab Reel 33 und die Referenz Reel 34, plus 1–2 eigene Animationen.

7. **B-Rolls:**
   - Anzahl: 2–4 pro Reel.
   - Start 1 Frame vor dem Wort, Ende mit der Textgruppe, harter Schnitt.
   - Abdunklung α 0,36 hinter dem Text.
   - **Ausnahme:** Bei hellen oder goldlastigen Clips α 0,62, sonst ist Gold nicht lesbar (Geldscheine in Reel 43, Stablecoin in Reel 49).

8. **Reihenfolge der B-Roll-Quellen:**
   1. vom User angehängte Clips
   2. sein Stock-Ordner
   3. Canva DAHBwfmCn-0
   4. Higgsfield-Standbild

   Weil: Erst kam die Ansage „nur Canva“ (30.09.). Dann sollte der Ordner bevorzugt werden (05.10.: „Den Rest findest du wie gewohnt im Ordner“). Wenn es nirgends ein Motiv gibt, ein Higgsfield-Bild generieren. Das wurde in Reel 51–54 gemacht und nicht beanstandet, ausdrücklich freigegeben ist es aber nicht (siehe Teil 4).

9. **B-Rolls nicht oft wiederholen.** Ab und zu ist okay (Vorgabe des Users).

10. **Querformat-Clips:**
    - Wenn ein Clip nur im Querformat vorliegt, dann ein anderes Motiv nehmen oder einen 9:16-Crop, der das Motiv noch zeigt.
    - Ist der Crop nichtssagend, das Motiv tauschen.
    - Weil: Korrektur zu Reel 48. Der brennende Geldschein im Querformat mit Unschärfe-Rand wurde abgelehnt und durch die leere Geldbörse ersetzt.

11. **SFX pro Reel:**
    - Riser + Camera Shutter am Blitz
    - Fuwa −18 dB auf 4–6 Gold-Momenten
    - Fuwa −21 dB auf 2–4 weiteren
    - Money_Caching −13 dB genau einmal
    - Ding −9 dB auf das CTA-Keyword

    Nicht mechanisch bei jedem Anlass, sondern an den stärksten Stellen.

12. **CTA:**
    - „Kommentier“ und „mit“ stehen als weiße Untertitel.
    - Darunter folgt das Keyword in Gold, in Versalien und mit Anführungszeichen, als ein Wort, bis zum letzten Frame.
    - **Ausnahme:** Spricht Thorsten keinen CTA, gibt es weder Keyword noch Ding (Reel 50).

13. **Hook-Texte:**
    - Wenn der User einen Hook schickt, wird genau dieser verwendet. Er sagt selbst „die kann ich besser wie du“.
    - Wenn nicht, schlägt Claude per Frage 3 Varianten vor oder setzt einen selbst, falls der User „einfach losstarten“ sagt. Das in der Antwort erwähnen, damit er ihn tauschen kann.

14. **Hook-Zuordnung bei mehreren Reels:** Kommen mehrere Hooks ohne Nummer, nach Inhalt zuordnen und die Zuordnung in der Antwort nennen (Reel 51–53).

15. **Liefern:**
    - Nach jedem fertigen Reel sofort die Datei schicken, nicht warten, bis alle fertig sind.
    - In der Antwort kurz aufzählen: Hook, B-Rolls mit Stelle, Gold-Momente, Besonderheiten.

---

## VERBOTEN

1. **Musik** jeder Art in Thorsten-Reels. Global gilt außerdem: niemals Musik mit ElevenLabs generieren.
2. **Swish_Whoosh_Large und andere laute, erschreckende Effekte.** Seit 14.10. ganz raus.
3. **Blau in Schrift, Schatten oder Kontur,** dazu jede zweite Akzentfarbe neben #fab926. (Korrektur Reel 32 v1)
4. **Kontur um die Untertitel.** Einzige Ausnahme: die gleichfarbige 2-px-Verdickung beim CTA.
5. **Zoom kurz rein und gleich wieder raus, langsames Rauszoomen, abrupte Zooms.** (Korrekturen Reel 32, 38, 05.10.)
6. **Text über Gesicht, Mund oder Kinn,** auch nicht für einen Frame. (30.09.)
7. **B-Rolls, die nur grob zum Thema passen** (z. B. Symbol-Handy bei „Einlagen“, Flugzeug ohne Flugbezug, Handschlag bei „Auslandskonto“).
8. **Querformat-B-Roll mit Rand oder Unschärfe-Hintergrund.** (Reel 48)
9. **Klischee-Motive:**
   - brennende Geldscheine (laut Brandingguide-Analyse ohnehin zu vermeiden, außerdem in Reel 48 abgelehnt),
   - kitschige Stock-Fotos,
   - Schwarz-Weiß-Anzug-Bilder.
10. **Emojis, Memes, Sticker, Logo, Wasserzeichen, Progressbar, Endkarte, Outro, Kapitel-Titel oben.** Kapitel-Titel gibt es seit Reel 34 nicht mehr.
11. **Abgeschnittene Unterlängen beim Wipe.** Die Maske braucht Padding 0.4em 16px. (Fix Reel 36)
12. **Mini-Fragmente unter 6 Frames.** (Fehler Reel 33 v1)
13. **Ein Riser, der nach dem Camera Shutter weiterläuft.** (Korrektur 07.10.)
14. **Lange B-Roll-Suche in Canva.** Lieber aus der bekannten Seitenliste bzw. dem Ordner direkt wählen. (Vorgabe des Users)
15. **Ein B-Roll, der länger läuft als der Clip** (Standbild am Ende). Generierte Bilder deshalb immer als 7-s-Clip rendern.
16. **Den Hook-Text als gesprochenen Satz übernehmen.** Er muss eine zugespitzte These oder Frage sein.
17. **Den User mit falschem Namen ansprechen.** In meinen alten Notizen steht „Dawid“, das ist ein Kunde und nicht der User (siehe Teil 4).

---

## Zusammenspiel Hook und Body

### Innerhalb eines Reels (das haben wir gemacht)

| Phase | Zeit | Was passiert |
|---|---|---|
| Hook | Frame 0 bis flash_c | Segment 0 ungeschnitten, Hook-Box + KI-Hinweis, Push 1.00→1.06, 1–2 Gold-Pops, Riser baut auf |
| Übergang | flash_c ±5 Frames | Gold-Blitz (11 Frames), Camera Shutter bei flash − 0,09 s, Riser-Peak auf flash, Riser-Ende flash + 0,25 s; Hook-Box und Hinweis verschwinden hart auf flash_c; Kamera springt hart auf 100 % (neues Segment) |
| Body | ab flash_c | Jump-Cuts, Zooms, Gold, B-Rolls, ein Fuwa kurz nach dem Blitz auf dem ersten Gold-Moment |
| CTA | ab „Kommentier“ | Keyword + Ding bis zum Ende, oft mit 1,12–1,15-Zoom auf „wie du…“ |

### Ads (TW_CCC): mehrere Hooks + gemeinsamer Body

**unklar.** Das wurde in diesem Chat nicht bearbeitet. Es gibt keine Entscheidung dazu, wie Hooks und Body hier zusammenspielen: kein Übergang, kein Timing, keine Festlegung, was pro Hook wechselt und was gleich bleibt. Die Projekt-Docs „ads-bodies-rrc.md“ und die Memory-Einträge zu TW_CCC stammen aus anderen Chats. Ich habe sie hier nicht übernommen, um nichts zu erfinden (siehe Teil 4).

---

## Arbeitsablauf (reproduzierbar)

1. **Rohvideo vorbereiten:**
   - Proxy: x264, CRF 14, GOP 15, ohne Ton → `rm/public/raw.mp4`
   - Mono-WAV mit 16 kHz
   - silencedetect (−35 dB, 0,12 s) → `sil.txt`
2. **Transkribieren:** faster-whisper medium, int8, Deutsch, word_timestamps, beam 5 (`tr.py`). Danach Wortgrenzen an die Stillen anpassen (`words.py`).
3. **Kinn messen:** `chin.py raw.mp4 chin_raw.json 3`. AY = Median, DY so wählen, dass `chin_check` bei 20 px nichts mehr meldet.
4. **Plan bauen** (`cfg_<nr>.py` → `mk.py` → `build_edit.py`):
   - Segmente, Zooms, Captions, Gold-Gruppen, B-Rolls, SFX-Zeitpunkte
   - Prüfungen: Fragmente ≥ 6 Frames, Captions ≥ 6 Frames, kein Zoomschritt > 0,0105/Frame außerhalb von Schnitt und B-Roll
5. **Kontroll-Stills rendern** (`stills.mjs`) und ansehen.
6. **Ton:** `audio.py` (Stimme schneiden, SFX mischen, Loudnorm −17).
7. **Rendern:** `run.sh` (Remotion → mux → x265 2-pass).
8. **QC:** Dauer und LUFS prüfen, Abdeckung der Problemstellen prüfen, dann liefern.
