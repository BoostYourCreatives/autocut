# Stil "motions"

Angelegt als Kopie von "thorsten". Noch nichts hier ist auf den neuen Kunden angepasst.

## Das musst du ersetzen

1. **regeln.md**: die Regeln des neuen Kunden (MUSS / STANDARD / VERBOTEN), in eigenen Worten, mit Begründung.
2. **style.json**: die maschinenlesbare Fassung (Schriften, Farben, Untertitel, Zooms, B-Roll, Übergänge).
3. **params.json**: alle Zahlen, die der Code liest (Layout, Zoom, Sound, Export). Die Felder `_quelle` und `_todo` zeigen, woher ein Wert kommt.
4. **beispiel-plan_*.json**: ein bis zwei fertige Schnitte des Kunden als Beispiel für Claude (sehr wichtig für die Qualität).
5. Schriften in assets/fonts und Sounds in der SFX-Library bereitstellen.

Starten mit diesem Stil: Umgebungsvariable `AUTOCUT_STYLE=motions` setzen (Railway: Variables) oder in config/autocut.config.json `"style": "motions"`.
Offene Platzhalter anzeigen: `AUTOCUT_STYLE=motions npx tsx src/cli.ts todos`.
