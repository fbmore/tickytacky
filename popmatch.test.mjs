import assert from "node:assert/strict";
import { foldPop, encodePop, decodePop, POP_TURNS, roundBoard } from "./popmatch.js";
import { cube, canExtend, isValidChain } from "./popgame.js";

let ts = 0;
const ev = (author, kind, extra = {}) => ({ author, authorName: author, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, recordName: `r${ts}`, ...extra });
/** First valid 3-chain on the board. */
function chain(b) {
  const { neighbours } = cube(b.n);
  for (let s = 0; s < b.cells.length; s++) for (const j of neighbours[s]) {
    if (!canExtend(b, [s], j)) continue;
    for (const k of neighbours[j]) if (canExtend(b, [s, j], k)) return [s, j, k];
  }
  return null;
}

assert.deepEqual(decodePop("1,2,3|4"), { path: [1, 2, 3], gravity: 4 });
assert.equal(decodePop("1,2,3|6"), null);
assert.equal(decodePop("1,a,3|2"), null);
assert.equal(decodePop("1,2,3"), null);
assert.equal(encodePop([5, 6, 7], 2), "5,6,7|2");

const id = "abc23defgh";
let events = [ev("ann", "join", { cell: 3, text: "Ann", color: "gold" })];
let s = foldPop(events, id);
assert.equal(s.size, 3);
assert.equal(s.turn, "X");
// Same board as a fresh roundBoard (deterministic seed from the id).
assert.deepEqual(s.board.cells, roundBoard(id, 3, 0).cells);

// The host may pop before the guest joins; the guest can't move until they join.
const popNow = (who) => { const c = chain(s.board); events.push(ev(who, "pop", { text: encodePop(c, 2), round: s.round })); s = foldPop(events, id); return c; };
popNow("ann");
assert.equal(s.score.X > 0, true);
assert.equal(s.turn, "O");
events.push(ev("bob", "pop", { text: "0,1,2|2" })); s = foldPop(events, id);
assert.equal(s.pops.length, 1, "not joined yet: ignored");
events.push(ev("bob", "join", { text: "Bob", color: "gold" })); s = foldPop(events, id);
assert.equal(s.players.O.name, "Bob");
assert.notEqual(s.colors.O, s.colors.X, "colour collision resolved");
// Out of turn ignored; invalid chain ignored.
events.push(ev("ann", "pop", { text: encodePop(chain(s.board), 2) })); s = foldPop(events, id);
assert.equal(s.pops.length, 1);
events.push(ev("bob", "pop", { text: "0,13,26|2" })); s = foldPop(events, id);
assert.equal(s.pops.length, 1);
// Play out the round.
while (!s.over) popNow(s.turn === "X" ? "ann" : "bob");
assert.equal(s.turns.X, POP_TURNS); assert.equal(s.turns.O, POP_TURNS);
assert.ok(["X", "O", "draw"].includes(s.over.winner));
const totalWins = s.wins.X + s.wins.O;
// Rematch needs both; new round, new board, O starts.
const r0 = s.board.cells.map((o) => o.color).join("");
events.push(ev("ann", "again", { round: 0 })); s = foldPop(events, id);
assert.equal(s.round, 0);
events.push(ev("bob", "again", { round: 0 })); s = foldPop(events, id);
assert.equal(s.round, 1); assert.equal(s.turn, "O"); assert.equal(s.score.X, 0);
assert.notEqual(s.board.cells.map((o) => o.color).join(""), r0);
assert.equal(s.wins.X + s.wins.O, totalWins);
// Resign gives the other player the round; close ends the game.
events.push(ev("bob", "resign", { round: 1 })); s = foldPop(events, id);
assert.equal(s.over.winner, "X"); assert.equal(s.resigned, "O");
events.push(ev("bob", "close")); events.push(ev("ann", "join", { text: "Ann2" })); s = foldPop(events, id);
assert.equal(s.closedBy, "O"); assert.equal(s.players.X.name, "Ann");
// Every pop recorded is a valid chain on the board it was played on.
assert.ok(foldPop(events.slice(0, 25), id).pops.every((p) => isValidChain(p.before, p.path)));
console.log("popmatch.test: all passed");
