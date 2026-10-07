// Cube Pop engine must match the Swift engine bit for bit (fixture generated from PopGame.swift).
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeBoard, popSeed, hasMoves, shuffle, pop, isValidChain, canExtend, gravityLines, specialForChain, fnv1a64, dayIndex } from "./popgame.js";

const fx = JSON.parse(fs.readFileSync(new URL("./popgame.fixture.json", import.meta.url)));
const snap = (b) => b.cells.map((o) => ({ c: o.color, g: o.gold, id: o.id, s: o.special ?? "" }));

for (const c of fx.cases) {
  const seed = popSeed(c.id, c.round);
  assert.equal(seed.toString(), c.seed, `seed for ${c.id}`);
  const b = makeBoard(c.n, seed);
  assert.deepEqual(snap(b), c.start, `start board ${c.id}`);
  if (!hasMoves(b)) shuffle(b);
  c.steps.forEach((s, k) => {
    const r = pop(b, s.chain, s.gravity);
    assert.ok(r, `${c.id} step ${k} valid`);
    if (!hasMoves(b)) shuffle(b);
    assert.equal(r.points, s.points, `${c.id} step ${k} points`);
    assert.deepEqual(r.popped, s.popped, `${c.id} step ${k} popped`);
    assert.equal(r.created ?? "", s.created, `${c.id} step ${k} created`);
    assert.equal(r.fired.length, s.fired, `${c.id} step ${k} fired`);
    assert.deepEqual(snap(b), s.board, `${c.id} step ${k} board`);
  });
}

// Rules spot checks (mirror ios PopTests).
const fixed = (colors, n = 3) => { const b = makeBoard(n, 42n); b.cells = b.cells.map((_, i) => ({ id: 1000 + i, color: colors[i % colors.length], special: null, gold: false })); return b; };
{
  const cs = Array(27).fill(1); cs[0] = cs[1] = cs[2] = cs[4] = 0;
  const b = fixed(cs);
  assert.ok(isValidChain(b, [0, 1, 2]));
  assert.ok(isValidChain(b, [0, 1, 4]));
  assert.ok(!isValidChain(b, [0, 4, 1]));
  assert.ok(!isValidChain(b, [0, 1, 0]));
  assert.ok(!isValidChain(b, [0, 1, 99]));
  assert.ok(!canExtend(b, [0, 1], 10));
}
{
  const cs = Array(27).fill(1); cs[0] = cs[1] = cs[2] = 0;
  const b = fixed(cs); const above = b.cells[3].id;
  const r = pop(b, [0, 1, 2], 2);
  assert.equal(b.cells[0].id, above);
  assert.equal(r.points, 90);
  assert.ok(r.spawns.every((s) => Math.floor(s.cell / 3) % 3 === 2));
}
assert.equal(specialForChain(5), "bomb"); assert.equal(specialForChain(6), "beam"); assert.equal(specialForChain(9), "prism");
assert.equal(gravityLines(3, 2)[0].join(), "0,3,6");
assert.equal(fnv1a64("").toString(16), "cbf29ce484222325");
assert.equal(dayIndex(new Date(2026, 9, 6)), 0);
assert.equal(dayIndex(new Date(2026, 9, 9, 23)), 3);
console.log(`popgame.test: all passed (${fx.cases.length} fixture cases, ${fx.cases.reduce((s, c) => s + c.steps.length, 0)} pops)`);
