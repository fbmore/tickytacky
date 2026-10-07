// Cube Pop two-player games: folds a game's event log into its state, deterministically.
// Same Event records as Tic Tac Cube (PROTOCOL.md → "Cube Pop games"); iOS mirrors this.
import { resolveColors } from "./game.js";
import { startBoard, popSeed, applyPop, POP_SIZES, cloneBoard } from "./popgame.js";

export const POP_TURNS = 10;        // pops each per round
export const starterFor = (round) => (round % 2 === 0 ? "X" : "O");
const other = (r) => (r === "X" ? "O" : "X");

/** `pop` events carry "c1,c2,…|g" in `text`: the chain and the gravity axis (0–5). */
export const encodePop = (path, gravity) => `${path.join(",")}|${gravity}`;
export function decodePop(text) {
  const [cells, g] = String(text || "").split("|");
  if (!cells || g === undefined || !/^[0-5]$/.test(g)) return null;
  const parts = cells.split(",");
  return parts.every((c) => /^[0-9]{1,4}$/.test(c)) ? { path: parts.map(Number), gravity: Number(g) } : null;
}

/** Board for round `r` of game `id` (empty games use a placeholder seed until the host joins). */
export const roundBoard = (id, size, round) => startBoard(size, popSeed(id, round));

/**
 * events: sorted (ts, then recordName). Returns everything the UI needs; invalid events
 * are ignored silently. `s.pops` is this round's accepted pops (with results) for animation.
 */
export function foldPop(events, gameId) {
  const s = {
    size: 4, players: {}, colors: { X: "coral", O: "teal" }, round: 0, board: null, startBoard: null,
    pops: [], score: { X: 0, O: 0 }, turns: { X: 0, O: 0 }, turn: "X", over: null, resigned: null,
    wins: { X: 0, O: 0 }, ready: { X: false, O: false }, closedBy: null, says: [],
  };
  const roleOfId = (id) => (s.players.X?.id === id ? "X" : s.players.O?.id === id ? "O" : null);
  const startRound = (r) => {
    s.round = r; s.board = roundBoard(gameId, s.size, r); s.startBoard = cloneBoard(s.board);
    s.pops = []; s.score = { X: 0, O: 0 }; s.turns = { X: 0, O: 0 }; s.turn = starterFor(r);
    s.over = null; s.resigned = null; s.ready = { X: false, O: false };
  };
  const finish = (reason, winner) => {
    s.over = { reason, winner: winner ?? (s.score.X > s.score.O ? "X" : s.score.O > s.score.X ? "O" : "draw") };
    if (s.over.winner !== "draw") s.wins[s.over.winner]++;
  };

  for (const e of events) {
    if (s.closedBy) break;
    const role = roleOfId(e.author);
    switch (e.kind) {
      case "join": {
        if (!s.players.X) {
          s.size = POP_SIZES.includes(e.cell) ? e.cell : 4;
          s.players.X = { id: e.author, name: e.text || e.authorName || "Player 1", color: e.color || "coral" };
          startRound(0);
        } else if (!role && !s.players.O) {
          s.players.O = { id: e.author, name: e.text || e.authorName || "Player 2", color: e.color || "teal" };
        } else if (role) {
          s.players[role].name = e.text || s.players[role].name;
          if (e.color) s.players[role].color = e.color;
        }
        break;
      }
      case "pop": {
        if (!role || s.over || e.round !== s.round || s.turn !== role || !s.board) break;
        const p = decodePop(e.text);
        if (!p) break;
        const before = cloneBoard(s.board);
        const result = applyPop(s.board, p.path, p.gravity);
        if (!result) break;
        s.score[role] += result.points;
        s.pops.push({ by: role, path: p.path, gravity: p.gravity, points: result.points, result, before, id: e.recordName });
        s.turns[role]++;
        s.turn = other(role);
        if (s.turns.X >= POP_TURNS && s.turns.O >= POP_TURNS) finish("turns");
        break;
      }
      case "resign": {
        if (!role || s.over || e.round !== s.round || !s.players.O) break;
        s.resigned = role;
        finish("resign", other(role));
        break;
      }
      case "again": {
        if (!role || !s.over || e.round !== s.round) break;
        s.ready[role] = true;
        if (s.ready.X && s.ready.O) startRound(s.round + 1);
        break;
      }
      case "close": {
        if (role) s.closedBy = role;
        break;
      }
      case "say": {
        if (role) s.says.push({ author: e.author, text: e.text, ts: e.ts });
        break;
      }
    }
  }
  s.says = s.says.slice(-30);
  s.colors = resolveColors(s.players.X?.color, s.players.O?.color);
  return s;
}

export const roleOf = (s, id) => (s.players.X?.id === id ? "X" : s.players.O?.id === id ? "O" : null);
