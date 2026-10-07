// Live, slowly turning 3-D previews for the home carousel: one small scene per game,
// with the same glass, lighting and pieces as the game pages. Only the visible page renders.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { fold, geometry, hexOf, resolveColors } from "./game.js";
import * as P from "./popgame.js";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const plateMat = new THREE.MeshStandardMaterial({
  color: 0x5b6fb8, transparent: true, opacity: 0.08, roughness: 0.35, metalness: 0,
  envMapIntensity: 0.15, depthWrite: false, side: THREE.DoubleSide,
});
const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fb2ec, transparent: true, opacity: 0.12, depthWrite: false });
const slotMat = new THREE.MeshStandardMaterial({ color: 0xc9d3f5, emissive: 0x6f84d6, emissiveIntensity: 0.18, transparent: true, opacity: 0.4, roughness: 0.35 });
const pearlMat = new THREE.MeshPhysicalMaterial({ color: 0xe9ecf8, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 });
const glossy = new Map();
function glossyMat(hex) {
  if (!glossy.has(hex)) glossy.set(hex, new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.16, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.06 }));
  return glossy.get(hex);
}
const letterMats = new Map();
function letterMat(t) {
  if (letterMats.has(t)) return letterMats.get(t);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const shown = t === "qu" ? "Qu" : t.toUpperCase();
  g.font = `700 ${shown.length > 1 ? 58 : 76}px ui-rounded, "SF Pro Rounded", Inter, system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#141a38";
  g.fillText(shown, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, toneMapped: false });
  letterMats.set(t, m);
  return m;
}

/** A tic-tac-toe position that never shows a finished line (same idea as iOS Match.showcase). */
function showcase(n, xColor) {
  const g = geometry(n), c = Math.floor(n / 2);
  const cells = [g.idx(c, c, c), g.idx(0, 0, 0), g.idx(c, n - 1, c), g.idx(n - 1, n - 1, n - 1), g.idx(0, c, n - 1),
    g.idx(n - 1, 0, 0), g.idx(c, 0, c), g.idx(0, n - 1, 0), g.idx(n - 1, c, c)];
  let evs = [{ recordName: "a", kind: "join", author: "x", ts: 1, cell: n, color: xColor },
             { recordName: "b", kind: "join", author: "o", ts: 2, color: resolveColors(xColor, xColor === "teal" ? "coral" : "teal").O }];
  let t = 10;
  for (const cell of [...new Set(cells)]) {
    const s0 = fold(evs);
    const next = [...evs, { recordName: "m" + t, kind: "move", author: s0.turn === "X" ? "x" : "o", round: 0, cell, ts: t++ }];
    if (!fold(next).winner) evs = next;
  }
  return fold(evs);
}

/**
 * kind: "ttt" | "words" | "pop". `getWordPuzzle(n)` → Promise<Puzzle> for the words preview.
 * Returns { setSize(n), setActive(on), resize() }.
 */
export function createPreview(canvas, kind, { color = "coral", getWordPuzzle } = {}) {
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
  const pivot = new THREE.Group();
  pivot.rotation.set(0.42, -0.62, 0, "XYZ");
  const spin = new THREE.Group();
  spin.add(pivot);
  scene.add(spin);
  const labels = [];
  let n = 4, active = false, raf = 0, token = 0, extent = 4;

  function clear() {
    for (const o of [...pivot.children]) pivot.remove(o);
    for (const l of labels) scene.remove(l.sprite);
    labels.length = 0;
  }
  function plates(count, pitch, gap, offset) {
    const side = pitch * count;
    const geo = new THREE.BoxGeometry(side, 0.02, side);
    for (let y = 0; y < count; y++) {
      const p = new THREE.Mesh(geo, plateMat);
      p.position.y = (y - (count - 1) / 2) * gap - offset;
      p.renderOrder = 10;
      p.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
      pivot.add(p);
    }
  }

  async function build() {
    const my = ++token;
    if (kind === "ttt") {
      clear();
      const s = showcase(n, color), mid = (n - 1) / 2, gap = 1.25;
      plates(n, 1, gap, 0.36);
      const slot = new THREE.SphereGeometry(0.085, 20, 14), piece = new THREE.SphereGeometry(n >= 5 ? 0.28 : 0.3, 40, 28);
      const g = geometry(n);
      for (let i = 0; i < g.cells; i++) {
        const [x, y, z] = g.coords(i), who = s.board[i];
        const m = new THREE.Mesh(who ? piece : slot, who ? glossyMat(hexOf(s.colors[who])) : slotMat);
        m.position.set(x - mid, (y - mid) * gap, z - mid);
        pivot.add(m);
      }
      extent = Math.hypot(n, n, n * gap) * 0.5;
    } else if (kind === "pop") {
      clear();
      const b = P.startBoard(n, 11n), mid = (n - 1) / 2, pitch = 0.82;
      plates(n, pitch, pitch, 0.33);
      const sphere = new THREE.SphereGeometry(n >= 5 ? 0.25 : 0.29, 36, 24);
      b.cells.forEach((o, i) => {
        const [x, y, z] = P.cube(n).coords(i);
        const m = new THREE.Mesh(sphere, glossyMat(hexOf(P.POP_COLORS[o.color])));
        m.position.set((x - mid) * pitch, (y - mid) * pitch, (z - mid) * pitch);
        pivot.add(m);
      });
      extent = Math.hypot(n, n, n) * pitch * 0.5 + 0.2;
    } else {
      const puzzle = await getWordPuzzle?.(n);
      if (my !== token || !puzzle) return;
      clear();
      const mid = (n - 1) / 2, gap = 1.25, r = n >= 5 ? 0.24 : 0.27;
      plates(n, 1, gap, 0.36);
      const sphere = new THREE.SphereGeometry(r, 36, 24);
      for (let i = 0; i < puzzle.cells; i++) {
        const t = puzzle.tiles[i];
        if (t == null) continue;
        const [x, y, z] = puzzle.coords(i);
        const m = new THREE.Mesh(sphere, pearlMat);
        m.position.set(x - mid, (y - mid) * gap, z - mid);
        pivot.add(m);
        const s = new THREE.Sprite(letterMat(t));
        s.renderOrder = 20;
        scene.add(s);
        labels.push({ sprite: s, node: m, r });
      }
      extent = Math.hypot(n, n, n * gap) * 0.5;
    }
    resize();
    if (!active) draw();
  }

  const wp = new THREE.Vector3(), dir = new THREE.Vector3();
  function draw() {
    spin.updateMatrixWorld(true);
    for (const l of labels) {
      l.node.getWorldPosition(wp);
      dir.copy(camera.position).sub(wp).normalize();
      l.sprite.position.copy(wp).addScaledVector(dir, l.r * 1.02);
      l.sprite.scale.setScalar(n >= 5 ? 0.34 : 0.38);
    }
    renderer.render(scene, camera);
  }
  function loop() {
    if (!active) return;
    if (!reduceMotion) spin.rotation.y += 0.0035;
    draw();
    raf = requestAnimationFrame(loop);
  }
  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const R = extent * 0.92;
    const fit = Math.min(1, camera.aspect);
    camera.position.set(0, 0, R / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / fit + R * 0.3);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    draw();
  }
  new ResizeObserver(resize).observe(canvas);

  build();
  return {
    setSize(next) { if (next !== n) { n = next; build(); } },
    setColor(c) { if (c !== color) { color = c; if (kind === "ttt") build(); } },
    setActive(on) {
      if (on === active) return;
      active = on;
      cancelAnimationFrame(raf);
      if (on) loop();
    },
    resize,
  };
}
