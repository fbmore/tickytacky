import assert from "node:assert/strict";
import { geometry, fold, threats, boardAt, describeLine, resolveColors } from "./game.js";

// Line counts per size
assert.equal(geometry(3).lines.length, 49, "49 lines for n=3");
assert.equal(geometry(4).lines.length, 76, "76 lines for n=4");
assert.equal(geometry(5).lines.length, 109, "109 lines for n=5");
for (const n of [3, 4, 5]) assert.ok(geometry(n).lines.every((l) => l.length === n));

const { idx } = geometry(4);
let ts = 0;
const ev = (author, kind, extra = {}) => ({ author, authorName: author, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, recordName: `r${ts}`, ...extra });
const mv = (a, cell, round = 0) => ev(a, "move", { cell, round });

const base = [ev("a", "join", { text: "Ann", cell: 4 }), ev("b", "join", { text: "Bob" }), ev("c", "join", { text: "Eve" })];
let s = fold(base);
assert.equal(s.size, 4);
assert.equal(s.players.X.name, "Ann");
assert.equal(s.players.O.name, "Bob");
assert.equal(s.players.c, undefined);
assert.equal(s.turn, "X");

// Size: from the first join only; bad values -> 4
assert.equal(fold([ev("a", "join", { cell: 3 }), ev("b", "join", { cell: 5 })]).size, 3);
assert.equal(fold([ev("a", "join", { cell: 5 }), ev("a", "join", { cell: 3 })]).size, 5);
assert.equal(fold([ev("a", "join", { cell: -1 })]).size, 4);
assert.equal(fold([ev("a", "join", { cell: 9 })]).size, 4);
assert.equal(fold([ev("a", "join", { cell: 5 })]).board.length, 125);

// Colours + collision rule
assert.deepEqual(resolveColors(), { X: "coral", O: "teal" });
assert.deepEqual(fold([ev("a", "join", { color: "gold" }), ev("b", "join", { color: "gold" })]).colors, { X: "gold", O: "violet" });
assert.deepEqual(fold([ev("a", "join", { color: "pearl" }), ev("b", "join", { color: "pearl" })]).colors, { X: "pearl", O: "coral" }, "cyclic");
assert.deepEqual(fold([ev("a", "join", { color: "nope" }), ev("b", "join", { color: "sky" })]).colors, { X: "coral", O: "sky" });

// turn alternation + illegal moves ignored
s = fold([...base, mv("b", 5), mv("a", 0), mv("a", 1), mv("b", 0), mv("c", 9), mv("b", 99), mv("b", 16)]);
assert.equal(s.board[0], "X");
assert.equal(s.board[1], null, "X cannot move twice");
assert.equal(s.board[5], null, "O cannot move first");
assert.equal(s.board[16], "O");
assert.equal(s.turn, "X");
assert.deepEqual(s.moves.map((m) => m.cell), [0, 16]);

// win detection along the x axis on y=0,z=0 ; O plays z=1
const win = [...base,
  mv("a", idx(0,0,0)), mv("b", idx(0,0,1)), mv("a", idx(1,0,0)), mv("b", idx(1,0,1)),
  mv("a", idx(2,0,0)), mv("b", idx(2,0,1)), mv("a", idx(3,0,0)), mv("b", idx(3,0,1))];
s = fold(win);
assert.equal(s.winner, "X");
assert.deepEqual([...s.winLine].sort((a, b) => a - b), [0, 1, 2, 3]);
assert.equal(s.score.X, 1);
assert.equal(s.board[idx(3,0,1)], null, "no moves after win");
assert.equal(describeLine(s.winLine, 4), "across one layer");
assert.deepEqual(boardAt(s, 2).filter(Boolean).length, 2);

// rematch needs both
s = fold([...win, ev("a", "again")]);
assert.equal(s.round, 0);
assert.equal(s.ready.X, true);
s = fold([...win, ev("a", "again"), ev("b", "again")]);
assert.equal(s.round, 1);
assert.equal(s.turn, "O", "round 1 starts with O");
assert.ok(s.board.every((c) => c === null));
assert.equal(s.moves.length, 0);
assert.equal(s.score.X, 1);
// old-round moves ignored
s = fold([...win, ev("a", "again"), ev("b", "again"), mv("b", 7, 0), mv("b", 8, 1)]);
assert.equal(s.board[7], null);
assert.equal(s.board[8], "O");

// Resign: other player wins, +1, no line
s = fold([...base, mv("a", 0), ev("a", "resign")]);
assert.equal(s.winner, "O");
assert.equal(s.resigned, "X");
assert.equal(s.winLine, null);
assert.equal(s.score.O, 1);
// Resign ignored after round over, from wrong round, and from spectators
s = fold([...win, ev("b", "resign")]);
assert.equal(s.winner, "X"); assert.equal(s.score.O, 0);
s = fold([...base, ev("a", "resign", { round: 3 })]);
assert.equal(s.winner, null);
s = fold([...base, ev("c", "resign")]);
assert.equal(s.winner, null);
// Resign → rematch works
s = fold([...base, ev("b", "resign"), ev("a", "again"), ev("b", "again")]);
assert.equal(s.round, 1); assert.equal(s.score.X, 1);

// space diagonal win
const diag = [...base, mv("a", idx(0,0,0)), mv("b", 1), mv("a", idx(1,1,1)), mv("b", 2), mv("a", idx(2,2,2)), mv("b", 3), mv("a", idx(3,3,3))];
s = fold(diag);
assert.equal(s.winner, "X");
assert.equal(describeLine(s.winLine, 4), "corner to corner through the whole cube");

// 3x3x3 win + threats
const g3 = geometry(3);
const three = [ev("a", "join", { cell: 3 }), ev("b", "join"), mv("a", g3.idx(0,0,0)), mv("b", g3.idx(0,2,2)), mv("a", g3.idx(0,1,0))];
s = fold(three);
assert.equal(threats(s.board, 3).get(g3.idx(0,2,0))?.has("X"), true, "X threatens column top");
s = fold([...three, mv("b", g3.idx(1,2,2)), mv("a", g3.idx(0,2,0))]);
assert.equal(s.winner, "X");
assert.equal(describeLine(s.winLine, 3), "straight down through all layers");

// close: host cancels the invite → nobody can join; spectators can't close; later events ignored
s = fold([ev("a", "join", { cell: 4 }), ev("a", "close"), ev("b", "join")]);
assert.equal(s.closedBy, "X");
assert.equal(s.players.O, null);
s = fold([...base, ev("c", "close"), mv("a", 0), ev("b", "close"), mv("b", 1)]);
assert.equal(s.closedBy, "O");
assert.deepEqual(s.moves.map((m) => m.cell), [0]);

console.log("game.test: all passed");
