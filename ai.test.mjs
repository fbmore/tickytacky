import assert from "node:assert/strict";
import { geometry } from "./game.js";
import { decide, threatsFor } from "./ai.js";

const empty = (n) => new Array(n * n * n).fill(null);

// Wins when it can, on every level.
for (const level of ["relaxed", "clever", "ruthless"]) {
  const b = empty(4);
  [16, 17, 18].forEach((c) => (b[c] = "O"));
  [0, 1, 2].forEach((c) => (b[c] = "X"));
  assert.equal(decide(b, 4, "O", level).cell, 19, `${level} takes the win`);
}

// Blocks (clever and ruthless always do).
for (const level of ["clever", "ruthless"]) {
  const b = empty(4);
  [0, 1, 2].forEach((c) => (b[c] = "X"));
  b[40] = "O";
  const d = decide(b, 4, "O", level);
  assert.equal(d.cell, 3, `${level} blocks`);
  assert.equal(d.mood, "blocked");
}

// Threat detection matches lines.
{
  const g = geometry(3), b = empty(3);
  b[g.idx(0, 0, 0)] = "X"; b[g.idx(1, 1, 1)] = "X";
  assert.ok(threatsFor(b, 3, "X").has(g.idx(2, 2, 2)));
}

// Ruthless is quick: empty 5×5×5 and a busy mid-game board.
function timed(board, n) {
  const t = performance.now();
  const d = decide(board, n, "O", "ruthless");
  const ms = performance.now() - t;
  assert.ok(d && board[d.cell] == null, "legal move");
  return ms;
}
const t1 = timed(empty(5), 5);
const mid = empty(5);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 30; k++) {
  const p = k % 2 ? "O" : "X";
  const d = decide(mid, 5, p, "clever", rnd);
  mid[d.cell] = p;
  if (threatsFor(mid, 5, "X").size && threatsFor(mid, 5, "O").size) break;
}
const t2 = timed(mid, 5);
const b4 = empty(4); [0, 21, 5, 26, 42, 10].forEach((c, i) => (b4[c] = i % 2 ? "O" : "X"));
const t3 = timed(b4, 4);
console.log(`ruthless ms: empty5=${t1.toFixed(1)} mid5=${t2.toFixed(1)} mid4=${t3.toFixed(1)}`);
for (const t of [t1, t2, t3]) assert.ok(t < 300, `ruthless under 300 ms (${t.toFixed(1)})`);

console.log("ai.test: all passed");
