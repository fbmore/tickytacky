// Pure game logic shared by the web client. Mirrors PROTOCOL.md exactly.

export const N = 4;
export const CELLS = N * N * N;
export const idx = (x, y, z) => x + N * y + N * N * z;
export const coords = (i) => [i % N, Math.floor(i / N) % N, Math.floor(i / (N * N))];

export const PRESETS = ["Your move 👀", "Nice one!", "Ooh, sneaky", "Good game 🤝", "Another round?", "Give me a sec"];

function makeLines() {
  const seen = new Set();
  const lines = [];
  for (let s = 0; s < CELLS; s++) {
    const [sx, sy, sz] = coords(s);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const cells = [];
          for (let k = 0; k < N; k++) {
            const x = sx + dx * k, y = sy + dy * k, z = sz + dz * k;
            if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) break;
            cells.push(idx(x, y, z));
          }
          if (cells.length !== N) continue;
          const key = [...cells].sort((a, b) => a - b).join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(cells);
        }
  }
  return lines;
}
export const LINES = makeLines();

export function sortEvents(events) {
  return [...events].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : String(a.recordName ?? "").localeCompare(String(b.recordName ?? "")));
}

export function emptyState() {
  return {
    players: { X: null, O: null }, // {id, name}
    round: 0,
    board: new Array(CELLS).fill(null),
    turn: "X",
    winner: null, // 'X' | 'O' | 'draw' | null
    winLine: null,
    lastMove: null,
    score: { X: 0, O: 0 },
    ready: { X: false, O: false },
    messages: [],
    moveCount: 0,
  };
}

export const starterFor = (round) => (round % 2 === 0 ? "X" : "O");
export const roleOf = (state, id) =>
  state.players.X?.id === id ? "X" : state.players.O?.id === id ? "O" : null;

export function winningLine(board, mark) {
  return LINES.find((l) => l.every((c) => board[c] === mark)) ?? null;
}

// Fold an (unsorted) list of events into game state.
export function fold(events) {
  const s = emptyState();
  for (const e of sortEvents(events)) apply(s, e);
  return s;
}

export function apply(s, e) {
  const role = roleOf(s, e.author);
  switch (e.kind) {
    case "join": {
      if (role) { s.players[role].name = e.text || s.players[role].name; break; }
      if (!s.players.X) s.players.X = { id: e.author, name: e.text || "Player X" };
      else if (!s.players.O) s.players.O = { id: e.author, name: e.text || "Player O" };
      break;
    }
    case "move": {
      if (!role || !s.players.X || !s.players.O) break;
      if (e.round !== s.round || s.winner) break;
      if (role !== s.turn) break;
      const c = e.cell;
      if (!Number.isInteger(c) || c < 0 || c >= CELLS || s.board[c]) break;
      s.board[c] = role;
      s.lastMove = c;
      s.moveCount++;
      const line = winningLine(s.board, role);
      if (line) { s.winner = role; s.winLine = line; s.score[role]++; }
      else if (s.moveCount === CELLS) s.winner = "draw";
      else s.turn = role === "X" ? "O" : "X";
      break;
    }
    case "again": {
      if (!role || e.round !== s.round || !s.winner) break;
      s.ready[role] = true;
      if (s.ready.X && s.ready.O) {
        s.round++;
        s.board = new Array(CELLS).fill(null);
        s.turn = starterFor(s.round);
        s.winner = null; s.winLine = null; s.lastMove = null; s.moveCount = 0;
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
