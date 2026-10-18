# Editing-Stile

Ein Stil ist ein Ordner unter `style/<name>/` mit `regeln.md`, `style.json`, `params.json` und Beispielplänen.
Der aktive Stil kommt aus `config/autocut.config.json` (`style`) oder der Umgebungsvariable `AUTOCUT_STYLE`.

- Vorhanden: `thorsten` (Thorsten Wittmann, Reels). Beschreibung als Skill: `.claude/skills/editing-thorsten-wittmann/SKILL.md`.
- Neuen Stil anlegen: `npx tsx src/cli.ts new-style <name> --from thorsten`. Die Checkliste liegt danach in `style/<name>/NEUER-STIL.md`.
- Pro Server läuft immer ein aktiver Stil. Für zwei Kunden gleichzeitig braucht es zwei Railway-Dienste mit unterschiedlichem `AUTOCUT_STYLE`.
