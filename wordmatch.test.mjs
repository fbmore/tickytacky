import assert from "node:assert/strict";
import fs from "node:fs";
import { makeBook, trace } from "./wordcube.js";
import { foldMatch, boardIndex, encodeWord, decodeWord, TURNS, phaseFor } from "./wordmatch.js";

const book = makeBook(JSON.parse(fs.readFileSync(new URL("./puzzles.json", import.meta.url))));
const puzzleFor = (gameId) => (n, r) => book.puzzle({ size: n, index: boardIndex(gameId, r, book.practiceCount(n)) });
const GID = "abc23defgh";
let ts = 0;
const ev = (author, kind, extra = {}) => ({ author, authorName: author, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, recordName: `r${ts}`, ...extra });
const fold = (list) => foldMatch(list, GID, puzzleFor(GID));

// Board choice: deterministic, changes per round, within range.
assert.equal(boardIndex(GID, 0, 60), boardIndex(GID, 0, 60));
assert.notEqual(boardIndex(GID, 0, 60), boardIndex(GID, 1, 60));
assert.ok(boardIndex("zzzzzzzzzz", 3, 60) < 60);
assert.equal(boardIndex("a", 0, 60), 97 % 60); // h = 97 for "a" (Swift must match)
assert.deepEqual(decodeWord(encodeWord("planet", [1, 2, 3])), { word: "planet", path: [1, 2, 3] });
assert.equal(decodeWord("nope"), null);
assert.equal(decodeWord("ab|1,,2"), null);
assert.equal(decodeWord("ab|+1,2"), null);

// Host joins with a size and may play the first turn before the guest arrives.
const events = [ev("ann", "join", { text: "Ann", cell: 3, color: "gold" })];
let s = fold(events);
assert.equal(s.size, 3);
assert.equal(s.turn, "X");
const p = s.puzzle;
const words0 = Object.entries(p.words).filter(([, ph]) => ph === 0).map(([w]) => w).sort((a, b) => b.length - a.length);
const play = (who, w, round = 0) => ev(who, "word", { round, text: encodeWord(w, trace(w, p, phaseFor(p, new Set(s.claims.map((c) => c.word))))) });
events.push(play("ann", words0[0]));
s = fold(events);
assert.equal(s.claims.length, 1);
assert.equal(s.turn, "O");
assert.ok(s.score.X > 0);
// Nobody can move for O until O joins; Ann can't go twice.
events.push(play("ann", words0[1]));
assert.equal(fold(events).claims.length, 1);
events.push(ev("bob", "join", { text: "Bob", color: "gold" }));
s = fold(events);
assert.equal(s.players.O.name, "Bob");
assert.equal(s.colors.O, "violet"); // same colour as X → next key
// Bob can't claim Ann's word; an untraced or fake path is ignored.
events.push(play("bob", words0[0]));
assert.equal(fold(events).claims.length, 1);
events.push(ev("bob", "word", { text: encodeWord(words0[1], [0, 1]) }));
assert.equal(fold(events).claims.length, 1);
events.push(play("bob", words0[1]));
s = fold(events);
assert.equal(s.claims.length, 2);
assert.equal(s.claims[1].by, "O");
assert.equal(s.turn, "X");
// Two passes in a row end the round.
events.push(ev("ann", "pass"));
s = fold(events);
assert.equal(s.over, null);
events.push(ev("bob", "pass"));
s = fold(events);
assert.equal(s.over.reason, "passes");
const winner = s.score.X > s.score.O ? "X" : s.score.O > s.score.X ? "O" : "draw";
assert.equal(s.over.winner, winner);
// Rematch: both ready → round 1 on a different board, O starts.
events.push(ev("ann", "again"));
assert.equal(fold(events).round, 0);
events.push(ev("bob", "again"));
s = fold(events);
assert.equal(s.round, 1);
assert.equal(s.turn, "O");
assert.equal(s.claims.length, 0);
assert.notEqual(s.puzzle.tiles.join(""), p.tiles.join(""));

// Turn limit: 10 each (passes count as turns; alternate a word so passes never reach 2 in a row).
{
  const list = [ev("ann", "join", { text: "Ann", cell: 4 }), ev("bob", "join", { text: "Bob" })];
  for (let k = 0; k < TURNS * 2; k++) list.push(ev(k % 2 ? "bob" : "ann", "pass"));
  // only passes → ends after the 2nd pass
  assert.equal(foldMatch(list, "t1", puzzleFor("t1")).over.reason, "passes");
  // Ann always passes, Bob always plays a word: never two passes in a row, so only the turn cap ends it.
  const list2 = [ev("ann", "join", { text: "Ann", cell: 4 }), ev("bob", "join", { text: "Bob" })];
  let st = foldMatch(list2, "t2", puzzleFor("t2"));
  const pz = st.puzzle;
  for (let k = 0; k < TURNS * 2; k++) {
    st = foldMatch(list2, "t2", puzzleFor("t2"));
    if (k % 2 === 0) { list2.push(ev("ann", "pass")); continue; }
    const found = new Set(st.claims.map((c) => c.word)), phase = phaseFor(pz, found);
    const free = Object.keys(pz.words).find((w) => !found.has(w) && trace(w, pz, phase));
    list2.push(ev("bob", "word", { text: encodeWord(free, trace(free, pz, phase)) }));
  }
  st = foldMatch(list2, "t2", puzzleFor("t2"));
  assert.equal(st.over?.reason, "turns");
  assert.deepEqual(st.turns, { X: TURNS, O: TURNS });
  assert.equal(st.claims.length, TURNS);
  assert.equal(st.over.winner, "O");
}

// Resign + close.
{
  const list = [ev("ann", "join", { text: "Ann", cell: 4 }), ev("bob", "join", { text: "Bob" }), ev("bob", "resign")];
  let st = foldMatch(list, "r1", puzzleFor("r1"));
  assert.deepEqual(st.over, { reason: "resign", winner: "X" });
  assert.equal(st.wins.X, 1);
  list.push(ev("eve", "close"));
  assert.equal(foldMatch(list, "r1", puzzleFor("r1")).closedBy, null); // spectators can't close
  list.push(ev("ann", "close"), ev("ann", "again"));
  st = foldMatch(list, "r1", puzzleFor("r1"));
  assert.equal(st.closedBy, "X");
  assert.equal(st.ready.X, false); // nothing after close counts
}
console.log("wordmatch ok");
