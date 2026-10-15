import fs from "node:fs";
import path from "node:path";
import type { Style } from "../config.ts";
import type { Analysis } from "../schema/analysis.ts";
import type { ClipMeta } from "../schema/ingest.ts";
import type { Transcript } from "../schema/transcript.ts";
import type { SfxEntry } from "../lib/sfxIndex.ts";
import { de1, de2 } from "../util/fmt.ts";

/** Transkript als Sätze mit Wortindizes und ⏸-Markierung für Pausen, die der Code automatisch schneidet. */
export function transcriptText(words: Transcript["words"], silences: { start_s: number; end_s: number }[], minPause: number): string {
  const lines: string[] = [];
  let cur: string[] = [];
  let startT = 0;
  const flush = (endT: number) => {
    if (cur.length) lines.push(`(${de2(startT)}–${de2(endT)} s) ${cur.join(" ")}`);
    cur = [];
  };
  words.forEach((w, k) => {
    if (cur.length === 0) startT = w.start_s;
    cur.push(`[${w.i}]${w.word}`);
    const nxt = words[k + 1];
    let pause = 0;
    if (nxt) {
      for (const s of silences) pause = Math.max(pause, Math.min(s.end_s, nxt.start_s) - Math.max(s.start_s, w.end_s));
    }
    if (pause >= minPause) cur.push(`⏸${de2(pause)}`);
    if (/[.?!]["“”]?$/.test(w.word)) flush(w.end_s);
  });
  if (cur.length) flush(words[words.length - 1]?.end_s ?? 0);
  return lines.join("\n");
}

/** Beispielplan des Users auf das Wesentliche reduzieren (Entscheidungen, nicht Layout-Details). */
export function condenseExample(ex: any): unknown {
  const text = (ex.overlays as any[]).filter((o) => o.type === "text");
  const gold = text.filter((o) => o.font === "SegoePro-BoldItalic" && !o.cta).map((o) => ({ text: o.text, animation: o.animation, gruppe: o.group, ab_s: o.start_s, bis_s: o.end_s }));
  const cta = text.find((o) => o.cta);
  const hook = (ex.overlays as any[]).find((o) => o.type === "hook");
  return {
    video: ex.video,
    art: ex.type,
    hook_box: hook?.lines,
    schnitte_rohzeit: (ex.cut_segments as any[]).map((s) => [s.raw_in_s, s.raw_out_s]),
    blitz_bei_s: ex.flash?.center_s,
    zooms: (ex.zooms as any[]).map((z) => ({ ab_s: z.start_s, auf: z.to_scale })),
    b_roll: (ex.broll as any[]).map((b) => ({ ab_s: b.start_s, bis_s: b.end_s, clip: b.src })),
    gold_einblendungen: gold,
    cta_keyword: cta ? { text: cta.text, ab_s: cta.start_s } : null,
    sfx: (ex.sfx as any[]).map((s) => ({ datei: s.file, bei_s: s.at_s ?? s.peak_at_s, gain_db: s.gain_db })),
  };
}

export function sfxIndexText(index: SfxEntry[]): string {
  const byFolder = new Map<string, string[]>();
  for (const e of index) byFolder.set(e.folder || "(Hauptordner)", [...(byFolder.get(e.folder || "(Hauptordner)") ?? []), e.name]);
  return [...byFolder.entries()].map(([f, names]) => `${f}: ${names.join(", ")}`).join("\n");
}

/** Statischer Systemprompt: ändert sich zwischen Läufen nicht (Prompt-Caching). */
export function buildSystemPrompt(style: Style, index: SfxEntry[], exampleFiles: string[]): string {
  const hu = style.params.hook_uebergang as unknown as { kriterium_text?: string };
  const examples = exampleFiles.map((f) => {
    const ex = JSON.parse(fs.readFileSync(f, "utf8"));
    const words = ex.transcript_words.map((w: any) => ({ i: w.i, start_s: w.start_s, end_s: w.end_s, word: w.word }));
    return `### Beispiel ${path.basename(f)}\nTranskript:\n${transcriptText(words, [], 99)}\n\nEntscheidungen des Users (Zeiten = Ausgabe-Timeline, falls nicht anders angegeben):\n${JSON.stringify(condenseExample(ex), null, 1)}`;
  });

  return `Du bist der Cutter für Reels von Thorsten Wittmann. Aus Transkript und technischer Analyse eines Rohvideos entscheidest du, was geschnitten, hervorgehoben und mit B-Roll/SFX belegt wird. Niemand prüft den Plan vorher: Ein Programm führt ihn aus und prüft streng, danach schaut ein Mensch das fertige Video an. Halte dich deshalb exakt an die Regeln unten. Erfinde keine Stilentscheidungen, die dort nicht stehen.

# Arbeitsteilung

Du lieferst NUR Entscheidungen als JSON (Schema wird mitgegeben). Verweise immer auf Wortindizes [i] aus dem Transkript. Folgendes macht der Code danach selbst, du musst es NICHT ausgeben und nicht nachrechnen:
- Pausen: jede Stille ab ${de2(style.params.schnitt.min_pause_s)} s (im Transkript als ⏸ markiert) wird geschnitten, mit ${de2(style.params.schnitt.luft_rand_s)} s Luft an den Rändern. Im Hook werden Pausen nicht geschnitten. Führende Stille und Nachlauf fallen weg. Bei vorgeschnittenem Material wird gar nichts geschnitten.
- Alle weißen Untertitel: ein Wort pro Einblendung, Gruppierung nach den Merge-Regeln, Timing, Mindestdauer.
- Zeitpunkte aller Soundeffekte, Riser und Camera Shutter, Hook-Box und KI-Hinweis inkl. Dauer, Kamera-Push, Zoom-Rampen, Abdunklung hinter B-Roll.

Du entscheidest:
1. **hook**: letztes Wort des ersten Satzes (end_word_idx), die 2 Zeilen der Hook-Box, den Übergang (blitz_riser oder hart).
2. **removals**: Versprecher, Abbrüche, Wiederholungen (doppelte Takes), Füllwörter. Bei einer Wiederholung gibst du den behaltenen Take an (kept_*), meist den letzten, sauberen. Nie im Hook, nie bei vorgeschnittenem Material. Wenn du unsicher bist, ob etwas ein Versprecher ist, lass es drin und setze keine Entfernung: zu viel Streichen ist schlimmer als zu wenig. confidence ehrlich setzen (hoch, mittel, niedrig): sie steuert die Liste „Hier genauer hinschauen“ für den Menschen.
3. **text_corrections**: nur echte Transkriptionsfehler (Namen, Fachwörter) oder so gesprochene Formen. Der Untertitel zeigt sonst exakt das gesprochene Wort.
4. **quotes**: Stellen, an denen Thorsten Aussagen anderer wiedergibt, die nicht seine Meinung sind.
5. **gold** (pop, wipe, stack) und **lists**: die Gold-Momente, siehe Regeln. stack = weiße Zeile oben + goldene Zeile + weiße Zeile unten, alles Wörter, die direkt aufeinanderfolgen. Ein Stack, eine Liste oder ein mehrwortiger Gold-Pop darf KEINE ⏸ (Pause) enthalten, weil er sonst über einen Schnitt läuft. Ein Wort darf nur in einer Hervorhebung vorkommen.
6. **zooms**: Wort, auf dem der Zoom beginnt, und Zielwert (nur ${style.params.zoom.erlaubte_werte.join(", ")}). Nur nach dem Hook, höchstens einer pro Abschnitt zwischen zwei Schnitten (⏸), bis zum Abschnittsende muss mindestens 0,8 s Platz sein. Bei vorgeschnittenem Material: leeres Array.
7. **broll**: 2–4 Slots, nur wo es ein eindeutiges, wörtlich passendes Bild gibt (motif beschreibt, was zu sehen ist). Kein Bild, wenn der Begriff kein eindeutiges Bild hat. Nicht im Hook. covers_ai_error nur true, wenn ein sichtbarer KI-Fehler im Rohvideo abgedeckt werden muss (das kannst du aus dem Transkript nicht sehen, also normalerweise false).
8. **sfx**: Wörter, auf denen fuwa_stark (4–6×), fuwa_leise (2–4×) und money (genau 1× bei Geld/Konto/Betrag) liegen. Nur an den stärksten Stellen, nicht mechanisch. Riser, Shutter und Ding setzt der Code.
9. **cta**: Wort des Keywords nach „Kommentier mit …“. Spricht Thorsten keinen CTA, null.
10. **notes**: Hinweise an den Menschen, falls nötig.

Entscheide den Übergang am Hook-Ende nach dem Inhalt des Hooks: ${hu.kriterium_text ?? "blitz_riser, wenn der Hook ein geschlossener Satz ist und danach ein neuer Abschnitt beginnt; hart, wenn der Satz gedanklich direkt weiterläuft."}

Hook-Ende: der erste Satz bleibt ungeschnitten. Endet er ohne Pause, setzt der Code den Schnitt in die nächste kleine Lücke. Gibt es zwischen Hook-Ende und nächstem Wort keine Lücke (< ${de2(style.params.hook.min_luecke_s)} s), verlängere den Hook bis zum nächsten Satzende.

Hook-Box-Text: zugespitzte These oder Frage in genau 2 Zeilen (je höchstens ${style.params.hook.max_zeichen_zeile} Zeichen), NICHT der gesprochene Satz. Keine Emojis. Wenn der Nutzer einen Hook-Text vorgibt, wird dieser verwendet (du lieferst trotzdem Zeilen, sie werden überschrieben).

reason: ein Satz, der erklärt, warum (z. B. „Zwei ähnliche Takes, Take 2 gewählt, weil Take 1 abbricht“). confidence: hoch = eindeutig, mittel = plausibel, aber ein Mensch sollte hinsehen, niedrig = Vermutung.

# Regeln des Kunden (Quelle der Wahrheit: regeln.md)

${style.regelnMd}

# Stilwerte (Quelle der Wahrheit: style.json)

${JSON.stringify(style.styleJson)}

# Beispiele aus echten, vom User abgenommenen Reels

${examples.join("\n\n")}

# Verfügbare Soundeffekte (nur diese, niemals Sounds oder Musik generieren; Musik gibt es in Thorsten-Reels nicht)

${sfxIndexText(index)}
`;
}

export interface UserPromptInput {
  meta: ClipMeta;
  transcript: Transcript;
  analysis: Analysis;
  minPause: number;
  force?: { transition?: string; hookLines?: [string, string] };
}

export function buildUserPrompt(inp: UserPromptInput): string {
  const { meta, transcript, analysis } = inp;
  const lines: string[] = [];
  lines.push(`Clip: ${meta.id} (${de1(meta.duration_s)} s, ${meta.fps} fps, ${meta.width}x${meta.height})`);
  lines.push(
    analysis.precut.effective
      ? `VORGESCHNITTEN: ja (${analysis.precut.setting === "auto" ? `automatisch erkannt, ${analysis.precut.hard_cuts} harte Schnitte` : "vom User angegeben"}). Keine Entfernungen, keine Zooms, kein Push. Nur Hook-Ende, Gold, B-Roll, SFX, CTA.`
      : `VORGESCHNITTEN: nein. Du schneidest komplett (Pausen macht der Code, du entscheidest über Versprecher, Wiederholungen, Füllwörter).`,
  );
  if (analysis.scene_changes.length) lines.push(`Harte Szenenwechsel bei: ${analysis.scene_changes.map((s) => de2(s.t_s) + " s").join(", ")}`);
  if (analysis.breath_candidates.length) lines.push(`Atmer-Kandidaten (leise, nicht still): ${analysis.breath_candidates.slice(0, 20).map((b) => `${de2(b.start_s)}–${de2(b.end_s)} s`).join(", ")}`);
  if (inp.force?.transition) lines.push(`VORGABE des Users: Übergang = ${inp.force.transition}. Setze hook.transition entsprechend.`);
  if (inp.force?.hookLines) lines.push(`VORGABE des Users: Hook-Text = "${inp.force.hookLines[0]} / ${inp.force.hookLines[1]}". Setze hook.lines entsprechend.`);
  lines.push("", "Transkript (Zeiten in Rohzeit, [i] = Wortindex, ⏸x,xx = Pause in Sekunden, die automatisch geschnitten wird):", transcriptText(transcript.words, analysis.silences, inp.minPause));
  lines.push("", "Liefere den Entwurf als JSON im vorgegebenen Schema.");
  return lines.join("\n");
}
