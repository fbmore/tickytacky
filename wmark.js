// The Wubee W, live in 3-D: glass beads (a clear glossy shell around a glowing coral core, with a glint)
// joined by glowing bonds. It builds itself like the app's launch splash: beads pop in along the stroke,
// the bonds trace through them, and the W turns to face you, then sways gently.
// Same layout and look as ios/TicTacCube/Splash/SplashView.swift (WubeeMarkScene) and the app icon.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const STROKES = [
  [[0, 0], [0, 1], [0, 2], [0, 3], [1, 4], [2, 3], [3, 4], [4, 3], [4, 2], [4, 1], [4, 0]],
  [[2, 3], [2, 2]],
];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const point = ([c, r]) => new THREE.Vector3(c - 2, 2 - r, 0);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Draws the W into `canvas`. Returns { play() } to run the build again (e.g. when it comes into view). */
export function wMark(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-4, 7, 8);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.35));
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, -0.05, 11.6);

  const coral = 0xff6b5b;
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0xffd6d0, transparent: true, opacity: 0.14, roughness: 0.03, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6, depthWrite: false,
  });
  const coreMat = new THREE.MeshStandardMaterial({ color: coral, emissive: coral, emissiveIntensity: 0.32, roughness: 0.3 });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const bondCore = new THREE.MeshBasicMaterial({ color: 0xffede6 });
  const bondSleeve = new THREE.MeshBasicMaterial({ color: 0xff8c7a, transparent: true, opacity: 0.35, depthWrite: false });

  const shellGeo = new THREE.SphereGeometry(0.42, 48, 32);
  const coreGeo = new THREE.SphereGeometry(0.28, 32, 24);
  const glintGeo = new THREE.SphereGeometry(0.07, 12, 8);

  const w = new THREE.Group();
  scene.add(w);

  // Beads, in stroke order.
  const order = [];
  for (const stroke of STROKES) for (const p of stroke) if (!order.some((q) => q[0] === p[0] && q[1] === p[1])) order.push(p);
  const beads = order.map((p) => {
    const bead = new THREE.Group();
    const shell = new THREE.Mesh(shellGeo, shellMat); shell.renderOrder = 2;
    const glint = new THREE.Mesh(glintGeo, glintMat);
    glint.scale.set(1.4, 0.8, 0.4); glint.position.set(-0.17, 0.22, 0.33); glint.rotation.z = 0.6; glint.renderOrder = 3;
    bead.add(new THREE.Mesh(coreGeo, coreMat), shell, glint);
    bead.position.copy(point(p));
    w.add(bead);
    return bead;
  });

  // Bonds: a hot core in a coral sleeve, scaled along their length as they trace in.
  const bonds = [];
  for (const stroke of STROKES) {
    for (let i = 1; i < stroke.length; i++) {
      const a = point(stroke[i - 1]), b = point(stroke[i]);
      const len = a.distanceTo(b);
      const bond = new THREE.Group();
      bond.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, len, 24), bondCore));
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, len, 24), bondSleeve); sleeve.renderOrder = 1;
      bond.add(sleeve);
      bond.position.copy(a.clone().add(b).multiplyScalar(0.5)).setZ(-0.01);
      bond.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      w.add(bond);
      bonds.push(bond);
    }
  }

  const popAt = (k) => 0.15 + k * 0.06;
  const bondsStart = popAt(beads.length) + 0.2;
  const bondAt = (k) => bondsStart + k * 0.07;
  const settled = bondAt(bonds.length) + 0.25;

  let start = performance.now() / 1000 - (reduceMotion ? settled : 0);
  let visible = false;

  function pose(t) {
    beads.forEach((b, k) => b.scale.setScalar(Math.max(0.001, easeOutBack(clamp01((t - popAt(k)) / 0.28)))));
    bonds.forEach((b, k) => { const p = clamp01((t - bondAt(k)) / 0.14); b.scale.set(1, Math.max(0.001, p), 1); b.visible = p > 0; });
    const turn = easeOut(clamp01(t / settled));
    const sway = reduceMotion ? 0 : Math.sin((t - settled) * 0.7) * 0.16 * clamp01((t - settled) / 1.2);
    w.rotation.set(0.18 * (1 - turn), -0.55 * (1 - turn) + (t > settled ? sway : 0), 0);
  }

  function resize() {
    const { clientWidth: cw, clientHeight: ch } = canvas;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * renderer.getPixelRatio())) renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  }

  function frame() {
    if (!visible) return;
    resize();
    const t = performance.now() / 1000 - start;
    pose(t);
    renderer.render(scene, camera);
    // Reduced motion: one still frame. Otherwise keep going for the sway.
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  new IntersectionObserver(([e]) => {
    const was = visible;
    visible = e.isIntersecting;
    if (visible && !was) requestAnimationFrame(frame);
  }).observe(canvas);
  addEventListener("resize", () => { if (visible && reduceMotion) requestAnimationFrame(frame); });

  return {
    play() {
      if (reduceMotion) return;
      start = performance.now() / 1000;
    },
  };
}
