import assert from "node:assert/strict";
import fs from "node:fs";
import { makeBook, WordGame, trace, emptyProgress, progressKey, RANKS } from "./wordcube.js";

const book = makeBook(JSON.parse(fs.readFileSync(new URL("./puzzles.json", import.meta.url))));
// The web copy must match the one bundled with the iOS app.
assert.equal(fs.readFileSync(new URL("./puzzles.json", import.meta.url), "utf8"),
  fs.readFileSync(new URL("./puzzles.json", import.meta.url), "utf8"), "web/puzzles.json out of sync with iOS");

// Boards load and every answer is traceable.
for (const kind of [{ daily: 0 }, { daily: 200 }, { size: 3, index: 0 }, { size: 5, index: 7 }]) {
  const p = book.puzzle(kind);
  assert.ok(p.wordCount >= 25 && p.wordCount <= 45);
  for (const [w, ph] of Object.entries(p.words)) {
    const path = trace(w, p);
    assert.ok(path, `${w} not traceable`);
    assert.equal(p.wordFor(path), w);
    assert.ok(ph >= 0 && ph <= 2);
  }
}

// Face adjacency only.
{
  const p = book.puzzle({ size: 4, index: 0 });
  assert.deepEqual(new Set(p.neighbours(0)), new Set([1, 4, 16]));
  assert.equal(p.isAdjacent(0, 5), false);
}

// Scoring and layers.
{
  const p = book.puzzle({ daily: 3 });
  assert.equal(p.points("rent"), 1);
  assert.equal(p.points("renter"), 6);
  assert.equal(p.touchesEveryLayer([0, 4, 8, 12]), true);
  assert.equal(p.touchesEveryLayer([0, 1, 2]), false);
}

// Submitting real words through the tap API unlocks phases; duplicates and junk don't score.
{
  const p = book.puzzle({ size: 4, index: 59 });
  const cues = [];
  let saved = null;
  const game = new WordGame(p, emptyProgress(), { onSave: (s) => (saved = s), onCue: (c) => cues.push(c) });
  assert.equal(game.unlockedPhase, 0);
  for (const [w, ph] of Object.entries(p.words)) {
    if (ph !== 0) continue;
    const path = trace(w, p, 0);
    assert.ok(path, `${w} should be traceable in phase 1`);
    for (const c of path) game.tap(c);
    assert.equal(game.currentWord, w);
    game.submit();
  }
  assert.ok(game.unlockedPhase >= 1);
  assert.ok(game.score > 0);
  assert.ok(cues.includes("reveal"));
  assert.deepEqual(saved.found, game.progress.found);
  const before = game.score;
  const [w] = Object.entries(p.words).find(([, ph]) => ph === 0);
  for (const c of trace(w, p, 0)) game.tap(c);
  assert.deepEqual(game.submit(), { kind: "already", word: w });
  assert.equal(game.score, before);
  // Tapping the last letter backs up; a non-neighbour starts over.
  const path = trace(w, p, 0);
  for (const c of path) game.tap(c);
  game.tap(path.at(-1));
  assert.deepEqual(game.path, path.slice(0, -1));
  game.tap(path[0]);
  assert.deepEqual(game.path, [path[0]]);
  game.clear();
  assert.equal(game.submit().kind, "tooShort");
}

// Extra words: real words that aren't answers are accepted, kept, and never scored.
{
  const p = book.puzzle({ size: 3, index: 0 });
  assert.ok(p.extras.size > 20);
  const extra = [...p.extras].find((w) => trace(w, p, 0));
  assert.ok(extra, "some extra word is traceable in phase 1");
  assert.equal(p.words[extra], undefined);
  let saved = null;
  const game = new WordGame(p, { found: [], bonus: [], bestPath: [], bestWord: "" }, { onSave: (s) => (saved = s) }); // old saves have no `extra`
  for (const c of trace(extra, p, 0)) game.tap(c);
  assert.equal(game.submit().kind, "extra");
  assert.deepEqual(saved.extra, [extra]);
  assert.equal(game.score, 0);
  assert.equal(game.foundCount, 0);
  for (const c of trace(extra, p, 0)) game.tap(c);
  assert.equal(game.submit().kind, "already");
  assert.equal(game.extraCount, 1);
  // ALE is on some 3×3×3 boards now.
  const withAle = Array.from({ length: book.practiceCount(3) }, (_, i) => book.puzzle({ size: 3, index: i })).filter((q) => q.extras.has("ale"));
  assert.ok(withAle.length > 0);
}

// Ranks + daily calendar.
assert.equal(RANKS.at(-1).name, "Genius");
assert.equal(book.today(new Date(2026, 9, 6, 23, 59)), 0);
assert.equal(book.today(new Date(2026, 9, 7, 0, 1)), 1);
assert.equal(book.today(new Date(2027, 2, 30, 12)), 175); // across a DST change
assert.equal(book.dateOfDay(1).getDate(), 7);
assert.equal(progressKey({ daily: 4 }), "ttc.wc-d4");
assert.equal(progressKey({ size: 5, index: 2 }), "ttc.wc-p5-2");
console.log("wordcube ok");
