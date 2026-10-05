// Computer opponent — a straight port of ios/TicTacCube/Game/AI.swift.
// - relaxed: plays the shape of the game, sometimes misses blocks.
// - clever: always wins/blocks, heuristic otherwise.
// - ruthless: also hunts forced wins (chains of threats the opponent must answer)
//   and defends against the player's forced wins.

import { geometry } from "./game.js";

export const LEVELS = ["relaxed", "clever", "ruthless"];
const other = (p) => (p === "X" ? "O" : "X");

/** Empty cells that would complete a line for `p` right now. */
export function threatsFor(board, n, p) {
  const out = new Set();
  for (const line of geometry(n).lines) {
    let own = 0, empty = -1, blocked = false;
    for (const c of line) {
      if (board[c] === p) own++;
      else if (board[c] == null) { if (empty >= 0) { blocked = true; break; } empty = c; }
      else { blocked = true; break; }
    }
    if (!blocked && own === n - 1 && empty >= 0) out.add(empty);
  }
  return out;
}

function completesLine(board, n, cell) {
  const p = board[cell];
  if (!p) return false;
  const g = geometry(n);
  return g.through[cell].some((li) => g.lines[li].every((c) => board[c] === p));
}

function threatsAfter(cell, board, n, p) {
  const b = board.slice();
  b[cell] = p;
  const g = geometry(n);
  let count = 0;
  for (const li of g.through[cell]) {
    let own = 0, empty = 0;
    for (const c of g.lines[li]) { if (b[c] === p) own++; else if (b[c] == null) empty++; }
    if (own === n - 1 && empty === 1) count++;
  }
  return count;
}

/** Victory by continuous threats; returns the first move of a winning chain. */
function forcedWin(board, n, p, depth, budget) {
  if (depth <= 0 || budget.left <= 0) return null;
  const opp = other(p);
  if (threatsFor(board, n, opp).size) return null; // they'd just win instead
  for (let c = 0; c < board.length; c++) {
    if (board[c] != null) continue;
    if (--budget.left <= 0) return null;
    const b = board.slice();
    b[c] = p;
    const mine = threatsFor(b, n, p);
    if (mine.size >= 2) return c;
    if (mine.size === 0) continue;
    const block = mine.values().next().value;
    b[block] = opp;
    if (completesLine(b, n, block)) continue;
    if (threatsFor(b, n, p).size) return c;      // still have a win ready
    if (threatsFor(b, n, opp).size) continue;    // their block made a threat; chain breaks
    if (forcedWin(b, n, p, depth - 1, budget) != null) return c;
  }
  return null;
}

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

/**
 * @returns {{cell:number, mood:'winning'|'blocked'|'forcing'|'sneaky'|'calm'} | null}
 */
export function decide(board, n, me, level = "clever", rnd = Math.random) {
  const empty = [];
  board.forEach((v, i) => { if (v == null) empty.push(i); });
  if (!empty.length) return null;
  const them = other(me);

  const win = threatsFor(board, n, me);
  if (win.size) return { cell: win.values().next().value, mood: "winning" };
  const theirs = threatsFor(board, n, them);
  if (theirs.size && (level !== "relaxed" || rnd() < 0.75)) return { cell: theirs.values().next().value, mood: "blocked" };
  if (level === "relaxed" && rnd() < 0.3) return { cell: pick(empty, rnd), mood: "calm" };

  if (level === "ruthless") {
    let c = forcedWin(board, n, me, 9, { left: 15000 });
    if (c != null) return { cell: c, mood: "forcing" };
    c = forcedWin(board, n, them, 7, { left: 15000 });
    if (c != null) return { cell: c, mood: "sneaky" };
  }
  if (level !== "relaxed") {
    const fork = empty.find((c) => threatsAfter(c, board, n, me) >= 2);
    if (fork != null) return { cell: fork, mood: "forcing" };
    if (level === "ruthless") {
      const stop = empty.find((c) => threatsAfter(c, board, n, them) >= 2);
      if (stop != null) return { cell: stop, mood: "sneaky" };
    }
  }

  const g = geometry(n);
  const weights = Array.from({ length: n + 1 }, (_, k) => (k < n ? Math.pow(5.5, k) : 0));
  let best = [], bestScore = -Infinity;
  for (const c of empty) {
    let s = 0;
    for (const li of g.through[c]) {
      let mine = 0, oth = 0;
      for (const x of g.lines[li]) { if (board[x] === me) mine++; else if (board[x] === them) oth++; }
      if (mine > 0 && oth > 0) continue;
      s += weights[mine] + 0.85 * weights[oth];
    }
    if (level !== "ruthless") {
      const [lo, hi] = level === "relaxed" ? [0.5, 1.5] : [0.92, 1.08];
      s *= lo + rnd() * (hi - lo);
    }
    if (s > bestScore + 0.001) { bestScore = s; best = [c]; }
    else if (Math.abs(s - bestScore) <= 0.001) best.push(c);
  }
  return { cell: pick(best, rnd), mood: "calm" };
}

// Lines the computer says (same as the iOS app).
export const BANTER = {
  blocked: ["Not so fast 😏", "Saw that one coming.", "Nope!", "Nice try."],
  forcing: ["Hmm, watch this…", "Two ways to win now 👀", "Getting interesting."],
  sneaky: ["I see what you’re building.", "Clever. Not clever enough."],
  aiWins: ["Good game! Again? 🙂", "Gotcha 😄", "That was fun. Rematch?"],
  youWin: ["Okay, okay. Rematch?", "Well played 👏", "I didn’t see that line!"],
  draw: ["A full cube! Respect."],
  resigned: ["Good game. Again?", "I’ll take it 😌", "Next one’s yours, maybe."],
};
