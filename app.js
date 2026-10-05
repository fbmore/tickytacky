import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CONFIG } from "./config.js";
import { N, CELLS, coords, fold, roleOf, PRESETS, sortEvents } from "./game.js";

const params = new URLSearchParams(location.search);
const GAME_ID = (params.get("g") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
const DEMO = params.has("demo");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);

const COLORS = { X: new THREE.Color("#ff6b5b"), O: new THREE.Color("#2ec4b6") };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ───────────────────────────── 3-D board ───────────────────────────── */

const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(8.2, 6.6, 9.6);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, -0.9, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.8;
controls.enablePan = false;
controls.minDistance = 7;
controls.maxDistance = 20;
controls.autoRotateSpeed = 0.6;

const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(5, 9, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x7f9cff, 0.9);
rim.position.set(-6, 2, -7);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0b1030, 0.5));

const board = new THREE.Group();
scene.add(board);

let spread = 0.25;
const GAP = 1.0;
const layerGap = () => 1.0 + spread * 1.8;
function cellPos(i, out = new THREE.Vector3()) {
  const [x, y, z] = coords(i);
  return out.set((x - 1.5) * GAP, (y - 1.5) * layerGap(), (z - 1.5) * GAP);
}

// Glass layer plates
const plates = [];
const plateGeo = new THREE.BoxGeometry(4.15, 0.035, 4.15);
const plateMat = new THREE.MeshPhysicalMaterial({
  color: 0xbfd0ff, transparent: true, opacity: 0.07, roughness: 0.08, metalness: 0,
  clearcoat: 1, depthWrite: false, side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0.22 });
for (let y = 0; y < N; y++) {
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.renderOrder = 1;
  plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(plateGeo), edgeMat));
  board.add(plate);
  plates.push(plate);
}

// Slot markers
const slotGeo = new THREE.SphereGeometry(0.085, 20, 14);
const slots = [];
for (let i = 0; i < CELLS; i++) {
  const m = new THREE.Mesh(slotGeo, new THREE.MeshStandardMaterial({
    color: 0xdfe6ff, emissive: 0x8fa6ff, emissiveIntensity: 0.25,
    transparent: true, opacity: 0.45, roughness: 0.3,
  }));
  board.add(m);
  slots.push(m);
}

// Pieces
const pieceGeo = new THREE.SphereGeometry(0.31, 48, 32);
const pieceMats = {
  X: new THREE.MeshPhysicalMaterial({ color: COLORS.X, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 }),
  O: new THREE.MeshPhysicalMaterial({ color: COLORS.O, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 }),
};
const pieces = new Map(); // cell -> mesh

const ghost = new THREE.Mesh(pieceGeo, new THREE.MeshPhysicalMaterial({
  color: COLORS.X, transparent: true, opacity: 0.45, roughness: 0.2, clearcoat: 1, depthWrite: false,
}));
ghost.visible = false;
board.add(ghost);

const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.4, 0.44, 64),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
);
ring.visible = false;
board.add(ring);

const beam = new THREE.Group();
const beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 16, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
const beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 24, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
beam.add(beamCore, beamGlow);
beam.visible = false;
board.add(beam);

let view = { board: new Array(CELLS).fill(null), lastMove: null, winLine: null, winner: null, turn: "X" };
let hover = -1;
let preview = -1;
let beamBorn = 0;

function syncBoard(s) {
  view = s;
  for (let i = 0; i < CELLS; i++) {
    const mark = s.board[i];
    let p = pieces.get(i);
    if (mark && (!p || p.userData.mark !== mark)) {
      if (p) board.remove(p);
      p = new THREE.Mesh(pieceGeo, pieceMats[mark].clone());
      p.userData = { cell: i, mark, born: performance.now() };
      board.add(p);
      pieces.set(i, p);
    } else if (!mark && p) {
      board.remove(p);
      pieces.delete(i);
    }
    slots[i].visible = !mark;
  }
  if (preview >= 0 && s.board[preview]) setPreview(-1);
  if (s.winLine && !beam.visible) { beam.visible = true; beamBorn = performance.now(); }
  if (!s.winLine) beam.visible = false;
}

function setPreview(i, mark) {
  preview = i;
  ghost.visible = i >= 0;
  if (i >= 0) ghost.material.color.copy(COLORS[mark]);
  ui.onPreviewChanged?.();
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
function layout(now) {
  plates.forEach((pl, y) => pl.position.set(0, (y - 1.5) * layerGap() - 0.34, 0));
  for (let i = 0; i < CELLS; i++) {
    cellPos(i, slots[i].position);
    const target = i === hover && !view.board[i] ? 1.9 : 1;
    const s = slots[i].scale.x + (target - slots[i].scale.x) * 0.25;
    slots[i].scale.setScalar(s);
    slots[i].material.opacity = i === hover ? 0.9 : 0.45;
  }
  for (const p of pieces.values()) {
    cellPos(p.userData.cell, p.position);
    const t = Math.min(1, (now - p.userData.born) / 420);
    const e = reduceMotion ? 1 : easeOutBack(t);
    p.scale.setScalar(Math.max(0.001, e));
    p.position.y += (1 - easeOutCubic(t)) * (reduceMotion ? 0 : 0.6);
    const win = view.winLine?.includes(p.userData.cell);
    p.material.emissive.copy(win ? COLORS[p.userData.mark] : new THREE.Color(0));
    p.material.emissiveIntensity = win ? 0.45 + 0.35 * Math.sin(now / 180) : 0;
  }
  if (preview >= 0) {
    cellPos(preview, ghost.position);
    ghost.scale.setScalar(0.92 + 0.05 * Math.sin(now / 160));
  }
  if (view.lastMove != null && !view.winLine) {
    ring.visible = true;
    cellPos(view.lastMove, ring.position);
    ring.quaternion.copy(camera.quaternion);
    const k = (now % 1600) / 1600;
    ring.scale.setScalar(1 + k * 0.5);
    ring.material.opacity = 0.55 * (1 - k);
  } else ring.visible = false;
  if (beam.visible && view.winLine) {
    const line = view.winLine.map((c) => cellPos(c, new THREE.Vector3()));
    line.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    const a = line[0], b = line[3];
    tmpV.subVectors(b, a);
    const len = tmpV.length() + 0.9;
    const grow = reduceMotion ? 1 : easeOutCubic(Math.min(1, (now - beamBorn) / 500));
    beam.position.addVectors(a, b).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(tmpV2.set(0, 1, 0), tmpV.normalize());
    beam.scale.set(1, len * grow, 1);
    const c = COLORS[view.winner] ?? new THREE.Color(0xffffff);
    beamCore.material.color.copy(c).lerp(new THREE.Color(0xffffff), 0.5);
    beamGlow.material.color.copy(c);
    beamGlow.material.opacity = 0.22 + 0.1 * Math.sin(now / 200);
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
requestAnimationFrame(loop);

// Picking: nearest empty cell centre to the pointer ray.
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = -1, bestT = Infinity;
  for (let i = 0; i < CELLS; i++) {
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

const cf = $("confetti");
const cctx = cf.getContext("2d");
let confetti = [];
function burst(colors) {
  if (reduceMotion) return;
  const w = (cf.width = innerWidth * devicePixelRatio), h = (cf.height = innerHeight * devicePixelRatio);
  for (let i = 0; i < 160; i++) {
    const a = Math.random() * Math.PI * 2, v = (6 + Math.random() * 10) * devicePixelRatio;
    confetti.push({
      x: w / 2, y: h * 0.42, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 8 * devicePixelRatio,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      s: (5 + Math.random() * 6) * devicePixelRatio, c: colors[i % colors.length], life: 1,
    });
  }
  requestAnimationFrame(tickConfetti);
}
function tickConfetti() {
  cctx.clearRect(0, 0, cf.width, cf.height);
  confetti = confetti.filter((p) => p.life > 0);
  for (const p of confetti) {
    p.vy += 0.35 * devicePixelRatio; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= 0.008;
    cctx.save(); cctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
    cctx.translate(p.x, p.y); cctx.rotate(p.r); cctx.fillStyle = p.c;
    cctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); cctx.restore();
  }
  if (confetti.length) requestAnimationFrame(tickConfetti);
}

/* ───────────────────────────── backends ───────────────────────────── */

// Each backend: { start(onEvents), save(fields) -> Promise<event>, me, signedIn }
function demoBackend() {
  const events = [];
  let ts = Date.now(), n = 0;
  const mk = (author, authorName, kind, extra = {}) => ({
    recordName: `demo-${++n}`, author, authorName, kind, round: 0, cell: -1, text: "", ts: ++ts, ...extra,
  });
  events.push(mk("demo-x", "Coral", "join", { text: "Coral" }), mk("demo-o", "Teal", "join", { text: "Teal" }));
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
    text: v("text", ""), author: v("author", ""), authorName: v("authorName", ""), ts: Number(v("ts", 0)),
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
    const tick = async () => {
      try { if (await fetchNew()) onEvents([...seen.values()]); }
      catch (err) { onError(err); }
      setTimeout(tick, document.hidden ? 8000 : 3000);
    };
    tick();
  };
  be.pending = new Map();
  be.save = async (f) => {
    const record = {
      recordType: "Event",
      fields: {
        game: { value: GAME_ID }, kind: { value: f.kind }, round: { value: f.round ?? 0 },
        cell: { value: f.cell ?? -1 }, text: { value: f.text ?? "" }, author: { value: f.author },
        authorName: { value: f.authorName ?? "" }, ts: { value: Date.now() },
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

function myRole() { return backend?.me ? roleOf(state, backend.me) : null; }
function myName() { return store.get("ttc.name") || ""; }
function nameOf(role) { return state.players[role]?.name || (role === "X" ? "Player X" : "Player O"); }
const bothJoined = () => state.players.X && state.players.O;

ui.canPlace = () => {
  const r = myRole();
  return !!(r && bothJoined() && !state.winner && state.turn === r && !busy);
};

ui.onTapCell = (cell) => {
  if (cell < 0) { if (preview >= 0) setPreview(-1); return; }
  if (!ui.canPlace()) { nudge(); return; }
  if (preview === cell) commitMove();
  else setPreview(cell, myRole());
};
ui.onPreviewChanged = () => render();

function nudge() {
  const s = $("status");
  s.animate?.([{ translate: "0 0" }, { translate: "-4px 0" }, { translate: "4px 0" }, { translate: "0 0" }], { duration: 240, easing: "ease-out" });
}

async function send(fields) {
  const f = { author: backend.me, authorName: myName() || nameOf(myRole() ?? "X"), round: state.round, cell: -1, text: "", ...fields };
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

function ingest(list) {
  events = sortEvents(list);
  const prev = state;
  state = fold(events);
  syncBoard(state);

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
  if (wk && wk !== lastWinnerKey && loaded) {
    if (state.winner !== "draw") {
      burst(state.winner === "X" ? ["#ff6b5b", "#ffb4a8", "#ffd166", "#ffffff"] : ["#2ec4b6", "#a6f4ea", "#ffd166", "#ffffff"]);
      const el = $("score" + state.winner);
      el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
      navigator.vibrate?.([20, 40, 20]);
    }
  }
  lastWinnerKey = wk;
  if (!loaded) loaded = true;
  render();
  maybeAskToJoin();
}

let statusError = null;
function showStatusError(msg) { statusError = msg; render(); setTimeout(() => { statusError = null; render(); }, 4000); }

function render() {
  const role = myRole();
  $("nameX").textContent = state.players.X?.name || "Waiting…";
  $("nameO").textContent = state.players.O?.name || "Waiting…";
  $("scoreX").textContent = state.score.X;
  $("scoreO").textContent = state.score.O;
  $("round").textContent = `Round ${state.round + 1}`;
  $("pX").classList.toggle("active", !!bothJoined() && !state.winner && state.turn === "X");
  $("pO").classList.toggle("active", !!bothJoined() && !state.winner && state.turn === "O");

  let turn = "—";
  if (state.winner === "draw") turn = "Draw";
  else if (state.winner) turn = `${nameOf(state.winner)} wins`;
  else if (bothJoined()) turn = role === state.turn ? "Your move" : `${nameOf(state.turn)}’s move`;
  $("turn").textContent = turn;

  let status;
  if (statusError) status = statusError;
  else if (!loaded) status = "Loading game…";
  else if (!bothJoined()) status = role === "X" ? "Waiting for your friend to open the link…" : backend?.signedIn ? "Joining…" : "A seat is open — sign in with Apple to play.";
  else if (state.winner) {
    const other = role === "X" ? "O" : "O" === role ? "X" : null;
    if (role && state.ready[role] && other && !state.ready[other]) status = `Waiting for ${nameOf(other)} to accept…`;
    else if (role && other && state.ready[other]) status = `${nameOf(other)} wants another round.`;
    else if (state.winner === "draw") status = "The cube is full — it’s a draw.";
    else status = role === state.winner ? "You got four in a row! 🎉" : role ? `${nameOf(state.winner)} got four in a row.` : `${nameOf(state.winner)} wins round ${state.round + 1}.`;
  } else if (!role) status = `Watching ${nameOf("X")} vs ${nameOf("O")}.`;
  else if (state.turn === role) status = preview >= 0 ? "Tap again to place — or pick another slot." : "Your move — spin the cube and tap a slot.";
  else status = `Waiting for ${nameOf(state.turn)}…`;
  if (backend?.demo && loaded && !state.winner) status = `${nameOf(state.turn)}’s move (pass-and-play demo)` + (preview >= 0 ? " — tap again to place." : "");
  $("status").textContent = status;

  $("placeBtn").hidden = !(preview >= 0 && ui.canPlace());
  const canAgain = role && state.winner && !state.ready[role];
  const other = role === "X" ? "O" : "X";
  $("againBtn").hidden = !canAgain;
  $("againBtn").textContent = canAgain && state.ready[other] ? "Accept rematch" : "Play again";
  $("chat").hidden = !(role && bothJoined());
  $("signin").hidden = !!backend?.signedIn || backend?.demo || !backend;
}

function toast(e) {
  const role = roleOf(state, e.author);
  const el = document.createElement("div");
  el.className = `toast ${role === "X" ? "x" : "o"}${e.author === backend?.me ? " mine" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = e.author === backend?.me && !backend.demo ? "You" : (e.authorName || nameOf(role));
  el.append(who, document.createTextNode(e.text));
  const box = $("toasts");
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, 4200);
}

let asking = false;
function maybeAskToJoin() {
  if (!backend || backend.demo || !backend.signedIn || !loaded || asking) return;
  if (myRole() || bothJoined()) return;
  const name = myName();
  if (name) { asking = true; send({ kind: "join", text: name }).finally(() => { asking = false; }); return; }
  asking = true;
  const dlg = $("nameDialog");
  dlg.showModal();
  dlg.addEventListener("close", () => {
    const v = $("nameInput").value.trim().slice(0, 24);
    if (v) { store.set("ttc.name", v); send({ kind: "join", text: v }).finally(() => { asking = false; }); }
    else asking = false;
  }, { once: true });
}

// Controls
$("placeBtn").addEventListener("click", () => { if (preview >= 0) commitMove(); });
$("againBtn").addEventListener("click", () => send({ kind: "again" }));
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button"; b.textContent = p;
  b.addEventListener("click", () => send({ kind: "say", text: p }));
  $("chips").append(b);
}
$("sayForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("sayInput").value.trim().slice(0, 80);
  if (!v) return;
  $("sayInput").value = "";
  send({ kind: "say", text: v });
});
for (const id of ["getApp", "get-app-landing"]) $(id).addEventListener("click", (e) => e.preventDefault());

/* ───────────────────────────── boot ───────────────────────────── */

async function boot() {
  if (!GAME_ID && !DEMO) {
    $("landing").hidden = false;
    $("legalLanding").hidden = false;
    controls.autoRotate = !reduceMotion;
    // Decorative position on the landing cube.
    const deco = [0, 21, 42, 63, 5, 26, 47, 12].map((c, i) => ({ recordName: "d" + i, kind: "move", author: i % 2 ? "o" : "x", round: 0, cell: c, ts: i + 10 }));
    syncBoard(fold([{ recordName: "a", kind: "join", author: "x", ts: 1 }, { recordName: "b", kind: "join", author: "o", ts: 2 }, ...deco]));
    return;
  }
  $("hud").hidden = false;
  $("openApp").href = `tictaccube://g/${GAME_ID}`;
  $("openApp").hidden = DEMO;
  if (DEMO) {
    backend = demoBackend();
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
