// Word Cube: pure puzzle + game logic for the web client. Mirrors the iOS
// WordPuzzle.swift / WordGame.swift exactly (same boards, scoring, phases, ranks).

export const LAYER_BONUS = 3;
export const UNLOCK_SHARE = 0.6;
export const RANKS = [
  { name: "Getting Started", share: 0 }, { name: "Good", share: 0.15 }, { name: "Great", share: 0.35 },
  { name: "Amazing", share: 0.5 }, { name: "Genius", share: 0.7 },
];
export const SIZE_LABEL = { 3: "Easy", 4: "Standard", 5: "Hard" };

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** One board. kind: { daily: day } or { size, index }. */
export class Puzzle {
  constructor({ kind, n, tiles, words, minLength, phaseBoxes }) {
    Object.assign(this, { kind, n, tiles, words, minLength, phaseBoxes });
    this.cells = n * n * n;
  }
  idx(x, y, z) { return x + this.n * y + this.n * this.n * z; }
  coords(i) { const n = this.n; return [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))]; }

  /** Which phase reveals this cell (0, 1 or 2). */
  phaseOf(cell) {
    const [x, y, z] = this.coords(cell);
    const k = this.phaseBoxes.findIndex((b) => x < b[0] && y < b[1] && z < b[2]);
    return k < 0 ? this.phaseBoxes.length : k;
  }

  /** Face-adjacent neighbours (up to 6) that hold a letter. */
  neighbours(cell) {
    const [x, y, z] = this.coords(cell), n = this.n, out = [];
    for (const [dx, dy, dz] of DIRS) {
      const a = x + dx, b = y + dy, c = z + dz;
      if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) continue;
      const j = this.idx(a, b, c);
      if (this.tiles[j] != null) out.push(j);
    }
    return out;
  }
  isAdjacent(a, b) { return this.neighbours(a).includes(b); }
  wordFor(path) { return path.map((c) => this.tiles[c] ?? "").join(""); }

  /** Spelling Bee-style: the shortest allowed words are worth 1, longer ones 1 per letter. */
  points(word) { return word.length <= this.minLength ? 1 : word.length; }
  /** A path that visits every layer of the cube earns a bonus. */
  touchesEveryLayer(path) { return new Set(path.map((c) => this.coords(c)[1])).size === this.n; }
  get maxPoints() { return Object.keys(this.words).reduce((s, w) => s + this.points(w), 0); }
  get wordCount() { return Object.keys(this.words).length; }
}

export function parsePuzzle(raw, n, kind, minLength, phaseBoxes) {
  const bar = raw.indexOf("|");
  if (bar < 0 || bar !== n * n * n) return null;
  const tiles = [...raw.slice(0, bar)].map((ch) => (ch === "." ? null : ch === "q" ? "qu" : ch));
  const words = {};
  for (const entry of raw.slice(bar + 1).split(",")) {
    const [w, ph] = entry.split(":");
    if (w && ph !== undefined && !Number.isNaN(+ph)) words[w] = +ph;
  }
  return new Puzzle({ kind, n, tiles, words, minLength, phaseBoxes });
}

// ───────────── the puzzle book (puzzles.json) ─────────────

const DAY_MS = 86_400_000;
const localMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function startDate(book) {
  const [y, m, d] = (book?.dailyStart || "2026-10-06").split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function makeBook(file) {
  return {
    file,
    /** Today's daily number (day 0 = launch day), by local calendar day, same as iOS. */
    today(date = new Date()) {
      return Math.max(0, Math.round((localMidnight(date) - startDate(file)) / DAY_MS));
    },
    dateOfDay(day) { const s = startDate(file); return new Date(s.getFullYear(), s.getMonth(), s.getDate() + day); },
    practiceCount(size) { return file.practice[String(size)]?.length ?? 0; },
    puzzle(kind) {
      let n, raw;
      if ("daily" in kind) {
        if (!file.daily.length) return null;
        n = 4; raw = file.daily[kind.daily % file.daily.length]; // loops after a year until the book is extended
      } else {
        const list = file.practice[String(kind.size)];
        if (!list?.length) return null;
        n = kind.size; raw = list[kind.index % list.length];
      }
      return parsePuzzle(raw, n, kind, file.minLen[String(n)] ?? 4, file.phases[String(n)] ?? []);
    },
  };
}

/** Storage key for a board's progress — same names as iOS, under the web's "ttc." prefix. */
export const progressKey = (kind) => ("daily" in kind ? `ttc.wc-d${kind.daily}` : `ttc.wc-p${kind.size}-${kind.index}`);
export const emptyProgress = () => ({ found: [], bonus: [], bestPath: [], bestWord: "" });

// ───────────── one game ─────────────

/**
 * Feedback kinds: { kind: "found", word, points, bonus } · { kind: "already", word } ·
 * { kind: "notAWord", word } · { kind: "tooShort" } · { kind: "phaseUnlocked", phase }.
 * Cues (for sound): letter(step) · undo(step) · word(length, bonus) · wrong · already · reveal.
 */
export class WordGame {
  constructor(puzzle, progress = emptyProgress(), { onSave = () => {}, onCue = () => {} } = {}) {
    this.puzzle = puzzle;
    this.progress = { ...emptyProgress(), ...progress };
    this.path = [];
    this.feedback = null;
    this.onSave = onSave;
    this.onCue = onCue;
  }

  get foundSet() { return new Set(this.progress.found); }
  get foundCount() { return this.progress.found.length; }
  get totalWords() { return this.puzzle.wordCount; }
  get currentWord() { return this.puzzle.wordFor(this.path); }

  get score() {
    return this.progress.found.reduce((s, w) => s + this.puzzle.points(w), 0) + this.progress.bonus.length * LAYER_BONUS;
  }
  get maxPoints() { return this.puzzle.maxPoints; }
  /** Share of the base points (bonuses can push you past 100%). */
  get share() { return this.maxPoints === 0 ? 0 : this.score / this.maxPoints; }
  get rank() { return [...RANKS].reverse().find((r) => this.share >= r.share) ?? RANKS[0]; }
  get isCubed() { return this.totalWords > 0 && this.foundCount === this.totalWords; }
  get rankName() { return this.isCubed ? "Cubed" : this.rank.name; }
  get nextRank() { return RANKS.find((r) => r.share > this.share) ?? null; }

  #phasePool(phase) { return Object.entries(this.puzzle.words).filter(([, p]) => p <= phase).map(([w]) => w); }

  /** Highest phase revealed so far (0, 1 or 2). */
  get unlockedPhase() {
    const found = this.foundSet;
    let phase = 0;
    while (phase < 2) {
      const pool = this.#phasePool(phase);
      const need = Math.ceil(pool.length * UNLOCK_SHARE);
      if (!pool.length || pool.filter((w) => found.has(w)).length < need) break;
      phase++;
    }
    return phase;
  }

  /** Words still needed to reveal the next phase, or null once everything is revealed. */
  get wordsToNextPhase() {
    const phase = this.unlockedPhase;
    if (phase >= 2) return null;
    const pool = this.#phasePool(phase), found = this.foundSet;
    return Math.max(0, Math.ceil(pool.length * UNLOCK_SHARE) - pool.filter((w) => found.has(w)).length);
  }

  isRevealed(cell) { return this.puzzle.tiles[cell] != null && this.puzzle.phaseOf(cell) <= this.unlockedPhase; }

  /** Cells you can tap next: unused revealed neighbours of the last letter. */
  get validNext() {
    const last = this.path.at(-1);
    if (last === undefined) return new Set();
    return new Set(this.puzzle.neighbours(last).filter((c) => this.isRevealed(c) && !this.path.includes(c)));
  }

  /** Tap a cell: start, extend, or (tapping the last letter) back up one. */
  tap(cell) {
    if (!this.isRevealed(cell)) return;
    if (this.path.at(-1) === cell) {
      this.path = this.path.slice(0, -1);
      this.onCue("undo", this.path.length);
    } else if (!this.path.length || this.validNext.has(cell)) {
      this.path = [...this.path, cell];
      this.onCue("letter", this.path.length - 1); // each letter is the next note up
    } else if (this.path.includes(cell)) {
      this.path = this.path.slice(0, this.path.indexOf(cell) + 1); // tap an earlier letter: trim back to it
      this.onCue("undo", this.path.length);
    } else {
      this.path = [cell]; // not adjacent: start a new word here
      this.onCue("letter", 0);
    }
  }

  backspace() {
    if (!this.path.length) return;
    this.path = this.path.slice(0, -1);
    this.onCue("undo", this.path.length);
  }

  clear() { this.path = []; }

  #pointsOf(word) {
    return this.puzzle.points(word) + (this.progress.bonus.includes(word) ? LAYER_BONUS : 0);
  }

  submit() {
    const word = this.currentWord, path = this.path;
    this.path = [];
    if (word.length < this.puzzle.minLength) { this.onCue("wrong"); return this.#say({ kind: "tooShort" }); }
    if (!(word in this.puzzle.words)) { this.onCue("wrong"); return this.#say({ kind: "notAWord", word }); }
    if (this.foundSet.has(word)) { this.onCue("already"); return this.#say({ kind: "already", word }); }
    const phaseBefore = this.unlockedPhase;
    const bonus = this.puzzle.touchesEveryLayer(path);
    const best = this.progress.bestWord ? this.#pointsOf(this.progress.bestWord) : 0;
    this.progress = {
      ...this.progress,
      found: [...this.progress.found, word],
      bonus: bonus ? [...this.progress.bonus, word] : this.progress.bonus,
    };
    const points = this.puzzle.points(word) + (bonus ? LAYER_BONUS : 0);
    if (points > best) this.progress = { ...this.progress, bestWord: word, bestPath: path };
    this.onSave(this.progress);
    this.onCue("word", word.length, bonus);
    const phase = this.unlockedPhase;
    if (phase > phaseBefore) {
      this.onCue("reveal");
      return this.#say({ kind: "phaseUnlocked", phase, word, points, bonus, path });
    }
    return this.#say({ kind: "found", word, points, bonus, path });
  }

  #say(f) { this.feedback = f; return f; }
}

/** Brute-force: a face-adjacent, no-reuse path spelling `word` within `maxPhase`, or null. */
export function trace(word, puzzle, maxPhase = 2) {
  const steps = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "q") { steps.push("qu"); i++; } else steps.push(word[i]);
  }
  const go = (cell, k, used) => {
    if (puzzle.tiles[cell] !== steps[k] || puzzle.phaseOf(cell) > maxPhase) return null;
    const path = [...used, cell];
    if (k === steps.length - 1) return path;
    for (const j of puzzle.neighbours(cell)) if (!path.includes(j)) { const r = go(j, k + 1, path); if (r) return r; }
    return null;
  };
  for (let c = 0; c < puzzle.cells; c++) { const r = go(c, 0, []); if (r) return r; }
  return null;
}
