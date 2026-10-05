import assert from "node:assert/strict";
import { LINES, fold, idx } from "./game.js";

assert.equal(LINES.length, 76, "76 winning lines");
assert.ok(LINES.every((l) => l.length === 4));

let ts = 0;
const ev = (author, kind, extra = {}) => ({ author, authorName: author, kind, round: 0, cell: -1, text: "", ts: ++ts, ...extra });
const mv = (a, cell, round = 0) => ev(a, "move", { cell, round });

const base = [ev("a", "join", { text: "Ann" }), ev("b", "join", { text: "Bob" }), ev("c", "join", { text: "Eve" })];
let s = fold(base);
assert.equal(s.players.X.name, "Ann");
assert.equal(s.players.O.name, "Bob");
assert.equal(s.turn, "X");

// turn alternation + illegal moves ignored
s = fold([...base, mv("b", 5), mv("a", 0), mv("a", 1), mv("b", 0), mv("c", 9), mv("b", 99), mv("b", 16)]);
assert.equal(s.board[0], "X");
assert.equal(s.board[1], null, "X cannot move twice");
assert.equal(s.board[5], null, "O cannot move first");
assert.equal(s.board[16], "O");
assert.equal(s.turn, "X");

// win detection along the x axis on y=0,z=0 ; O plays z=1
const win = [...base,
  mv("a", idx(0,0,0)), mv("b", idx(0,0,1)), mv("a", idx(1,0,0)), mv("b", idx(1,0,1)),
  mv("a", idx(2,0,0)), mv("b", idx(2,0,1)), mv("a", idx(3,0,0)), mv("b", idx(3,0,1))];
s = fold(win);
assert.equal(s.winner, "X");
assert.deepEqual([...s.winLine].sort((a, b) => a - b), [0, 1, 2, 3]);
assert.equal(s.score.X, 1);
assert.equal(s.board[idx(3,0,1)], null, "no moves after win");

// rematch needs both
s = fold([...win, ev("a", "again")]);
assert.equal(s.round, 0);
assert.equal(s.ready.X, true);
s = fold([...win, ev("a", "again"), ev("b", "again")]);
assert.equal(s.round, 1);
assert.equal(s.turn, "O", "round 1 starts with O");
assert.ok(s.board.every((c) => c === null));
assert.equal(s.score.X, 1);
// old-round moves ignored
s = fold([...win, ev("a", "again"), ev("b", "again"), mv("b", 7, 0), mv("b", 8, 1)]);
assert.equal(s.board[7], null);
assert.equal(s.board[8], "O");

// space diagonal win
const diag = [...base, mv("a", idx(0,0,0)), mv("b", 1), mv("a", idx(1,1,1)), mv("b", 2), mv("a", idx(2,2,2)), mv("b", 3), mv("a", idx(3,3,3))];
assert.equal(fold(diag).winner, "X");

console.log("game.test: all passed");
