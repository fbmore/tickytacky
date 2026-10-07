// Cube Pop rules: a bit-exact port of ios/TicTacCube/Pop/PopGame.swift (see PROTOCOL.md,
// "Cube Pop games"). Same seed → same board, refills and scores on every client.

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9E3779B97F4A7C15n;

export const COLOR_COUNT = 5;
export const MIN_CHAIN = 3;
export const MOVES_PER_GAME = 30;
export const POP_SIZES = [3, 4, 5];
/** Colour index → palette key (shared with game.js PALETTE). */
export const POP_COLORS = ["coral", "teal", "gold", "violet", "sky"];
/** Gravity index = Swift `Axis.rawValue`. */
export const AXES = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
export const AXIS_NAMES = ["negX", "posX", "negY", "posY", "negZ", "posZ"];

/** SplitMix64 as an object with BigInt state. */
export function splitmix(seed) {
  return { state: BigInt.asUintN(64, BigInt(seed)) };
}
export function next(rng) {
  rng.state = (rng.state + GOLDEN) & MASK;
  let z = rng.state;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
  return z ^ (z >> 31n);
}

export function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  for (const ch of s) {
    for (const b of new TextEncoder().encode(ch)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & MASK;
  }
  return h;
}

/** Seed for round `r` of an online / two-player game. */
export function popSeed(id, round) {
  return fnv1a64(id) ^ ((BigInt(round) * GOLDEN) & MASK);
}

/** Seed for the daily: 0xC0BE0000 + day index (days since 2026-10-06, local date). */
export const dailySeed = (day) => 0xC0BE0000n + BigInt(day);

export function dayIndex(date = new Date()) {
  const start = new Date(2026, 9, 6);
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const b = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  return Math.max(0, Math.round((a - b) / 86400000));
}

/* ── geometry ── */

const geo = new Map();
export function cube(n) {
  if (geo.has(n)) return geo.get(n);
  const count = n * n * n;
  const index = (x, y, z) => x + n * y + n * n * z;
  const coords = (i) => [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
  const neighbours = [];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = coords(i), out = [];
    for (const [dx, dy, dz] of AXES) {
      const a = x + dx, b = y + dy, c = z + dz;
      if (a >= 0 && a < n && b >= 0 && b < n && c >= 0 && c < n) out.push(index(a, b, c));
    }
    neighbours.push(out);
  }
  const g = { n, count, index, coords, neighbours };
  geo.set(n, g);
  return g;
}

/* ── board ── */

function makeOrb(board) {
  const color = Number(next(board.rng) % BigInt(COLOR_COUNT));
  const gold = next(board.rng) % 100n < 4n;
  return { id: board.nextID++, color, special: null, gold };
}

/** A fresh n×n×n board from `seed` (BigInt or number). Cells filled in index order. */
export function makeBoard(n, seed) {
  const board = { n, rng: splitmix(seed), nextID: 0, cells: [] };
  for (let i = 0; i < n * n * n; i++) board.cells.push(makeOrb(board));
  return board;
}

export function cloneBoard(b) {
  return { n: b.n, rng: { state: b.rng.state }, nextID: b.nextID, cells: b.cells.map((o) => ({ ...o })) };
}

/** JSON-safe copy (BigInt state → string) and back, for saving. */
export const boardToJSON = (b) => ({ n: b.n, rng: b.rng.state.toString(), nextID: b.nextID, cells: b.cells });
export const boardFromJSON = (j) => ({ n: j.n, rng: { state: BigInt(j.rng) }, nextID: j.nextID, cells: j.cells.map((o) => ({ ...o })) });

/** Colour of a chain: its first non-prism orb (null if all prisms). */
export function chainColor(b, path) {
  for (const c of path) if (b.cells[c].special !== "prism") return b.cells[c].color;
  return null;
}

export function canExtend(b, path, cell) {
  if (!path.length) return true;
  if (path.includes(cell) || !cube(b.n).neighbours[path[path.length - 1]].includes(cell)) return false;
  if (b.cells[cell].special === "prism") return true;
  const color = chainColor(b, path);
  if (color === null) return true;
  return b.cells[cell].color === color;
}

export function isValidChain(b, path) {
  if (!Array.isArray(path) || path.length < MIN_CHAIN) return false;
  if (!path.every((c) => Number.isInteger(c) && c >= 0 && c < b.cells.length)) return false;
  for (let k = 1; k < path.length; k++) if (!canExtend(b, path.slice(0, k), path[k])) return false;
  return true;
}

/** Is there any chain of 3 left? */
export function hasMoves(b) {
  const { neighbours } = cube(b.n);
  for (let s = 0; s < b.cells.length; s++) {
    for (const j of neighbours[s]) {
      if (!canExtend(b, [s], j)) continue;
      for (const k of neighbours[j]) if (canExtend(b, [s, j], k)) return true;
    }
  }
  return false;
}

/** Cells along `axis` through `cell` (for beams). */
export function lineThrough(b, cell, axis) {
  const g = cube(b.n), [x, y, z] = g.coords(cell), [dx, dy, dz] = AXES[axis];
  return Array.from({ length: b.n }, (_, k) => g.index(dx ? k : x, dy ? k : y, dz ? k : z));
}

/** Every line parallel to gravity, each ordered floor → ceiling. */
export function gravityLines(n, gravity) {
  const g = cube(n), [dx, dy, dz] = AXES[gravity];
  const toPos = dx + dy + dz > 0;
  const lines = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      lines.push(Array.from({ length: n }, (_, k) => {
        const t = toPos ? n - 1 - k : k;
        if (dx) return g.index(t, a, b);
        if (dy) return g.index(a, t, b);
        return g.index(a, b, t);
      }));
    }
  }
  return lines;
}

export function specialForChain(len) {
  if (len < 5) return null;
  if (len === 5) return "bomb";
  if (len === 6) return "beam";
  return "prism";
}

/** Points a chain would score before any special fires (for the Pop button). */
export function previewPoints(b, path) {
  if (path.length < MIN_CHAIN) return 0;
  const base = path.length * path.length * 10;
  return path.some((c) => b.cells[c].gold) ? base * 2 : base;
}

/**
 * Pops `path` with gravity along AXES[gravity]; mutates `b` (refills from its RNG).
 * Returns null if the chain isn't valid.
 */
export function pop(b, path, gravity) {
  if (!isValidChain(b, path) || !(gravity >= 0 && gravity < 6)) return null;
  const g = cube(b.n);
  const removed = new Set(path);
  const order = [...path];
  const fired = [];
  const queue = path.filter((c) => b.cells[c].special === "bomb" || b.cells[c].special === "beam");
  const done = new Set();
  while (queue.length) {
    const cell = queue.shift();
    const sp = b.cells[cell].special;
    if (done.has(cell) || !sp || sp === "prism") continue;
    done.add(cell);
    fired.push({ cell, special: sp });
    const blast = sp === "bomb" ? g.neighbours[cell] : lineThrough(b, cell, gravity);
    for (const c of blast) {
      if (removed.has(c)) continue;
      removed.add(c);
      order.push(c);
      const s = b.cells[c].special;
      if (s && s !== "prism") queue.push(c);
    }
  }

  const len = path.length;
  let points = len * len * 10 + (order.length - len) * 15;
  if (path.some((c) => b.cells[c].gold)) points *= 2;
  points = Math.floor(points * (1 + 0.5 * fired.length));

  const created = specialForChain(len);
  let keep = null;
  if (created) {
    const end = path[len - 1];
    removed.delete(end);
    const i = order.indexOf(end);
    if (i >= 0) order.splice(i, 1);
    b.cells[end] = { id: b.cells[end].id, color: b.cells[end].color, special: created, gold: false };
    keep = end;
  }

  const moves = [], spawns = [];
  const cells = b.cells.slice();
  for (const line of gravityLines(b.n, gravity)) {
    const survivors = line.filter((c) => !removed.has(c));
    const gaps = line.length - survivors.length;
    if (!gaps) continue;
    survivors.forEach((from, k) => {
      const to = line[k];
      cells[to] = b.cells[from];
      if (from !== to) moves.push({ id: b.cells[from].id, from, to });
    });
    for (let k = survivors.length; k < line.length; k++) {
      const orb = makeOrb(b);
      cells[line[k]] = orb;
      spawns.push({ orb, cell: line[k], drop: gaps });
    }
  }
  b.cells = cells;
  const createdAt = keep === null ? null : (moves.find((m) => m.from === keep)?.to ?? keep);
  return { popped: order, fired, created, createdAt, moves, spawns, points, gravity };
}

/** Recolour every non-special orb until a chain exists (only call when there's none). */
export function shuffle(b) {
  do {
    for (const o of b.cells) if (!o.special) o.color = Number(next(b.rng) % BigInt(COLOR_COUNT));
  } while (!hasMoves(b));
}

/** A new board that's guaranteed to have a move (as iOS: shuffle if needed). */
export function startBoard(n, seed) {
  const b = makeBoard(n, seed);
  if (!hasMoves(b)) shuffle(b);
  return b;
}

/** Pop + refill + shuffle-if-stuck, as every client must apply it. */
export function applyPop(b, path, gravity) {
  const r = pop(b, path, gravity);
  if (r && !hasMoves(b)) shuffle(b);
  return r;
}
