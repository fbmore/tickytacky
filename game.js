// Pure game logic shared by the web client. Mirrors PROTOCOL.md exactly.

export const SIZES = [3, 4, 5];
export const DEFAULT_SIZE = 4;

export const PRESETS = ["Your move 👀", "Nice one!", "Ooh, sneaky", "Good game 🤝", "Another round?", "Give me a sec"];

export const PALETTE = [
  ["coral", "#FF6B5B"], ["teal", "#2EC4B6"], ["gold", "#F4B942"], ["violet", "#8B6CF6"],
  ["sky", "#4EA8F5"], ["lime", "#8BD45A"], ["rose", "#F26DAA"], ["pearl", "#E8E4DA"],
];
export const PALETTE_KEYS = PALETTE.map(([k]) => k);
export const hexOf = (key) => (PALETTE.find(([k]) => k === key) ?? PALETTE[0])[1];

/** Colour keys actually shown for X and O (O never matches X). */
export function resolveColors(xKey, oKey) {
  const x = PALETTE_KEYS.includes(xKey) ? xKey : "coral";
  let o = PALETTE_KEYS.includes(oKey) ? oKey : "teal";
  if (o === x) o = PALETTE_KEYS[(PALETTE_KEYS.indexOf(x) + 1) % PALETTE_KEYS.length];
  return { X: x, O: o };
}

// ───────────── geometry (cached per size) ─────────────

const geoCache = new Map();
export function geometry(n = DEFAULT_SIZE) {
  if (geoCache.has(n)) return geoCache.get(n);
  const cells = n * n * n;
  const idx = (x, y, z) => x + n * y + n * n * z;
  const coords = (i) => [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
  const seen = new Set();
  const lines = [];
  for (let s = 0; s < cells; s++) {
    const [sx, sy, sz] = coords(s);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const line = [];
          for (let k = 0; k < n; k++) {
            const x = sx + dx * k, y = sy + dy * k, z = sz + dz * k;
            if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) break;
            line.push(idx(x, y, z));
          }
          if (line.length !== n) continue;
          const key = [...line].sort((a, b) => a - b).join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(line);
        }
  }
  const through = Array.from({ length: cells }, () => []);
  lines.forEach((l, li) => l.forEach((c) => through[c].push(li)));
  const g = { n, cells, idx, coords, lines, through };
  geoCache.set(n, g);
  return g;
}

export const sizeFrom = (v) => (SIZES.includes(Number(v)) ? Number(v) : DEFAULT_SIZE);

// ───────────── folding ─────────────

export function sortEvents(events) {
  return [...events].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : String(a.recordName ?? "").localeCompare(String(b.recordName ?? "")));
}

export function emptyState(n = DEFAULT_SIZE) {
  const g = geometry(n);
  return {
    size: n,
    sizeSet: false,
    players: { X: null, O: null }, // {id, name, color}
    colors: resolveColors(),
    round: 0,
    board: new Array(g.cells).fill(null),
    turn: "X",
    winner: null, // 'X' | 'O' | 'draw' | null
    winLine: null,
    resigned: null, // role that resigned this round
    lastMove: null,
    moves: [], // [{cell, role}] this round, for replay
    score: { X: 0, O: 0 },
    ready: { X: false, O: false },
    messages: [],
  };
}

export const starterFor = (round) => (round % 2 === 0 ? "X" : "O");
export const roleOf = (state, id) =>
  state.players.X?.id === id ? "X" : state.players.O?.id === id ? "O" : null;

export function winningLine(board, mark, n) {
  return geometry(n).lines.find((l) => l.every((c) => board[c] === mark)) ?? null;
}

// Fold an (unsorted) list of events into game state.
export function fold(events) {
  let s = emptyState();
  for (const e of sortEvents(events)) s = apply(s, e);
  return s;
}

function resetBoard(s) {
  s.board = new Array(geometry(s.size).cells).fill(null);
  s.turn = starterFor(s.round);
  s.winner = null; s.winLine = null; s.resigned = null; s.lastMove = null; s.moves = [];
}

export function apply(s, e) {
  const role = roleOf(s, e.author);
  switch (e.kind) {
    case "join": {
      if (!s.sizeSet) {
        s.sizeSet = true;
        s.size = sizeFrom(e.cell);
        resetBoard(s);
      }
      if (role) {
        s.players[role].name = e.text || s.players[role].name;
        if (e.color) s.players[role].color = e.color;
      } else if (!s.players.X) s.players.X = { id: e.author, name: e.text || "Player X", color: e.color || "" };
      else if (!s.players.O) s.players.O = { id: e.author, name: e.text || "Player O", color: e.color || "" };
      s.colors = resolveColors(s.players.X?.color, s.players.O?.color);
      break;
    }
    case "move": {
      if (!role || !s.players.X || !s.players.O) break;
      if (e.round !== s.round || s.winner) break;
      if (role !== s.turn) break;
      const c = e.cell;
      if (!Number.isInteger(c) || c < 0 || c >= s.board.length || s.board[c]) break;
      s.board[c] = role;
      s.lastMove = c;
      s.moves.push({ cell: c, role });
      const line = winningLine(s.board, role, s.size);
      if (line) { s.winner = role; s.winLine = line; s.score[role]++; }
      else if (s.moves.length === s.board.length) s.winner = "draw";
      else s.turn = role === "X" ? "O" : "X";
      break;
    }
    case "resign": {
      if (!role || !s.players.X || !s.players.O) break;
      if (e.round !== s.round || s.winner) break;
      const other = role === "X" ? "O" : "X";
      s.winner = other; s.resigned = role; s.winLine = null; s.score[other]++;
      break;
    }
    case "again": {
      if (!role || e.round !== s.round || !s.winner) break;
      s.ready[role] = true;
      if (s.ready.X && s.ready.O) {
        s.round++;
        resetBoard(s);
        s.ready = { X: false, O: false };
      }
      break;
    }
    case "say": {
      const text = String(e.text ?? "").slice(0, 80);
      if (!text) break;
      s.messages.push({ author: e.author, name: e.authorName, text, ts: e.ts });
      if (s.messages.length > 30) s.messages.shift();
      break;
    }
  }
  return s;
}

/** Board after the first k moves of the round (for replay). */
export function boardAt(state, k) {
  const b = new Array(state.board.length).fill(null);
  state.moves.slice(0, k).forEach(({ cell, role }) => { b[cell] = role; });
  return b;
}

/** Empty cells that would complete a line for a player: Map cell -> Set(roles). */
export function threats(board, n) {
  const g = geometry(n);
  const out = new Map();
  for (const line of g.lines) {
    for (const role of ["X", "O"]) {
      let own = 0, empty = -1, blocked = false;
      for (const c of line) {
        if (board[c] === role) own++;
        else if (board[c] == null) { if (empty >= 0) { blocked = true; break; } empty = c; }
        else { blocked = true; break; }
      }
      if (!blocked && own === n - 1 && empty >= 0) {
        if (!out.has(empty)) out.set(empty, new Set());
        out.get(empty).add(role);
      }
    }
  }
  return out;
}

/** Human description of how a winning line runs. */
export function describeLine(line, n) {
  const { coords } = geometry(n);
  const [ax, ay, az] = coords(line[0]);
  const [bx, by, bz] = coords(line[line.length - 1]);
  if (ay === by) return ax === bx || az === bz ? "across one layer" : "diagonally across one layer";
  if (ax === bx && az === bz) return "straight down through all layers";
  if (ax !== bx && az !== bz) return "corner to corner through the whole cube";
  return "diagonally through all layers";
}
