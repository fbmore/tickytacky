// Cube Pop for the web: solo (today's challenge, 30 moves, zen) and two players (same device or a
// link). Same rules, boards, scoring, look and sounds as the iOS app (Pop/*.swift); the rules
// live in popgame.js / popmatch.js and are bit-exact with Swift.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { hexOf, PALETTE, PRESETS, sortEvents, resolveColors } from "./game.js";
import * as P from "./popgame.js";
import { foldPop, encodePop, roleOf, starterFor, POP_TURNS } from "./popmatch.js";
import { cloudGame } from "./cloud.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const accentHex = hexOf(store.get("ttc.color") || "coral");
document.documentElement.style.setProperty("--me", accentHex);
const ORB_HEX = P.POP_COLORS.map(hexOf);

/* ───────────────────────────── sound ───────────────────────────── */

// The iOS glass-bell synth: inharmonic partials, each with its own exponential decay.
const sound = {
  ctx: null, master: null,
  on: store.get("ttc.sound") !== "0",
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 7000;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(lp).connect(this.ctx.destination);
  },
  bell(notes, { duration, decay, gain }) {
    if (!this.on || !this.ctx) return;
    const now = this.ctx.currentTime + 0.005;
    const g = gain / Math.sqrt(Math.max(1, notes.length));
    for (const [f, start] of notes) {
      const t0 = now + start, end = now + duration;
      if (t0 >= end) continue;
      for (const [ratio, amp, mul] of [[1, 1, 1], [2.76, 0.35, 1.8], [5.4, 0.12, 2.6], [8.93, 0.05, 3.4]]) {
        const o = this.ctx.createOscillator(), v = this.ctx.createGain();
        o.frequency.value = f * ratio;
        v.gain.setValueAtTime(0, t0);
        v.gain.linearRampToValueAtTime(g * amp, t0 + 0.003);
        v.gain.setTargetAtTime(0, t0 + 0.003, 1 / (decay * mul));
        o.connect(v).connect(this.master);
        o.start(t0); o.stop(end);
      }
    }
  },
  note(i) { const s = [0, 2, 4, 7, 9]; return 392 * Math.pow(2, (12 * Math.floor(i / 5) + s[i % 5]) / 12); },
  tick() { this.bell([[2600, 0]], { duration: 0.04, decay: 90, gain: 0.08 }); },
  orb(step) { this.bell([[this.note(step), 0]], { duration: 0.45, decay: 11, gain: 0.2 }); },
  undo(step) { this.bell([[this.note(step) * 0.5, 0]], { duration: 0.22, decay: 22, gain: 0.12 }); },
  /** Bright plucks cascading up, one per popped orb; a low boom under it when specials go off. */
  pop(count, specials) {
    const notes = Array.from({ length: Math.min(10, count) }, (_, k) => [this.note(4 + k) * 1.5, k * 0.035]);
    if (specials > 0) notes.unshift([98, 0], [147, 0.02]);
    this.bell(notes, { duration: 0.9, decay: 9, gain: 0.17 });
  },
  wrong() { this.bell([[196, 0], [147, 0.07]], { duration: 0.35, decay: 16, gain: 0.22 }); },
  lose() { this.bell([[392, 0], [261.6, 0.16]], { duration: 1.0, decay: 5, gain: 0.25 }); },
  fanfare() { this.bell([0, 2, 4, 7, 9, 11].map((e, k) => [this.note(e + 3), k * 0.08]), { duration: 1.8, decay: 3.5, gain: 0.2 }); },
};
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => sound.unlock(), { capture: true });
const haptic = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

/* ───────────────────────────── 3-D cube ───────────────────────────── */

const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// Same stage as the tic-tac-toe board (app.js): room reflections, key + rim + hemisphere light.
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(5, 9, 6);
const rimLight = new THREE.DirectionalLight(0x7f9cff, 0.8);
rimLight.position.set(-6, 2, -7);
scene.add(keyLight, rimLight, new THREE.HemisphereLight(0x9fb4ff, 0x0b1030, 0.45));

const pivot = new THREE.Group();
scene.add(pivot);
const orientation = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.42)
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.62));
pivot.quaternion.copy(orientation);

const PITCH = 0.82;
const SPREAD = { closed: 1.0, open: 1.9, min: 1.0, max: 2.2 };
let spacing = SPREAD.closed, targetSpacing = SPREAD.closed;

const plateMat = new THREE.MeshStandardMaterial({
  color: 0x5b6fb8, transparent: true, opacity: 0.08, roughness: 0.35, metalness: 0,
  envMapIntensity: 0.15, depthWrite: false, side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fb2ec, transparent: true, opacity: 0.12, depthWrite: false });
const floorMat = new THREE.MeshBasicMaterial({ color: 0x9fb2ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });

function canvasTexture(draw, w = 128, h = 128) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const iridescent = canvasTexture((g, w, h) => {
  const grad = g.createLinearGradient(0, 0, w, 0);
  ["#ff8c99", "#ffd966", "#80f2b3", "#73b3ff", "#cc8cff", "#ff8c99"].forEach((c, i, a) => grad.addColorStop(i / (a.length - 1), c));
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
}, 256, 128);
const mats = new Map();
function orbMaterial(o) {
  const key = o.special === "prism" ? "prism" : `${o.color}-${o.gold}`;
  if (mats.has(key)) return mats.get(key);
  const m = o.special === "prism"
    ? new THREE.MeshPhysicalMaterial({ map: iridescent, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.06 })
    : new THREE.MeshPhysicalMaterial({
      color: ORB_HEX[o.color], roughness: o.gold ? 0.18 : 0.14, metalness: o.gold ? 0.75 : 0.05,
      clearcoat: 1, clearcoatRoughness: 0.05, emissive: o.gold ? 0xffc74d : 0x000000, emissiveIntensity: o.gold ? 0.15 : 0,
    });
  mats.set(key, m);
  return m;
}
const ringTex = canvasTexture((g) => { g.strokeStyle = "#fff"; g.lineWidth = 4.5; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.stroke(); });
const nextRingMat = new THREE.SpriteMaterial({ map: ringTex, depthTest: true, depthWrite: false, transparent: true, toneMapped: false });
const markMats = {
  bomb: new THREE.SpriteMaterial({ map: canvasTexture((g) => { g.strokeStyle = "#fff"; g.lineWidth = 7; g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke(); }), depthWrite: false, toneMapped: false }),
  beam: new THREE.SpriteMaterial({ map: canvasTexture((g) => { g.strokeStyle = "#fff"; g.lineWidth = 9; g.lineCap = "round"; g.beginPath(); g.moveTo(64, 14); g.lineTo(64, 114); g.moveTo(14, 64); g.lineTo(114, 64); g.stroke(); }), depthWrite: false, toneMapped: false }),
  prism: new THREE.SpriteMaterial({ map: canvasTexture((g) => { g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke(); }), depthWrite: false, toneMapped: false, transparent: true }),
};
const sparkTex = canvasTexture((g) => {
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.4, "rgba(255,255,255,0.6)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});

const cube = {
  n: 0, plates: [], floor: null, orbs: new Map(), cellOf: new Map(), idAt: [], marks: new Map(),
  links: [], rings: [], bursts: [], shocks: [], radius: 0.29, shownPath: [], shownNext: "", chainHex: "#ffffff",
};
let gravity = 2; // negY
const mid = () => (cube.n - 1) / 2;
function localPos(cell, out = new THREE.Vector3()) {
  const g = P.cube(cube.n), [x, y, z] = g.coords(cell);
  return out.set((x - mid()) * PITCH, (y - mid()) * PITCH * spacing, (z - mid()) * PITCH);
}

function buildCube(board) {
  for (const o of [...pivot.children]) pivot.remove(o);
  for (const s of cube.marks.values()) scene.remove(s.sprite);
  for (const r of cube.rings) scene.remove(r);
  Object.assign(cube, { n: board.n, plates: [], orbs: new Map(), cellOf: new Map(), idAt: board.cells.map((o) => o.id), marks: new Map(), links: [], rings: [], shownPath: [], shownNext: "" });
  const n = board.n, side = PITCH * n;
  cube.radius = n >= 5 ? 0.25 : 0.29;
  const plateGeo = new THREE.BoxGeometry(side, 0.02, side);
  for (let y = 0; y < n; y++) {
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.renderOrder = 10;
    plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(plateGeo), edgeMat));
    pivot.add(plate);
    cube.plates.push(plate);
  }
  cube.floor = new THREE.Mesh(new THREE.BoxGeometry(side + 0.2, 0.01, side + 0.2), floorMat);
  cube.floor.renderOrder = 5;
  pivot.add(cube.floor);
  board.cells.forEach((o, cell) => addOrb(o, cell));
  layout();
  placeFloor();
}

const sphereGeo = new Map();
function addOrb(o, cell) {
  if (!sphereGeo.has(cube.radius)) sphereGeo.set(cube.radius, new THREE.SphereGeometry(cube.radius, 40, 28));
  const m = new THREE.Mesh(sphereGeo.get(cube.radius), orbMaterial(o));
  localPos(cell, m.position);
  m.userData.id = o.id;
  pivot.add(m);
  cube.orbs.set(o.id, m);
  cube.cellOf.set(o.id, cell);
  dress(o);
  return m;
}

/** Specials wear a mark that always faces you. */
function dress(o) {
  const old = cube.marks.get(o.id);
  if (old) { scene.remove(old.sprite); cube.marks.delete(o.id); }
  const m = cube.orbs.get(o.id);
  if (!m) return;
  m.material = orbMaterial(o);
  if (!o.special) return;
  const sprite = new THREE.Sprite(markMats[o.special].clone());
  sprite.renderOrder = 20;
  scene.add(sprite);
  cube.marks.set(o.id, { sprite, special: o.special });
}

function layout() {
  cube.plates.forEach((p, y) => p.position.set(0, (y - mid()) * PITCH * spacing - 0.33, 0));
  for (const [id, cell] of cube.cellOf) {
    const m = cube.orbs.get(id);
    if (m && !m.userData.move) localPos(cell, m.position);
  }
  for (const l of cube.links) placeLink(l);
  placeFloor();
}

function placeFloor() {
  if (!cube.floor) return;
  const [dx, dy, dz] = P.AXES[gravity];
  const reach = ((cube.n - 1) / 2) * PITCH * (dy ? spacing : 1) + 0.38;
  cube.floor.position.set(dx * reach, dy * reach, dz * reach);
  cube.floor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.abs(dx), Math.abs(dy), Math.abs(dz)));
}

// ── tiny tweens: scale + position along a list of steps ──
const clock = () => performance.now() / 1000;
function tween(obj, steps, from = obj.scale.x) {
  obj.userData.anim = { t0: clock(), from, steps: reduceMotion ? [{ to: steps.at(-1)?.to ?? from, dur: 0 }] : steps };
}
function stepTween(obj, now) {
  const a = obj.userData.anim;
  if (!a) return;
  let t = now - a.t0, v = a.from;
  for (const s of a.steps) {
    if ("wait" in s) { if (t < s.wait) return obj.scale.setScalar(v); t -= s.wait; continue; }
    if (t < s.dur) { const k = t / s.dur; return obj.scale.setScalar(v + (s.to - v) * (1 - Math.pow(1 - k, 3))); }
    t -= s.dur; v = s.to;
  }
  obj.scale.setScalar(v);
  obj.userData.anim = null;
  if (a.then) a.then();
}
/** Fall from `from` to the target cell after `wait`, ease-in, then a little wobble. */
function moveTo(obj, cell, wait, dur, fromPos) {
  obj.userData.move = { t0: clock() + (reduceMotion ? 0 : wait), dur: reduceMotion ? 0.01 : dur, from: fromPos.clone(), cell };
}
function stepMove(obj, now) {
  const mv = obj.userData.move;
  if (!mv) return;
  const target = localPos(mv.cell, new THREE.Vector3());
  if (now < mv.t0) { obj.position.copy(mv.from); return; }
  const k = Math.min(1, (now - mv.t0) / mv.dur);
  obj.position.lerpVectors(mv.from, target, k * k);
  if (k >= 1) {
    obj.userData.move = null;
    obj.userData.wobble = now;
  }
}
function stepWobble(obj, now) {
  const w0 = obj.userData.wobble;
  if (w0 == null) return;
  const d = 0.36, k = (now - w0) / d;
  if (k >= 1 || reduceMotion) { obj.userData.wobble = null; if (!obj.userData.anim) obj.scale.setScalar(1); return; }
  const w = Math.sin(k * Math.PI * 3) * (1 - k) * 0.16;
  if (!obj.userData.anim) obj.scale.set(1 + w, 1 - w, 1 + w);
}

/** Animate one pop: burst the popped orbs, fall the survivors, drop new orbs in. */
function animatePop(r, board) {
  clearSelection();
  const popped = new Set();
  r.popped.forEach((cell, k) => {
    const id = cube.idAt[cell];
    const m = cube.orbs.get(id);
    if (!m) return;
    popped.add(id);
    cube.orbs.delete(id); cube.cellOf.delete(id);
    const mark = cube.marks.get(id);
    if (mark) { scene.remove(mark.sprite); cube.marks.delete(id); }
    const color = m.material.color?.getHex?.() ?? 0xffffff;
    m.userData.anim = { t0: clock(), from: 1, steps: reduceMotion ? [{ to: 0, dur: 0 }] : [{ wait: 0.03 * k }, { to: 1.25, dur: 0.08 }, { to: 0.01, dur: 0.16 }], then: () => pivot.remove(m) };
    setTimeout(() => burst(m.position.clone(), color), reduceMotion ? 0 : 30 * k + 80);
  });
  for (const f of r.fired) shockwave(localPos(f.cell, new THREE.Vector3()));
  const popTime = 0.03 * r.popped.length + 0.2;
  // A long chain leaves a special: re-dress the orb that stayed.
  if (r.createdAt != null) {
    const o = board.cells[r.createdAt];
    const m = cube.orbs.get(o.id);
    if (m) { dress(o); tween(m, [{ wait: popTime * 0.6 }, { to: 1.35, dur: 0.12 }, { to: 1, dur: 0.2 }], 1); }
  }
  for (const mv of r.moves) {
    const m = cube.orbs.get(mv.id);
    if (!m) continue;
    cube.cellOf.set(mv.id, mv.to);
    const dist = localPos(mv.from, new THREE.Vector3()).distanceTo(localPos(mv.to, new THREE.Vector3()));
    moveTo(m, mv.to, popTime, 0.18 + dist * 0.1, m.position);
  }
  const [dx, dy, dz] = P.AXES[r.gravity];
  for (const s of r.spawns) {
    const m = addOrb(s.orb, s.cell);
    const target = localPos(s.cell, new THREE.Vector3());
    const start = target.clone().add(new THREE.Vector3(-dx, -dy * spacing, -dz).multiplyScalar(s.drop * PITCH));
    m.position.copy(start);
    moveTo(m, s.cell, popTime + 0.05, 0.22 + s.drop * 0.08, start);
  }
  cube.idAt = board.cells.map((o) => o.id);
  // Anything out of sync (a shuffle) snaps to the board.
  setTimeout(() => reconcile(board), (popTime + 0.8) * 1000);
}

/** Make the scene match `board` exactly (after shuffles, loads, or replays). */
function reconcile(board) {
  if (!cube.n || board.n !== cube.n) { buildCube(board); return; }
  const want = new Set(board.cells.map((o) => o.id));
  for (const [id, m] of [...cube.orbs]) if (!want.has(id)) {
    pivot.remove(m); cube.orbs.delete(id); cube.cellOf.delete(id);
    const mark = cube.marks.get(id); if (mark) { scene.remove(mark.sprite); cube.marks.delete(id); }
  }
  board.cells.forEach((o, cell) => {
    const m = cube.orbs.get(o.id);
    if (!m) { addOrb(o, cell); return; }
    cube.cellOf.set(o.id, cell);
    if (!m.userData.move) localPos(cell, m.position);
    if (m.material !== orbMaterial(o) || (cube.marks.get(o.id)?.special ?? null) !== o.special) dress(o);
  });
  cube.idAt = board.cells.map((o) => o.id);
}

function burst(pos, color) {
  if (reduceMotion) return;
  const N = 18, geo = new THREE.BufferGeometry(), arr = new Float32Array(N * 3), vel = [];
  for (let i = 0; i < N; i++) {
    arr.set([pos.x, pos.y, pos.z], i * 3);
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.2 + Math.random() * 1.2);
    vel.push(v);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.PointsMaterial({ map: sparkTex, color, size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const pts = new THREE.Points(geo, mat);
  pivot.add(pts);
  cube.bursts.push({ pts, vel, t0: clock() });
}
function shockwave(pos) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthWrite: false, toneMapped: false }));
  s.userData = { local: pos.clone(), t0: clock() };
  s.renderOrder = 25;
  scene.add(s);
  cube.shocks.push(s);
}

// ── chain display ──
const linkGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
function placeLink(l) {
  localPos(l.userData.a, tmpA); localPos(l.userData.b, tmpB);
  l.position.copy(tmpA).add(tmpB).multiplyScalar(0.5);
  const len = tmpA.distanceTo(tmpB);
  l.quaternion.setFromUnitVectors(up, tmpB.sub(tmpA).normalize());
  l.scale.set(0.05, len, 0.05);
}
function clearSelection() {
  for (const cell of cube.shownPath) { const m = cube.orbs.get(cube.idAt[cell]); if (m && !m.userData.move) tween(m, [{ to: 1, dur: 0.1 }]); }
  cube.shownPath = [];
  for (const l of cube.links) pivot.remove(l);
  cube.links = [];
  showNext(new Set());
}
function showChain(path, next, hex) {
  const key = path.join();
  if (key !== cube.shownPath.join() || hex !== cube.chainHex) {
    for (const cell of cube.shownPath) if (!path.includes(cell)) { const m = cube.orbs.get(cube.idAt[cell]); if (m) tween(m, [{ to: 1, dur: 0.1 }]); }
    for (const cell of path) if (!cube.shownPath.includes(cell)) { const m = cube.orbs.get(cube.idAt[cell]); if (m) tween(m, [{ to: 1.22, dur: 0.08 }, { to: 1.12, dur: 0.1 }]); }
    cube.shownPath = [...path];
    cube.chainHex = hex;
    for (const l of cube.links) pivot.remove(l);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.35), toneMapped: false });
    cube.links = path.slice(1).map((c, k) => {
      const l = new THREE.Mesh(linkGeo, mat);
      l.userData = { a: path[k], b: c };
      placeLink(l);
      pivot.add(l);
      return l;
    });
  }
  showNext(next);
}
function showNext(next) {
  const key = [...next].sort((a, b) => a - b).join();
  if (key === cube.shownNext) return;
  for (const r of cube.rings) scene.remove(r);
  cube.rings = [...next].map((cell) => {
    const s = new THREE.Sprite(nextRingMat);
    s.userData.cell = cell;
    s.renderOrder = 15;
    scene.add(s);
    return s;
  });
  cube.shownNext = key;
}

// ── per frame ──
const wp = new THREE.Vector3(), dir = new THREE.Vector3(), invQ = new THREE.Quaternion(), down = new THREE.Vector3();
let velocity = new THREE.Vector2(), tickAccum = 0, onGravity = () => {};
function frame() {
  const now = clock();
  if (velocity.lengthSq() > 4e-8) { rotate(velocity.x, velocity.y); velocity.multiplyScalar(0.95); }
  if (Math.abs(spacing - targetSpacing) > 0.0005) { spacing += (targetSpacing - spacing) * 0.2; layout(); }
  for (const m of cube.orbs.values()) { stepTween(m, now); stepMove(m, now); stepWobble(m, now); }
  for (const m of pivot.children) if (m.userData.anim && !cube.orbs.has(m.userData.id)) stepTween(m, now);
  pivot.updateMatrixWorld(true);
  for (const [id, mk] of cube.marks) {
    const m = cube.orbs.get(id);
    if (!m) continue;
    m.getWorldPosition(wp);
    dir.copy(camera.position).sub(wp).normalize();
    mk.sprite.position.copy(wp).addScaledVector(dir, cube.radius * 1.05 * m.scale.x);
    const pulse = mk.special === "bomb" ? 1 + 0.06 * Math.sin(now * Math.PI * 2) : 1;
    mk.sprite.scale.setScalar(cube.radius * 2.3 * m.scale.x * pulse);
    if (mk.special === "beam") mk.sprite.material.rotation = now * 1.05;
    if (mk.special === "prism") mk.sprite.material.opacity = 0.6 + 0.4 * Math.cos(now * Math.PI / 0.6);
  }
  nextRingMat.opacity = reduceMotion ? 0.8 : 0.625 + 0.3 * Math.cos(now * Math.PI / 0.55);
  for (const r of cube.rings) {
    const m = cube.orbs.get(cube.idAt[r.userData.cell]);
    if (!m) continue;
    m.getWorldPosition(r.position);
    r.scale.setScalar(0.36 * 2 * (64 / 58));
  }
  for (const b of [...cube.bursts]) {
    const t = now - b.t0, arr = b.pts.geometry.attributes.position.array;
    const damp = Math.exp(-2.5 * t);
    b.vel.forEach((v, i) => { arr[i * 3] += v.x * 0.016 * damp; arr[i * 3 + 1] += v.y * 0.016 * damp; arr[i * 3 + 2] += v.z * 0.016 * damp; });
    b.pts.geometry.attributes.position.needsUpdate = true;
    b.pts.material.opacity = Math.max(0, 1 - t / 0.45);
    if (t > 0.5) { pivot.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); cube.bursts.splice(cube.bursts.indexOf(b), 1); }
  }
  for (const s of [...cube.shocks]) {
    const t = (now - s.userData.t0) / 0.45;
    s.position.copy(s.userData.local).applyMatrix4(pivot.matrixWorld);
    s.scale.setScalar(0.6 + 2.4 * t);
    s.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) { scene.remove(s); s.material.dispose(); cube.shocks.splice(cube.shocks.indexOf(s), 1); }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const axis = new THREE.Vector3(), dq = new THREE.Quaternion();
function rotate(dx, dy, ticks = true) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-5) return;
  axis.set(dy, dx, 0).normalize();
  orientation.premultiply(dq.setFromAxisAngle(axis, len)).normalize();
  pivot.quaternion.copy(orientation);
  if (ticks) { tickAccum += len; if (tickAccum > Math.PI / 6) { tickAccum = 0; sound.tick(); } }
  updateGravity(!ticks);
}
/** "Down" on screen, in the cube's own axes, snapped to the nearest one. */
function updateGravity(silent = false) {
  invQ.copy(orientation).invert();
  down.set(0, -1, 0).applyQuaternion(invQ);
  const comps = [-down.x, down.x, -down.y, down.y, -down.z, down.z];
  let best = 0;
  for (let i = 1; i < 6; i++) if (comps[i] > comps[best]) best = i;
  if (best === gravity) return;
  gravity = best;
  placeFloor();
  if (!silent) { sound.tick(); haptic(4); }
  onGravity(best);
}

let band = () => ({ top: 0, bottom: innerHeight });
/** Wide screens (iPad, unfolded foldables, desktop): the controls sit in a right-hand panel. */
const isWide = () => innerWidth >= 700 && innerWidth > innerHeight * 0.9;
function frameCamera() {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  const playing = !$("play").hidden;
  const panel = playing && isWide() ? Math.min(420, W * 0.38) : 0;
  const { top, bottom } = panel ? { top: 16, bottom: H - 16 } : band();
  const availH = Math.max(120, bottom - top), centre = (top + bottom) / 2, availW = W - panel;
  camera.setViewOffset(W, H, panel / 2, H / 2 - centre, W, H);
  const n = cube.n || 4;
  // Radius of the spinning cube with a little air.
  const R = 0.5 * Math.hypot(n * PITCH, n * PITCH, n * PITCH) * 0.95;
  const f = (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = (R * f) / (Math.min(availH, availW - 24) / 2) + R * 0.15;
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}
addEventListener("resize", frameCamera);

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(clientX, clientY) {
  if (!cube.n) return -1;
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = -1, bestT = Infinity;
  for (const [id, m] of cube.orbs) {
    m.getWorldPosition(wp);
    if (ray.ray.distanceSqToPoint(wp) > 0.34 * 0.34) continue;
    const t = wp.sub(ray.ray.origin).dot(ray.ray.direction);
    if (t < bestT) { bestT = t; best = cube.cellOf.get(id); }
  }
  return best ?? -1;
}

// Gestures: one finger turns (with inertia), two fingers / the wheel spread the layers, a tap picks.
const pointers = new Map();
let down0 = null, pinch = null, lastMove = null, interactive = true;
let onTapCell = () => {};
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  velocity.set(0, 0);
  if (pointers.size === 1) { down0 = { x: e.clientX, y: e.clientY, t: performance.now() }; lastMove = { x: e.clientX, y: e.clientY, t: performance.now() }; }
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), start: targetSpacing }; down0 = null; }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) { if (e.pointerType === "mouse") canvas.style.cursor = interactive && pick(e.clientX, e.clientY) >= 0 ? "pointer" : "grab"; return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size >= 2) { const [a, b] = [...pointers.values()]; setSpacing(pinch.start * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d)); return; }
  rotate(dx * 0.0085, dy * 0.0085);
  const t = performance.now(), dt = Math.max(8, t - lastMove.t);
  velocity.set((dx * 0.0085) * (16.7 / dt), (dy * 0.0085) * (16.7 / dt));
  lastMove = { x: e.clientX, y: e.clientY, t };
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size < 2) pinch = null;
  if (performance.now() - (lastMove?.t ?? 0) > 80) velocity.set(0, 0);
  if (!down0 || pointers.size) { if (!pointers.size) down0 = null; return; }
  const moved = Math.hypot(e.clientX - down0.x, e.clientY - down0.y), quick = performance.now() - down0.t < 600;
  down0 = null;
  if (e.type === "pointerup" && moved < 8 && quick && interactive) {
    velocity.set(0, 0);
    const cell = pick(e.clientX, e.clientY);
    if (cell >= 0) onTapCell(cell);
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); setSpacing(targetSpacing * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
function setSpacing(v) {
  targetSpacing = Math.min(SPREAD.max, Math.max(SPREAD.min, v));
  $("spreadBtn")?.setAttribute("aria-pressed", String(targetSpacing > 1.4));
}

/* ───────────────────────────── shared UI ───────────────────────────── */

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("out");
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add("out"); setTimeout(() => (el.hidden = true), 260); }, 1300);
}
function bump(el, value) {
  const s = String(value);
  if (el.textContent === s) return;
  el.textContent = s;
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}
function setSoundUI() {
  $("soundToggle").setAttribute("aria-pressed", String(sound.on));
  $("soundToggle").setAttribute("aria-label", sound.on ? "Sound on" : "Sound off");
}
$("soundToggle").addEventListener("click", () => {
  sound.on = !sound.on; store.set("ttc.sound", sound.on ? "1" : "0"); setSoundUI();
  if (sound.on) { sound.unlock(); sound.tick(); }
});
setSoundUI();
$("spreadBtn").addEventListener("click", () => { setSpacing(targetSpacing > 1.4 ? SPREAD.closed : SPREAD.open); sound.tick(); });

/** The traced chain, shared by solo and two-player play. */
function makeTracer(getBoard, canAct) {
  const t = {
    path: [],
    tap(cell) {
      if (!canAct()) return;
      const b = getBoard();
      const i = t.path.indexOf(cell);
      if (t.path.at(-1) === cell) { t.path.pop(); sound.undo(t.path.length); }
      else if (i >= 0) { t.path = t.path.slice(0, i + 1); sound.undo(t.path.length); }
      else if (P.canExtend(b, t.path, cell)) { t.path.push(cell); sound.orb(t.path.length - 1); haptic(6); }
      else { t.path = [cell]; sound.orb(0); haptic(6); }
    },
    next() {
      const b = getBoard(), last = t.path.at(-1);
      if (last === undefined) return new Set();
      return new Set(P.cube(b.n).neighbours[last].filter((c) => P.canExtend(b, t.path, c)));
    },
    clear() { t.path = []; },
  };
  return t;
}
function chainHex(b, path) { const c = P.chainColor(b, path); return c === null ? "#ffffff" : ORB_HEX[c]; }
function updatePopButton(b, path, enabled) {
  const ok = enabled && P.isValidChain(b, path);
  $("popBtn").disabled = !ok;
  $("popBtn").style.setProperty("--chain", chainHex(b, path));
  $("popLabel").textContent = ok ? `Pop ${path.length} · +${P.previewPoints(b, path)}` : path.length ? "Need 3 in a chain" : "Trace a chain";
  $("clearBtn").disabled = !path.length;
}
const madeEmoji = { bomb: "💣", beam: "✳️", prism: "🔮" };

let lastFocus = null;
function openCard(el, focusEl) {
  lastFocus = document.activeElement;
  el.hidden = false; void el.offsetWidth; el.classList.add("open");
  focusEl?.focus({ preventScroll: true });
}
function closeCard(el) {
  el.classList.remove("open");
  setTimeout(() => { if (!el.classList.contains("open")) el.hidden = true; }, reduceMotion ? 0 : 200);
  lastFocus?.focus?.({ preventScroll: true });
}

/* ───────────────────────────── solo ───────────────────────────── */

const params = new URLSearchParams(location.search);
const sizeParam = P.POP_SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : 4;
const fmtDate = (day) => new Date(2026, 9, 6 + day).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function bootSolo(mode) {
  $("play").hidden = false;
  $("duel").hidden = true;
  const day = P.dayIndex();
  const n = mode === "daily" ? 4 : sizeParam;
  const key = mode === "daily" ? `ttc.pop.d${day}` : `ttc.pop.${mode}${n}`;
  const bestKey = mode === "daily" ? `ttc.popbest.d${day}` : `ttc.popbest.${mode}${n}`;
  const endless = mode === "zen";
  document.title = mode === "daily" ? "Today’s Pop · Cube Pop" : `Cube Pop · ${endless ? "Zen" : "30 moves"}`;
  $("boardTitle").textContent = mode === "daily" ? `Today’s challenge · ${fmtDate(day)} · 4×4×4` : `${endless ? "Zen" : "30 moves"} · ${n}×${n}×${n}`;
  $("movesWrap").hidden = endless;
  $("newGameBtn").hidden = mode === "daily";

  const fresh = () => ({
    board: P.startBoard(n, mode === "daily" ? P.dailySeed(day) : BigInt(crypto.getRandomValues(new Uint32Array(2)).reduce((a, x) => a * 4294967296 + x, 0))),
    score: 0, moves: endless ? Infinity : P.MOVES_PER_GAME, bestChain: 0, specials: 0,
  });
  let g;
  try {
    const s = JSON.parse(store.get(key) || "null");
    g = s ? { ...s, board: P.boardFromJSON(s.board), moves: s.moves ?? Infinity } : fresh();
  } catch { g = fresh(); }
  const save = () => store.set(key, JSON.stringify({ ...g, board: P.boardToJSON(g.board), moves: Number.isFinite(g.moves) ? g.moves : null }));
  const best = () => Number(store.get(bestKey) || 0);
  const over = () => !endless && g.moves <= 0;
  let busy = false;
  const tracer = makeTracer(() => g.board, () => !over() && !busy);

  band = () => ({ top: $("play").querySelector(".wc-top").getBoundingClientRect().bottom + 8, bottom: $("play").querySelector(".wc-bottom").getBoundingClientRect().top - 4 });
  new ResizeObserver(frameCamera).observe($("play").querySelector(".wc-bottom"));
  buildCube(g.board);
  frameCamera();

  function render() {
    bump($("score"), g.score);
    $("best").textContent = best() > 0 ? `Best ${best()}` : "Score";
    if (!endless) { bump($("moves"), g.moves); $("moves").classList.toggle("low", g.moves <= 5); }
    showChain(tracer.path, tracer.next(), chainHex(g.board, tracer.path));
    updatePopButton(g.board, tracer.path, !over() && !busy);
    interactive = !over();
    $("status").textContent = over() ? "Out of moves." : tracer.path.length ? "" : "Trace 3+ touching orbs of one colour. Turn the cube to choose where the rest fall.";
    $("status").hidden = !$("status").textContent;
  }

  function pop() {
    const path = tracer.path;
    if (!P.isValidChain(g.board, path) || over()) return;
    tracer.clear();
    const r = P.applyPop(g.board, path, gravity);
    if (!r) return;
    g.score += r.points;
    g.bestChain = Math.max(g.bestChain, r.popped.length);
    if (r.created) g.specials++;
    if (!endless) g.moves--;
    sound.pop(r.popped.length, r.fired.length);
    haptic(r.fired.length ? 30 : 16);
    animatePop(r, g.board);
    toast(`+${r.points}${r.created ? "  " + madeEmoji[r.created] : ""}`);
    save();
    if (over()) {
      const wasBest = g.score > best();
      if (wasBest) store.set(bestKey, String(g.score));
      setTimeout(() => sound.fanfare(), 900);
      setTimeout(() => openEnd(wasBest), 1300);
    }
    render();
  }

  function openEnd(newBest) {
    $("resultOrb").dataset.mark = "pop";
    $("resultTitle").textContent = newBest ? "New best!" : "Out of moves";
    $("resultHow").textContent = `${g.score} points`;
    $("resultDuo").hidden = true;
    $("resultSolo").hidden = false;
    $("stChain").textContent = g.bestChain;
    $("stSpecials").textContent = g.specials;
    $("stBest").textContent = best();
    $("resultNext").replaceChildren();
    $("resultAgain").hidden = mode === "daily";
    $("resultAgain").textContent = "Play again";
    $("resultShare").hidden = false;
    openCard($("result"), mode === "daily" ? $("resultShare") : $("resultAgain"));
  }
  const shareText = () => `Cube Pop · ${mode === "daily" ? `Daily #${day + 1}` : `${n}×${n}×${n}`}\n🫧 ${g.score} points · longest pop ${g.bestChain} · ${g.specials} specials\nhttps://fbmore.github.io/wubee/pop.html`;
  $("resultShare").addEventListener("click", async () => {
    const text = shareText();
    if (navigator.share) { navigator.share({ title: "Cube Pop", text }).catch(() => {}); return; }
    try { await navigator.clipboard.writeText(text); $("resultShare").textContent = "✓ Copied"; setTimeout(() => ($("resultShare").textContent = "Share"), 1600); } catch {}
  });
  const restart = () => { store.del(key); g = fresh(); tracer.clear(); buildCube(g.board); frameCamera(); render(); };
  $("resultAgain").addEventListener("click", () => { closeCard($("result")); restart(); });
  $("resultClose").addEventListener("click", () => closeCard($("result")));
  $("result").addEventListener("click", (e) => { if (e.target === $("result")) closeCard($("result")); });
  $("newGameBtn").addEventListener("click", () => { $("menuPop").hidePopover?.(); restart(); });

  onTapCell = (cell) => { tracer.tap(cell); render(); };
  $("clearBtn").addEventListener("click", () => { tracer.clear(); render(); });
  $("popBtn").addEventListener("click", pop);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("result").hidden) return closeCard($("result")); tracer.clear(); render(); }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && $("result").hidden) { e.preventDefault(); pop(); }
  });
  render();
  if (over()) setTimeout(() => openEnd(false), 400);
  window.__pop = { get board() { return g.board; }, get game() { return g; }, tap: (c) => onTapCell(c), pop, get gravity() { return gravity; } };
}

/* ───────────────────────────── two players ───────────────────────────── */

const SEAT2 = params.get("seat") === "2";
const HOST_SIZE = P.POP_SIZES.includes(Number(params.get("host"))) ? Number(params.get("host")) : 0;
const prefs = {
  get name() { return store.get("ttc.name") || ""; },
  get color() { return store.get("ttc.color") || "coral"; },
  get name2() { return store.get("ttc.name2") || "Player 2"; },
  get color2() { const c = store.get("ttc.color2"); return c && c !== prefs.color ? c : resolveColors(prefs.color, "teal").O; },
};
const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const popUrl = (id) => `${location.origin}${location.pathname}?p=${id}`;
function savedPops() { try { return JSON.parse(store.get("ttc.pgames") || "[]"); } catch { return []; } }
function rememberPop(id, patch) {
  const list = savedPops();
  const i = list.findIndex((g) => g.id === id);
  const g = { id, opp: "", t: Date.now(), archived: false, closed: false, ...(i >= 0 ? list[i] : {}), ...patch };
  if (patch.closed) g.archived = true;
  if (i >= 0) list.splice(i, 1);
  list.unshift(g);
  store.set("ttc.pgames", JSON.stringify(list.slice(0, 40)));
}

/** Two people on this device: events kept in this browser; whoever's turn it is acts. */
function localDuo(size) {
  const key = "ttc.plocal";
  let saved = null;
  try { saved = JSON.parse(store.get(key) || "null"); } catch {}
  const resume = saved && Array.isArray(saved.events) && saved.id && (!size || saved.size === size);
  size = resume ? saved.size : size || 4;
  const id = resume ? saved.id : `local${newGameId()}`;
  const events = resume ? saved.events : [];
  let ts = Math.max(Date.now(), ...events.map((e) => e.ts)), n = events.length;
  const mk = (author, authorName, kind, extra = {}) => ({ recordName: `local-${++n}`, author, authorName, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, ...extra });
  const xName = prefs.name || "Player 1";
  if (!events.length) {
    events.push(mk("local-x", xName, "join", { text: xName, cell: size, color: prefs.color }),
                mk("local-o", prefs.name2, "join", { text: prefs.name2, color: prefs.color2 }));
  } else {
    Object.assign(events[0], { text: xName, color: prefs.color });
    Object.assign(events[1], { text: prefs.name2, color: prefs.color2 });
  }
  const persist = () => store.set(key, JSON.stringify({ id, size, events }));
  let cb;
  const be = {
    local: true, gameId: id, signedIn: true, me: "local-x",
    start(onEvents) { cb = onEvents; emit(); },
    async save(f) {
      events.push(mk(f.author, f.authorName, f.kind, f));
      const s = foldPop(sortEvents(events), id);
      if (f.kind === "again" && s.over) {
        const o = roleOf(s, f.author) === "X" ? s.players.O : s.players.X;
        if (o) events.push(mk(o.id, o.name, "again", { round: s.round }));
      }
      emit();
      return { event: events.at(-1), all: events.slice() };
    },
    restart() { store.del(key); },
  };
  function emit() {
    const s = foldPop(sortEvents(events), id);
    if (!s.over && s.players[s.turn]) be.me = s.players[s.turn].id;
    persist();
    cb?.(events.slice());
  }
  return be;
}

function swatchPicker(fieldset, name, selected) {
  for (const [key, hex] of PALETTE) {
    const label = document.createElement("label");
    label.className = "swatch";
    label.style.setProperty("--sw", hex);
    label.title = key[0].toUpperCase() + key.slice(1);
    const input = document.createElement("input");
    input.type = "radio"; input.name = name; input.value = key; input.checked = key === selected;
    input.setAttribute("aria-label", label.title);
    label.append(input);
    fieldset.append(label);
  }
}
const pickedIn = (fs) => fs.querySelector("input:checked")?.value;
const other = (r) => (r === "X" ? "O" : "X");

function bootDuo(rawId) {
  const local = rawId === "local";
  let gameId = local ? null : rawId;
  $("play").hidden = false;
  $("solo").hidden = true;
  for (const id of ["duel", "duoActions"]) $(id).hidden = false;
  document.title = "Cube Pop · Two players";

  let backend = null, events = [], state = foldPop([], gameId || "x"), loaded = false, busy = false;
  let shown = { round: -1, pops: 0 }, replaying = false, resultOpen = false, inviteOpen = false, inviteShown = false;
  let statusError = null, connError = null, overKey = null, asking = false;
  const toasted = new Set(), queue = [];
  const myRole = () => (backend?.me ? roleOf(state, backend.me) : null);
  const nameOf = (r) => state.players[r]?.name || (r === "X" ? "Player 1" : "Player 2");
  const hexFor = (r) => hexOf(state.colors[r] || "coral");
  const bothJoined = () => !!(state.players.X && state.players.O);
  const who = (r) => (r === myRole() && !local ? "You" : nameOf(r));
  const canPlay = () => {
    const r = myRole();
    return !!(r && state.board && !state.over && !state.closedBy && state.turn === r && !busy && !replaying && (r === "X" || bothJoined()));
  };
  // The board you're tracing on: what the scene shows (it lags the fold while replays play).
  let view = null;
  const tracer = makeTracer(() => view, canPlay);

  band = () => ({ top: $("play").querySelector(".wc-top").getBoundingClientRect().bottom + 8, bottom: $("play").querySelector(".wc-bottom").getBoundingClientRect().top - 4 });
  new ResizeObserver(frameCamera).observe($("play").querySelector(".wc-head"));
  new ResizeObserver(frameCamera).observe($("play").querySelector(".wc-bottom"));

  function ingest(list) {
    connError = null;
    events = sortEvents(list);
    const prev = state;
    state = foldPop(events, gameId);
    const root = document.documentElement.style;
    root.setProperty("--cx", hexFor("X")); root.setProperty("--co", hexFor("O"));
    root.setProperty("--me", hexFor(myRole() || "X"));
    if (state.board) {
      if (state.round !== shown.round) {
        // New round (or first load): show its board as it stands now.
        shown = { round: state.round, pops: state.pops.length };
        view = P.cloneBoard(state.board);
        buildCube(view);
        frameCamera();
      } else if (state.pops.length < shown.pops) {
        // A pop we sent didn't make it: back to the true board.
        shown.pops = state.pops.length;
        queue.length = 0;
        view = P.cloneBoard(state.board);
        reconcile(view);
      } else if (state.pops.length > shown.pops) {
        for (const p of state.pops.slice(shown.pops)) queue.push(p);
        shown.pops = state.pops.length;
        if (!replaying) nextPop();
      }
    }
    for (const e of events) {
      if (toasted.has(e.recordName) || String(e.recordName).startsWith("~local")) continue;
      toasted.add(e.recordName);
      if (!loaded) continue;
      if (e.kind === "say") chatToast(e);
      else if (e.kind === "join" && e.author !== backend?.me && !roleOf(prev, e.author) && roleOf(state, e.author)) chatToast({ ...e, text: "joined the game" });
    }
    const ok = state.over ? `${state.round}:${state.over.reason}` : null;
    if (ok && ok !== overKey && loaded) celebrate();
    if (!ok && resultOpen) closeResult();
    overKey = ok;
    if (!loaded) loaded = true;
    const me = myRole();
    if (!local && me) {
      rememberPop(gameId, { opp: state.players[other(me)]?.name || "", closed: !!state.closedBy });
      if (HOST_SIZE && state.players.X) history.replaceState(null, "", popUrl(gameId) + (SEAT2 ? "&seat=2" : ""));
    }
    render();
    maybeAskToJoin();
  }

  /** Play queued pops: yours animate at once; the other player's chain is traced first. */
  function nextPop() {
    const p = queue.shift();
    if (!p) { replaying = false; view = P.cloneBoard(state.board); reconcile(view); render(); return; }
    replaying = true;
    tracer.clear();
    const mine = !local && p.by === myRole();
    const go = () => {
      view = P.cloneBoard(p.before);
      const after = P.cloneBoard(p.before);
      const r = P.applyPop(after, p.path, p.gravity);
      if (!r) { nextPop(); return; }
      sound.pop(r.popped.length, r.fired.length);
      haptic(r.fired.length ? 30 : 14);
      animatePop(r, after);
      view = after;
      toast(`${local || mine ? "" : nameOf(p.by) + " "}+${r.points}${r.created ? "  " + madeEmoji[r.created] : ""}`);
      setTimeout(nextPop, reduceMotion ? 200 : 900);
    };
    if (mine || local) { go(); return; }
    // Their chain, traced orb by orb in their colour, then the pop.
    let k = 0;
    const step = () => {
      k++;
      showChain(p.path.slice(0, k), new Set(), hexFor(p.by));
      sound.orb(k - 1);
      if (k < p.path.length) { setTimeout(step, reduceMotion ? 80 : 180); return; }
      setTimeout(go, 280);
    };
    reconcile(p.before);
    setTimeout(step, 300);
  }

  async function send(fields) {
    const role = myRole();
    const f = { author: backend.me, authorName: prefs.name || nameOf(role ?? "X"), round: state.round, cell: -1, text: "", color: "", ...fields };
    if (backend.local) { f.authorName = nameOf(roleOf(state, f.author)); return backend.save(f); }
    const temp = { ...f, recordName: `~local-${Math.random()}`, ts: Date.now() };
    ingest([...events, temp]);
    try { const { all } = await backend.save(f); ingest(all); }
    catch (err) { console.error(err); ingest(events.filter((e) => e !== temp)); showStatusError("Couldn’t reach iCloud — try again."); }
  }
  function showStatusError(msg) { statusError = msg; render(); setTimeout(() => { statusError = null; render(); }, 4000); }

  function pop() {
    if (!canPlay() || !view || !P.isValidChain(view, tracer.path)) return;
    const path = tracer.path;
    tracer.clear();
    busy = true;
    send({ kind: "pop", text: encodePop(path, gravity) }).finally(() => { busy = false; render(); });
  }

  function render() {
    const role = myRole();
    const waiting = !!(backend && !local && role && !state.closedBy && (canPlay() || (state.over && state.ready[other(role)] && !state.ready[role])));
    document.title = (document.hidden && waiting ? "● Your turn · " : "") + "Cube Pop";
    for (const r of ["X", "O"]) {
      $("name" + r).textContent = state.players[r]?.name || "Waiting…";
      const sc = $("score" + r);
      if (sc.textContent !== String(state.score[r])) { sc.textContent = state.score[r]; if (loaded) { sc.classList.remove("bump"); void sc.offsetWidth; sc.classList.add("bump"); } }
      $("p" + r).classList.toggle("active", !!state.board && !state.over && !state.closedBy && state.turn === r && (r === "X" || bothJoined()));
      const mine = r === role && !local && !state.closedBy;
      $("name" + r).classList.toggle("editable", mine);
      $("p" + r).title = mine ? "Change your name or colour" : "";
    }
    $("turns").textContent = state.over ? (state.over.winner === "draw" ? "Draw" : `${who(state.over.winner)} won`)
      : `Pop ${Math.min(POP_TURNS, state.turns[state.turn] + 1)} of ${POP_TURNS}`;
    $("boardTitle").textContent = `${state.size}×${state.size}×${state.size} · Game ${state.round + 1}${local ? " · Two players" : ""}`;
    if (view && !replaying) showChain(tracer.path, canPlay() ? tracer.next() : new Set(), chainHex(view, tracer.path));
    interactive = !replaying;
    updatePopButton(view || state.board || P.makeBoard(3, 1n), tracer.path, canPlay());

    let status;
    if (statusError) status = statusError;
    else if (connError) status = connError;
    else if (!loaded) status = "Loading game…";
    else if (state.closedBy) status = !state.players.O
      ? (role === state.closedBy ? "You cancelled this invite." : "This invite was cancelled.")
      : (role === state.closedBy ? "You ended this game." : `${nameOf(state.closedBy)} ended this game.`);
    else if (!state.players.X) status = backend?.signedIn ? "Starting…"
      : backend?.authError ? "Apple sign-in isn’t available here right now. You can still play two players on this device."
      : HOST_SIZE ? "Sign in with Apple to start your game — then send your friend the link."
      : "A seat is open — sign in with Apple to play.";
    else if (state.over) {
      const opp = role ? other(role) : null;
      if (role && !local && state.ready[role] && !state.ready[opp]) status = `Waiting for ${nameOf(opp)} to accept…`;
      else if (role && !local && state.ready[opp]) status = `${nameOf(opp)} wants another game.`;
      else status = resultHow();
    } else if (!role) status = backend?.signedIn ? "Joining…" : bothJoined() ? `Watching ${nameOf("X")} vs ${nameOf("O")}.` : "A seat is open — sign in with Apple to play.";
    else if (replaying) status = local ? "" : `${nameOf(other(role))} popped…`;
    else if (local) status = `${nameOf(state.turn)}, your turn — trace a chain and pop it.`;
    else if (state.turn === role) status = !bothJoined() && role === "X" ? "Your turn — pop a chain while your friend opens the link." : "Your turn — trace a chain. Turn the cube to choose where things fall.";
    else if (!bothJoined()) status = "Waiting for your friend to open the link…";
    else status = `${nameOf(state.turn)}’s turn — you can turn the cube meanwhile.`;
    $("status").textContent = status;
    $("status").hidden = !status;

    const opp = role ? other(role) : "O";
    const closed = !!state.closedBy;
    $("againBtn").hidden = closed || !role || !state.over || state.ready[role] || resultOpen;
    $("againBtn").textContent = local ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
    $("resultBtn").hidden = !state.over || resultOpen;
    $("resignWrap").hidden = closed || !role || !bothJoined() || !!state.over;
    $("endWrap").hidden = closed || !role || local;
    $("newGameBtn").hidden = !local;
    $("endBtn").textContent = $("endYes").textContent = bothJoined() ? "End game" : "Cancel invite";
    $("endQ").textContent = bothJoined() ? "End it for both of you?" : "Cancel the invite? The link stops working.";
    $("signin").hidden = local || !backend || !!backend.signedIn || !!backend.authError;
    $("chatBtn").hidden = local || closed || !role || !bothJoined();
    if ($("chatBtn").hidden) $("chatPop").hidePopover?.();
    const host = role === "X" && !bothJoined() && !closed && !local && loaded;
    $("inviteBtn").hidden = !host || inviteOpen;
    if (host && !inviteShown) { inviteShown = true; openInvite(); }
    if (!host && inviteOpen) closeInvite();
    if (resultOpen) renderResult();
  }

  function celebrate() {
    const role = myRole(), w = state.over.winner;
    if (w === "draw") sound.tick();
    else if (local || role === w) { setTimeout(() => sound.fanfare(), 300); haptic([20, 40, 20]); }
    else sound.lose();
    setTimeout(() => { if (state.over) openResult(); }, replaying ? 2200 : 900);
  }
  function resultHow() {
    const o = state.over;
    if (!o) return "";
    if (o.reason === "resign") return o.winner === myRole() && !local ? `${nameOf(state.resigned)} resigned — you take the game.` : `${who(state.resigned)} resigned — ${nameOf(o.winner)} takes the game.`;
    return `${POP_TURNS} pops each.`;
  }
  function renderResult() {
    const role = myRole(), o = state.over;
    if (!o) return;
    const w = o.winner;
    $("resultTitle").textContent = w === "draw" ? "It’s a draw"
      : o.reason === "resign" && role === state.resigned && !local ? "You resigned"
      : role === w && !local ? "You win!" : `${nameOf(w)} wins${local ? "!" : ""}`;
    $("resultHow").textContent = resultHow();
    $("resultOrb").dataset.mark = w === "draw" ? "draw" : w;
    $("resultDuo").hidden = false;
    $("resultSolo").hidden = true;
    $("resultShare").hidden = true;
    for (const r of ["X", "O"]) { $("rs" + r).textContent = state.score[r]; $("rsName" + r).textContent = role === r && !local ? "You" : nameOf(r); }
    const next = [];
    const opp = role ? other(role) : null;
    if (state.round > 0 || state.wins.X + state.wins.O > 1) next.push(["flag", `Games won: ${who("X")} ${state.wins.X} · ${who("O")} ${state.wins.O}`]);
    if (role && !local) {
      if (state.ready[role] && !state.ready[opp]) next.push(["wait", `Waiting for ${nameOf(opp)} to accept.`]);
      else if (state.ready[opp]) next.push(["wave", `${nameOf(opp)} wants another game.`]);
      else next.push(["again", `Ask for a rematch — ${nameOf(opp)} can accept whenever they’re ready.`]);
    }
    const starter = starterFor(state.round + 1);
    next.push(["flag", `Next game: a new cube, ${role === starter && !local ? "you go" : `${nameOf(starter)} goes`} first.`]);
    $("resultNext").replaceChildren(...next.map(([icon, text]) => { const li = document.createElement("li"); li.dataset.icon = icon; li.textContent = text; return li; }));
    const again = $("resultAgain");
    again.hidden = !role || state.ready[role] || !!state.closedBy;
    again.textContent = local ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
  }
  function openResult() { resultOpen = true; renderResult(); openCard($("result"), $("resultAgain").hidden ? $("resultClose") : $("resultAgain")); render(); }
  function closeResult() { resultOpen = false; closeCard($("result")); render(); }

  function chatToast(e) {
    const r = roleOf(state, e.author);
    const el = document.createElement("div");
    el.className = `toast${e.author === backend?.me ? " mine" : ""}`;
    el.dataset.mark = r || "X";
    const whoEl = document.createElement("span");
    whoEl.className = "who";
    whoEl.textContent = e.author === backend?.me && !local ? "You" : (e.authorName || nameOf(r));
    el.append(whoEl, document.createTextNode(e.text));
    $("toasts").append(el);
    while ($("toasts").children.length > 3) $("toasts").firstElementChild.remove();
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 4200);
  }
  for (const text of PRESETS) {
    const b = document.createElement("button");
    b.className = "chip"; b.type = "button"; b.textContent = text;
    b.addEventListener("click", () => { send({ kind: "say", text }); $("chatPop").hidePopover?.(); });
    $("chips").append(b);
  }

  function maybeAskToJoin() {
    if (!backend || backend.local || !backend.signedIn || !loaded || asking) return;
    if (myRole() || bothJoined() || state.closedBy) return;
    const hostCell = HOST_SIZE && !events.length ? HOST_SIZE : -1;
    const name = prefs.name, color = store.get("ttc.color");
    if (name && color) { asking = true; send({ kind: "join", text: name, color, cell: hostCell }).finally(() => { asking = false; }); return; }
    asking = true;
    $("nameInput").value = name;
    const fs = $("joinSwatches");
    fs.querySelectorAll("label").forEach((l) => l.remove());
    const taken = state.players.X?.color;
    swatchPicker(fs, "joinColor", color || PALETTE.find(([k]) => k !== taken && k !== "coral")?.[0] || "teal");
    const dlg = $("nameDialog");
    dlg.showModal();
    dlg.addEventListener("close", () => {
      const v = $("nameInput").value.trim().slice(0, 24), c = pickedIn(fs) || "teal";
      if (v) { store.set("ttc.name", v); store.set("ttc.color", c); send({ kind: "join", text: v, color: c, cell: hostCell }).finally(() => { asking = false; }); }
      else asking = false;
    }, { once: true });
  }
  function editMe() {
    const role = myRole();
    if (!role || local || state.closedBy) return;
    const dlg = $("nameDialog");
    $("nameTitle").textContent = "Your name & colour"; $("nameOk").textContent = "Save"; $("nameCancel").hidden = false;
    $("nameInput").value = state.players[role]?.name || prefs.name;
    const fs = $("joinSwatches");
    fs.querySelectorAll("label").forEach((l) => l.remove());
    swatchPicker(fs, "joinColor", state.players[role]?.color || prefs.color);
    dlg.showModal();
    dlg.addEventListener("close", () => {
      $("nameTitle").textContent = "Join the game"; $("nameOk").textContent = "Join game"; $("nameCancel").hidden = true;
      if (dlg.returnValue !== "ok") return;
      const v = $("nameInput").value.trim().slice(0, 24), c = pickedIn(fs) || prefs.color;
      if (!v) return;
      store.set("ttc.name", v); store.set("ttc.color", c);
      if (v !== state.players[role]?.name || c !== state.players[role]?.color) send({ kind: "join", text: v, color: c, cell: -1 });
    }, { once: true });
  }
  for (const r of ["X", "O"]) $("p" + r).addEventListener("click", () => { if (myRole() === r) editMe(); });

  function openInvite() {
    inviteOpen = true;
    $("inviteUrl").textContent = popUrl(gameId).replace(/^https?:\/\//, "");
    $("inviteLead").textContent = `Your ${state.size}×${state.size}×${state.size} Cube Pop game is ready. Send this link to the person you want to play.`;
    openCard($("invite"), $("inviteCopy"));
    render();
  }
  function closeInvite() { if (!inviteOpen) return; inviteOpen = false; closeCard($("invite")); render(); }
  async function copyInvite() {
    const b = $("inviteCopy");
    try { await navigator.clipboard.writeText(popUrl(gameId)); b.textContent = "✓ Copied"; haptic(10); }
    catch { getSelection().selectAllChildren($("inviteUrl")); b.textContent = "Press ⌘C"; }
    setTimeout(() => { b.textContent = "Copy link"; }, 1800);
  }
  $("inviteBtn").addEventListener("click", openInvite);
  $("inviteCopy").addEventListener("click", copyInvite);
  $("inviteLink").addEventListener("click", copyInvite);
  $("inviteDone").addEventListener("click", closeInvite);
  $("invite").addEventListener("click", (e) => { if (e.target === $("invite")) closeInvite(); });
  $("inviteShare").hidden = !navigator.share;
  $("inviteShare").addEventListener("click", () => navigator.share?.({ title: "Cube Pop", text: "Play Cube Pop with me 🫧", url: popUrl(gameId) }).catch(() => {}));

  onTapCell = (cell) => { if (!replaying && view) { tracer.tap(cell); render(); } };
  $("clearBtn").addEventListener("click", () => { tracer.clear(); render(); });
  $("popBtn").addEventListener("click", pop);
  $("againBtn").addEventListener("click", () => send({ kind: "again" }));
  $("resultBtn").addEventListener("click", openResult);
  $("resultAgain").addEventListener("click", () => { closeResult(); send({ kind: "again" }); });
  $("resultClose").addEventListener("click", closeResult);
  $("result").addEventListener("click", (e) => { if (e.target === $("result")) closeResult(); });
  $("newGameBtn").addEventListener("click", () => { $("menuPop").hidePopover?.(); backend?.restart?.(); location.reload(); });
  const confirmRow = (btn, box, on) => { $(btn).hidden = on; $(box).hidden = !on; };
  $("resignBtn").addEventListener("click", () => confirmRow("resignBtn", "resignConfirm", true));
  $("resignNo").addEventListener("click", () => confirmRow("resignBtn", "resignConfirm", false));
  $("resignYes").addEventListener("click", () => { confirmRow("resignBtn", "resignConfirm", false); $("menuPop").hidePopover?.(); send({ kind: "resign" }); });
  $("endBtn").addEventListener("click", () => confirmRow("endBtn", "endConfirm", true));
  $("endNo").addEventListener("click", () => confirmRow("endBtn", "endConfirm", false));
  $("endYes").addEventListener("click", () => { confirmRow("endBtn", "endConfirm", false); $("menuPop").hidePopover?.(); send({ kind: "close" }); });
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $("nameDialog").open) return;
    if (e.key === "Escape") { if (resultOpen) return closeResult(); if (inviteOpen) return closeInvite(); tracer.clear(); render(); }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !resultOpen && !inviteOpen) { e.preventDefault(); pop(); }
  });
  document.addEventListener("visibilitychange", render);

  if (local) {
    backend = localDuo(sizeParam);
    gameId = backend.gameId;
    backend.start(ingest);
    window.__pop = { get state() { return state; }, get view() { return view; }, tap: (c) => onTapCell(c), pop, get gravity() { return gravity; } };
    return;
  }
  render();
  cloudGame(gameId, () => { render(); maybeAskToJoin(); }).then((be) => {
    backend = be;
    window.__pop = { get state() { return state; }, get backend() { return backend; }, tap: (c) => onTapCell(c), pop };
    be.start(ingest, (err) => {
      console.warn(err);
      if (loaded) showStatusError("Having trouble reaching iCloud — retrying…");
      else { connError = "Couldn’t reach iCloud. Retrying… You can still play two players on this device."; render(); }
    });
  }).catch((err) => {
    console.warn(err);
    statusError = `${err.message} You can still play two players on this device.`;
    loaded = true;
    render();
  });
}

/* ───────────────────────────── boot ───────────────────────────── */

function boot() {
  requestAnimationFrame(frame);
  updateGravity(true);
  onGravity = () => {};
  const p = (params.get("p") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
  const m = params.get("m");
  if (p) return bootDuo(p);
  if (["daily", "moves", "zen"].includes(m)) return bootSolo(m);
  // No game: how it works, over a slowly turning cube.
  $("hub").hidden = false;
  buildCube(P.startBoard(3, 11n));
  frameCamera();
  const spin = () => { if (!reduceMotion) rotate(0.0022, 0, false); requestAnimationFrame(spin); };
  spin();
  $("hub").addEventListener("scroll", () => { canvas.style.opacity = String(Math.max(0, 1 - $("hub").scrollTop / 220)); }, { passive: true });
}
boot();
