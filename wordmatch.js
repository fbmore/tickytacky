// Word Cube two-player games: folds a game's event log into its state, deterministically.
// Same Event records as Tic Tac Cube (see PROTOCOL.md → "Word Cube games"); iOS mirrors this.
import { LAYER_BONUS } from "./wordcube.js";
import { resolveColors } from "./game.js";

export const TURNS = 10;            // turns each per round (a word or a pass)
export const WORD_SIZES = [3, 4, 5];

/** Which practice board a round uses: the same on every device, a new one each rematch. */
export function boardIndex(gameId, round, count) {
  let h = 0;
  for (const ch of gameId) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return count ? (h + round * 7) % count : 0;
}

export const starterFor = (round) => (round % 2 === 0 ? "X" : "O");

/** Dictionaries, by the index the host's first join carries: cell = size + 10 × language. */
export const LANGS = ["en", "it", "es"];
export function decodeJoin(cell) {
  const c = Math.max(0, cell | 0), n = c % 10;
  return { size: WORD_SIZES.includes(n) ? n : 4, language: LANGS[Math.floor(c / 10)] ?? "en" };
}
const other = (r) => (r === "X" ? "O" : "X");

/** `word` events carry "word|c1,c2,…" in `text`: the word and the cells traced. */
export const encodeWord = (word, path) => `${word}|${path.join(",")}`;
export function decodeWord(text) {
  const [word, cells] = String(text || "").split("|");
  if (!word || !cells) return null;
  const parts = cells.split(",");
  // Digits only, so every client rejects exactly the same malformed input.
  return parts.every((c) => /^[0-9]{1,4}$/.test(c)) ? { word, path: parts.map(Number) } : null;
}

/** Highest reveal phase (0–2) given every word found so far (by either player). */
export function phaseFor(puzzle, found) {
  let phase = 0;
  while (phase < 2) {
    const pool = Object.entries(puzzle.words).filter(([, p]) => p <= phase).map(([w]) => w);
    if (!pool.length || pool.filter((w) => found.has(w)).length < Math.ceil(pool.length * 0.6)) break;
    phase++;
  }
  return phase;
}

/** Is `path` a legal trace of `word` on `puzzle` with cells revealed up to `phase`? */
export function validTrace(puzzle, word, path, phase) {
  if (!path.length || new Set(path).size !== path.length) return false;
  for (let k = 0; k < path.length; k++) {
    const c = path[k];
    if (!(c >= 0 && c < puzzle.cells) || puzzle.tiles[c] == null || puzzle.phaseOf(c) > phase) return false;
    if (k && !puzzle.isAdjacent(path[k - 1], c)) return false;
  }
  return puzzle.wordFor(path) === word;
}

/**
 * events: sorted (ts, then recordName). puzzleFor(size, round, language) → Puzzle for that round.
 * Returns everything the UI needs; invalid events are ignored silently.
 */
export function foldMatch(events, gameId, puzzleFor) {
  const s = {
    size: 4, language: "en", sizeSet: false, players: {}, colors: { X: "coral", O: "teal" },
    round: 0, puzzle: null, claims: [], score: { X: 0, O: 0 }, turns: { X: 0, O: 0 }, passes: 0,
    turn: "X", over: null, resigned: null, wins: { X: 0, O: 0 }, ready: { X: false, O: false }, closedBy: null, says: [],
  };
  const roleOfId = (id) => (s.players.X?.id === id ? "X" : s.players.O?.id === id ? "O" : null);
  const startRound = (r) => {
    s.round = r; s.puzzle = puzzleFor(s.size, r, s.language); s.claims = []; s.score = { X: 0, O: 0 };
    s.turns = { X: 0, O: 0 }; s.passes = 0; s.turn = starterFor(r); s.over = null; s.resigned = null; s.ready = { X: false, O: false };
  };
  const finish = (reason, winner) => {
    s.over = { reason, winner: winner ?? (s.score.X > s.score.O ? "X" : s.score.O > s.score.X ? "O" : "draw") };
    if (s.over.winner !== "draw") s.wins[s.over.winner]++;
  };
  const endTurn = (role) => {
    s.turns[role]++;
    s.turn = other(role);
    if (s.passes >= 2) finish("passes");
    else if (s.claims.length === s.puzzle.wordCount) finish("cleared");
    else if (s.turns.X >= TURNS && s.turns.O >= TURNS) finish("turns");
  };

  for (const e of events) {
    if (s.closedBy) break;
    const role = roleOfId(e.author);
    switch (e.kind) {
      case "join": {
        if (!s.players.X) {
          ({ size: s.size, language: s.language } = decodeJoin(e.cell));
          s.sizeSet = true;
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
      case "word": {
        if (!role || s.over || e.round !== s.round || s.turn !== role || !s.puzzle) break;
        const w = decodeWord(e.text);
        if (!w || !(w.word in s.puzzle.words) || s.claims.some((c) => c.word === w.word)) break;
        const found = new Set(s.claims.map((c) => c.word));
        if (!validTrace(s.puzzle, w.word, w.path, phaseFor(s.puzzle, found))) break;
        const bonus = s.puzzle.touchesEveryLayer(w.path);
        const points = s.puzzle.points(w.word) + (bonus ? LAYER_BONUS : 0);
        s.claims.push({ word: w.word, path: w.path, by: role, points, bonus, id: e.recordName });
        s.score[role] += points;
        s.passes = 0;
        endTurn(role);
        break;
      }
      case "pass": {
        if (!role || s.over || e.round !== s.round || s.turn !== role || !s.puzzle) break;
        s.passes++;
        endTurn(role);
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
        if (role) s.closedBy = role; // the host can cancel before anyone joins
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
