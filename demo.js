// Self-playing 3-D demos for the marketing page. Each uses the real game engines
// (game.js + ai.js, wordcube.js, popgame.js) and only runs while it's on screen.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { geometry, winningLine, hexOf } from "./game.js";
import { decide } from "./ai.js";
import { makeBook, trace } from "./wordcube.js";
import * as P from "./popgame.js";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t;

/* ── shared materials (same glass and pieces as the app) ── */
const plateMat = new THREE.MeshStandardMaterial({
  color: 0x5b6fb8, transparent: true, opacity: 0.08, roughness: 0.35, metalness: 0,
  envMapIntensity: 0.15, depthWrite: false, side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fb2ec, transparent: true, opacity: 0.12, depthWrite: false });
const slotMat = new THREE.MeshStandardMaterial({ color: 0xc9d3f5, emissive: 0x6f84d6, emissiveIntensity: 0.18, transparent: true, opacity: 0.4, roughness: 0.35 });
const glossy = (hex, extra = {}) => new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.16, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.06, emissive: hex, emissiveIntensity: 0.04, ...extra });
const white = new THREE.MeshBasicMaterial({ color: 0xffffff });

/** A small scene with the app's lighting, a spinning turntable and a pivot to build on. */
function stage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(5, 9, 6);
  const rim = new THREE.DirectionalLight(0x7f9cff, 0.8); rim.position.set(-6, 2, -7);
  scene.add(key, rim, new THREE.HemisphereLight(0x9fb4ff, 0x0b1030, 0.45));
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const spin = new THREE.Group(), pivot = new THREE.Group();
  pivot.rotation.set(0.42, -0.62, 0);
  spin.add(pivot);
  scene.add(spin);
  let extent = 3;
  const s = {
    renderer, scene, camera, spin, pivot,
    setExtent(e) { extent = e; s.resize(); },
    resize() {
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const fit = Math.min(1, camera.aspect);
      camera.position.set(0, 0, extent / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / fit + extent * 0.3);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    },
    render() { renderer.render(scene, camera); },
  };
  new ResizeObserver(() => { s.resize(); s.render(); }).observe(canvas);
  return s;
}

function plates(pivot, n, pitch, gap, offset) {
  const side = pitch * n;
  const geo = new THREE.BoxGeometry(side, 0.02, side);
  const out = [];
  for (let y = 0; y < n; y++) {
    const p = new THREE.Mesh(geo, plateMat);
    p.position.y = (y - (n - 1) / 2) * gap - offset;
    p.renderOrder = 10;
    p.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
    pivot.add(p);
    out.push(p);
  }
  return out;
}

function link(a, b, hex, r = 0.045) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 12), new THREE.MeshBasicMaterial({ color: hex }));
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

/** Runs `tick(dt)` every frame and `script()` (an async loop) only while visible. */
function runner(canvas, s, script, tick) {
  let visible = false, raf = 0, last = 0, running = false, gen = 0;
  const frame = (t) => {
    if (!visible) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    if (!reduceMotion) s.spin.rotation.y += dt * 0.18;
    tick?.(dt);
    s.render();
    raf = requestAnimationFrame(frame);
  };
  const ctl = { alive: () => visible, gen: () => gen };
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (visible) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
      if (!running && !reduceMotion) {
        running = true;
        const my = ++gen;
        script(ctl, my).finally(() => { running = false; });
      }
    }
  }, { threshold: 0.15 }).observe(canvas);
  s.resize();
  s.render();
}

/* ───────────────────────── Tic Tac Cube: computer vs computer ───────────────────────── */

export function tttDemo(canvas) {
  const s = stage(canvas);
  const n = 3, mid = (n - 1) / 2, gap = 1.25, g = geometry(n);   // 3×3×3, like the apps’ default
  plates(s.pivot, n, 1, gap, 0.36);
  const pos = (i) => { const [x, y, z] = g.coords(i); return new THREE.Vector3(x - mid, (y - mid) * gap, z - mid); };
  const slotGeo = new THREE.SphereGeometry(0.085, 18, 12), pieceGeo = new THREE.SphereGeometry(0.3, 40, 28);
  const slots = [];
  for (let i = 0; i < g.cells; i++) { const m = new THREE.Mesh(slotGeo, slotMat); m.position.copy(pos(i)); s.pivot.add(m); slots.push(m); }
  const COLORS = { X: hexOf("coral"), O: hexOf("teal") };
  const mats = { X: glossy(COLORS.X), O: glossy(COLORS.O) };
  s.setExtent(Math.hypot(n, n, n * gap) * 0.5 * 0.92);
  let pieces = [], drops = [], extras = [];

  async function play(ctl, my) {
    while (ctl.gen() === my) {
      const board = new Array(g.cells).fill(null);
      let turn = Math.random() < 0.5 ? "X" : "O", line = null;
      for (let k = 0; k < g.cells && !line; k++) {
        if (!ctl.alive()) { await sleep(400); k--; continue; }
        const d = decide(board, n, turn, turn === "X" ? "clever" : "relaxed");
        if (!d) break;
        board[d.cell] = turn;
        slots[d.cell].visible = false;
        const m = new THREE.Mesh(pieceGeo, mats[turn]);
        const to = pos(d.cell);
        m.position.copy(to).add(new THREE.Vector3(0, 1.1, 0));
        s.pivot.add(m); pieces.push(m);
        drops.push({ m, to, t: 0 });
        line = winningLine(board, turn, n);
        turn = turn === "X" ? "O" : "X";
        await sleep(900);
      }
      if (line) {
        const mark = board[line[0]];
        line.forEach((c) => { const p = pieces.find((m) => m.position.distanceTo(pos(c)) < 0.01); if (p) p.material = glossy(COLORS[mark], { emissiveIntensity: 0.5 }); });
        const beam = link(pos(line[0]).multiplyScalar(1.15), pos(line[n - 1]).multiplyScalar(1.15), COLORS[mark], 0.025);
        s.pivot.add(beam); extras.push(beam);
      }
      await sleep(2600);
      for (const m of [...pieces, ...extras]) s.pivot.remove(m);
      pieces = []; extras = []; drops = [];
      slots.forEach((m) => { m.visible = true; });
      await sleep(500);
    }
  }
  function tick(dt) {
    for (const d of drops) {
      d.t = Math.min(1, d.t + dt / 0.32);
      d.m.position.lerpVectors(d.to.clone().add(new THREE.Vector3(0, 1.1, 0)), d.to, easeIn(d.t));
    }
    drops = drops.filter((d) => d.t < 1);
  }
  // A still frame for reduced motion: a game in progress.
  if (reduceMotion) {
    const board = new Array(g.cells).fill(null);
    let turn = "X";
    for (let k = 0; k < 9; k++) { const d = decide(board, n, turn, "relaxed"); board[d.cell] = turn; slots[d.cell].visible = false; const m = new THREE.Mesh(pieceGeo, mats[turn]); m.position.copy(pos(d.cell)); s.pivot.add(m); turn = turn === "X" ? "O" : "X"; }
  }
  runner(canvas, s, play, tick);
}

/* ───────────────────────── Word Cube: tracing real answers ───────────────────────── */

function letterSprite(t) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const shown = t === "qu" ? "Qu" : t.toUpperCase();
  g.font = `700 ${shown.length > 1 ? 58 : 76}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#141a38";
  g.fillText(shown, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
}

export async function wordsDemo(canvas, onWord) {
  const s = stage(canvas);
  const book = await fetch("puzzles.json").then((r) => r.json()).then(makeBook).catch(() => null);
  const puzzle = book?.puzzle({ size: 3, index: 0 });
  if (!puzzle) return;
  const n = 3, mid = (n - 1) / 2, gap = 1.25, r = 0.27;
  plates(s.pivot, n, 1, gap, 0.36);
  const pearl = new THREE.MeshPhysicalMaterial({ color: 0xe9ecf8, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06 });
  const coral = hexOf("coral");
  const sel = glossy(new THREE.Color(coral).multiplyScalar(0.8).getHex(), { emissiveIntensity: 0 });
  const nodes = {}, labels = [];
  const pos = (i) => { const [x, y, z] = puzzle.coords(i); return new THREE.Vector3(x - mid, (y - mid) * gap, z - mid); };
  const sphere = new THREE.SphereGeometry(r, 36, 24);
  for (let i = 0; i < puzzle.cells; i++) {
    if (puzzle.tiles[i] == null) continue;
    const m = new THREE.Mesh(sphere, pearl);
    m.position.copy(pos(i));
    s.pivot.add(m);
    nodes[i] = m;
    const sp = letterSprite(puzzle.tiles[i]);
    sp.renderOrder = 20;
    sp.scale.setScalar(0.38);
    s.scene.add(sp);
    labels.push({ sp, m });
  }
  s.setExtent(Math.hypot(n, n, n * gap) * 0.5 * 0.92);
  const words = Object.keys(puzzle.words).sort((a, b) => b.length - a.length).slice(0, 14).sort(() => Math.random() - 0.5);
  let links = [];
  const wp = new THREE.Vector3(), dir = new THREE.Vector3();
  function tick() {
    s.spin.updateMatrixWorld(true);
    for (const l of labels) {
      l.m.getWorldPosition(wp);
      dir.copy(s.camera.position).sub(wp).normalize();
      l.sp.position.copy(wp).addScaledVector(dir, r * l.m.scale.x * 1.04);
    }
  }
  async function play(ctl, my) {
    while (ctl.gen() === my) {
      for (const w of words) {
        while (!ctl.alive()) await sleep(400);
        const path = trace(w, puzzle, 2);
        if (!path) continue;
        for (let k = 0; k < path.length; k++) {
          nodes[path[k]].material = sel;
          nodes[path[k]].scale.setScalar(1.12);
          if (k > 0) { const l = link(pos(path[k - 1]), pos(path[k]), coral); s.pivot.add(l); links.push(l); }
          await sleep(190);
        }
        onWord?.(w, puzzle.points(w));
        await sleep(650);
        for (const c of path) { nodes[c].material = pearl; nodes[c].scale.setScalar(1); }
        for (const l of links) s.pivot.remove(l);
        links = [];
        await sleep(450);
      }
      onWord?.(null);
    }
  }
  runner(canvas, s, play, tick);
}

/* ───────────────────────── Cube Pop: chains, gravity, specials ───────────────────────── */

export function popDemo(canvas) {
  const s = stage(canvas);
  const n = 3, mid = (n - 1) / 2, pitch = 0.82;
  const box = new THREE.Group();          // turned so the current gravity points down the screen
  s.pivot.rotation.set(0.32, 0, 0);
  s.pivot.add(box);
  const side = pitch * n, plateGeo = new THREE.BoxGeometry(side, 0.02, side);
  for (let y = 0; y < n; y++) {
    const p = new THREE.Mesh(plateGeo, plateMat);
    p.position.y = (y - mid) * pitch - 0.33;
    p.renderOrder = 10;
    p.add(new THREE.LineSegments(new THREE.EdgesGeometry(plateGeo), edgeMat));
    box.add(p);
  }
  s.setExtent(Math.hypot(n, n, n) * pitch * 0.5 + 0.7);
  const sphere = new THREE.SphereGeometry(0.29, 32, 22);
  const mats = P.POP_COLORS.map((c) => glossy(hexOf(c)));
  const goldMats = P.POP_COLORS.map((c) => glossy(hexOf(c), { metalness: 0.75, roughness: 0.2, emissive: 0xffc54d, emissiveIntensity: 0.15 }));
  const prismMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.08, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.6, emissive: 0xffffff, emissiveIntensity: 0.1 });
  const ringGeo = new THREE.TorusGeometry(0.34, 0.025, 8, 40);
  const pos = (cell) => { const [x, y, z] = P.cube(n).coords(cell); return new THREE.Vector3((x - mid) * pitch, (y - mid) * pitch, (z - mid) * pitch); };
  const orbs = new Map();   // id → mesh
  function makeOrb(o) {
    const m = new THREE.Mesh(sphere, o.special === "prism" ? prismMat : (o.gold ? goldMats : mats)[o.color]);
    if (o.special === "bomb" || o.special === "beam") {
      const ring = new THREE.Mesh(ringGeo, white);
      ring.userData.face = true;
      m.add(ring);
      if (o.special === "beam") { const r2 = new THREE.Mesh(ringGeo, white); r2.rotation.y = Math.PI / 2; m.add(r2); }
    }
    return m;
  }
  let board = P.startBoard(n, BigInt(Math.floor(Math.random() * 1e9)));
  board.cells.forEach((o, i) => { const m = makeOrb(o); m.position.copy(pos(i)); box.add(m); orbs.set(o.id, m); });

  // Tweens
  let tweens = [];
  const tween = (m, from, to, dur, fn = ease, delay = 0) => tweens.push({ m, from: from.clone(), to: to.clone(), dur, fn, t: -delay });
  let turn = null;   // { from: Quaternion, to: Quaternion, t }
  function tick(dt) {
    for (const tw of tweens) {
      tw.t += dt;
      const k = Math.max(0, Math.min(1, tw.t / tw.dur));
      tw.m.position.lerpVectors(tw.from, tw.to, tw.fn(k));
    }
    tweens = tweens.filter((tw) => tw.t < tw.dur);
    if (turn) {
      turn.t = Math.min(1, turn.t + dt / 0.8);
      box.quaternion.slerpQuaternions(turn.from, turn.to, ease(turn.t));
      if (turn.t >= 1) turn = null;
    }
  }

  // Gravity cycles: down, then sideways, then the other way; the cube turns to match.
  const GRAVITY = [2, 2, 0, 0, 4, 4, 1, 1, 5, 5];
  const DOWN = new THREE.Vector3(0, -1, 0);
  function aim(g) {
    const a = new THREE.Vector3(...P.AXES[g]);
    turn = { from: box.quaternion.clone(), to: new THREE.Quaternion().setFromUnitVectors(a, DOWN), t: 0 };
  }

  /** Longest chain (up to 7), preferring ones that start on a special. */
  function bestChain(b) {
    const g = P.cube(n);
    let best = [];
    const order = [...b.cells.keys()].sort((x, y) => (b.cells[y].special ? 1 : 0) - (b.cells[x].special ? 1 : 0));
    for (const start of order) {
      let budget = 400;
      const dfs = (path) => {
        if (--budget < 0) return;
        if (path.length > best.length) best = path;
        if (best.length >= 7) return;
        for (const j of g.neighbours[path[path.length - 1]]) if (P.canExtend(b, path, j)) dfs([...path, j]);
      };
      dfs([start]);
      if (best.length >= 6) break;
    }
    return best.length >= 3 ? best : null;
  }

  async function play(ctl, my) {
    let k = 0, grav = 2;
    while (ctl.gen() === my) {
      if (!ctl.alive()) { await sleep(400); continue; }
      const g = GRAVITY[k++ % GRAVITY.length];
      if (g !== grav) { grav = g; aim(g); await sleep(900); }
      const chain = bestChain(board);
      if (!chain) { board = P.startBoard(n, BigInt(Math.floor(Math.random() * 1e9))); continue; }
      // Trace it: each orb swells in turn, joined by a glowing thread.
      const hex = hexOf(P.POP_COLORS[P.chainColor(board, chain) ?? 0]);
      const threads = [];
      for (let i = 0; i < chain.length; i++) {
        orbs.get(board.cells[chain[i]].id)?.scale.setScalar(1.18);
        if (i) { const t = link(pos(chain[i - 1]), pos(chain[i]), 0xffffff, 0.04); t.material.color.set(hex).lerp(new THREE.Color(0xffffff), 0.4); box.add(t); threads.push(t); }
        await sleep(110);
      }
      await sleep(220);
      threads.forEach((t) => box.remove(t));
      const before = board.cells.map((o) => o.id);
      const r = P.applyPop(board, chain, g);
      if (!r) continue;
      // Pop: burst away.
      for (const c of r.popped) {
        const m = orbs.get(before[c]);
        if (!m) continue;
        orbs.delete(before[c]);
        const grow = { t: 0 };
        const step = () => { grow.t += 1 / 12; m.scale.setScalar(1.25 * (1 - grow.t)); if (grow.t < 1) requestAnimationFrame(step); else box.remove(m); };
        requestAnimationFrame(step);
      }
      // A special left behind gets its new look.
      if (r.createdAt != null) {
        const o = board.cells[r.createdAt];
        const old = orbs.get(o.id);
        if (old) { box.remove(old); const m = makeOrb(o); m.position.copy(old.position); box.add(m); orbs.set(o.id, m); }
      }
      chain.forEach((c) => orbs.get(before[c])?.scale.setScalar(1));
      await sleep(240);
      // Fall along gravity; new orbs drop in from beyond the far side.
      const up = new THREE.Vector3(...P.AXES[g]).multiplyScalar(-pitch);
      for (const mv of r.moves) { const m = orbs.get(mv.id); if (m) tween(m, m.position, pos(mv.to), 0.34, easeIn); }
      for (const sp of r.spawns) {
        const m = makeOrb(sp.orb);
        const to = pos(sp.cell);
        m.position.copy(to).addScaledVector(up, sp.drop);
        box.add(m); orbs.set(sp.orb.id, m);
        tween(m, m.position, to, 0.38, easeIn, 0.05);
      }
      // Any shuffle (rare): recolour to match the board.
      board.cells.forEach((o) => { const m = orbs.get(o.id); if (m && !o.special) m.material = (o.gold ? goldMats : mats)[o.color]; });
      await sleep(1000);
    }
  }
  runner(canvas, s, play, tick);
}
