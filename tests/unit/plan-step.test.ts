import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig, loadStyle, type Config } from "../../src/config.ts";
import { plan, planPaths, PlanFailedError } from "../../src/steps/plan.ts";
import type { LlmClient, LlmRequest, LlmTurn } from "../../src/llm/client.ts";
import { runPaths, saveManifest } from "../../src/util/run.ts";
import { writeJson, readJson } from "../../src/util/files.ts";
import { readRunLog } from "../../src/util/runlog.ts";
import { fixtureFromExample, EX53 } from "../helpers/reel.ts";
import { draftReel53 } from "../fixtures/draft-reel53.ts";
import type { QualitySummary } from "../../src/steps/plan.ts";

const TMP = path.join(ROOT, "tests", ".tmp", "plan-step");
let cfg: Config;

/** Scriptbarer LLM-Ersatz: liefert nacheinander vorgegebene Antworten und merkt sich die Requests. */
class FakeLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private answers: (unknown | string)[]) {}
  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.calls.push(structuredClone(req));
    const a = this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)];
    const text = typeof a === "string" ? a : JSON.stringify(a);
    return {
      text,
      content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
      stopReason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: this.calls.length > 1 ? 20000 : 0, cache_write_tokens: this.calls.length > 1 ? 0 : 20000 },
    };
  }
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const sfx = path.join(TMP, "sfx");
  fs.mkdirSync(path.join(sfx, "Impact & Hit"), { recursive: true });
  for (const n of ["Riser.mp3", "Camera_Shutter.mp3", "Fuwa.mp3", "Money_Caching.mp3", "Ding.mp3"]) fs.writeFileSync(path.join(sfx, "Impact & Hit", n), "x");
  cfg = { ...loadConfig(), runsPath: path.join(TMP, "runs"), sfxLibrary: sfx };
  // Run mit den Daten aus Reel 53 anlegen (ohne ffmpeg)
  const run = runPaths(cfg, "r53");
  saveManifest(run, { name: "r53", created_at: new Date().toISOString(), style: "thorsten", clips: [{ id: "reel", role: "reel", source_path: "/x/Reel_53_raw.mp4", precut: "auto" }] });
  const f = fixtureFromExample(EX53, { silencesFromCuts: true, precut: false });
  const p = run.clip("reel");
  writeJson(p.meta, f.meta);
  writeJson(p.transcript, f.transcript);
  writeJson(p.analysis, f.analysis);
});

const badHook = () => ({ ...draftReel53, removals: [{ kind: "fuellwort", from_word_idx: 3, to_word_idx: 3, kept_from_word_idx: null, kept_to_word_idx: null, reason: "x", confidence: "hoch" }] });

test("plan: erster Versuch abgelehnt, zweiter ok; Fehler gehen zurück, Prefix bleibt gleich (Cache)", async () => {
  const llm = new FakeLlm([badHook(), draftReel53]);
  const style = loadStyle(cfg);
  const p = await plan(cfg, style, "r53", { llm, video: "TW_Reel_53" });
  assert.equal(p.video, "TW_Reel_53");

  const pp = planPaths(runPaths(cfg, "r53"));
  assert.ok(fs.existsSync(pp.plan));
  assert.ok(!fs.existsSync(pp.report));
  const q = readJson<QualitySummary>(pp.quality);
  assert.equal(q.attempts, 2);
  assert.deepEqual(q.validator_errors_per_attempt, [1, 0]);
  assert.ok(q.est_cost_usd > 0);
  assert.equal(q.tokens.cache_read_tokens, 20000);

  // Zweiter Request: Konversation = user, assistant (Original-Blöcke), user (Fehlertext)
  const [c1, c2] = llm.calls;
  assert.equal(c1!.system, c2!.system, "statischer Systemprompt muss identisch sein, sonst kein Cache-Treffer");
  assert.equal(c2!.messages.length, 3);
  assert.deepEqual(c2!.messages[0], c1!.messages[0]);
  assert.match(String(c2!.messages[2]!.content), /liegt im Hook/);
  assert.ok(Array.isArray(c2!.messages[1]!.content));

  // Prompt-Inhalt: Regeln, Beispiele, SFX-Index, Transkript mit Indizes und Pausen
  assert.match(c1!.system, /Untertitel liegen immer unter dem Kinn/);
  assert.match(c1!.system, /Beispiel beispiel-plan_reel53/);
  assert.match(c1!.system, /Impact & Hit: .*Riser\.mp3/);
  assert.match(String(c1!.messages[0]!.content), /\[13\]ab\.\n.*Bedeutung\. ⏸0,38/);

  const log = readRunLog(runPaths(cfg, "r53"));
  assert.equal(log.steps.filter((s) => s.step === "plan").length, 2);
  assert.ok(log.steps.every((s) => s.status === "ok"));
  assert.ok(fs.existsSync(path.join(pp.attempts, "attempt-1.json")) && fs.existsSync(path.join(pp.attempts, "attempt-2.json")));
});

test("plan: nach 3 Fehlversuchen wird abgebrochen, nichts gerendert, Fehlerbericht liegt da", async () => {
  const llm = new FakeLlm([badHook()]);
  await assert.rejects(plan(cfg, loadStyle(cfg), "r53", { llm }), (e: unknown) => e instanceof PlanFailedError);
  assert.equal(llm.calls.length, 3);
  const pp = planPaths(runPaths(cfg, "r53"));
  assert.ok(!fs.existsSync(pp.plan), "plan.json darf nicht entstehen");
  assert.match(fs.readFileSync(pp.report, "utf8"), /nicht gerendert/);
});

test("plan: kein JSON in der Antwort zählt als Versuch und wird zurückgemeldet", async () => {
  const llm = new FakeLlm(["Hier ist mein Plan: ...", draftReel53]);
  await plan(cfg, loadStyle(cfg), "r53", { llm });
  assert.equal(llm.calls.length, 2);
  assert.match(String(llm.calls[1]!.messages[2]!.content), /kein gültiges JSON/);
});

test("plan: Validator-Fehler im fertigen Plan gehen zurück (z. B. Riser fehlt in der Library)", async () => {
  fs.rmSync(path.join(cfg.sfxLibrary, "Impact & Hit", "Riser.mp3"));
  const llm = new FakeLlm([draftReel53]);
  await assert.rejects(plan(cfg, loadStyle(cfg), "r53", { llm }), PlanFailedError);
  assert.match(String(llm.calls[1]!.messages[2]!.content), /nicht in der SFX-Library/);
});

test("plan: CLI-Vorgabe 'hart' wird im Prompt genannt und im Plan erzwungen", async () => {
  const llm = new FakeLlm([draftReel53]);
  const p = await plan(cfg, loadStyle(cfg), "r53", { llm, transition: "hart", hookLines: ["Eigene Zeile eins", "Eigene Zeile zwei"] });
  assert.match(String(llm.calls[0]!.messages[0]!.content), /Übergang = hart/);
  assert.equal(p.hook!.transition, "hart");
  assert.deepEqual(p.hook!.lines, ["EIGENE ZEILE EINS", "EIGENE ZEILE ZWEI"]);
  assert.equal(p.hook!.text_origin, "user");
});
