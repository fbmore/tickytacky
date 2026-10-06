// Word Cube for the web: hub (today's cube + practice boards) and the play view.
// Same boards, rules, scoring, sounds and look as the iOS app (WordCube/*.swift).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { hexOf } from "./game.js";
import { makeBook, WordGame, progressKey, emptyProgress, RANKS, LAYER_BONUS, SIZE_LABEL } from "./wordcube.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const accentHex = hexOf(store.get("ttc.color") || "coral");
document.documentElement.style.setProperty("--me", accentHex);

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
  /** notes: [[Hz, start s]] */
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
  /** Major pentatonic from G4 upward. */
  note(i) { const s = [0, 2, 4, 7, 9]; return 392 * Math.pow(2, (12 * Math.floor(i / 5) + s[i % 5]) / 12); },
  tick() { this.bell([[2600, 0]], { duration: 0.04, decay: 90, gain: 0.08 }); },
  letter(step) { this.bell([[this.note(step), 0]], { duration: 0.45, decay: 11, gain: 0.2 }); },
  undo(step) { this.bell([[this.note(step) * 0.5, 0]], { duration: 0.22, decay: 22, gain: 0.12 }); },
  /** A quick upward arpeggio; longer words reach higher. A through-every-layer word adds a sparkle. */
  word(length, bonus) {
    const notes = Array.from({ length: Math.min(6, Math.max(3, length)) }, (_, k) => [this.note(k * 2), k * 0.055]);
    if (bonus) notes.push([this.note(14), 0.38], [this.note(16), 0.46]);
    this.bell(notes, { duration: 1.2 + length * 0.08, decay: 4.5, gain: 0.2 });
  },
  wrong() { this.bell([[196, 0], [147, 0.07]], { duration: 0.35, decay: 16, gain: 0.22 }); },
  already() { this.bell([[this.note(7), 0], [this.note(7), 0.09]], { duration: 0.3, decay: 20, gain: 0.12 }); },
  reveal() { this.bell(Array.from({ length: 9 }, (_, k) => [this.note(5 + k), k * 0.07]), { duration: 1.4, decay: 5, gain: 0.13 }); },
  rankUp() { this.bell([0, 2, 4, 7, 9, 11].map((e, k) => [this.note(e + 3), k * 0.08]), { duration: 1.8, decay: 3.5, gain: 0.2 }); },
};
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => sound.unlock(), { capture: true });
const haptic = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

/* ───────────────────────────── 3-D letter cube ───────────────────────────── */

const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(4, 7, 8);
scene.add(keyLight, new THREE.AmbientLight(0xffffff, 0.35));

const pivot = new THREE.Group();
scene.add(pivot);
const orientation = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.42)
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.62));
pivot.quaternion.copy(orientation);

const PITCH = 1.0;
const SPREAD = { closed: 1.25, open: 2.1, min: 1.0, max: 2.6 };
let spacing = SPREAD.closed, targetSpacing = SPREAD.closed;

const plateMat = new THREE.MeshStandardMaterial({
  color: 0x5b6fb8, transparent: true, opacity: 0.07, roughness: 0.35, metalness: 0,
  envMapIntensity: 0.15, depthWrite: false, side: THREE.DoubleSide,
});
const pearlMat = new THREE.MeshPhysicalMaterial({ color: 0xe9ecf8, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 });
// Not-yet-revealed cells: solid, dim slate pearls (opaque, so nothing shows through).
const hiddenMat = new THREE.MeshPhysicalMaterial({
  color: 0x2e3863, emissive: 0x6f84d6, emissiveIntensity: 0.06, roughness: 0.3, clearcoat: 0.6,
  clearcoatRoughness: 0.2, envMapIntensity: 0.35,
});
// Selected letters: a solid, slightly deeper shade of your colour; no emission, so white letters stay crisp.
const selectedMat = (() => {
  // HSB like iOS: saturation ×1.08, brightness ×0.78.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accentHex.slice(i, i + 2), 16) / 255);
  const v = Math.max(r, g, b), d = v - Math.min(r, g, b), s = v ? d / v : 0;
  const v2 = v * 0.78, s2 = Math.min(1, s * 1.08);
  const ch = (c) => (d ? v2 * (1 - s2 * (v - c) / d) : v2);
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(ch(r), ch(g), ch(b), THREE.SRGBColorSpace),
    roughness: 0.32, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.15,
  });
})();
const linkMat = new THREE.MeshBasicMaterial({ color: accentHex, toneMapped: false });
const flashColor = new THREE.Color(accentHex).lerp(new THREE.Color(0xffffff), 0.35);

const labelCache = new Map();
/** A letter rendered once into a texture; it rides on the camera-facing surface of its pearl. */
function labelMaterial(text, dark) {
  const key = `${text}-${dark}`;
  if (labelCache.has(key)) return labelCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const shown = text === "qu" ? "Qu" : text.toUpperCase();
  g.font = `700 ${shown.length > 1 ? 58 : 76}px ui-rounded, "SF Pro Rounded", Inter, system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  if (!dark) { g.shadowColor = "rgb(0 0 0 / 0.45)"; g.shadowBlur = 5; g.shadowOffsetY = 1.5; }
  g.fillStyle = dark ? "#141a38" : "#fff";
  g.fillText(shown, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, toneMapped: false });
  labelCache.set(key, m);
  return m;
}
const ringMat = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.strokeStyle = "#fff"; g.lineWidth = 4.5;
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  return new THREE.SpriteMaterial({ map: tex, color: accentHex, depthTest: true, depthWrite: false, transparent: true, toneMapped: false });
})();

const cube = {
  puzzle: null, layers: [], cells: new Map(), labels: new Map(), rings: [], links: [], flashes: [],
  shownPhase: -1, shownPath: [], shownNext: new Set(), interactive: true, radius: 0.27,
};
const mid = () => (cube.puzzle.n - 1) / 2;
function localPos(cell, out = new THREE.Vector3()) {
  const [x, y, z] = cube.puzzle.coords(cell);
  return out.set((x - mid()) * PITCH, (y - mid()) * spacing, (z - mid()) * PITCH);
}

function buildCube(puzzle) {
  cube.puzzle = puzzle;
  for (const o of [...pivot.children]) pivot.remove(o);
  for (const s of cube.labels.values()) scene.remove(s);
  for (const r of cube.rings) scene.remove(r);
  Object.assign(cube, { layers: [], cells: new Map(), labels: new Map(), rings: [], links: [], flashes: [], shownPhase: -1, shownPath: [], shownNext: new Set() });
  const n = puzzle.n, side = PITCH * n;
  cube.radius = n >= 5 ? 0.24 : 0.27;
  const plateGeo = new THREE.BoxGeometry(side, 0.02, side);
  const sphere = new THREE.SphereGeometry(cube.radius, 48, 32);
  for (let y = 0; y < n; y++) {
    const layer = new THREE.Group();
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.y = -0.36;
    plate.renderOrder = 10;
    layer.add(plate);
    pivot.add(layer);
    cube.layers.push(layer);
  }
  for (let cell = 0; cell < puzzle.cells; cell++) {
    if (puzzle.tiles[cell] == null) continue; // blocked: nothing there
    const [x, y, z] = puzzle.coords(cell);
    const m = new THREE.Mesh(sphere, hiddenMat);
    m.position.set((x - mid()) * PITCH, 0, (z - mid()) * PITCH);
    m.userData.cell = cell;
    cube.layers[y].add(m);
    cube.cells.set(cell, m);
  }
  layoutLayers();
}
function layoutLayers() { cube.layers.forEach((l, y) => (l.position.y = (y - mid()) * spacing)); }

// ── tiny scale tweens ──
const clock = () => performance.now() / 1000;
/** steps: [{ wait }, { to, dur }] from `from` (default: the current scale). */
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
}

function syncCube({ phase, path, next }) {
  if (phase !== cube.shownPhase) reveal(phase, cube.shownPhase >= 0);
  if (path.join() !== cube.shownPath.join()) showPath(path);
  const nextKey = [...next].sort((a, b) => a - b).join();
  if (nextKey !== [...cube.shownNext].sort((a, b) => a - b).join()) showNext(next);
}

function reveal(phase, animated) {
  const p = cube.puzzle;
  for (const [cell, node] of cube.cells) {
    const open = p.phaseOf(cell) <= phase, wasOpen = p.phaseOf(cell) <= cube.shownPhase;
    if (!cube.shownPath.includes(cell)) node.material = open ? pearlMat : hiddenMat;
    if (open && !cube.labels.has(cell)) {
      const s = new THREE.Sprite(labelMaterial(p.tiles[cell], true));
      s.renderOrder = 20;
      s.userData.size = p.n >= 5 ? 0.34 : 0.38;
      scene.add(s);
      cube.labels.set(cell, s);
    }
    if (open && !wasOpen && animated) {
      // Newly revealed letters pop in, rippling out from the corner.
      const [x, y, z] = p.coords(cell);
      tween(node, [{ wait: (x + y + z) * 0.05 }, { to: 1.12, dur: 0.18 }, { to: 1, dur: 0.14 }], 0.3);
    }
  }
  cube.shownPhase = phase;
}

function showPath(path) {
  const p = cube.puzzle;
  for (const cell of cube.shownPath) {
    if (path.includes(cell)) continue;
    const node = cube.cells.get(cell);
    node.material = p.phaseOf(cell) <= cube.shownPhase ? pearlMat : hiddenMat;
    const l = cube.labels.get(cell);
    if (l) l.material = labelMaterial(p.tiles[cell], true);
    tween(node, [{ to: 1, dur: 0.12 }]);
  }
  for (const cell of path) {
    cube.cells.get(cell).material = selectedMat;
    const l = cube.labels.get(cell);
    if (l) l.material = labelMaterial(p.tiles[cell], false);
  }
  const last = path.at(-1);
  if (last !== undefined && last !== cube.shownPath.at(-1)) tween(cube.cells.get(last), [{ to: 1.15, dur: 0.1 }, { to: 1.06, dur: 0.12 }]);
  // An earlier letter that used to be last settles back.
  const prevLast = cube.shownPath.at(-1);
  if (prevLast !== undefined && prevLast !== last && path.includes(prevLast)) tween(cube.cells.get(prevLast), [{ to: 1, dur: 0.12 }]);
  cube.shownPath = [...path];
  for (const l of cube.links) pivot.remove(l);
  cube.links = path.slice(1).map((c, k) => makeLink(path[k], c, 0.045, linkMat));
}

const linkGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
function makeLink(a, b, radius, material) {
  const m = new THREE.Mesh(linkGeo, material);
  m.userData = { a, b, radius };
  placeLink(m);
  pivot.add(m);
  return m;
}
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
function placeLink(m) {
  localPos(m.userData.a, tmpA); localPos(m.userData.b, tmpB);
  m.position.copy(tmpA).add(tmpB).multiplyScalar(0.5);
  const len = tmpA.distanceTo(tmpB);
  m.quaternion.setFromUnitVectors(up, tmpB.sub(tmpA).normalize());
  m.scale.set(m.userData.radius, len, m.userData.radius);
}

function showNext(next) {
  for (const r of cube.rings) scene.remove(r);
  cube.rings = [...next].map((cell) => {
    const s = new THREE.Sprite(ringMat);
    s.userData.cell = cell;
    s.renderOrder = 15;
    scene.add(s);
    return s;
  });
  cube.shownNext = new Set(next);
}

/** Found a word: the path flashes bright and the letters pop in sequence. */
function flash(path) {
  if (path.length < 2) return;
  const mat = new THREE.MeshBasicMaterial({ color: flashColor, transparent: true, toneMapped: false });
  const links = path.slice(1).map((c, k) => makeLink(path[k], c, 0.06, mat));
  cube.flashes.push({ links, mat, t0: clock() });
  path.forEach((cell, k) => tween(cube.cells.get(cell), [{ wait: 0.05 * k }, { to: 1.22, dur: 0.12 }, { to: 1, dur: 0.2 }], 1));
}

// ── per frame ──
const camLocal = new THREE.Vector3(), wp = new THREE.Vector3(), dir = new THREE.Vector3();
let velocity = new THREE.Vector2(), autoSpin = false, tickAccum = 0;
function frame() {
  const now = clock();
  if (velocity.lengthSq() > 4e-8) { rotate(velocity.x, velocity.y); velocity.multiplyScalar(0.95); }
  if (autoSpin && !reduceMotion) rotate(0.0022, 0, false);
  if (Math.abs(spacing - targetSpacing) > 0.0005) {
    spacing += (targetSpacing - spacing) * 0.2;
    if (cube.puzzle) { layoutLayers(); for (const l of cube.links) placeLink(l); for (const f of cube.flashes) f.links.forEach(placeLink); }
  }
  for (const node of cube.cells.values()) stepTween(node, now);
  pivot.updateMatrixWorld(true);
  // Labels sit on the camera-facing surface of their pearl, so the pearl never hides them.
  for (const [cell, s] of cube.labels) {
    const node = cube.cells.get(cell);
    node.getWorldPosition(wp);
    dir.copy(camera.position).sub(wp).normalize();
    const k = node.scale.x;
    s.position.copy(wp).addScaledVector(dir, cube.radius * 1.02 * k);
    s.scale.setScalar(s.userData.size * k);
  }
  const pulse = 0.625 + 0.275 * Math.cos(now * Math.PI / 0.6);
  ringMat.opacity = reduceMotion ? 0.8 : pulse;
  for (const r of cube.rings) {
    const node = cube.cells.get(r.userData.cell);
    node.getWorldPosition(r.position);
    r.scale.setScalar(0.36 * 2 * (64 / 58));
  }
  for (const f of [...cube.flashes]) {
    const t = now - f.t0;
    f.mat.opacity = t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.5);
    if (t > 0.85) { f.links.forEach((l) => pivot.remove(l)); f.mat.dispose(); cube.flashes.splice(cube.flashes.indexOf(f), 1); }
  }
  renderer.render(scene, camera);
}

const axis = new THREE.Vector3(), dq = new THREE.Quaternion();
function rotate(dx, dy, ticks = true) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-5) return;
  axis.set(dy, dx, 0).normalize();
  orientation.premultiply(dq.setFromAxisAngle(axis, len)).normalize();
  pivot.quaternion.copy(orientation);
  if (ticks) { tickAccum += len; if (tickAccum > Math.PI / 6) { tickAccum = 0; sound.tick(); } }
}

/** Fit the cube into the free band between `top` and `bottom` (CSS px). */
let band = () => ({ top: 0, bottom: innerHeight });
function frameCamera() {
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  const { top, bottom } = band();
  const availH = Math.max(120, bottom - top), centre = (top + bottom) / 2;
  camera.setViewOffset(W, H, 0, H / 2 - centre, W, H);
  const n = cube.puzzle?.n ?? 4;
  // Radius of the spinning cube (layers at their widest closed spacing) with a little air.
  const R = 0.5 * Math.hypot(n * PITCH, n * PITCH, n * SPREAD.closed) * 0.82;
  const f = (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = (R * f) / (Math.min(availH, W - 24) / 2) + R * 0.15;
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}
addEventListener("resize", frameCamera);

// Picking: the nearest revealed letter to the pointer ray (taps pass through hidden ones).
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(clientX, clientY) {
  if (!cube.puzzle) return -1;
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = -1, bestT = Infinity;
  for (const [cell, node] of cube.cells) {
    if (cube.puzzle.phaseOf(cell) > cube.shownPhase) continue;
    node.getWorldPosition(wp);
    if (ray.ray.distanceSqToPoint(wp) > 0.36 * 0.36) continue;
    const t = wp.sub(ray.ray.origin).dot(ray.ray.direction);
    if (t < bestT) { bestT = t; best = cell; }
  }
  return best;
}

// Gestures: one finger spins (with inertia), two fingers pinch the layers apart, a quick tap picks.
const pointers = new Map();
let down = null, pinch = null, lastMove = null;
let onTapCell = () => {};
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  velocity.set(0, 0);
  autoSpin = false;
  if (pointers.size === 1) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; lastMove = { x: e.clientX, y: e.clientY, t: performance.now() }; }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), start: targetSpacing };
    down = null;
  }
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) {
    if (e.pointerType === "mouse" && cube.interactive) canvas.style.cursor = pick(e.clientX, e.clientY) >= 0 ? "pointer" : "grab";
    return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    setSpacing(pinch.start * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d));
    return;
  }
  if (!cube.interactive) return;
  rotate(dx * 0.0085, dy * 0.0085);
  const t = performance.now(), dt = Math.max(8, t - lastMove.t);
  velocity.set((dx * 0.0085) * (16.7 / dt), (dy * 0.0085) * (16.7 / dt));
  lastMove = { x: e.clientX, y: e.clientY, t };
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size < 2) pinch = null;
  if (performance.now() - (lastMove?.t ?? 0) > 80) velocity.set(0, 0);
  if (!down || pointers.size) { if (!pointers.size) down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 600;
  down = null;
  if (e.type === "pointerup" && moved < 8 && quick && cube.interactive) {
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
  $("spreadBtn")?.setAttribute("aria-pressed", String(targetSpacing > 1.6));
}

/* ───────────────────────────── puzzle book + progress ───────────────────────────── */

const loadProgress = (kind) => { try { return JSON.parse(store.get(progressKey(kind)) || "null"); } catch { return null; } };
const saveProgress = (kind, p) => store.set(progressKey(kind), JSON.stringify(p));
const practiceIndex = (n) => Math.max(0, Number.parseInt(store.get(`ttc.wc-pi${n}`) || "0", 10) || 0);
const fmt = (d, opts) => d.toLocaleDateString(undefined, opts);

/** ?b=d12 → daily 12 · ?b=p4-7 → 4×4×4 practice board 8. Future dailies fall back to today. */
function kindFromURL(book) {
  const b = new URLSearchParams(location.search).get("b") || "";
  let m = b.match(/^d(\d+)$/);
  if (m) return { daily: Math.min(+m[1], book.today()) };
  if (b === "daily") return { daily: book.today() };
  m = b.match(/^p([345])-(\d+)$/);
  if (m) return { size: +m[1], index: +m[2] % Math.max(1, book.practiceCount(+m[1])) };
  return null;
}
const boardParam = (kind) => ("daily" in kind ? `d${kind.daily}` : `p${kind.size}-${kind.index}`);

/* ───────────────────────────── hub ───────────────────────────── */

function bootHub(book) {
  $("hub").hidden = false;
  document.title = "Word Cube · Tic Tac Cube";
  const day = book.today();
  const kind = { daily: day };
  const prog = loadProgress(kind);
  const total = book.puzzle(kind)?.wordCount ?? 0;
  $("dailyCard").href = `?b=${boardParam(kind)}`;
  $("dailyDate").textContent = fmt(book.dateOfDay(day), { weekday: "long", month: "long", day: "numeric" });
  if (prog?.found?.length) $("dailyLine").textContent = `${prog.found.length} of ${total} words found`;
  $("dailyGoLabel").textContent = prog ? "Continue" : "Play";

  const list = $("practice");
  const renderPractice = () => {
    list.replaceChildren(...[3, 4, 5].map((n) => {
      const index = practiceIndex(n), k = { size: n, index };
      const found = loadProgress(k)?.found?.length ?? 0;
      const li = document.createElement("li");
      li.innerHTML = `<a href="?b=${boardParam(k)}"><span><b>${n}×${n}×${n} · ${SIZE_LABEL[n]}</b>
        <small>Board ${index + 1} · ${found} of ${book.puzzle(k)?.wordCount ?? 0} words</small></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        <button class="icon-btn" type="button" aria-label="Next ${n} by ${n} board" title="Next board">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12m-4-5 5 5-5 5M20 5v14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      li.querySelector("button").addEventListener("click", () => {
        store.set(`ttc.wc-pi${n}`, String((index + 1) % Math.max(1, book.practiceCount(n))));
        sound.letter(0);
        renderPractice();
      });
      return li;
    }));
  };
  renderPractice();

  // Today's cube spins quietly in the band above the title (first wave only: nothing to spoil).
  const p = book.puzzle(kind);
  if (p) {
    buildCube(p);
    syncCube({ phase: 0, path: [], next: new Set() });
  }
  cube.interactive = false;
  autoSpin = true;
  band = () => {
    // Matches .home-inner's top padding: the cube floats above the title.
    const top = 16;
    return { top, bottom: top + Math.min(innerHeight * 0.38, 340) };
  };
  frameCamera();
  $("hub").addEventListener("scroll", () => {
    canvas.style.opacity = String(Math.max(0, 1 - $("hub").scrollTop / 220));
  }, { passive: true });
  // Coming back via the browser's back button should show fresh progress.
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
}

/* ───────────────────────────── play ───────────────────────────── */

function bootPlay(book, kind) {
  const puzzle = book.puzzle(kind);
  if (!puzzle) { location.replace("words.html"); return; }
  $("play").hidden = false;
  buildCube(puzzle);
  const title = "daily" in kind
    ? `Daily · ${fmt(book.dateOfDay(kind.daily), { month: "short", day: "numeric" })}`
    : `${kind.size}×${kind.size}×${kind.size} · Board ${kind.index + 1}`;
  $("boardTitle").textContent = title;
  document.title = `${title} · Word Cube`;
  if (!("daily" in kind)) store.set(`ttc.wc-pi${kind.size}`, String(kind.index));

  const game = new WordGame(puzzle, loadProgress(kind) ?? emptyProgress(), {
    onSave: (p) => saveProgress(kind, p),
    onCue: (cue, a, b) => {
      if (cue === "letter") { sound.letter(a); haptic(6); }
      else if (cue === "undo") sound.undo(a);
      else if (cue === "word") { sound.word(a, b); haptic(18); }
      else if (cue === "wrong") { sound.wrong(); haptic([12, 40, 12]); }
      else if (cue === "already") sound.already();
      else if (cue === "reveal") setTimeout(() => sound.reveal(), 450); // follows the word chord
    },
  });
  // Mark the board as started so the hub says "Continue".
  if (!loadProgress(kind)) saveProgress(kind, game.progress);

  band = () => ({ top: $("play").querySelector(".wc-top").getBoundingClientRect().bottom + 8, bottom: $("play").querySelector(".wc-bottom").getBoundingClientRect().top - 4 });
  frameCamera();
  new ResizeObserver(frameCamera).observe($("play").querySelector(".wc-head"));

  // Rank ticks along the bar, with Genius near the end.
  const barPos = (share) => Math.min(1, share / 0.7 * 0.92);
  for (const r of RANKS.slice(1)) {
    const t = document.createElement("span");
    t.className = "wc-tick"; t.style.left = `${barPos(r.share) * 100}%`; t.dataset.share = r.share;
    $("rankBar").append(t);
  }

  let lastRank = game.rankName, lastScore = game.score;
  function render() {
    syncCube({ phase: game.unlockedPhase, path: game.path, next: game.validNext });
    $("rank").textContent = game.rankName;
    $("score").textContent = game.score;
    if (game.score !== lastScore) { const s = $("score"); s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump"); lastScore = game.score; }
    $("rankFill").style.width = `max(8px, ${barPos(game.share) * 100}%)`;
    for (const t of $("rankBar").querySelectorAll(".wc-tick")) t.classList.toggle("on", game.share >= +t.dataset.share);
    $("rankBar").setAttribute("aria-label", `Rank ${game.rankName}, ${Math.floor(game.share * 100)} percent of points`);
    $("wordCount").textContent = `${game.foundCount} of ${game.totalWords} words`;
    const left = game.wordsToNextPhase;
    $("phaseHint").textContent = left == null ? "" : left === 1 ? "1 more word reveals more" : `${left} more words reveal more`;
    $("phase").querySelectorAll(".wc-dot").forEach((d, k) => { d.classList.toggle("on", k <= game.unlockedPhase); d.classList.toggle("now", k === game.unlockedPhase); });
    $("phase").setAttribute("aria-label", `Phase ${game.unlockedPhase + 1} of 3`);
    renderLetters();
    const ok = game.currentWord.length >= puzzle.minLength;
    $("enterBtn").disabled = !ok;
    $("clearBtn").disabled = !game.path.length;
  }
  const hint = $("lettersHint");
  let shownLetters = [];
  function renderLetters() {
    const box = $("letters"), path = game.path;
    if (!path.length) { box.replaceChildren(hint); box.removeAttribute("aria-label"); shownLetters = []; return; }
    // Keep existing tiles in place (so only new letters pop in).
    const keep = shownLetters.length <= path.length && shownLetters.every((c, i) => c === path[i]) ? shownLetters.length : 0;
    if (!keep) box.replaceChildren();
    else while (box.children.length > keep) box.lastChild.remove();
    for (const cell of path.slice(keep)) {
      const t = document.createElement("span");
      const s = puzzle.tiles[cell];
      t.className = "wc-tile"; t.textContent = s === "qu" ? "Qu" : s.toUpperCase();
      box.append(t);
    }
    box.setAttribute("aria-label", `Current word: ${game.currentWord.toUpperCase()}`);
    shownLetters = [...path];
  }
  let toastTimer = 0;
  function toast(text) {
    const t = $("toast");
    t.hidden = false; t.classList.remove("out");
    t.textContent = text;
    t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.add("out"); toastTimer = setTimeout(() => (t.hidden = true), 260); }, 1800);
  }

  function submit() {
    if (!game.path.length) return;
    const f = game.submit();
    if (f.kind === "found" || f.kind === "phaseUnlocked") flash(f.path);
    const text = {
      found: () => (f.bonus ? `+${f.points} · through every layer!` : f.points >= 6 ? `+${f.points} · Brilliant!` : `+${f.points}`),
      already: () => `Already found ${f.word.toUpperCase()}`,
      notAWord: () => `${f.word.toUpperCase()} isn’t in the list`,
      tooShort: () => `Words need ${puzzle.minLength}+ letters`,
      phaseUnlocked: () => "New letters revealed ✨",
    }[f.kind]();
    toast(text);
    render();
    // Every new rank gets a little fanfare; Genius (or every word) also shows the share card.
    const now = game.rankName;
    if (now !== lastRank) {
      setTimeout(() => sound.rankUp(), 700);
      if (now === "Genius" || now === "Cubed") setTimeout(openDone, 900);
    }
    lastRank = now;
  }

  onTapCell = (cell) => { game.tap(cell); render(); };
  $("clearBtn").addEventListener("click", () => { game.clear(); render(); });
  $("enterBtn").addEventListener("click", submit);
  $("spreadBtn").addEventListener("click", () => { setSpacing(targetSpacing > 1.6 ? SPREAD.closed : SPREAD.open); sound.tick(); });
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (!$("wordsSheet").hidden) return closeSheet($("wordsSheet"));
      if (!$("done").hidden) return closeSheet($("done"));
      game.clear(); render();
    }
    if (!$("wordsSheet").hidden || !$("done").hidden) return;
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); submit(); }
    else if (e.key === "Backspace") { e.preventDefault(); game.backspace(); render(); }
  });

  // ── sheets ──
  let lastFocus = null;
  function openSheet(el) {
    lastFocus = document.activeElement;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("open"));
    el.querySelector(".btn.ghost")?.focus({ preventScroll: true });
  }
  function closeSheet(el) {
    el.classList.remove("open");
    setTimeout(() => (el.hidden = true), reduceMotion ? 0 : 220);
    lastFocus?.focus?.({ preventScroll: true });
  }
  for (const el of [$("wordsSheet"), $("done")]) el.addEventListener("click", (e) => { if (e.target === el) closeSheet(el); });
  $("wordsDone").addEventListener("click", () => closeSheet($("wordsSheet")));
  $("doneClose").addEventListener("click", () => closeSheet($("done")));

  $("wordsBtn").addEventListener("click", () => {
    $("wordsTally").textContent = `${game.foundCount} / ${game.totalWords}`;
    const all = Object.keys(puzzle.words);
    const lengths = [...new Set(all.map((w) => w.length))].sort((a, b) => a - b);
    $("wordsList").replaceChildren(...lengths.map((len) => {
      // Spelling Bee-style hint: how many words of each length remain.
      const found = game.progress.found.filter((w) => w.length === len).sort();
      const total = all.filter((w) => w.length === len).length;
      const sec = document.createElement("section");
      sec.className = "wc-len";
      const h = document.createElement("h3");
      h.textContent = `${len} letters · ${found.length} of ${total}`;
      const chips = document.createElement("div");
      chips.className = "wc-chips";
      for (const w of found) {
        const c = document.createElement("span");
        c.className = "wc-chip" + (game.progress.bonus.includes(w) ? " bonus" : "");
        c.textContent = w.toUpperCase();
        if (game.progress.bonus.includes(w)) c.title = `Through every layer · +${LAYER_BONUS}`;
        chips.append(c);
      }
      for (let k = found.length; k < total; k++) {
        const c = document.createElement("span");
        c.className = "wc-chip blank"; c.style.width = `${len * 11 + 20}px`; c.setAttribute("aria-hidden", "true");
        chips.append(c);
      }
      sec.append(h, chips);
      return sec;
    }));
    openSheet($("wordsSheet"));
  });

  function openDone() {
    drawShare($("shareCanvas"), game);
    const next = game.nextRank;
    $("nextRank").textContent = next && !game.isCubed
      ? `${Math.ceil(next.share * game.maxPoints) - game.score} more points to ${next.name}` : "";
    openSheet($("done"));
  }
  $("shareBtn").addEventListener("click", openDone);
  $("shareGo").addEventListener("click", () => share(game, kind));

  render();
}

/* ───────────────────────────── share card ───────────────────────────── */

function caption(kind) { return "daily" in kind ? `WORD CUBE · DAILY #${kind.daily + 1}` : `WORD CUBE · ${kind.size}×${kind.size}×${kind.size}`; }

/** Rank, words, points, and the path of your best word through the cube, drawn without letters so it never spoils the puzzle. */
function drawShare(cv, game) {
  const g = cv.getContext("2d"), S = cv.width, u = S / 600;
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, "#1a1c45"); bg.addColorStop(1, "#0a0f21");
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  const font = (w, px) => `${w} ${px * u}px ui-rounded, "SF Pro Rounded", Inter, system-ui, sans-serif`;
  g.fillStyle = "rgb(255 255 255 / 0.6)"; g.font = font(600, 20);
  g.fillText(caption(game.puzzle.kind), S / 2, 62 * u);
  g.fillStyle = "#fff"; g.font = font(800, 54);
  g.fillText(game.rankName, S / 2, 124 * u);
  g.fillStyle = "rgb(255 255 255 / 0.75)"; g.font = font(500, 24);
  g.fillText(`${game.foundCount}/${game.totalWords} words · ${game.score} pts`, S / 2, 164 * u);

  // Isometric projection of the letter cells.
  const p = game.puzzle, n = p.n;
  const box = { x: 30 * u, y: 190 * u, w: S - 60 * u, h: S - 220 * u };
  const unit = Math.min(box.w, box.h) / (n * 2.1);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const project = (cell) => {
    const [x, y, z] = p.coords(cell), m = (n - 1) / 2;
    const fx = x - m, fy = y - m, fz = z - m;
    return [cx + (fx - fz) * unit * 0.87, cy + (fx + fz) * unit * 0.5 - fy * unit * 1.05];
  };
  g.fillStyle = "rgb(255 255 255 / 0.22)";
  for (let c = 0; c < p.cells; c++) {
    if (p.tiles[c] == null) continue;
    const [x, y] = project(c);
    g.beginPath(); g.arc(x, y, 2.5 * u * 1.4, 0, Math.PI * 2); g.fill();
  }
  const path = game.progress.bestPath;
  if (path.length > 1) {
    g.lineCap = g.lineJoin = "round";
    const stroke = (w, style) => {
      g.beginPath();
      path.forEach((c, k) => { const [x, y] = project(c); k ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.lineWidth = w; g.strokeStyle = style; g.stroke();
    };
    stroke(9 * u * 1.4, `color-mix(in srgb, ${accentHex} 35%, transparent)`);
    stroke(3.5 * u * 1.4, accentHex);
    path.forEach((c, k) => {
      const [x, y] = project(c);
      g.fillStyle = k === 0 ? "#fff" : accentHex;
      g.beginPath(); g.arc(x, y, (k === 0 ? 7 : 5) * u * 1.4, 0, Math.PI * 2); g.fill();
    });
  }
}

async function share(game, kind) {
  const url = `${location.origin}${location.pathname}`;
  const text = `${caption(kind).replace("WORD CUBE", "Word Cube").replace("DAILY", "Daily")}: ${game.rankName} · ${game.foundCount}/${game.totalWords} words · ${game.score} pts`;
  const blob = await new Promise((r) => $("shareCanvas").toBlob(r, "image/png"));
  const file = blob && new File([blob], "word-cube.png", { type: "image/png" });
  try {
    if (file && navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], text: `${text}\n${url}` });
    if (navigator.share) return await navigator.share({ text, url });
  } catch (err) {
    if (err?.name === "AbortError") return;
  }
  // Desktop fallback: copy the summary and download the card.
  try { await navigator.clipboard.writeText(`${text}\n${url}`); } catch {}
  if (blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "word-cube.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const t = $("toast");
  if (t) { t.hidden = false; t.classList.remove("out"); t.textContent = "Copied, and the card is downloading"; setTimeout(() => t.classList.add("out"), 2200); }
}

/* ───────────────────────────── boot ───────────────────────────── */

function setSoundUI() {
  const b = $("soundToggle");
  b.setAttribute("aria-pressed", String(sound.on));
  b.setAttribute("aria-label", sound.on ? "Sound on" : "Sound off");
}
$("soundToggle").addEventListener("click", () => {
  sound.on = !sound.on; store.set("ttc.sound", sound.on ? "1" : "0"); setSoundUI();
  if (sound.on) { sound.unlock(); sound.tick(); }
});
setSoundUI();

async function boot() {
  frameCamera();
  renderer.setAnimationLoop(frame);
  let book;
  try {
    const res = await fetch("puzzles.json");
    if (!res.ok) throw new Error(res.statusText);
    book = makeBook(await res.json());
  } catch (err) {
    console.warn(err);
    $("hub").hidden = false;
    $("dailyLine").textContent = "Couldn’t load today’s cube. Check your connection and reload.";
    return;
  }
  const kind = kindFromURL(book);
  if (kind) bootPlay(book, kind); else bootHub(book);
  window.__wc = { book, cube, camera }; // for tests and debugging
}
boot();
