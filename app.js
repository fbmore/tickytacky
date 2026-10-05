import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CONFIG } from "./config.js";
import {
  geometry, fold, roleOf, PRESETS, PALETTE, hexOf, resolveColors, sortEvents,
  boardAt, threats, describeLine, starterFor, SIZES,
} from "./game.js";

const params = new URLSearchParams(location.search);
const GAME_ID = (params.get("g") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
const DEMO = params.has("demo");
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
const pieces = new Map(); // cell -> mesh

const ghost = new THREE.Mesh(pieceGeo, new THREE.MeshPhysicalMaterial({
  color: roleColor.X, transparent: true, opacity: 0.45, roughness: 0.2, clearcoat: 1, depthWrite: false,
}));
ghost.visible = false;
board.add(ghost);

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
    if (mark && (!p || p.userData.mark !== mark)) {
      if (p) board.remove(p);
      p = new THREE.Mesh(pieceGeo, pieceMats[mark].clone());
      p.userData = { cell: i, mark, born: v.instant ? -1e9 : performance.now() };
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
  for (const p of pieces.values()) {
    cellPos(p.userData.cell, p.position);
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

$("spread").addEventListener("input", (e) => { spread = +e.target.value; });

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
function demoBackend({ size, colorX, colorO }) {
  const events = [];
  let ts = Date.now(), n = 0;
  const mk = (author, authorName, kind, extra = {}) => ({
    recordName: `demo-${++n}`, author, authorName, kind, round: 0, cell: -1, text: "", color: "", ts: ++ts, ...extra,
  });
  events.push(
    mk("demo-x", "Player 1", "join", { text: "Player 1", cell: size, color: colorX }),
    mk("demo-o", "Player 2", "join", { text: "Player 2", color: colorO }),
  );
  let cb;
  const be = {
    demo: true, signedIn: true, me: "demo-x",
    start(onEvents) { cb = onEvents; onEvents(events.slice()); },
    async save(f) {
      const e = mk(f.author, f.authorName, f.kind, f);
      e.ts = ++ts;
      events.push(e);
      // Hot-seat: whoever must act next becomes "me".
      const s = fold(events);
      if (f.kind === "again") {
        const other = roleOf(s, f.author) === "X" ? s.players.O : s.players.X;
        if (s.winner && other) events.push(mk(other.id, other.name, "again", { round: s.round }));
      }
      const s2 = fold(events);
      be.me = s2.players[s2.turn].id;
      cb(events.slice());
      return e;
    },
  };
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

async function cloudBackend(onAuthChange) {
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
      be.signedIn = true; be.me = identity.userRecordName; onAuthChange(be);
      container.whenUserSignsOut().then(() => { be.signedIn = false; be.me = null; onAuthChange(be); container.whenUserSignsIn().then(handleIdentity); });
    } else {
      be.signedIn = false; be.me = null; onAuthChange(be);
      container.whenUserSignsIn().then(handleIdentity);
    }
  };
  container.setUpAuth().then(handleIdentity).catch((err) => { console.warn("auth", err); onAuthChange(be); });

  const seen = new Map();
  let since = 0;
  async function fetchNew() {
    const query = {
      recordType: "Event",
      filterBy: [
        { fieldName: "game", comparator: "EQUALS", fieldValue: { value: GAME_ID } },
        // Overlap window absorbs small clock skew between players; dedupe by recordName.
        { fieldName: "ts", comparator: "GREATER_THAN_OR_EQUALS", fieldValue: { value: Math.max(0, since - 120000) } },
      ],
      sortBy: [{ fieldName: "ts", ascending: true }],
    };
    let res = await db.performQuery(query, { resultsLimit: 200 });
    let added = false;
    for (;;) {
      if (res.hasErrors) throw res.errors[0];
      for (const r of res.records) {
        if (seen.has(r.recordName)) continue;
        const e = toEvent(r);
        seen.set(r.recordName, e);
        since = Math.max(since, e.ts);
        added = true;
      }
      if (!res.moreRecordsComing) break;
      res = await db.performQuery(res);
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
    const record = {
      recordType: "Event",
      fields: {
        game: { value: GAME_ID }, kind: { value: f.kind }, round: { value: f.round ?? 0 },
        cell: { value: f.cell ?? -1 }, text: { value: f.text ?? "" }, author: { value: f.author },
        authorName: { value: f.authorName ?? "" }, color: { value: f.color ?? "" }, ts: { value: Date.now() },
      },
    };
    const res = await db.saveRecords([record]);
    if (res.hasErrors) throw res.errors[0];
    const e = toEvent(res.records[0]);
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
const other = (r) => (r === "X" ? "O" : "X");

ui.canPlace = () => {
  const r = myRole();
  return !!(r && bothJoined() && !state.winner && state.turn === r && !busy && !replay);
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
  if (backend.demo) { f.authorName = nameOf(roleOf(state, f.author)); return backend.save(f); }
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
  events = sortEvents(list);
  const prev = state;
  state = fold(events);
  if (state.size !== N) buildBoard(state.size);
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
  render();
  maybeAskToJoin();
}

function celebrate() {
  const role = myRole();
  if (state.winner !== "draw") {
    const won = backend?.demo || !role || role === state.winner;
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
  const demo = !!backend?.demo;
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
    title = iWon ? "You win!" : `${nameOf(w)} wins`;
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
  if (role && !demo) {
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
  again.textContent = demo ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
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
function showStatusError(msg) { statusError = msg; render(); setTimeout(() => { statusError = null; render(); }, 4000); }

function render() {
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
  else if (bothJoined()) turn = role === state.turn && !backend?.demo ? "Your move" : `${nameOf(state.turn)}’s move`;
  $("turn").textContent = turn;

  let status;
  if (statusError) status = statusError;
  else if (!loaded) status = "Loading game…";
  else if (replay) status = "Replaying the round — scrub to any move.";
  else if (!bothJoined()) status = role === "X" ? "Waiting for your friend to open the link…" : backend?.signedIn ? "Joining…" : "A seat is open — sign in with Apple to play.";
  else if (state.winner) {
    const opp = role ? other(role) : null;
    if (role && state.ready[role] && !state.ready[opp]) status = `Waiting for ${nameOf(opp)} to accept…`;
    else if (role && state.ready[opp]) status = `${nameOf(opp)} wants another round.`;
    else if (state.winner === "draw") status = "The cube is full — it’s a draw.";
    else if (state.resigned) status = `${nameOf(state.resigned)} resigned this round.`;
    else status = role === state.winner && !backend?.demo ? `You got ${N} in a row!` : `${nameOf(state.winner)} got ${N} in a row.`;
  } else if (!role) status = `Watching ${nameOf("X")} vs ${nameOf("O")}.`;
  else if (backend?.demo) status = `${nameOf(state.turn)}’s move (pass-and-play)` + (preview >= 0 ? " — tap again to place." : "");
  else if (state.turn === role) status = preview >= 0 ? "Tap again to place — or pick another slot." : "Your move — spin the cube and tap a slot.";
  else status = `Waiting for ${nameOf(state.turn)}…`;
  $("status").textContent = status;

  const inReplay = !!replay;
  $("replay").hidden = !inReplay;
  $("placeBtn").hidden = inReplay || !(preview >= 0 && ui.canPlace());
  const opp = role ? other(role) : "O";
  const canAgain = !inReplay && role && state.winner && !state.ready[role] && !resultOpen;
  $("againBtn").hidden = !canAgain;
  $("againBtn").textContent = backend?.demo ? "Play again" : state.ready[opp] ? "Accept rematch" : "Ask for a rematch";
  $("resultBtn").hidden = inReplay || !state.winner || resultOpen;
  const canResign = !inReplay && role && bothJoined() && !state.winner;
  $("resignWrap").hidden = !canResign;
  if (!canResign) setResignConfirm(false);
  $("chat").hidden = inReplay || !(role && bothJoined());
  $("signin").hidden = !!backend?.signedIn || backend?.demo || !backend;
  if (resultOpen) renderResult();
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
  who.textContent = e.author === backend?.me && !backend.demo ? "You" : (e.authorName || nameOf(role));
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
  if (!backend || backend.demo || !backend.signedIn || !loaded || asking) return;
  if (myRole() || bothJoined()) return;
  const name = myName(), color = myColor();
  if (name && color) {
    asking = true;
    send({ kind: "join", text: name, color }).finally(() => { asking = false; });
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
      send({ kind: "join", text: v, color: c }).finally(() => { asking = false; });
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
  else if (!$("resignConfirm").hidden) setResignConfirm(false);
});
$("resignBtn").addEventListener("click", () => setResignConfirm(true));
$("resignNo").addEventListener("click", () => { setResignConfirm(false); $("resignBtn").focus({ preventScroll: true }); });
$("resignYes").addEventListener("click", () => { setResignConfirm(false); setPreview(-1); send({ kind: "resign" }); });
$("replayPlay").addEventListener("click", () => (replay?.timer ? pauseReplay() : playReplay()));
$("replaySlider").addEventListener("input", (e) => { pauseReplay(); setReplayK(+e.target.value); });
$("replayDone").addEventListener("click", () => { stopReplay(); openResult(); });

function setToggle(id, on) { $(id).setAttribute("aria-pressed", String(on)); }
setToggle("soundToggle", sound.on);
setToggle("threatToggle", showThreats);
$("soundToggle").addEventListener("click", () => {
  sound.on = !sound.on; store.set("ttc.sound", sound.on ? "1" : "0"); setToggle("soundToggle", sound.on);
  if (sound.on) { sound.unlock(); sound.tick(); }
});
$("threatToggle").addEventListener("click", () => {
  showThreats = !showThreats; store.set("ttc.threats", showThreats ? "1" : "0"); setToggle("threatToggle", showThreats);
  syncBoard({ ...currentView(), instant: true });
});

for (const p of PRESETS) {
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button"; b.textContent = p;
  b.addEventListener("click", () => send({ kind: "say", text: p }));
  $("chips").append(b);
}
for (const id of ["getApp", "get-app-landing"]) $(id).addEventListener("click", (e) => e.preventDefault());

/* ───────────────────────────── boot ───────────────────────────── */

function askDemoSetup() {
  return new Promise((resolve) => {
    const seg = $("sizeSeg");
    const savedSize = Number(store.get("ttc.demoSize")) || 4;
    for (const n of SIZES) {
      const label = document.createElement("label");
      label.className = "seg-opt";
      const input = document.createElement("input");
      input.type = "radio"; input.name = "size"; input.value = n; input.checked = n === savedSize;
      const span = document.createElement("span");
      span.textContent = `${n}×${n}×${n}`;
      label.append(input, span);
      seg.append(label);
    }
    const cx = store.get("ttc.demoX") || "coral", co = store.get("ttc.demoO") || "teal";
    swatchPicker($("demoSwatchesX"), "demoX", cx);
    swatchPicker($("demoSwatchesO"), "demoO", co);
    const dlg = $("demoDialog");
    dlg.addEventListener("close", () => {
      const size = Number(seg.querySelector("input:checked")?.value) || 4;
      const colorX = pickedIn($("demoSwatchesX")) || "coral";
      const colorO = pickedIn($("demoSwatchesO")) || "teal";
      store.set("ttc.demoSize", size); store.set("ttc.demoX", colorX); store.set("ttc.demoO", colorO);
      resolve({ size, colorX, colorO });
    }, { once: true });
    dlg.showModal();
  });
}

async function boot() {
  buildBoard(4);
  requestAnimationFrame(loop);
  if (!GAME_ID && !DEMO) {
    $("landing").hidden = false;
    $("legalLanding").hidden = false;
    controls.autoRotate = !reduceMotion;
    // Decorative position on the landing cube.
    const deco = [0, 21, 42, 63, 5, 26, 47, 12].map((c, i) => ({ recordName: "d" + i, kind: "move", author: i % 2 ? "o" : "x", round: 0, cell: c, ts: i + 10 }));
    const s = fold([{ recordName: "a", kind: "join", author: "x", ts: 1, cell: 4 }, { recordName: "b", kind: "join", author: "o", ts: 2 }, ...deco]);
    setColors(s.colors);
    syncBoard(s);
    return;
  }
  $("hud").hidden = false;
  $("openApp").href = `tictaccube://g/${GAME_ID}`;
  $("openApp").hidden = DEMO;
  if (DEMO) {
    const setup = await askDemoSetup();
    backend = demoBackend(setup);
    backend.start(ingest);
    window.__ttc = { get state() { return state; }, place: (c) => { setPreview(c, myRole()); return commitMove(); } };
    return;
  }
  render();
  try {
    backend = await cloudBackend(() => { render(); maybeAskToJoin(); });
    backend.start(ingest, (err) => { console.warn(err); showStatusError("Having trouble reaching iCloud — retrying…"); });
  } catch (err) {
    console.warn(err);
    statusError = `${err.message} Try the offline demo at ?demo=1.`;
    loaded = true;
    render();
  }
}
boot();
