import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CONFIG } from "./config.js";
import {
  geometry, fold, roleOf, PRESETS, PALETTE, hexOf, resolveColors, sortEvents,
  boardAt, threats, describeLine, starterFor, SIZES,
} from "./game.js";
import { decide, LEVELS, BANTER } from "./ai.js";

const params = new URLSearchParams(location.search);
const GAME_ID = (params.get("g") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
const SEAT2 = params.get("seat") === "2"; // testing: second seat with the same Apple Account
const DEMO = params.has("demo"); // old link: same as ?play=local
// ?play=ai → against the computer, ?play=local → two players on this device (no account for either).
const PLAY = GAME_ID ? null : DEMO || params.get("play") === "local" ? "local" : params.get("play") === "ai" ? "ai" : null;
const HOST_SIZE = Number(params.get("host")) || 0; // set when this browser just created the game
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ───────────────────────────── sound ───────────────────────────── */

// Small glass-bell synth: inharmonic partials, quick decay. Starts on first gesture.
const sound = {
  ctx: null, master: null,
  on: store.get("ttc.sound") !== "0",
  unlock() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 6500;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(lp).connect(this.ctx.destination);
  },
  bell(freq, { gain = 0.5, dur = 1.1, at = 0 } = {}) {
    if (!this.on || !this.ctx) return;
    const t0 = this.ctx.currentTime + 0.005 + at;
    const partials = [[1, 1], [2.76, 0.32], [5.4, 0.14], [8.93, 0.05]];
    for (const [ratio, g] of partials) {
      const o = this.ctx.createOscillator();
      const v = this.ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq * ratio;
      const d = dur / Math.sqrt(ratio);
      v.gain.setValueAtTime(0, t0);
      v.gain.linearRampToValueAtTime(gain * g, t0 + 0.004);
      v.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(v).connect(this.master);
      o.start(t0); o.stop(t0 + d + 0.05);
    }
  },
  tick() { this.bell(1760, { gain: 0.12, dur: 0.18 }); },
  place(layer, n) {
    // Pentatonic, rising with the layer.
    const steps = [0, 2, 4, 7, 9];
    const semis = steps[layer % 5] + (n === 3 ? 2 : 0);
    this.bell(392 * Math.pow(2, semis / 12), { gain: 0.55, dur: 1.3 });
  },
  win() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.bell(f, { gain: 0.45, dur: 1.6, at: i * 0.09 })); },
  lose() { this.bell(440, { gain: 0.4, dur: 1.2 }); this.bell(329.63, { gain: 0.4, dur: 1.6, at: 0.16 }); },
};
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => sound.unlock(), { capture: true });

/* ───────────────────────────── 3-D board ───────────────────────────── */

const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
const CAM_DIR = new THREE.Vector3(8.2, 6.6, 9.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.8;
controls.enablePan = false;
controls.autoRotateSpeed = 0.6;

const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(5, 9, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x7f9cff, 0.8);
rim.position.set(-6, 2, -7);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0b1030, 0.45));

const board = new THREE.Group();
scene.add(board);

const GAP = 1.0;
let N = 4;
let G = geometry(N);
let spread = 0.25;
const mid = () => (N - 1) / 2;
const layerGap = () => 1.0 + spread * 1.8;
function cellPos(i, out = new THREE.Vector3()) {
  const [x, y, z] = G.coords(i);
  return out.set((x - mid()) * GAP, (y - mid()) * layerGap(), (z - mid()) * GAP);
}

// Dark tinted glass: normal blending, low opacity, faint reflections — never blows out.
const plateMat = new THREE.MeshStandardMaterial({
  color: 0x5b6fb8, transparent: true, opacity: 0.08, roughness: 0.35, metalness: 0,
  envMapIntensity: 0.15, depthWrite: false, side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fb2ec, transparent: true, opacity: 0.12, depthWrite: false });
const slotGeo = new THREE.SphereGeometry(0.085, 20, 14);
const slotMat = () => new THREE.MeshStandardMaterial({
  color: 0xc9d3f5, emissive: 0x6f84d6, emissiveIntensity: 0.18, transparent: true, opacity: 0.4, roughness: 0.35,
});

let plates = [];
let slots = [];
function buildBoard(n) {
  for (const o of [...plates, ...slots]) { board.remove(o); o.geometry !== slotGeo && o.geometry?.dispose(); }
  for (const p of pieces.values()) board.remove(p);
  pieces.clear();
  N = n; G = geometry(n);
  const side = n * GAP + 0.15;
  const plateGeo = new THREE.BoxGeometry(side, 0.03, side);
  plates = [];
  for (let y = 0; y < n; y++) {
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.renderOrder = 1;
    plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(plateGeo), edgeMat));
    board.add(plate);
    plates.push(plate);
  }
  slots = [];
  for (let i = 0; i < G.cells; i++) {
    const m = new THREE.Mesh(slotGeo, slotMat());
    board.add(m);
    slots.push(m);
  }
  const scale = n / 4;
  camera.position.copy(CAM_DIR).multiplyScalar(scale);
  controls.target.set(0, -0.9 * scale, 0);
  controls.minDistance = 7 * scale;
  controls.maxDistance = 20 * scale;
  controls.update();
}

// Pieces
const pieceGeo = new THREE.SphereGeometry(0.31, 48, 32);
const roleColor = { X: new THREE.Color(hexOf("coral")), O: new THREE.Color(hexOf("teal")) };
const pieceMats = {
  X: new THREE.MeshPhysicalMaterial({ color: roleColor.X, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 }),
  O: new THREE.MeshPhysicalMaterial({ color: roleColor.O, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 }),
};
const pieces = new Map(); // cell -> Object3D (a sphere mesh, or an X / O group)

// Piece style is a per-browser look preference ("orbs" | "xo"); it never touches the protocol.
let pieceStyle = store.get("ttc.pieces") === "xo" ? "xo" : "orbs";

// X = two crossed capsules, O = a torus — same sizes as iOS. Both lie in the XY plane and are
// turned to face the camera every frame, so they read as X and O from any spin angle.
const shapeCache = new Map();
function xoShapes(n) {
  const key = n >= 5 ? 5 : 4;
  if (!shapeCache.has(key)) {
    const big = key === 4;
    const len = big ? 0.62 : 0.56, r = big ? 0.085 : 0.075;
    const bar = new THREE.CapsuleGeometry(r, len - 2 * r, 8, 24);
    const ring = new THREE.TorusGeometry(big ? 0.24 : 0.21, big ? 0.075 : 0.065, 24, 72);
    shapeCache.set(key, { bar, ring });
  }
  return shapeCache.get(key);
}

/** One piece in the current style. `.material` is always the single shared material of its parts. */
function makePiece(mark, material) {
  if (pieceStyle === "orbs") return new THREE.Mesh(pieceGeo, material);
  const { bar, ring } = xoShapes(N);
  const g = new THREE.Group();
  if (mark === "X") {
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const m = new THREE.Mesh(bar, material);
      m.rotation.z = a;
      g.add(m);
    }
  } else g.add(new THREE.Mesh(ring, material));
  g.material = material;
  return g;
}

const ghostMat = new THREE.MeshPhysicalMaterial({
  color: roleColor.X, transparent: true, opacity: 0.45, roughness: 0.2, clearcoat: 1, depthWrite: false,
});
let ghost = makePiece("X", ghostMat);
let ghostMark = "X";
ghost.visible = false;
board.add(ghost);
function rebuildGhost(mark) {
  const visible = ghost.visible;
  board.remove(ghost);
  ghost = makePiece(mark, ghostMat);
  ghostMark = mark;
  ghost.visible = visible;
  board.add(ghost);
}

/** Switch orbs ↔ X & O; rebuilds every piece in place. */
function setPieceStyle(style) {
  if (style === pieceStyle) return;
  pieceStyle = style;
  store.set("ttc.pieces", style);
  rebuildGhost(ghostMark);
  for (const p of pieces.values()) board.remove(p);
  pieces.clear();
  syncBoard({ ...view, instant: true });
  for (const id of ["homePieces", "menuPieces"]) {
    for (const input of $(id)?.querySelectorAll("input") ?? []) input.checked = input.value === style;
  }
}

const ringGeo = new THREE.RingGeometry(0.4, 0.43, 64);
const ring = new THREE.Mesh(ringGeo,
  new THREE.MeshBasicMaterial({ color: 0xdfe6ff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
ring.visible = false;
board.add(ring);

// Threat rings (pooled)
const threatRings = [];
function threatRing(k) {
  while (threatRings.length <= k) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.4, 48),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    r.visible = false;
    board.add(r);
    threatRings.push(r);
  }
  return threatRings[k];
}

// A thin, restrained line of light through the winning pieces.
const beam = new THREE.Group();
const beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 12, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }));
const beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 16, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }));
beam.add(beamCore, beamGlow);
beam.visible = false;
board.add(beam);

let view = { board: [], lastMove: null, winLine: null, winner: null };
let hover = -1;
let preview = -1;
let beamBorn = 0;
let showThreats = store.get("ttc.threats") === "1";
let threatCells = new Map();

function syncBoard(v) {
  view = v;
  for (let i = 0; i < G.cells; i++) {
    const mark = v.board[i];
    let p = pieces.get(i);
    if (mark && (!p || p.userData.mark !== mark || p.userData.n !== N)) {
      if (p) board.remove(p);
      p = makePiece(mark, pieceMats[mark].clone());
      p.userData = { cell: i, mark, n: N, born: v.instant ? -1e9 : performance.now() };
      board.add(p);
      pieces.set(i, p);
    } else if (!mark && p) {
      board.remove(p);
      pieces.delete(i);
    }
    slots[i].visible = !mark;
  }
  if (preview >= 0 && v.board[preview]) setPreview(-1);
  if (v.winLine && !beam.visible) { beam.visible = true; beamBorn = performance.now(); }
  if (!v.winLine) beam.visible = false;
  threatCells = showThreats && !v.winner ? threats(v.board, N) : new Map();
}

function setColors(colors) {
  roleColor.X.set(hexOf(colors.X));
  roleColor.O.set(hexOf(colors.O));
  pieceMats.X.color.copy(roleColor.X);
  pieceMats.O.color.copy(roleColor.O);
  for (const p of pieces.values()) p.material.color.copy(roleColor[p.userData.mark]);
  document.documentElement.style.setProperty("--cx", hexOf(colors.X));
  document.documentElement.style.setProperty("--co", hexOf(colors.O));
}

function setPreview(i, mark) {
  const changed = i !== preview;
  preview = i;
  if (i >= 0 && pieceStyle === "xo" && mark !== ghostMark) rebuildGhost(mark);
  ghost.visible = i >= 0;
  if (i >= 0) ghost.material.color.copy(roleColor[mark]);
  if (changed && i >= 0) sound.tick();
  ui.onPreviewChanged?.();
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const black = new THREE.Color(0);
function layout(now) {
  plates.forEach((pl, y) => pl.position.set(0, (y - mid()) * layerGap() - 0.34, 0));
  for (let i = 0; i < G.cells; i++) {
    cellPos(i, slots[i].position);
    const target = i === hover && !view.board[i] ? 1.9 : 1;
    const s = slots[i].scale.x + (target - slots[i].scale.x) * 0.25;
    slots[i].scale.setScalar(s);
    slots[i].material.opacity = i === hover ? 0.85 : 0.4;
  }
  const pulse = reduceMotion ? 0 : Math.sin(now / 320);
  const face = pieceStyle === "xo"; // billboard X and O toward the camera (the board itself never rotates)
  for (const p of pieces.values()) {
    cellPos(p.userData.cell, p.position);
    if (face) p.quaternion.copy(camera.quaternion);
    const t = Math.min(1, (now - p.userData.born) / 420);
    const e = reduceMotion ? 1 : easeOutBack(t);
    const win = view.winLine?.includes(p.userData.cell);
    p.scale.setScalar(Math.max(0.001, e) * (win ? 1 + 0.045 * pulse : 1));
    p.position.y += (1 - easeOutCubic(t)) * (reduceMotion ? 0 : 0.6);
    p.material.emissive.copy(win ? roleColor[p.userData.mark] : black);
    p.material.emissiveIntensity = win ? 0.16 + 0.08 * pulse : 0;
  }
  if (preview >= 0) {
    cellPos(preview, ghost.position);
    if (face) ghost.quaternion.copy(camera.quaternion);
    ghost.scale.setScalar(0.92 + 0.05 * Math.sin(now / 160));
  }
  if (view.lastMove != null && !view.winLine) {
    ring.visible = true;
    cellPos(view.lastMove, ring.position);
    ring.quaternion.copy(camera.quaternion);
    const k = reduceMotion ? 0.3 : (now % 1600) / 1600;
    ring.scale.setScalar(1 + k * 0.45);
    ring.material.opacity = 0.45 * (1 - k);
  } else ring.visible = false;

  // Threat rings: one per (cell, role).
  let k = 0;
  for (const [cell, roles] of threatCells) {
    let j = 0;
    for (const role of roles) {
      const r = threatRing(k++);
      r.visible = true;
      cellPos(cell, r.position);
      r.quaternion.copy(camera.quaternion);
      r.scale.setScalar(1 + j * 0.18 + (reduceMotion ? 0 : 0.04 * Math.sin(now / 260)));
      r.material.color.copy(roleColor[role]);
      r.material.opacity = 0.55;
      j++;
    }
  }
  for (; k < threatRings.length; k++) threatRings[k].visible = false;

  if (beam.visible && view.winLine) {
    const line = view.winLine.map((c) => cellPos(c, new THREE.Vector3()));
    const a = line[0], b = line[line.length - 1];
    tmpV.subVectors(b, a);
    const len = tmpV.length() + 0.7;
    const grow = reduceMotion ? 1 : easeOutCubic(Math.min(1, (now - beamBorn) / 650));
    beam.position.addVectors(a, b).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(tmpV2.set(0, 1, 0), tmpV.normalize());
    beam.scale.set(1, len * grow, 1);
    const c = roleColor[view.winner] ?? new THREE.Color(0xffffff);
    beamCore.material.color.copy(c).lerp(new THREE.Color(0xffffff), 0.35);
    beamGlow.material.color.copy(c);
  }
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Keep the cube comfortably framed on narrow (phone) screens.
  camera.fov = w / h < 0.8 ? 52 : 38;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function loop(now) {
  controls.update();
  layout(now);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// Picking: nearest empty cell centre to the pointer ray.
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = -1, bestT = Infinity;
  for (let i = 0; i < G.cells; i++) {
    if (view.board[i]) continue;
    cellPos(i, tmpV).applyMatrix4(board.matrixWorld);
    if (ray.ray.distanceSqToPoint(tmpV) > 0.36 * 0.36) continue;
    const t = tmpV.sub(ray.ray.origin).dot(ray.ray.direction);
    if (t < bestT) { bestT = t; best = i; }
  }
  // An occupied piece in front of the slot blocks it.
  if (best >= 0) {
    for (const p of pieces.values()) {
      cellPos(p.userData.cell, tmpV2).applyMatrix4(board.matrixWorld);
      if (ray.ray.distanceSqToPoint(tmpV2) < 0.3 * 0.3 && tmpV2.sub(ray.ray.origin).dot(ray.ray.direction) < bestT - 0.2) return -1;
    }
  }
  return best;
}

let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; controls.autoRotate = false; });
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && !e.buttons) {
    hover = ui.canPlace() ? pick(e.clientX, e.clientY) : -1;
    canvas.style.cursor = hover >= 0 ? "pointer" : "grab";
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = performance.now() - down.t < 600;
  down = null;
  if (moved < 8 && quick) ui.onTapCell(pick(e.clientX, e.clientY));
});

$("spread").addEventListener("input", (e) => {
  spread = +e.target.value;
  $("spreadBtn").setAttribute("aria-pressed", String(spread > 0.55));
});
// Toolbar shortcut: open/close the layers in one tap (fine control lives in the ⋯ menu).
$("spreadBtn").addEventListener("click", () => {
  const r = $("spread");
  r.value = spread > 0.55 ? "0.25" : "0.9";
  r.dispatchEvent(new Event("input"));
  sound.tick?.();
});

/* ───────────────────────────── confetti ───────────────────────────── */

// Fewer, softer pieces that drift and flutter rather than explode.
const cf = $("confetti");
const cctx = cf.getContext("2d");
let confetti = [];
function burst(colors) {
  if (reduceMotion) return;
  const dpr = devicePixelRatio;
  const w = (cf.width = innerWidth * dpr), h = (cf.height = innerHeight * dpr);
  for (let i = 0; i < 50; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, v = (5 + Math.random() * 6) * dpr;
    confetti.push({
      x: w / 2 + (Math.random() - 0.5) * 80 * dpr, y: h * 0.45, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25, ph: Math.random() * 6,
      s: (4 + Math.random() * 4) * dpr, c: colors[i % colors.length], life: 1,
    });
  }
  requestAnimationFrame(tickConfetti);
}
function tickConfetti() {
  const dpr = devicePixelRatio;
  cctx.clearRect(0, 0, cf.width, cf.height);
  confetti = confetti.filter((p) => p.life > 0);
  for (const p of confetti) {
    p.vy = Math.min(p.vy + 0.22 * dpr, 2.2 * dpr); p.vx *= 0.97; p.ph += 0.12;
    p.x += p.vx + Math.sin(p.ph) * 0.6 * dpr; p.y += p.vy; p.r += p.vr; p.life -= 0.0075;
    cctx.save(); cctx.globalAlpha = Math.max(0, Math.min(0.9, p.life * 1.4));
    cctx.translate(p.x, p.y); cctx.rotate(p.r); cctx.scale(1, Math.abs(Math.cos(p.ph))); cctx.fillStyle = p.c;
    cctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); cctx.restore();
  }
  if (confetti.length) requestAnimationFrame(tickConfetti);
}

/* ───────────────────────────── backends ───────────────────────────── */

// Each backend: { start(onEvents), save(fields) -> Promise<event>, me, signedIn }

const SIZE_NOTES = {
  3: "Quick and chaotic: whoever starts has the edge.",
  4: "The classic. Deep, but a game takes a few minutes.",
  5: "Big and strategic. Room for long plans.",
};
const prefs = {
  get size() { return SIZES.includes(Number(store.get("ttc.size"))) ? Number(store.get("ttc.size")) : 4; },
  get color() { return store.get("ttc.color") || "coral"; },
  get name2() { return store.get("ttc.name2") || "Player 2"; },
  get color2() { const c = store.get("ttc.color2"); return c && c !== prefs.color ? c : resolveColors(prefs.color, "teal").O; },
  get level() { return LEVELS.includes(store.get("ttc.level")) ? store.get("ttc.level") : "clever"; },
};

/** Games without an account, kept in this browser: against the computer, or pass-and-play. */
function localBackend(mode) {
  const key = `ttc.local.${mode}`;
  const size = prefs.size;
  const ai = mode === "ai";
  const xName = myName() || (ai ? "You" : "Player 1");
  const xColor = prefs.color;
  const oName = ai ? "Computer" : prefs.name2;
  const oColor = ai ? resolveColors(xColor, xColor === "teal" ? "coral" : "teal").O : prefs.color2;
  let saved = null;
  try { saved = JSON.parse(store.get(key) || "null"); } catch {}
  let events = saved && saved.size === size && Array.isArray(saved.events) ? saved.events : [];
  let ts = Math.max(Date.now(), ...events.map((e) => e.ts)), n = events.length;
  const mk = (author, authorName, kind, extra = {}) => ({
    recordName: `local-${++n}`, author, authorName, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, ...extra,
  });
  if (!events.length) {
    events.push(mk("local-x", xName, "join", { text: xName, cell: size, color: xColor }),
                mk("local-o", oName, "join", { text: oName, color: oColor }));
  } else {
    // Names and colours follow the current settings.
    Object.assign(events[0], { text: xName, color: xColor });
    Object.assign(events[1], { text: oName, color: oColor });
  }
  const persist = () => store.set(key, JSON.stringify({ size, events }));
  persist();

  let cb, thinking = false, lastBanter = 0;
  const be = {
    local: true, mode, signedIn: true, me: "local-x",
    level: prefs.level,
    get thinking() { return thinking; },
    onSay: null,
    start(onEvents) { cb = onEvents; emit(); },
    async save(f) {
      const before = fold(events);
      events.push(mk(f.author, f.authorName, f.kind, f));
      let s = fold(events);
      // The other side always agrees to another round.
      if (f.kind === "again" && s.winner) {
        const o = roleOf(s, f.author) === "X" ? s.players.O : s.players.X;
        if (o) events.push(mk(o.id, o.name, "again", { round: s.round }));
      }
      s = fold(events);
      if (ai) {
        if (!before.winner && s.winner && f.kind === "move") say(s.winner === "X" ? BANTER.youWin : s.winner === "draw" ? BANTER.draw : BANTER.aiWins, true);
        if (f.kind === "resign") say(BANTER.resigned, true);
      }
      emit();
      return { event: events[events.length - 1], all: events.slice() };
    },
  };
  function emit() {
    const s = fold(events);
    if (!ai && s.players[s.turn]) be.me = s.players[s.turn].id; // whoever must act next is "me"
    persist();
    cb?.(events.slice());
    if (ai && !s.winner && s.turn === "O" && !thinking) think();
  }
  function say(lines, always = false) {
    const now = Date.now();
    if (!always && (now - lastBanter < 12000 || Math.random() >= 0.7)) return;
    lastBanter = now;
    be.onSay?.({ recordName: `say-${now}`, author: "local-o", authorName: "Computer", kind: "say", text: lines[Math.floor(Math.random() * lines.length)] });
  }
  function think() {
    thinking = true;
    cb?.(events.slice());
    setTimeout(() => {
      const s = fold(events);
      thinking = false;
      if (s.winner || s.turn !== "O") { cb?.(events.slice()); return; }
      const d = decide(s.board, s.size, "O", be.level);
      if (!d) return;
      events.push(mk("local-o", "Computer", "move", { round: s.round, cell: d.cell }));
      const after = fold(events);
      if (after.winner) say(after.winner === "O" ? BANTER.aiWins : after.winner === "draw" ? BANTER.draw : BANTER.youWin, true);
      else if (BANTER[d.mood]) say(BANTER[d.mood]);
      emit();
    }, 650 + Math.random() * 450);
  }
  return be;
}

function whenCloudKit(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (window.CloudKit) return resolve(window.CloudKit);
    const t = setTimeout(() => reject(new Error("CloudKit JS failed to load")), timeout);
    window.addEventListener("cloudkitloaded", () => { clearTimeout(t); resolve(window.CloudKit); }, { once: true });
    const iv = setInterval(() => { if (window.CloudKit) { clearInterval(iv); clearTimeout(t); resolve(window.CloudKit); } }, 200);
  });
}

function toEvent(r) {
  const f = r.fields || {};
  const v = (k, d) => (f[k] && f[k].value != null ? f[k].value : d);
  return {
    recordName: r.recordName, kind: v("kind", ""), round: Number(v("round", 0)), cell: Number(v("cell", -1)),
    text: v("text", ""), author: v("author", ""), authorName: v("authorName", ""), color: v("color", ""),
    ts: Number(v("ts", 0)),
  };
}

let ckSetup = null;
/** Configure CloudKit once; `auth` tracks the signed-in player. */
function cloudSetup(onAuthChange) {
  if (ckSetup) return ckSetup;
  ckSetup = (async () => {
  if (!CONFIG.apiToken || CONFIG.apiToken.startsWith("REPLACE")) {
    throw new Error("This game server isn't set up yet (missing CloudKit API token).");
  }
  const CK = await whenCloudKit();
  CK.configure({
    containers: [{
      containerIdentifier: CONFIG.containerIdentifier,
      apiTokenAuth: {
        apiToken: CONFIG.apiToken, persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" },
      },
      environment: CONFIG.environment,
    }],
  });
  const container = CK.getDefaultContainer();
  const db = container.publicCloudDatabase;
  const be = { signedIn: false, me: null };

  const handleIdentity = (identity) => {
    if (identity) {
      // `&seat=2` (testing): play the other seat with the same Apple Account.
      be.signedIn = true; be.me = identity.userRecordName + (SEAT2 ? "~2" : ""); onAuthChange(be);
      container.whenUserSignsOut().then(() => { be.signedIn = false; be.me = null; onAuthChange(be); container.whenUserSignsIn().then(handleIdentity); });
    } else {
      be.signedIn = false; be.me = null; onAuthChange(be);
      container.whenUserSignsIn().then(handleIdentity);
    }
  };
  be.ready = container.setUpAuth().then(handleIdentity).catch((err) => {
    console.warn("auth", err);
    be.authError = true; // e.g. Apple sign-in unavailable on this domain or blocked by the browser
    onAuthChange(be);
  });
  return { container, db, auth: be };
  })();
  return ckSetup;
}

async function queryGame(db, gameId, since = 0) {
  const out = [];
  let res = await db.performQuery({
    recordType: "Event",
    filterBy: [
      { fieldName: "game", comparator: "EQUALS", fieldValue: { value: gameId } },
      { fieldName: "ts", comparator: "GREATER_THAN_OR_EQUALS", fieldValue: { value: Math.max(0, since) } },
    ],
    sortBy: [{ fieldName: "ts", ascending: true }],
  }, { resultsLimit: 200 });
  for (;;) {
    if (res.hasErrors) throw res.errors[0];
    out.push(...res.records.map(toEvent));
    if (!res.moreRecordsComing) break;
    res = await db.performQuery(res);
  }
  return out;
}

async function saveEvent(db, gameId, f) {
  const res = await db.saveRecords([{
    recordType: "Event",
    fields: {
      game: { value: gameId }, kind: { value: f.kind }, round: { value: f.round ?? 0 },
      cell: { value: f.cell ?? -1 }, text: { value: f.text ?? "" }, author: { value: f.author },
      authorName: { value: f.authorName ?? "" }, color: { value: f.color ?? "" }, ts: { value: Date.now() },
    },
  }]);
  if (res.hasErrors) throw res.errors[0];
  return toEvent(res.records[0]);
}

async function cloudBackend(onAuthChange) {
  const { db, auth: be } = await cloudSetup(onAuthChange);
  const seen = new Map();
  let since = 0;
  async function fetchNew() {
    // Overlap window absorbs small clock skew between players; dedupe by recordName.
    let added = false;
    for (const e of await queryGame(db, GAME_ID, since - 120000)) {
      if (seen.has(e.recordName)) continue;
      seen.set(e.recordName, e);
      since = Math.max(since, e.ts);
      added = true;
    }
    return added;
  }

  be.start = (onEvents, onError) => {
    let first = true;
    const tick = async () => {
      // Always report the first successful fetch, even an empty game, so the page stops "loading".
      try { if ((await fetchNew()) || first) onEvents([...seen.values()]); first = false; }
      catch (err) { onError(err); }
      setTimeout(tick, document.hidden ? 8000 : 3000);
    };
    tick();
  };
  be.save = async (f) => {
    const e = await saveEvent(db, GAME_ID, f);
    seen.set(e.recordName, e);
    since = Math.max(since, e.ts);
    return { event: e, all: [...seen.values()] };
  };
  return be;
}

/* ───────────────────────────── UI / controller ───────────────────────────── */

const ui = {};
let backend = null;
let state = fold([]);
let events = [];
let loaded = false;
let inviteOpen = false;   // invite card visible
let inviteShown = false;  // auto-opened once for a new game
const toastedIds = new Set();
let lastWinnerKey = null;
let busy = false;
let resultOpen = false;
let replay = null; // { k, timer } while scrubbing through a finished round

function myRole() { return backend?.me ? roleOf(state, backend.me) : null; }
function myName() { return store.get("ttc.name") || ""; }
function myColor() { return store.get("ttc.color") || ""; }
function nameOf(role) { return state.players[role]?.name || (role === "X" ? "Player X" : "Player O"); }
const bothJoined = () => state.players.X && state.players.O;
// Two people on this device: names, not "you".
const hotseat = () => backend?.mode === "local";
const offline = () => !!backend?.local;
const vsComputer = () => backend?.mode === "ai";
const other = (r) => (r === "X" ? "O" : "X");

ui.canPlace = () => {
  const r = myRole();
  return !!(r && bothJoined() && !state.winner && !state.closedBy && state.turn === r && !busy && !replay);
};

ui.onTapCell = (cell) => {
  if (replay) return;
  if (cell < 0) return; // a miss never throws away a chosen spot
  if (!ui.canPlace()) { nudge(); return; }
  if (preview === cell) commitMove();
  else setPreview(cell, myRole());
};
ui.onPreviewChanged = () => render();

function nudge() {
  $("status").animate?.([{ translate: "0 0" }, { translate: "-4px 0" }, { translate: "4px 0" }, { translate: "0 0" }], { duration: 240, easing: "ease-out" });
}

async function send(fields) {
  const f = { author: backend.me, authorName: myName() || nameOf(myRole() ?? "X"), round: state.round, cell: -1, text: "", color: "", ...fields };
  if (backend.local) { f.authorName = nameOf(roleOf(state, f.author)); return backend.save(f); }
  // Optimistic local event so the board responds instantly.
  const temp = { ...f, recordName: `~local-${Math.random()}`, ts: Date.now() };
  ingest([...events, temp]);
  try {
    const { all } = await backend.save(f);
    ingest(all);
  } catch (err) {
    console.error(err);
    ingest(events.filter((e) => e !== temp));
    showStatusError("Couldn't reach iCloud — try again.");
  }
}

async function commitMove() {
  const cell = preview;
  setPreview(-1);
  busy = true;
  navigator.vibrate?.(12);
  try { await send({ kind: "move", cell }); } finally { busy = false; render(); }
}

function currentView() {
  if (replay) {
    const k = replay.k;
    return { board: boardAt(state, k), lastMove: k ? state.moves[k - 1].cell : null,
      winLine: k === state.moves.length ? state.winLine : null, winner: k === state.moves.length ? state.winner : null };
  }
  return state;
}

function ingest(list) {
  connError = null;
  events = sortEvents(list);
  const prev = state;
  state = fold(events);
  // Before the host's first join lands, show the size they picked.
  const want = state.sizeSet ? state.size : SIZES.includes(HOST_SIZE) ? HOST_SIZE : state.size;
  if (want !== N) buildBoard(want);
  setColors(state.colors);
  if (replay && (state.round !== prev.round || !state.winner)) stopReplay(false);
  syncBoard(currentView());

  // Sound for newly placed pieces (skip history on first load).
  if (loaded && state.round === prev.round && state.moves.length > prev.moves.length) {
    const m = state.moves[state.moves.length - 1];
    sound.place(G.coords(m.cell)[1], N);
  }

  // Toasts for new chat + joins (skip history on first load).
  for (const e of events) {
    if (toastedIds.has(e.recordName) || String(e.recordName).startsWith("~local")) continue;
    toastedIds.add(e.recordName);
    if (!loaded) continue;
    if (e.kind === "say") toast(e);
    else if (e.kind === "join" && e.author !== backend?.me && !roleOf(prev, e.author) && roleOf(state, e.author)) toast({ ...e, text: "joined the game" });
  }

  // Celebrate a newly finished round.
  const wk = state.winner ? `${state.round}:${state.winner}` : null;
  if (wk && wk !== lastWinnerKey && loaded) celebrate();
  if (!wk && resultOpen) closeResult();
  lastWinnerKey = wk;
  if (!loaded) loaded = true;
  if (GAME_ID && myRole()) {
    rememberGame(GAME_ID, { opp: nameOf(other(myRole())), closed: !!state.closedBy });
    if (HOST_SIZE && state.players.X) history.replaceState(null, "", shareUrl() + (SEAT2 ? "&seat=2" : ""));
  }
  render();
  maybeAskToJoin();
}

function celebrate() {
  const role = myRole();
  if (state.winner !== "draw") {
    const won = hotseat() || !role || role === state.winner;
    if (won) {
      sound.win();
      const hex = hexOf(state.colors[state.winner]);
      burst([hex, hex, hexOf("pearl"), mix(hex, "#ffffff", 0.5)]);
    } else sound.lose();
    const el = $("score" + state.winner);
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    navigator.vibrate?.(won ? [20, 40, 20] : 30);
  }
  // Let the line light up on the cube before the card appears.
  setTimeout(() => { if (state.winner) openResult(); }, state.winLine && !reduceMotion ? 1100 : 300);
}

function mix(a, b, t) {
  const c = new THREE.Color(a).lerp(new THREE.Color(b), t);
  return `#${c.getHexString()}`;
}

/* ── result card ── */

function openResult() {
  resultOpen = true;
  renderResult();
  const el = $("result");
  el.hidden = false;
  void el.offsetWidth; // commit the closed state so the fade starts right away
  el.classList.add("open");
  render();
  ($("resultAgain").hidden ? $("resultClose") : $("resultAgain")).focus({ preventScroll: true });
}
function closeResult() {
  resultOpen = false;
  const el = $("result");
  el.classList.remove("open");
  setTimeout(() => { if (!resultOpen) el.hidden = true; }, reduceMotion ? 0 : 180);
  render();
}

function renderResult() {
  const role = myRole();
  const demo = hotseat();
  const w = state.winner;
  const n = N;
  let title, how;
  if (w === "draw") {
    title = "It’s a draw";
    how = `All ${G.cells} spots are filled and nobody got ${n} in a row.`;
  } else if (state.resigned) {
    title = role === state.resigned && !demo ? "You resigned" : `${nameOf(state.resigned)} resigned`;
    how = `${role === w && !demo ? "You take" : `${nameOf(w)} takes`} the round.`;
  } else {
    const iWon = role === w && !demo;
    title = iWon ? "You win!" : `${nameOf(w)} wins${demo ? "!" : ""}`;
    how = `${iWon ? "" : `${nameOf(w)} got `}${n} in a row ${describeLine(state.winLine, n)}.`;
    how = how[0].toUpperCase() + how.slice(1);
  }
  $("resultTitle").textContent = title;
  $("resultHow").textContent = how;
  const orb = $("resultOrb");
  orb.dataset.mark = w === "draw" ? "draw" : w;
  for (const r of ["X", "O"]) {
    $("rs" + r).textContent = state.score[r];
    $("rsName" + r).textContent = role === r && !demo ? "You" : nameOf(r);
  }

  const next = [];
  const opp = role ? other(role) : null;
  if (role && !offline()) {
    if (state.ready[role] && !state.ready[opp]) next.push(["wait", `Waiting for ${nameOf(opp)} to accept. You can close this and look at the cube, or send a message.`]);
    else if (state.ready[opp]) next.push(["wave", `${nameOf(opp)} wants another round.`]);
    else next.push(["again", `Ask for a rematch — ${nameOf(opp)} can accept whenever they’re ready.`]);
  }
  const starter = starterFor(state.round + 1);
  next.push(["flag", `Round ${state.round + 2}: ${role === starter && !demo ? "you go" : `${nameOf(starter)} goes`} first.`]);
  const ul = $("resultNext");
  ul.replaceChildren(...next.map(([icon, text]) => {
    const li = document.createElement("li");
    li.dataset.icon = icon;
    li.textContent = text;
    return li;
  }));

  const again = $("resultAgain");
  again.hidden = !role || state.ready[role];
  again.textContent = offline() ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
  $("resultLevel").hidden = !vsComputer();
  if (vsComputer()) setLevelUI();
  $("resultReplay").hidden = state.moves.length === 0;
}

/* ── replay ── */

function startReplay() {
  closeResult();
  setPreview(-1);
  replay = { k: 0, timer: null };
  $("replaySlider").max = state.moves.length;
  playReplay();
  render();
}
function playReplay() {
  if (!replay) return;
  clearInterval(replay.timer);
  if (replay.k >= state.moves.length) replay.k = 0;
  setReplayK(replay.k);
  replay.timer = setInterval(() => {
    if (replay.k >= state.moves.length) { pauseReplay(); return; }
    setReplayK(replay.k + 1, true);
  }, reduceMotion ? 700 : 520);
  updateReplayButton();
}
function pauseReplay() { if (replay) { clearInterval(replay.timer); replay.timer = null; updateReplayButton(); } }
function stopReplay(reRender = true) {
  if (!replay) return;
  clearInterval(replay.timer);
  replay = null;
  syncBoard({ ...currentView(), instant: true });
  if (reRender) render();
}
function setReplayK(k, withSound = false) {
  replay.k = Math.max(0, Math.min(state.moves.length, k));
  syncBoard(currentView());
  if (withSound && replay.k > 0) sound.place(G.coords(state.moves[replay.k - 1].cell)[1], N);
  $("replaySlider").value = replay.k;
  $("replayCount").textContent = `${replay.k} / ${state.moves.length}`;
}
function updateReplayButton() {
  const playing = !!replay?.timer;
  const b = $("replayPlay");
  b.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
  b.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
}

/* ── render ── */

let statusError = null;
let connError = null; // until the first successful fetch
function showStatusError(msg) { statusError = msg; render(); setTimeout(() => { statusError = null; render(); }, 4000); }

// Online only: flag the tab when it's your turn (or a rematch waits) while you're elsewhere.
function updateTitle() {
  const role = myRole();
  const waiting = !!(backend && !backend.local && role && !state.closedBy &&
    (ui.canPlace() || (state.winner && state.ready[other(role)] && !state.ready[role])));
  document.title = (document.hidden && waiting ? "● Your move · " : "") + "Tic Tac Cube";
}
document.addEventListener("visibilitychange", updateTitle);

function render() {
  updateTitle();
  const role = myRole();
  $("nameX").textContent = state.players.X?.name || "Waiting…";
  $("nameO").textContent = state.players.O?.name || "Waiting…";
  $("scoreX").textContent = state.score.X;
  $("scoreO").textContent = state.score.O;
  $("round").textContent = `Round ${state.round + 1} · ${N}×${N}×${N}`;
  $("pX").classList.toggle("active", !!bothJoined() && !state.winner && state.turn === "X");
  $("pO").classList.toggle("active", !!bothJoined() && !state.winner && state.turn === "O");

  let turn = "—";
  if (state.winner === "draw") turn = "Draw";
  else if (state.resigned) turn = `${nameOf(state.resigned)} resigned`;
  else if (state.winner) turn = `${nameOf(state.winner)} wins`;
  else if (bothJoined()) turn = role === state.turn && !hotseat() ? "Your move" : `${nameOf(state.turn)}’s move`;
  $("turn").textContent = turn;

  let status;
  if (statusError) status = statusError;
  else if (connError) status = connError;
  else if (!loaded) status = "Loading game…";
  else if (state.closedBy) status = !state.players.O
    ? (role === state.closedBy ? "You cancelled this invite." : "This invite was cancelled.")
    : (role === state.closedBy ? "You ended this game." : `${nameOf(state.closedBy)} ended this game.`);
  else if (replay) status = "Replaying the round — scrub to any move.";
  else if (!bothJoined()) status = role === "X" ? "Waiting for your friend to open the link…"
    : backend?.signedIn ? "Joining…"
    : backend?.authError ? "Apple sign-in isn’t available here right now. You can still play the computer from Home."
    : HOST_SIZE && !events.length ? "Sign in with Apple to start your game — then send your friend the link."
    : "A seat is open — sign in with Apple to play.";
  else if (state.winner) {
    const opp = role ? other(role) : null;
    if (role && state.ready[role] && !state.ready[opp]) status = `Waiting for ${nameOf(opp)} to accept…`;
    else if (role && state.ready[opp]) status = `${nameOf(opp)} wants another round.`;
    else if (state.winner === "draw") status = "The cube is full — it’s a draw.";
    else if (state.resigned) status = `${nameOf(state.resigned)} resigned this round.`;
    else status = role === state.winner && !hotseat() ? `You got ${N} in a row!` : `${nameOf(state.winner)} got ${N} in a row.`;
  } else if (!role) status = `Watching ${nameOf("X")} vs ${nameOf("O")}.`;
  else if (hotseat()) status = `${nameOf(state.turn)}, your move` + (preview >= 0 ? " — tap again to place." : "");
  else if (vsComputer() && state.turn === "O") status = "The computer is thinking…";
  else if (state.turn === role) status = preview >= 0 ? "Tap again to place — or pick another slot." : "Your move — spin the cube and tap a slot.";
  else status = `Waiting for ${nameOf(state.turn)}…`;
  $("status").textContent = status;

  const inReplay = !!replay;
  $("replay").hidden = !inReplay;
  $("placeBtn").hidden = inReplay || !(preview >= 0 && ui.canPlace());
  const opp = role ? other(role) : "O";
  const closed = !!state.closedBy;
  const canAgain = !closed && !inReplay && role && state.winner && !state.ready[role] && !resultOpen;
  $("againBtn").hidden = !canAgain;
  $("againBtn").textContent = offline() ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
  $("resultBtn").hidden = inReplay || !state.winner || resultOpen;
  const canResign = !closed && !inReplay && role && bothJoined() && !state.winner;
  const canEnd = !closed && !inReplay && role && !offline();
  $("endWrap").hidden = !canEnd;
  if (!canEnd) setEndConfirm(false);
  $("endBtn").textContent = bothJoined() ? "End game" : "Cancel invite";
  $("endYes").textContent = bothJoined() ? "End game" : "Cancel invite";
  $("endQ").textContent = bothJoined() ? "End it for both of you?" : "Cancel the invite? The link stops working.";
  $("resignWrap").hidden = !canResign;
  if (!canResign) setResignConfirm(false);
  $("chat").hidden = closed || inReplay || !(role && bothJoined());
  $("signin").hidden = !!backend?.signedIn || offline() || !backend || !!backend?.authError;
  $("chat").hidden ||= offline();
  $("chatBtn").hidden = $("chat").hidden;          // chat lives behind the toolbar icon
  if ($("chatBtn").hidden) $("chatPop").hidePopover?.();
  $("homeBtn").hidden = !(closed || (state.winner && !resultOpen && !inReplay));
  $("levelWrap").hidden = !vsComputer();
  const host = role === "X" && !bothJoined() && !closed && !offline() && loaded;
  $("inviteBtn").hidden = !host || inviteOpen;
  if (host && !inviteShown) { inviteShown = true; openInvite(); }   // a new game: show the invite once
  if (!host && inviteOpen) closeInvite();                            // they joined (or it ended)
  // Your own name on the scoreboard can be tapped to rename yourself (online games).
  for (const r of ["X", "O"]) {
    const mine = r === role && !offline() && !closed;
    $("name" + r).classList.toggle("editable", mine);
    $("name" + r).title = mine ? "Change your name or colour" : "";
  }
  $("openApp").hidden = offline();
  if (resultOpen) renderResult();
}

function setEndConfirm(on) {
  $("endBtn").hidden = on;
  $("endConfirm").hidden = !on;
  if (on) $("endNo").focus({ preventScroll: true });
}

function setResignConfirm(on) {
  $("resignBtn").hidden = on;
  $("resignConfirm").hidden = !on;
  if (on) $("resignNo").focus({ preventScroll: true });
}

function toast(e) {
  const role = roleOf(state, e.author);
  const el = document.createElement("div");
  el.className = `toast${e.author === backend?.me ? " mine" : ""}`;
  el.dataset.mark = role || "X";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = e.author === backend?.me && !hotseat() ? "You" : (e.authorName || nameOf(role));
  el.append(who, document.createTextNode(e.text));
  const box = $("toasts");
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 4200);
}

/* ── colour + size pickers ── */

function swatchPicker(fieldset, name, selected, onChange) {
  for (const [key, hex] of PALETTE) {
    const label = document.createElement("label");
    label.className = "swatch";
    label.style.setProperty("--sw", hex);
    label.title = key[0].toUpperCase() + key.slice(1);
    const input = document.createElement("input");
    input.type = "radio"; input.name = name; input.value = key; input.checked = key === selected;
    input.setAttribute("aria-label", label.title);
    input.addEventListener("change", () => onChange?.(key));
    label.append(input);
    fieldset.append(label);
  }
}
const pickedIn = (fieldset) => fieldset.querySelector("input:checked")?.value;

let asking = false;
function maybeAskToJoin() {
  if (!backend || backend.local || !backend.signedIn || !loaded || asking) return;
  if (myRole() || bothJoined() || state.closedBy) return;
  const name = myName(), color = myColor();
  // The browser that created this game fixes the cube size with the first join.
  const hostCell = HOST_SIZE && !events.length ? HOST_SIZE : -1;
  if (name && color) {
    asking = true;
    send({ kind: "join", text: name, color, cell: hostCell }).finally(() => { asking = false; });
    return;
  }
  asking = true;
  const dlg = $("nameDialog");
  $("nameInput").value = name;
  const fs = $("joinSwatches");
  if (!fs.querySelector("input")) {
    const taken = state.players.X?.color;
    swatchPicker(fs, "joinColor", color || PALETTE.find(([k]) => k !== taken && k !== "coral")?.[0] || "teal");
  }
  dlg.showModal();
  dlg.addEventListener("close", () => {
    const v = $("nameInput").value.trim().slice(0, 24);
    const c = pickedIn(fs) || "teal";
    if (v) {
      store.set("ttc.name", v); store.set("ttc.color", c);
      send({ kind: "join", text: v, color: c, cell: hostCell }).finally(() => { asking = false; });
    } else asking = false;
  }, { once: true });
}

/* ── controls ── */

$("placeBtn").addEventListener("click", () => { if (preview >= 0) commitMove(); });
$("againBtn").addEventListener("click", () => send({ kind: "again" }));
$("resultBtn").addEventListener("click", openResult);
$("resultAgain").addEventListener("click", () => { closeResult(); send({ kind: "again" }); });
$("resultClose").addEventListener("click", closeResult);
$("resultReplay").addEventListener("click", startReplay);
$("result").addEventListener("click", (e) => { if (e.target === $("result")) closeResult(); });
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (resultOpen) closeResult();
  else if (inviteOpen) closeInvite();
  else if (!$("resignConfirm").hidden) setResignConfirm(false);
  else if (!$("endConfirm").hidden) setEndConfirm(false);
});
$("resignBtn").addEventListener("click", () => setResignConfirm(true));
$("endBtn").addEventListener("click", () => setEndConfirm(true));
$("endNo").addEventListener("click", () => { setEndConfirm(false); $("endBtn").focus({ preventScroll: true }); });
$("endYes").addEventListener("click", () => { setEndConfirm(false); $("menuPop").hidePopover?.(); setPreview(-1); send({ kind: "close" }); });
$("resignNo").addEventListener("click", () => { setResignConfirm(false); $("resignBtn").focus({ preventScroll: true }); });
$("resignYes").addEventListener("click", () => { setResignConfirm(false); $("menuPop").hidePopover?.(); setPreview(-1); send({ kind: "resign" }); });
$("replayPlay").addEventListener("click", () => (replay?.timer ? pauseReplay() : playReplay()));
$("replaySlider").addEventListener("input", (e) => { pauseReplay(); setReplayK(+e.target.value); });
$("replayDone").addEventListener("click", () => { stopReplay(); openResult(); });

function setToggle(id, on) { $(id).setAttribute("aria-pressed", String(on)); }
setToggle("soundToggle", sound.on);
setToggle("threatToggle", showThreats);
$("soundToggle").addEventListener("click", () => {
  sound.on = !sound.on; store.set("ttc.sound", sound.on ? "1" : "0"); setToggle("soundToggle", sound.on);
  $("soundToggle").setAttribute("aria-label", sound.on ? "Sound on" : "Sound off");
  if ($("homeSound")) setToggle("homeSound", sound.on);
  if (sound.on) { sound.unlock(); sound.tick(); }
});
$("threatToggle").addEventListener("click", () => {
  showThreats = !showThreats; store.set("ttc.threats", showThreats ? "1" : "0"); setToggle("threatToggle", showThreats);
  syncBoard({ ...currentView(), instant: true });
});

// Pieces style: in-game ⋯ menu (the home copy is wired in initHome).
const PIECE_OPTIONS = [["orbs", "Orbs"], ["xo", "X & O"]];
segPicker($("menuPieces"), "menuPiecesPick", PIECE_OPTIONS, pieceStyle, (v) => setPieceStyle(v));

for (const p of PRESETS) {
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button"; b.textContent = p;
  b.addEventListener("click", () => { send({ kind: "say", text: p }); $("chatPop").hidePopover?.(); });
  $("chips").append(b);
}

/* ───────────────────────────── games list ───────────────────────────── */

const shareUrl = (id = GAME_ID) => `${location.origin}${location.pathname}?g=${id}`;
function savedGames() { try { return JSON.parse(store.get("ttc.games") || "[]"); } catch { return []; } }
function setSavedGames(list) { store.set("ttc.games", JSON.stringify(list.slice(0, 40))); }
function rememberGame(id, patch) {
  const list = savedGames();
  const i = list.findIndex((g) => g.id === id);
  const g = { id, opp: "", t: Date.now(), archived: false, closed: false, ...(i >= 0 ? list[i] : {}), ...patch };
  if (patch.closed) g.archived = true;
  else if (!("t" in patch)) g.t = Date.now();
  if (i >= 0) list.splice(i, 1);
  list.unshift(g);
  setSavedGames(list);
}
const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

/* ───────────────────────────── controls: level + share ───────────────────────────── */

function setLevelUI() {
  const lvl = backend?.level || prefs.level;
  $("levelSelect").value = lvl;
  for (const input of $("resultLevel").querySelectorAll("input")) input.checked = input.value === lvl;
}
function setLevel(lvl) {
  store.set("ttc.level", lvl);
  if (backend?.local) backend.level = lvl;
  setLevelUI();
}
$("levelSelect").addEventListener("change", (e) => setLevel(e.target.value));
segPicker($("resultLevel"), "resultLevelPick", LEVELS.map((l) => [l, l[0].toUpperCase() + l.slice(1)]), prefs.level, setLevel);

/* ── invite card ── */
function openInvite() {
  inviteOpen = true;
  $("inviteUrl").textContent = shareUrl().replace(/^https:\/\//, "");
  $("inviteLead").textContent = `Your ${N}×${N}×${N} game is ready. Send this link to the person you want to play.`;
  const el = $("invite");
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("open");
  $("inviteCopy").focus({ preventScroll: true });
  render();
}
function closeInvite() {
  if (!inviteOpen) return;
  inviteOpen = false;
  const el = $("invite");
  el.classList.remove("open");
  setTimeout(() => { if (!inviteOpen) el.hidden = true; }, reduceMotion ? 0 : 300);
  render();
}
async function copyInvite() {
  const b = $("inviteCopy");
  try { await navigator.clipboard.writeText(shareUrl()); b.textContent = "✓ Copied"; navigator.vibrate?.(10); }
  catch { getSelection().selectAllChildren($("inviteUrl")); b.textContent = "Press ⌘C"; }
  setTimeout(() => { b.textContent = "Copy link"; }, 1800);
}
$("inviteBtn").addEventListener("click", openInvite);
$("inviteCopy").addEventListener("click", copyInvite);
$("inviteLink").addEventListener("click", copyInvite);
$("inviteDone").addEventListener("click", closeInvite);
$("invite").addEventListener("click", (e) => { if (e.target === $("invite")) closeInvite(); });
$("inviteShare").hidden = !navigator.share;
$("inviteShare").addEventListener("click", () => navigator.share?.({ title: "Tic Tac Cube", text: "Play 3-D tic-tac-toe with me 🧊", url: shareUrl() }).catch(() => {}));
// Swipe the card down to close (touch).
{
  let y0 = null, dy = 0;
  const card = document.querySelector(".invite-card");
  card.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  card.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    card.style.transition = "none"; card.style.translate = `0 ${dy}px`;
  }, { passive: true });
  card.addEventListener("touchend", () => {
    card.style.transition = ""; card.style.translate = "";
    if (dy > 110) closeInvite();
    y0 = null;
  });
}

/* ── rename yourself (tap your name on the scoreboard) ── */
function editMe() {
  const role = myRole();
  if (!role || offline() || state.closedBy) return;
  const dlg = $("nameDialog");
  $("nameTitle").textContent = "Your name & colour";
  $("nameOk").textContent = "Save";
  $("nameCancel").hidden = false;
  $("nameInput").value = state.players[role]?.name || myName();
  const fs = $("joinSwatches");
  fs.querySelectorAll("label").forEach((l) => l.remove());
  swatchPicker(fs, "joinColor", state.players[role]?.color || myColor() || "coral");
  dlg.showModal();
  dlg.addEventListener("close", () => {
    $("nameTitle").textContent = "Join the game"; $("nameOk").textContent = "Join game"; $("nameCancel").hidden = true;
    if (dlg.returnValue !== "ok") return;
    const v = $("nameInput").value.trim().slice(0, 24), c = pickedIn(fs) || myColor();
    if (!v) return;
    store.set("ttc.name", v); store.set("ttc.color", c);
    if (v !== state.players[role]?.name || c !== state.players[role]?.color) send({ kind: "join", text: v, color: c, cell: -1 });
  }, { once: true });
}
for (const r of ["X", "O"]) $("name" + r).addEventListener("click", () => { if (myRole() === r) editMe(); });

function segPicker(fieldset, name, options, selected, onChange) {
  // The glass track is its own element: styling the fieldset itself puts the legend inside its padding/background on WebKit.
  const track = document.createElement("div");
  track.className = "seg-track";
  fieldset.append(track);
  for (const [value, text] of options) {
    const label = document.createElement("label");
    label.className = "seg-opt";
    const input = document.createElement("input");
    input.type = "radio"; input.name = name; input.value = value; input.checked = String(value) === String(selected);
    input.addEventListener("change", () => onChange(value));
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    track.append(label);
  }
}

/* ───────────────────────────── home ───────────────────────────── */

let homeAuth = null;
let homeReframe = () => {};
function showcase() {
  const n = prefs.size, g = geometry(n), c = Math.floor(n / 2);
  const cells = [g.idx(c, c, c), g.idx(0, 0, 0), g.idx(c, n - 1, c), g.idx(n - 1, n - 1, n - 1), g.idx(0, c, n - 1),
    g.idx(n - 1, 0, 0), g.idx(c, 0, c), g.idx(0, n - 1, 0), g.idx(n - 1, c, c)];
  let evs = [{ recordName: "a", kind: "join", author: "x", ts: 1, cell: n, color: prefs.color },
             { recordName: "b", kind: "join", author: "o", ts: 2, color: resolveColors(prefs.color, prefs.color === "teal" ? "coral" : "teal").O }];
  let t = 10;
  for (const cell of [...new Set(cells)]) {
    const s0 = fold(evs);
    const next = [...evs, { recordName: "m" + t, kind: "move", author: s0.turn === "X" ? "x" : "o", round: 0, cell, ts: t++ }];
    if (!fold(next).winner) evs = next; // never show a finished line on the title screen
  }
  const s = fold(evs);
  if (s.size !== N) { buildBoard(s.size); homeReframe(); }
  setColors(s.colors);
  syncBoard({ ...s, lastMove: null, instant: true });
}

function renderHomeChrome() {
  document.documentElement.style.setProperty("--me", hexOf(prefs.color));
  $("sizeNote").textContent = SIZE_NOTES[prefs.size];
  $("homeTag").textContent = `${["", "", "", "Three", "Four", "Five"][prefs.size]} in a row, in any direction.`;
}

const STATUS_LABEL = { mine: "Your move", theirs: "Their move", waiting: "Waiting for them to join", rematch: "Wants a rematch", over: "Round over", ended: "Ended" };
const summaries = new Map();

function renderGames() {
  const all = savedGames();
  const active = all.filter((g) => !g.archived);
  const archived = all.filter((g) => g.archived);
  $("homeGamesWrap").hidden = !all.length;
  const urgent = (g) => ["mine", "rematch"].includes(summaries.get(g.id)?.status);
  active.sort((a, b) => (urgent(b) - urgent(a)) || ((summaries.get(b.id)?.last ?? b.t) - (summaries.get(a.id)?.last ?? a.t)));
  const waiting = active.filter(urgent).length;
  $("waitingBadge").hidden = !waiting;
  $("waitingBadge").textContent = `${waiting} waiting on you`;
  $("homeGames").replaceChildren(...active.map((g) => gameRow(g, false)));
  $("showArchived").hidden = !archived.length;
  $("showArchived").textContent = `${$("archivedGames").hidden ? "Show" : "Hide"} archived (${archived.length})`;
  $("archivedGames").replaceChildren(...archived.map((g) => gameRow(g, true)));
}

function gameRow(g, archived) {
  const sum = summaries.get(g.id);
  const li = document.createElement("li");
  li.className = "game-row" + (["mine", "rematch"].includes(sum?.status) ? " mine" : "");
  const a = document.createElement("a");
  a.href = `?g=${g.id}`;
  const title = document.createElement("span");
  title.className = "g-title";
  const opp = sum?.opp || g.opp;
  title.textContent = opp ? `vs ${opp}` : "Invite sent";
  const sub = document.createElement("span");
  sub.className = "g-sub";
  sub.textContent = sum ? `${STATUS_LABEL[sum.status]} · ${sum.size}³` : (g.closed ? "Ended" : homeAuth?.signedIn ? "…" : " ");
  a.append(title, sub);
  const score = document.createElement("span");
  score.className = "g-score";
  if (sum && sum.status !== "waiting") score.textContent = `${sum.mine}–${sum.theirs}`;
  const actions = document.createElement("span");
  actions.className = "g-actions";
  const iconBtn = (label, path, onClick) => {
    const b = document.createElement("button");
    b.className = "icon-btn"; b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.addEventListener("click", onClick);
    return b;
  };
  if (archived) {
    if (!g.closed) actions.append(iconBtn("Restore", "M4 12a8 8 0 1 0 3-6.2M4 4v4h4", () => { rememberGame(g.id, { archived: false, t: g.t }); renderGames(); }));
    actions.append(iconBtn("Remove", "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12", () => { setSavedGames(savedGames().filter((x) => x.id !== g.id)); renderGames(); }));
  } else {
    actions.append(iconBtn("Archive", "M4 6h16v4H4zM6 10v9h12v-9M10 14h4", () => { rememberGame(g.id, { archived: true, t: g.t }); renderGames(); }));
    if (homeAuth?.signedIn) {
      actions.append(iconBtn(sum?.status === "waiting" ? "Cancel invite" : "End game", "M6 6l12 12M18 6L6 18", () => {
        if (li.querySelector(".g-confirm")) return;
        const c = document.createElement("div");
        c.className = "g-confirm";
        const q = document.createElement("span");
        q.className = "muted small";
        q.textContent = sum?.status === "waiting" ? "Cancel the invite?" : "End it for both of you?";
        const yes = document.createElement("button");
        yes.className = "btn small danger"; yes.type = "button"; yes.textContent = sum?.status === "waiting" ? "Cancel invite" : "End game";
        const no = document.createElement("button");
        no.className = "btn small"; no.type = "button"; no.textContent = "Keep";
        no.addEventListener("click", () => c.remove());
        yes.addEventListener("click", async () => {
          yes.disabled = true;
          try {
            const { db } = await cloudSetup(() => {});
            await saveEvent(db, g.id, { kind: "close", author: homeAuth.me, authorName: myName() || "Player" });
            rememberGame(g.id, { closed: true, t: g.t });
            summaries.set(g.id, { ...(sum || { size: 4, mine: 0, theirs: 0 }), status: "ended" });
          } catch (err) { console.warn(err); yes.disabled = false; q.textContent = "Couldn’t reach iCloud — try again."; return; }
          renderGames();
        });
        c.append(q, yes, no);
        li.append(c);
        no.focus({ preventScroll: true });
      }));
    }
  }
  li.append(a, score, actions);
  return li;
}

async function refreshGames() {
  if (!homeAuth?.signedIn) return;
  const { db } = await cloudSetup(() => {});
  const me = homeAuth.me;
  await Promise.all(savedGames().filter((g) => !g.archived).map(async (g) => {
    try {
      const s = fold(await queryGame(db, g.id));
      const role = roleOf(s, me);
      if (!role) return;
      const opp = other(role);
      let status;
      if (s.closedBy) status = "ended";
      else if (!s.players.O) status = "waiting";
      else if (s.winner) status = s.ready[opp] && !s.ready[role] ? "rematch" : "over";
      else status = s.turn === role ? "mine" : "theirs";
      summaries.set(g.id, { status, size: s.size, mine: s.score[role], theirs: s.score[opp], opp: s.players[opp]?.name || "", last: 0 });
      if (s.closedBy) rememberGame(g.id, { closed: true, t: g.t, opp: s.players[opp]?.name || g.opp });
    } catch (err) { console.warn(err); }
  }));
  renderGames();
}

function bootHome() {
  $("home").hidden = false;
  renderHomeChrome();
  showcase();
  controls.autoRotate = !reduceMotion;
  controls.enabled = false;
  // Small and high: the cube floats in the band above the title.
  const frame = () => {
    controls.maxDistance = 100;
    camera.position.copy(CAM_DIR).multiplyScalar((prefs.size / 4) * (innerWidth / innerHeight < 0.8 ? 1.55 : 2.1));
    camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.3, innerWidth, innerHeight);
  };
  frame();
  addEventListener("resize", frame);
  homeReframe = frame;
  // The cube sits behind the page; let it fade away as the settings scroll over it.
  $("home").addEventListener("scroll", () => {
    canvas.style.opacity = String(Math.max(0, 1 - $("home").scrollTop / 220));
  }, { passive: true });

  $("homeName").value = myName();
  $("homeName").addEventListener("input", (e) => store.set("ttc.name", e.target.value.trim().slice(0, 24)));
  $("homeName2").value = store.get("ttc.name2") || "";
  $("homeName2").addEventListener("input", (e) => store.set("ttc.name2", e.target.value.trim().slice(0, 24)));
  const paint2 = () => {
    for (const input of $("homeSwatches2").querySelectorAll("input")) {
      input.checked = input.value === prefs.color2;
      input.disabled = input.value === prefs.color;
      input.closest(".swatch").style.opacity = input.disabled ? 0.3 : "";
    }
  };
  swatchPicker($("homeSwatches"), "homeColor", prefs.color, (c) => { store.set("ttc.color", c); renderHomeChrome(); showcase(); paint2(); });
  swatchPicker($("homeSwatches2"), "homeColor2", prefs.color2, (c) => store.set("ttc.color2", c));
  paint2();
  segPicker($("homeSize"), "homeSizePick", SIZES.map((n) => [n, `${n}×${n}×${n}`]), prefs.size, (n) => { store.set("ttc.size", n); renderHomeChrome(); showcase(); });
  segPicker($("homePieces"), "homePiecesPick", PIECE_OPTIONS, pieceStyle, (v) => setPieceStyle(v));
  const homeToggle = (id, on, set) => {
    setToggle(id, on);
    $(id).addEventListener("click", () => { const v = $(id).getAttribute("aria-pressed") !== "true"; setToggle(id, v); set(v); });
  };
  // Home and in-game switches share one setting, so keep both in sync.
  homeToggle("homeSound", sound.on, (v) => { sound.on = v; store.set("ttc.sound", v ? "1" : "0"); setToggle("soundToggle", v); if (v) { sound.unlock(); sound.tick(); } });
  homeToggle("homeThreats", showThreats, (v) => { showThreats = v; store.set("ttc.threats", v ? "1" : "0"); setToggle("threatToggle", v); });

  $("playFriend").addEventListener("click", () => {
    location.href = `?g=${newGameId()}&host=${prefs.size}`;
  });
  $("showArchived").addEventListener("click", () => { $("archivedGames").hidden = !$("archivedGames").hidden; renderGames(); });

  renderGames();
  // Live status needs the player's Apple sign-in (if they've signed in here before, it's remembered).
  if (savedGames().length) {
    $("homeSignin").append($("signin"));
    cloudSetup((auth) => {
      homeAuth = auth;
      $("homeSignin").hidden = auth.signedIn || !!auth.authError;
      $("signin").hidden = auth.signedIn || !!auth.authError;
      renderGames();
      refreshGames();
    }).catch((err) => console.warn(err));
    setInterval(() => { if (!document.hidden) refreshGames(); }, 20000);
  }
}

/* ───────────────────────────── boot ───────────────────────────── */

async function boot() {
  buildBoard(PLAY ? prefs.size : SIZES.includes(HOST_SIZE) ? HOST_SIZE : 4);
  requestAnimationFrame(loop);
  for (const id of ["getApp", "get-app-home"]) $(id).addEventListener("click", (e) => e.preventDefault());
  if (!GAME_ID && !PLAY) { bootHome(); return; }

  $("hud").hidden = false;
  $("openApp").href = `tictaccube://g/${GAME_ID}`;
  setLevelUI();
  if (PLAY) {
    backend = localBackend(PLAY);
    backend.onSay = (e) => toast(e);
    backend.start(ingest);
    window.__ttc = { get state() { return state; }, place: (c) => { setPreview(c, myRole()); return commitMove(); } };
    return;
  }
  render();
  try {
    backend = await cloudBackend(() => { render(); maybeAskToJoin(); });
    backend.start(ingest, (err) => {
      console.warn(err);
      if (loaded) showStatusError("Having trouble reaching iCloud — retrying…");
      else { connError = "Couldn’t reach iCloud. Retrying… You can still play the computer from Home."; render(); }
    });
  } catch (err) {
    console.warn(err);
    statusError = `${err.message} You can still play the computer from Home.`;
    loaded = true;
    render();
  }
}
boot();
