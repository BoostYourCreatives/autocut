import test from "node:test";
import assert from "node:assert/strict";
import { chunkWords } from "../../src/motions/plan.ts";
import { buildScenes, imageName } from "../../src/motions/scenes.ts";

const w = (word: string, s: number, e: number) => ({ word, start_s: s, end_s: e });

test("chunkWords: höchstens 3 Wörter, Satzzeichen weg, Pausen trennen", () => {
  const c = chunkWords([w("Die", 0, 0.2), w("Zukunft", 0.2, 0.7), w("ist", 0.7, 0.9), w("China,", 0.9, 1.4), w("Indien", 2.2, 2.7)]);
  assert.ok(c.every((x) => x.words.length <= 3));
  assert.ok(c.flatMap((x) => x.words).every((x) => !/[.,]$/.test(x.text)));
  assert.equal(c[c.length - 1]!.words[0]!.text, "Indien");
});

test("buildScenes: Überlappung oberer Bildbereich und kurze Szenen werden verworfen", () => {
  const r = buildScenes(
    [
      { type: "image_row", start_s: 3, end_s: 6, items: [{ image_prompt: "a" }] },
      { type: "back_card", start_s: 5, end_s: 8, image_prompt: "b" },
      { type: "glass_panel", start_s: 7, end_s: 7.3, text: "x" },
      { type: "fullscreen_image", start_s: 10, end_s: 15, image_prompt: "c" },
      { type: "glass_panel", start_s: 9, end_s: 11, text: "Kern" },
      { type: "number_item", start_s: 10, end_s: 12, n: 1, text: "Eins" },
    ],
    20,
  );
  assert.deepEqual(r.scenes.map((s) => s.type), ["image_row", "glass_panel"]);
  assert.equal(r.dropped.length, 4);
  assert.equal(imageName("a"), imageName("a"));
});
