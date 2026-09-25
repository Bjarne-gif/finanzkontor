/* ============================================================
   KI — Reaktor-Münze im Konfig-Fenster (WebGL, three.js r128).
   Echte, glatte Körper mit Licht, Metall-Reflexen und Schatten;
   Leiterbahnen graviert, darunter optional ein Elektronik-Werk
   unter Glas. three.js wird erst beim ersten Öffnen geladen
   (js/vendor/three.min.js, lokal – kein Internet nötig).
   Ohne WebGL liefert makeCoin3D null → Aufrufer zeigt den flachen Reaktor.
   ============================================================ */
import { AREAS, R_DIM, R_BLOCK_OFF, R_NSEG, rPol, angleOf, modelLabel, branchLines, PADS, FLOW, FILLER } from "./ai_shared.js";

/* three.js bei Bedarf nachladen (einmalig) */
let _threeP = null;
export function loadThree() {
  if (window.THREE) return Promise.resolve(window.THREE);
  if (!_threeP) _threeP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "js/vendor/three.min.js";
    s.onload = () => (window.THREE ? res(window.THREE) : rej(new Error("three.js fehlt")));
    s.onerror = () => { _threeP = null; rej(new Error("three.js konnte nicht geladen werden")); };
    document.head.appendChild(s);
  });
  return _threeP;
}
/* ============================================================
   Reaktor-Münze in WebGL (three.js r128).
   Echte, glatte Körper mit Licht, Metall-Reflexen und Schatten.
   Design-Koordinaten wie das SVG (0..100), 1 Szenen-Einheit = Radius.
   ============================================================ */
const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
const V3 = (x, y, z) => new THREE.Vector3((x - 50) / 50, -(y - 50) / 50, z);
const Z = { face:.07, ring:.074, pearl:.08, trace:.0735, block:.066 };
const DEG = Math.PI / 180;
/* Bereichsfarbe für 3D etwas satter (Licht + Tonemapping machen sie sonst blass) */
const SAT = (hex) => { const c = C(hex), h = {}; c.getHSL(h); return c.setHSL(h.h, Math.min(1, h.s * 1.15 + .04), Math.min(h.l * .85, .52)); };

/* Mock-Schalter: Glasboden mit Elektronik-Werk darunter (an/aus) */
/* Münz-Einstellungen (Zahnrad-Menü unten rechts auf der Bühne), gemerkt im Browser:
   fk_ai_coin_glass = "an"|"aus" (Standard an), fk_ai_coin_werk = "dezent"|"kraeftig" (Standard dezent) */
export const LS_COIN = { glass: "fk_ai_coin_glass", werk: "fk_ai_coin_werk" };
let GLASS = true, STRONG = false;
export function readCoinSettings(){
  try { GLASS = localStorage.getItem(LS_COIN.glass) !== "aus"; STRONG = localStorage.getItem(LS_COIN.werk) === "kraeftig"; }
  catch (_) { GLASS = true; STRONG = false; }
  return { glass: GLASS ? "an" : "aus", werk: STRONG ? "kraeftig" : "dezent" };
}
readCoinSettings();

/* opts: { onMaster(), onArea(id), onHover(id|null), getModel() } */
export function makeCoin3D(host, opts = {}){
  if (!window.THREE) return null;
  const onMaster = opts.onMaster || (() => {}), onArea = opts.onArea || (() => {});
  const onHover = opts.onHover || (() => {}), getModel = opts.getModel || (() => "");
  const SOON = new Set(AREAS.filter((a) => a.soon).map((a) => a.id));   // ausgegraut, nicht schaltbar
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, powerPreference:"high-performance" }); }
  catch (_) { return null; }
  host.appendChild(canvas);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, .1, 50); camera.position.set(0, 0, 5.4);

  /* --- Umgebung für die Metall-Reflexe: kleines Fotostudio mit Softboxen --- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ color:C("#16140f"), side:THREE.BackSide })));
  const soft = (w, h, x, y, z, col, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color:C(col).multiplyScalar(k), side:THREE.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m); };
  soft(9, 5, -5, 6, 6, "#fff0d4", 3.0);    // große warme Softbox oben links
  soft(3, 9, 7, 0, 4, "#dce6ff", 1.2);     // schmale kühle Kante rechts
  soft(12, 3, 0, -7, 3, "#3b3226", 1.0);   // warmer Boden-Reflex
  soft(8, 8, 0, 3, -8, "#ffffff", .5);
  scene.environment = pmrem.fromScene(env, .04).texture;

  /* --- Licht + Schatten auf der Rückwand --- */
  scene.add(new THREE.AmbientLight(0xffffff, .12));
  const key = new THREE.DirectionalLight(0xfff1dc, 1.5); key.position.set(-1.5, 2.0, 4.8); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left:-2, right:2, top:2, bottom:-2, near:.5, far:12 });
  key.shadow.bias = -.0006;
  scene.add(key);
  const rimLight = new THREE.DirectionalLight(0xcfdcff, .35); rimLight.position.set(3, -1, 1.5); scene.add(rimLight);
  const shadowWall = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity:.3 }));
  shadowWall.position.z = -.85; shadowWall.receiveShadow = true; scene.add(shadowWall);

  const root = new THREE.Group(); scene.add(root);
  const cast = (m) => { m.castShadow = true; return m; };

  /* --- Münzkörper: gedrehtes Profil mit gerundetem Rand --- */
  const gold = new THREE.MeshStandardMaterial({ color:C("#cdb783"), metalness:1, roughness:.3, side:THREE.DoubleSide });
  const prof = [[GLASS ? .5 : 0, .07],[.915,.07],[.928,.08],[.945,.095],[.972,.097],[.99,.087],[1,.066],[1,-.066],[.99,-.087],[.972,-.097],[.945,-.095],[.928,-.08],[.915,-.07],[0,-.07]]
    .map(([r, z]) => new THREE.Vector2(r, z));
  const body = new THREE.LatheGeometry(prof, 200); body.rotateX(Math.PI / 2);
  const bodyMesh = cast(new THREE.Mesh(body, gold)); root.add(bodyMesh);

  // Riffelung am Rand: feine Rillen als Normal-Map-Ersatz über einen zweiten, leicht größeren Ring
  const reedTex = (() => { const c = document.createElement("canvas"); c.width = 512; c.height = 8; const x = c.getContext("2d");
    for (let i = 0; i < 512; i++){ const v = 150 + 90 * Math.sin(i / 512 * Math.PI * 2 * 128); x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, 0, 1, 8); }
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; return t; })();
  const edge = new THREE.CylinderGeometry(1.0005, 1.0005, .128, 200, 1, true); edge.rotateX(Math.PI / 2);
  const edgeMesh = new THREE.Mesh(edge, new THREE.MeshStandardMaterial({ color:C("#cdb783"), metalness:1, roughness:.38, roughnessMap:reedTex, bumpMap:reedTex, bumpScale:.004 }));
  root.add(edgeMesh);

  /* Gravur: Rillen mit feiner Goldkante in der schwarzen Fläche (Farb- + Relief-Textur) */
  function engraveFace(){
    const S = 2048, k = S / (2 * 45.75), P = ([X, Y]) => [(X - 50) * k + S / 2, (Y - 50) * k + S / 2];
    const col = document.createElement("canvas"), bump = document.createElement("canvas"); col.width = col.height = bump.width = bump.height = S;
    const c = col.getContext("2d"), b = bump.getContext("2d");
    const bg = c.createRadialGradient(S / 2, S * .46, S * .05, S / 2, S / 2, S / 2); bg.addColorStop(0, "#1a1610"); bg.addColorStop(1, "#0e0c08");
    c.fillStyle = bg; c.fillRect(0, 0, S, S); b.fillStyle = "#fff"; b.fillRect(0, 0, S, S);
    const polys = [], dots = [], soonPolys = [], soonDots = [];
    AREAS.forEach((ar, i) => { const ang = angleOf(i);
      branchLines(ang, i).forEach((l) => (ar.soon ? soonPolys : polys).push(l.p));
      PADS(ang, i).forEach(([r, aa, onRing]) => (ar.soon ? soonDots : dots).push([rPol(r, aa), onRing])); });
    for (let i = 0; i < AREAS.length; i++){ const a = -90 + i * (360 / AREAS.length) + (180 / AREAS.length); polys.push(FILLER(a)); }
    const stroke = (ctx, w, style, list = polys) => { ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = style; ctx.lineWidth = w * k;
      list.forEach((pl) => { ctx.beginPath(); pl.forEach((p, j) => { const [x, y] = P(p); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }); };
    const disc = (ctx, rr, style, list = dots) => { ctx.fillStyle = style; list.forEach(([p]) => { const [x, y] = P(p); ctx.beginPath(); ctx.arc(x, y, rr * k, 0, Math.PI * 2); ctx.fill(); }); };
    // Farbe: Goldkante, darin die dunkle Rille
    stroke(c, 1.75, "#8c7447"); disc(c, 1.35, "#8c7447");
    stroke(c, 1.2, "#070605");  disc(c, .95, "#070605");
    // noch nicht verfügbare Bereiche: matte, ausgegraute Kante
    stroke(c, 1.75, "#3f3526", soonPolys); disc(c, 1.35, "#3f3526", soonDots);
    stroke(c, 1.2, "#0a0907", soonPolys);  disc(c, .95, "#0a0907", soonDots);
    // Relief: Rille tiefer (dunkel), weich auslaufend
    b.filter = "blur(3px)"; stroke(b, 1.35, "#000"); disc(b, 1.05, "#000");
    stroke(b, 1.35, "#000", soonPolys); disc(b, 1.05, "#000", soonDots); b.filter = "none";
    const tc = new THREE.CanvasTexture(col); tc.encoding = THREE.sRGBEncoding; tc.anisotropy = 8;
    const tb = new THREE.CanvasTexture(bump); tb.anisotropy = 8;
    return { tc, tb };
  }
  const eng = engraveFace();
  // dunkle Einlage vorne, mit Gravur
  const faceMat = new THREE.MeshStandardMaterial({ color:0xffffff, map:eng.tc, bumpMap:eng.tb, bumpScale:.0045, metalness:.55, roughness:.5 });
  const face = new THREE.Mesh(GLASS ? new THREE.RingGeometry(.5, .915, 160, 1) : new THREE.CircleGeometry(.915, 160), faceMat); face.position.z = Z.face + .0005; face.receiveShadow = true; root.add(face);

  /* Rückseite: äußerer Ring mit Skala + erhöhtes Plateau in der Mitte mit den Schriften.
     Alles eingraviert: Farb-Textur (vertieft, mit Lichtkante) + Relief-Textur (Bump). */
  const canvas2 = () => { const c = document.createElement("canvas"); c.width = c.height = 1024; return c; };
  const texOf = (c, srgb) => { const t = new THREE.CanvasTexture(c); if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t; };
  const backCanvas = canvas2(), backBumpC = canvas2(), capCanvas = canvas2(), capBumpC = canvas2();
  const backTex = texOf(backCanvas, true), backBump = texOf(backBumpC), capTex = texOf(capCanvas, true), capBump = texOf(capBumpC);
  const back = new THREE.Mesh(new THREE.CircleGeometry(.915, 160),
    new THREE.MeshStandardMaterial({ map:backTex, bumpMap:backBump, bumpScale:.003, metalness:.35, roughness:.5 }));
  back.rotation.y = Math.PI; back.position.z = -Z.face - .0005; root.add(back);
  const PL_R = .72, PL_TOP = .698, PL_H = .022;                     // Plateau: Radius unten/oben, Höhe
  const plProf = [[PL_R, 0], [PL_R - .004, PL_H * .45], [PL_R - .012, PL_H * .85], [PL_TOP, PL_H]]
    .map(([r, h]) => new THREE.Vector2(r, -Z.face - .0005 - h));
  const plSide = new THREE.LatheGeometry(plProf, 200); plSide.rotateX(Math.PI / 2);
  const plMat = new THREE.MeshStandardMaterial({ color:C("#1c1811"), metalness:.6, roughness:.4, side:THREE.DoubleSide });
  const plateauBack = new THREE.Mesh(plSide, plMat); plateauBack.castShadow = true; root.add(plateauBack);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(PL_TOP, 160),
    new THREE.MeshStandardMaterial({ map:capTex, bumpMap:capBump, bumpScale:.004, metalness:.45, roughness:.45 }));
  cap.rotation.y = Math.PI; cap.position.z = -Z.face - .0005 - PL_H; root.add(cap);

  /* --- Glasboden mit Elektronik-Werk (nur wenn GLASS) --- */
  const movement = GLASS ? buildMovement() : null;
  function buildMovement(){
    const FLOOR = .018, W = new THREE.Group(); root.add(W);
    // Kammer: Wand + Boden
    const wallG = new THREE.CylinderGeometry(.5, .5, Z.face - FLOOR, 128, 1, true); wallG.rotateX(Math.PI / 2);
    const wall = new THREE.Mesh(wallG, new THREE.MeshStandardMaterial({ color:C("#6d5a38"), metalness:.9, roughness:.35, side:THREE.BackSide }));
    wall.position.z = (Z.face + FLOOR) / 2; W.add(wall);
    // Platine: feine Leiterbahnen + Vias auf dunklem Grund (Canvas)
    const S = 1024, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d");
    x.fillStyle = STRONG ? "#17130c" : "#100d09"; x.fillRect(0, 0, S, S);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    x.lineCap = x.lineJoin = "round";
    for (let n = 0; n < 170; n++){
      let px = rnd() * S, py = rnd() * S; if (Math.hypot(px - S / 2, py - S / 2) > S * .46) continue;
      x.strokeStyle = STRONG ? (rnd() < .3 ? "#a07a3c" : "#5e4727") : (rnd() < .3 ? "#8a6a36" : "#4d3b22"); x.lineWidth = rnd() < .2 ? 3 : 1.6;
      x.beginPath(); x.moveTo(px, py);
      for (let k = 0; k < 3; k++){ const d = [0, 45, 90, 135, 180, 225, 270, 315][(rnd() * 8) | 0] * DEG, L = 20 + rnd() * 90;
        px += Math.cos(d) * L; py += Math.sin(d) * L; x.lineTo(px, py); }
      x.stroke(); x.fillStyle = STRONG ? "#c9a25c" : "#a8864c"; x.beginPath(); x.arc(px, py, 3.2, 0, Math.PI * 2); x.fill();
    }
    x.strokeStyle = "rgba(205,187,144,.18)"; x.lineWidth = 1.2;
    [.18, .3, .42].forEach((r) => { x.beginPath(); x.arc(S / 2, S / 2, r * S, 0, Math.PI * 2); x.stroke(); });
    const ft = new THREE.CanvasTexture(cv); ft.encoding = THREE.sRGBEncoding; ft.anisotropy = 8;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(.5, 128), new THREE.MeshStandardMaterial({ map:ft, metalness:.35, roughness:.6 }));
    floor.position.z = FLOOR; floor.receiveShadow = true; W.add(floor);
    // Chips: beschriftete Gehäuse mit Pin-1-Markierung, verschiedene Bauformen
    const chipMat = new THREE.MeshStandardMaterial({ color:C("#18181a"), metalness:.25, roughness:.5 });
    const labelTex = (lines, lid) => { const c = document.createElement("canvas"); c.width = c.height = 256; const g = c.getContext("2d");
      if (lid){ const gr = g.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, "#d9c38f"); gr.addColorStop(1, "#8e7a4d"); g.fillStyle = gr; }
      else { const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, "#2a2a2e"); gr.addColorStop(1, "#141416"); g.fillStyle = gr; }
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = lid ? "rgba(40,30,15,.75)" : "rgba(210,200,180,.78)"; g.textAlign = "center";
      g.font = "600 44px 'JetBrains Mono', monospace"; g.fillText(lines[0], 128, 118);
      g.font = "500 30px 'JetBrains Mono', monospace"; g.fillText(lines[1], 128, 166);
      g.beginPath(); g.arc(36, 36, 13, 0, Math.PI * 2); g.fillStyle = lid ? "rgba(40,30,15,.6)" : "rgba(210,200,180,.55)"; g.fill();   // Pin 1
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t; };
    const pinMat = new THREE.MeshStandardMaterial({ color:C("#cdb783"), metalness:1, roughness:.3 });
    const ledMats = [];
    const chip = (cx, cy, w, h, rot, pins, label, lid) => {
      const g = new THREE.Group(); g.position.set(cx, cy, FLOOR); g.rotation.z = rot;
      const top = new THREE.MeshStandardMaterial({ map:labelTex(label, lid), metalness:lid ? .9 : .25, roughness:lid ? .3 : .5 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, .014), [chipMat, chipMat, chipMat, chipMat, top, chipMat]); b.position.z = .007; b.castShadow = true; g.add(b);
      const pg = new THREE.BoxGeometry(.004, .012, .003);
      const sides = pins > 0 ? 4 : 2, np = Math.abs(pins);                                  // pins < 0: nur zwei Seiten (SOIC)
      for (let k = 0; k < np; k++){ const tw = ((k + .5) / np - .5) * w, th = ((k + .5) / np - .5) * h;
        [[tw, h / 2 + .005, 0], [tw, -h / 2 - .005, 0], [w / 2 + .005, th, Math.PI / 2], [-w / 2 - .005, th, Math.PI / 2]].slice(0, sides).forEach(([px, py, rz]) => {
          const pm = new THREE.Mesh(pg, pinMat); pm.position.set(px, py, .002); pm.rotation.z = rz; g.add(pm); }); }
      const lm = new THREE.MeshStandardMaterial({ color:C("#3a2a10"), emissive:C("#ffb347"), emissiveIntensity:0 });
      const led = new THREE.Mesh(new THREE.CircleGeometry(.0055, 12), lm); led.position.set(w * .32, h * .32, .0145); g.add(led);
      ledMats.push({ m:lm, ph:rnd() * 6.28, sp:.4 + rnd() * .9 });
      W.add(g);
    };
    // nur in den Lücken zwischen den Strängen, außerhalb der Encoder-Scheibe
    const CHIPS = [
      { w:.09,  h:.09,  pins:8,  label:["KNTR", "26·A7"], lid:false, r:.34 },
      { w:.075, h:.075, pins:0,  label:["FK", "AI·01"],   lid:true,  r:.34 },
      { w:.085, h:.06,  pins:-6, label:["LDG", "0x3F"],   lid:false, r:.335 },
      { w:.08,  h:.08,  pins:7,  label:["VTR", "Q-12"],   lid:false, r:.34 },
      { w:.07,  h:.07,  pins:0,  label:["NPU", "7B"],     lid:true,  r:.34 },
    ];
    CHIPS.forEach((c, i) => { const a = (-90 + i * 72 + 36) * -DEG;
      chip(Math.cos(a) * c.r, Math.sin(a) * c.r, c.w, c.h, a + Math.PI / 2, c.pins, c.label, c.lid); });
    // Encoder-Scheibe: dreht sich langsam, mit Lichtschranke
    const ec = document.createElement("canvas"); ec.width = ec.height = 512; const e = ec.getContext("2d");
    e.clearRect(0, 0, 512, 512); e.fillStyle = STRONG ? "rgba(222,200,150,.92)" : "rgba(205,187,144,.55)"; e.beginPath(); e.arc(256, 256, 250, 0, Math.PI * 2); e.arc(256, 256, 60, 0, Math.PI * 2, true); e.fill();
    e.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 72; k++){ e.save(); e.translate(256, 256); e.rotate(k / 72 * Math.PI * 2); e.fillRect(-4, 190, 8, 50); e.restore(); }
    for (let k = 0; k < 12; k++){ e.save(); e.translate(256, 256); e.rotate(k / 12 * Math.PI * 2); e.fillRect(-10, 100, 20, 60); e.restore(); }
    const et = new THREE.CanvasTexture(ec); et.encoding = THREE.sRGBEncoding;
    const enc = new THREE.Mesh(new THREE.CircleGeometry(.24, 96), new THREE.MeshStandardMaterial({ map:et, transparent:true, metalness:.7, roughness:.3, side:THREE.DoubleSide }));
    enc.position.z = FLOOR + .03; W.add(enc);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .03, 32), pinMat); hub.rotation.x = Math.PI / 2; hub.position.z = FLOOR + .015; W.add(hub);
    const fork = new THREE.Mesh(new THREE.BoxGeometry(.05, .03, .045), chipMat); fork.position.set(0, -.215, FLOOR + .0225); fork.castShadow = true; W.add(fork);
    const eye = new THREE.MeshStandardMaterial({ color:C("#300"), emissive:C("#ff4a2e"), emissiveIntensity:0 });
    const eyeM = new THREE.Mesh(new THREE.SphereGeometry(.006, 10, 8), eye); eyeM.position.set(.028, -.215, FLOOR + .036); W.add(eyeM);
    // LED-Kranz am Rand der Kammer: ein Lichtpunkt wandert langsam herum
    const leds = [];
    for (let k = 0; k < 36; k++){ const a = k / 36 * Math.PI * 2;
      const m = new THREE.MeshStandardMaterial({ color:C("#2a2010"), emissive:C("#ffcf7a"), emissiveIntensity:0 });
      const l = new THREE.Mesh(new THREE.BoxGeometry(.012, .007, .004), m); l.rotation.z = a; l.position.set(Math.cos(a) * .455, Math.sin(a) * .455, FLOOR + .002); W.add(l); leds.push(m); }
    const glow = new THREE.PointLight(0xffc98a, STRONG ? 1 : .35, .9, 2); glow.position.set(0, 0, FLOOR + .04); W.add(glow);
    // Glas: leicht getönt und spiegelnd, darauf die gravierten Leiterbahnen (Dekor mit Transparenz)
    const glass = new THREE.Mesh(new THREE.CircleGeometry(.5, 128), new THREE.MeshStandardMaterial({ color:C("#b9c6cc"), transparent:true, opacity:STRONG ? .06 : .13, metalness:.9, roughness:.06, envMapIntensity:1.6, depthWrite:false }));
    glass.position.z = Z.face + .0008; root.add(glass);
    const dc = document.createElement("canvas"), DS = 1024; dc.width = dc.height = DS; const d = dc.getContext("2d"), k = DS / 50;
    const P = ([X, Y]) => [(X - 50) * k + DS / 2, (Y - 50) * k + DS / 2];
    const polys = [], dots = [], soonPolys = [], soonDots = [];
    AREAS.forEach((ar, i) => { const ang = angleOf(i); branchLines(ang, i).forEach((l) => (ar.soon ? soonPolys : polys).push(l.p));
      PADS(ang, i).forEach(([r, aa]) => (ar.soon ? soonDots : dots).push(rPol(r, aa))); });
    for (let i = 0; i < AREAS.length; i++) polys.push(FILLER(-90 + i * (360 / AREAS.length) + (180 / AREAS.length)));
    const st = (w, c, list = polys) => { d.lineCap = d.lineJoin = "round"; d.strokeStyle = c; d.lineWidth = w * k;
      list.forEach((pl) => { d.beginPath(); pl.forEach((p, j) => { const [a, b] = P(p); j ? d.lineTo(a, b) : d.moveTo(a, b); }); d.stroke(); }); };
    const dt_ = (r, c, list = dots) => { d.fillStyle = c; list.forEach((p) => { const [a, b] = P(p); d.beginPath(); d.arc(a, b, r * k, 0, Math.PI * 2); d.fill(); }); };
    st(1.75, "rgba(160,132,82,.95)"); dt_(1.35, "rgba(160,132,82,.95)");
    d.globalCompositeOperation = "destination-out"; st(1.2, "#000"); dt_(.95, "#000"); d.globalCompositeOperation = "source-over";
    st(1.2, "rgba(6,5,4,.78)"); dt_(.95, "rgba(6,5,4,.78)");
    st(1.75, "rgba(92,80,58,.8)", soonPolys); dt_(1.35, "rgba(92,80,58,.8)", soonDots);        // ausgegraut
    d.globalCompositeOperation = "destination-out"; st(1.2, "#000", soonPolys); dt_(.95, "#000", soonDots); d.globalCompositeOperation = "source-over";
    st(1.2, "rgba(6,5,4,.78)", soonPolys); dt_(.95, "rgba(6,5,4,.78)", soonDots);
    const dtx = new THREE.CanvasTexture(dc); dtx.encoding = THREE.sRGBEncoding; dtx.anisotropy = 8;
    const decal = new THREE.Mesh(new THREE.CircleGeometry(.5, 128), new THREE.MeshStandardMaterial({ map:dtx, transparent:true, metalness:.6, roughness:.4, depthWrite:false }));
    decal.position.z = Z.face + .0012; root.add(decal);
    return {
      update(t, dt, on){
        enc.rotation.z -= dt * (Math.PI * 2 / 24) * on;                                       // Encoder: eine Runde in 24 s
        eye.emissiveIntensity = on ? (Math.sin(enc.rotation.z * 72) > .6 ? 2.2 : .25) : .05;   // Lichtschranke blinkt mit den Schlitzen
        const head = ((t / 6) % 1) * 36;                                                         // Lauflicht: eine Runde in 6 s
        const LK = STRONG ? 1.8 : 1;
        leds.forEach((m, k2) => { let dd = Math.abs(k2 - head); dd = Math.min(dd, 36 - dd); m.emissiveIntensity = on * (.08 + 2.4 * LK * Math.max(0, 1 - dd / 4)); });
        ledMats.forEach((o) => { o.m.emissiveIntensity = on * Math.max(0, Math.sin(t * o.sp + o.ph)) * 1.6 * LK; });
        glow.intensity = (STRONG ? .3 : .1) + (STRONG ? .8 : .3) * on;
      },
    };
  }

  /* --- feine Goldringe --- */
  /* Plateau: das Perlenband (zwischen den Ringen .5 und .66) liegt erhöht, mit abgeschrägten Kanten */
  const PLAT = .024;
  const platProf = [[.5, 0], [.506, PLAT * .8], [.512, PLAT], [.648, PLAT], [.654, PLAT * .8], [.66, 0]]
    .map(([r, h]) => new THREE.Vector2(r, Z.face + h));
  const platG = new THREE.LatheGeometry(platProf, 200); platG.rotateX(Math.PI / 2);
  const plateau = new THREE.Mesh(platG, new THREE.MeshStandardMaterial({ color:C("#1d1911"), metalness:.6, roughness:.42, side:THREE.DoubleSide }));
  plateau.castShadow = plateau.receiveShadow = true; root.add(plateau);
  [[.74, Z.ring], [.66, Z.face + PLAT * .55], [.5, Z.face + PLAT * .55]].forEach(([r, z]) => {
    const t = new THREE.Mesh(new THREE.TorusGeometry(r, .0068, 10, 160), gold); t.position.z = z; root.add(cast(t)); });

  /* --- Perlen --- */
  const pearlMat = new THREE.MeshStandardMaterial({ color:C("#ffe9b0"), emissive:C("#ffd98a"), emissiveIntensity:1, metalness:.2, roughness:.3 });
  const pearlG = new THREE.SphereGeometry(.024, 20, 14);
  for (let i = 0; i < 24; i++){ const a = i * 15 * DEG; const m = new THREE.Mesh(pearlG, pearlMat);
    m.position.set(Math.cos(a) * .58, Math.sin(a) * .58, Z.face + PLAT + .008); m.scale.z = .75; root.add(cast(m)); }

  /* --- Rand-Blöcke: abgerundete Klötze, drehen als Ganzes --- */
  const blockGroup = new THREE.Group(); root.add(blockGroup);
  const span = (360 / R_NSEG) * .6 * DEG;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, .955, -span / 2, span / 2, false); shape.absarc(0, 0, .805, span / 2, -span / 2, true);
  const blockG = new THREE.ExtrudeGeometry(shape, { depth:.042, bevelEnabled:true, bevelThickness:.012, bevelSize:.009, bevelSegments:4, curveSegments:18 });
  const blocks = [], bezels = [];
  // Fassung: goldener Rahmen mit Aussparung in Blockform (dreht mit, Block sitzt darin)
  const bezelShape = (() => {
    const mo = .03, mh = .007, ro = [.779, .983], rh = [.791, .969];
    const sh = new THREE.Shape();
    sh.absarc(0, 0, ro[1], -span / 2 - mo, span / 2 + mo, false); sh.absarc(0, 0, ro[0], span / 2 + mo * 1.2, -span / 2 - mo * 1.2, true);
    const hole = new THREE.Path();
    hole.absarc(0, 0, rh[1], -span / 2 - mh, span / 2 + mh, false); hole.absarc(0, 0, rh[0], span / 2 + mh * 1.2, -span / 2 - mh * 1.2, true);
    sh.holes.push(hole); return sh;
  })();
  const bezelG = new THREE.ExtrudeGeometry(bezelShape, { depth:.022, bevelEnabled:true, bevelThickness:.006, bevelSize:.004, bevelSegments:3, curveSegments:24 });
  for (let i = 0; i < R_NSEG; i++){
    const mat = new THREE.MeshStandardMaterial({ color:C(R_BLOCK_OFF), emissive:C("#000000"), metalness:.1, roughness:.58, envMapIntensity:.45 });
    const m = cast(new THREE.Mesh(blockG, mat));
    const am = ((i / R_NSEG) * 360 + (360 / R_NSEG) * .3);         // Mitte wie im SVG (Uhrzeigersinn)
    m.rotation.z = -am * DEG; m.position.z = Z.block;
    m.userData = { kind:"block", idx:i, col:C(R_BLOCK_OFF), emi:0, tCol:C(R_BLOCK_OFF), tEmi:0, startAt:0, from:null };
    blockGroup.add(m); blocks.push(m);
    const bz = cast(new THREE.Mesh(bezelG, gold)); bz.rotation.z = m.rotation.z; bz.position.z = Z.block - .002;
    bz.userData = { kind:"block", idx:i }; blockGroup.add(bz); bezels.push(bz);
  }

  /* --- Leiterbahnen je Bereich --- */
  const dim = C("#6f5d3a");                      // ausgeschaltet: gedämpftes Gold in der Gravur
  const SOON_DIM = C("#3a3124");                 // noch nicht verfügbar: ausgegraut
  const segs = [], flows = [], strandHits = [], areaGroups = {};
  const hitMat = new THREE.MeshBasicMaterial();
  const tubeSeg = (a, b, mat, rad, reg) => {
    const g = new THREE.Group();
    const segN = reg ? Math.max(4, Math.ceil(a.distanceTo(b) / .02)) : 1;       // fein unterteilt, damit sie sich biegen lässt
    const tm = cast(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), segN, rad, 10, false), mat)); g.add(tm);
    if (reg){ tm.frustumCulled = false; reg.push({ geo:tm.geometry, base:Float32Array.from(tm.geometry.attributes.position.array) }); }
    [a, b].forEach((p) => { const s = new THREE.Mesh(new THREE.SphereGeometry(rad, 12, 8), mat); s.position.copy(p); g.add(s);
      if (reg) reg.push({ obj:s, base:p.clone() }); });
    return g;
  };
  /* Anheben wie eine Leiterbahn: innen (am Kern) bleibt sie kleben, nach außen hebt sie sich immer stärker ab */
  const peel = (x, y, L) => { const u = Math.max(0, Math.min(1, (Math.hypot(x, y) - .1) / .4)); return L * .14 * u * u; };
  function applyPeel(reg, L){
    reg.forEach((e) => {
      if (e.geo){ const a = e.geo.attributes.position.array, b = e.base;
        for (let v = 0; v < a.length; v += 3){ a[v + 2] = b[v + 2] + peel(b[v], b[v + 1], L); }
        e.geo.attributes.position.needsUpdate = true; }
      else e.obj.position.z = e.base.z + peel(e.base.x, e.base.y, L);
    });
  }
  AREAS.forEach((ar, i) => {
    const ang = angleOf(i), areaCol = SAT(ar.color), isSoon = SOON.has(ar.id), base = isSoon ? SOON_DIM : dim;
    const ag = new THREE.Group(); ag.userData = { lift:0, applied:0, reg:[] }; root.add(ag); areaGroups[ar.id] = ag;
    branchLines(ang, i).forEach((l) => {
      for (let s = 0; s < l.p.length - 1; s++){
        const a = V3(l.p[s][0], l.p[s][1], Z.trace), b = V3(l.p[s + 1][0], l.p[s + 1][1], Z.trace);
        const mat = new THREE.MeshStandardMaterial({ color:base.clone(), emissive:C("#000000"), metalness:.5, roughness:.4 });
        const g = tubeSeg(a, b, mat, .0068, ag.userData.reg); ag.add(g);
        const r = Math.hypot((l.p[s][0] + l.p[s + 1][0]) / 2 - 50, (l.p[s][1] + l.p[s + 1][1]) / 2 - 50);
        segs.push({ mat, area:ar.id, col:areaCol, base, r, mix:0, target:0, startAt:0 });
      }
    });
    PADS(ang, i).forEach(([r, aa, onRing]) => {
      const [x, y] = rPol(r, aa);
      const mat = new THREE.MeshStandardMaterial({ color:base.clone(), emissive:C("#000000"), metalness:.5, roughness:.35 });
      let pad;
      if (onRing){ pad = cast(new THREE.Mesh(new THREE.CylinderGeometry(.0145, .0145, .008, 24), mat)); pad.rotation.x = Math.PI / 2; }
      else pad = cast(new THREE.Mesh(new THREE.TorusGeometry(.0125, .0042, 10, 24), mat));        // Via: kleiner Ring
      pad.position.copy(V3(x, y, Z.trace)); ag.add(pad);
      ag.userData.reg.push({ obj:pad, base:pad.position.clone() });

      segs.push({ mat, area:ar.id, col:areaCol, base, r, mix:0, target:0, startAt:0 });
    });
    if (isSoon) return;                                   // ausgegraut: kein Datenfluss, nicht anklickbar
    // Datenfluss: kleine Lichtpunkte vom Ast-Ende zum Kern
    const path = new THREE.CurvePath();
    const pts = FLOW(ang, i).map(([x, y]) => V3(x, y, Z.trace + .009));
    for (let k = 0; k < pts.length - 1; k++) path.add(new THREE.LineCurve3(pts[k], pts[k + 1]));
    const fm = new THREE.MeshBasicMaterial({ color:C("#fff6d8") });
    for (let k = 0; k < 3; k++){ const p = new THREE.Mesh(new THREE.SphereGeometry(.0065, 10, 8), fm); p.visible = false; ag.add(p);
      flows.push({ mesh:p, path, area:ar.id, t:k / 3 }); }
    // unsichtbare Trefferfläche: der ganze Sektor des Strangs innerhalb des Goldrings
    const step = 360 / AREAS.length;
    const sec = new THREE.Mesh(new THREE.RingGeometry(.12, .5, 32, 1, (-ang - step / 2) * DEG, step * DEG), hitMat);
    sec.visible = false; sec.position.z = Z.trace + .02; sec.userData = { kind:"area", area:ar.id }; root.add(sec); strandHits.push(sec);
  });
  // neutrale Füll-Bahnen erscheinen nur als Gravur in der Fläche (siehe engraveFace)

  /* --- Kern: Goldfassung + leuchtende Kugel + Schein --- */
  const tube = new THREE.CylinderGeometry(.112, .112, .032, 64, 1, true); tube.rotateX(Math.PI / 2);
  const tubeM = cast(new THREE.Mesh(tube, new THREE.MeshStandardMaterial({ color:C("#cdb783"), metalness:1, roughness:.28, side:THREE.DoubleSide })));
  tubeM.position.z = Z.face + .016; root.add(tubeM);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(.112, .009, 12, 64), gold); lip.position.z = Z.face + .032; root.add(lip);
  const coreMat = new THREE.MeshStandardMaterial({ color:C("#fff8e6"), emissive:C("#fff3d0"), emissiveIntensity:1.2, roughness:.25 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(.056, 32, 20), coreMat); core.position.z = Z.face + .028; core.userData = { kind:"core" }; root.add(core);
  const glowTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(.25, "rgba(255,255,255,.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTex, color:C("#fff0c8"), blending:THREE.AdditiveBlending, depthWrite:false, transparent:true, opacity:.8 }));
  halo.scale.set(.36, .36, 1); halo.position.z = Z.face + .065; root.add(halo);
  const coreHit = new THREE.Mesh(new THREE.CircleGeometry(.12, 24), new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false }));
  coreHit.position.z = Z.face + .08; coreHit.userData = { kind:"core" }; root.add(coreHit);

  /* --- Rückseiten-Gravur --- */
  let backKey = "";
  function arcText(x, text, r, font, spacing, bottom){
    x.save(); x.font = font; x.textAlign = "center"; x.textBaseline = "middle";
    const ws = [...text].map((ch) => x.measureText(ch).width + spacing);
    const total = ws.reduce((s, w) => s + w, 0) - spacing, rot = total / r;
    x.translate(512, 512); x.rotate(bottom ? rot / 2 : -rot / 2);
    [...text].forEach((ch, i) => { const w = ws[i]; x.rotate((bottom ? -1 : 1) * (w - spacing) / 2 / r);
      x.fillText(ch, 0, bottom ? r : -r); x.rotate((bottom ? -1 : 1) * ((w - spacing) / 2 + spacing) / r); });
    x.restore();
  }
  /* Gravur: jede Form wird dreifach gezeichnet – Lichtkante (unten rechts), Schattenkante (oben links),
     dann der vertiefte Grund; dazu dieselbe Form dunkel in der Relief-Textur. */
  function engrave(x, bx, draw){
    const o = 1.6;
    x.save(); x.translate(o, o); x.globalAlpha = .55; draw(x, "#f3dfad"); x.restore();          // Licht fängt sich an der unteren Kante
    x.save(); x.translate(-o, -o); x.globalAlpha = .75; draw(x, "#050403"); x.restore();         // Schatten an der oberen Kante
    x.save(); x.globalAlpha = 1; draw(x, "#6e5b37"); x.restore();                                  // vertiefter Grund (mattes Gold)
    bx.save(); draw(bx, "#000"); bx.restore();
  }
  function softenBump(c){                                    // Relief weich machen: einmal pro Fläche weichzeichnen
    const t = document.createElement("canvas"); t.width = t.height = 1024; const tx = t.getContext("2d");
    tx.filter = "blur(1.2px)"; tx.drawImage(c, 0, 0);
    const x = c.getContext("2d"); x.clearRect(0, 0, 1024, 1024); x.drawImage(t, 0, 0);
  }
  const ringStroke = (r, w) => (c, col) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.arc(512, 512, r, 0, Math.PI * 2); c.stroke(); };
  function drawBack(){
    const year = String(new Date().getFullYear()), name = modelLabel(getModel()) || "—";
    const key = year + "|" + name + "|" + (document.fonts && document.fonts.status);
    if (key === backKey) return; backKey = key;
    const prep = (c, b, inner) => { const x = c.getContext("2d"), bx = b.getContext("2d");
      x.clearRect(0, 0, 1024, 1024);
      const bg = x.createRadialGradient(512, 470, 60, 512, 512, 512);
      bg.addColorStop(0, inner ? "#221d14" : "#1b1811"); bg.addColorStop(1, inner ? "#14110b" : "#0d0b08");
      x.fillStyle = bg; x.fillRect(0, 0, 1024, 1024); bx.fillStyle = "#fff"; bx.fillRect(0, 0, 1024, 1024); return [x, bx]; };

    // äußerer Ring: Linie + Skala (91,5 Einheiten = Durchmesser der Einlage)
    const s = 1024 / 91.5, [x, bx] = prep(backCanvas, backBumpC, false);
    engrave(x, bx, ringStroke(43.5 * s, .5 * s));
    engrave(x, bx, (c, col) => { c.strokeStyle = col; c.lineWidth = .45 * s; c.lineCap = "round";
      for (let i = 0; i < 60; i++){ const a = i * 6 * DEG, r1 = 41.8 * s, r2 = (i % 5 ? 40.5 : 39.3) * s;
        c.beginPath(); c.moveTo(512 + Math.cos(a) * r1, 512 + Math.sin(a) * r1); c.lineTo(512 + Math.cos(a) * r2, 512 + Math.sin(a) * r2); c.stroke(); } });
    softenBump(backBumpC); backTex.needsUpdate = true; backBump.needsUpdate = true;

    // Plateau: Schriften (Oberfläche = Radius PL_TOP → in Einheiten)
    const unitsR = PL_TOP / .915 * 45.75, k = 512 / unitsR, [y, by] = prep(capCanvas, capBumpC, true);
    const txt = (t, r, font, sp, bottom) => (c, col) => { c.fillStyle = col; arcText(c, t, r * k, font, sp * k, bottom); };
    engrave(y, by, txt("FINANZKONTOR", 30.6, `600 ${4.2 * k}px "Space Grotesk", sans-serif`, 1.6, false));
    engrave(y, by, txt(year, 25.8, `500 ${3.2 * k}px "Space Grotesk", sans-serif`, 1.2, false));
    engrave(y, by, txt("created by", 25.8, `500 ${3.2 * k}px "Space Grotesk", sans-serif`, 1.2, true));
    engrave(y, by, txt("Bjarne Rogalski", 30.6, `600 ${4.2 * k}px "Space Grotesk", sans-serif`, 1.4, true));
    const fs = Math.min(16, 140 / Math.max(7, name.length)) * k;
    engrave(y, by, (c, col) => { c.fillStyle = col; c.textAlign = "center"; c.textBaseline = "alphabetic";
      c.font = `${fs}px "Pinyon Script", "Snell Roundhand", cursive`; c.fillText(name, 512, 512 + 3 * k); });
    engrave(y, by, (c, col) => { c.strokeStyle = col; c.lineWidth = .45 * k; c.beginPath(); c.moveTo(512 - 19 * k, 512 + 10 * k); c.lineTo(512 + 19 * k, 512 + 10 * k); c.stroke();
      c.fillStyle = col; c.beginPath(); c.arc(512, 512 + 10 * k, .9 * k, 0, Math.PI * 2); c.fill(); });
    softenBump(capBumpC); capTex.needsUpdate = true; capBump.needsUpdate = true;
  }
  if (document.fonts){ ["100px \"Pinyon Script\"", "600 40px \"Space Grotesk\""].forEach((f) => document.fonts.load(f).then(() => { backKey = ""; drawBack(); }).catch(() => {})); }
  const yearTimer = setInterval(() => drawBack(), 60 * 60 * 1000);   // Jahreswechsel bei offener Seite

  /* --- Zustand (Ziele), wird in jedem Frame weich angesteuert --- */
  let tgt = { enabled:true, offline:false, allowed:new Set() };
  let spinSpeed = 1, coreK = 1, pearlK = 1, ignite = -1, hit = -1, hovArea = null, hovBlock = -1, hovCore = false, coreLift = 0;
  const LIFTED = C("#c9ae74");                     // gehobener Strang: heller Metallton, noch ohne Bereichsfarbe
  const now = () => performance.now() / 1000;
  const RED = C("#ff3b2e"), WHITE = C("#fff3d0");

  function setState(st){
    const allowed = new Set(st.enabled ? st.allowed : []);
    const active = AREAS.filter((a) => allowed.has(a.id)), n = active.length, t = now();
    tgt = { enabled:st.enabled, offline:st.enabled && st.conn === "off", allowed };
    blocks.forEach((b, i) => { const u = b.userData;
      const col = n ? SAT(active[i % n].color) : C(R_BLOCK_OFF), emi = n ? .3 : 0;
      if (!u.tCol.equals(col) || u.tEmi !== emi){ u.from = { col:u.col.clone(), emi:u.emi }; u.tCol = col; u.tEmi = emi; u.startAt = t + i * .028; } });
    segs.forEach((sg) => { const on = allowed.has(sg.area) ? 1 : 0;
      if (sg.target !== on){ sg.target = on; sg.startAt = t + (on ? (21 - sg.r) / 21 * .45 : sg.r / 21 * .3); } });
    drawBack();
  }

  /* --- Bewegung: Auge folgt der Maus (ganze Seite), Ziehen, Schwung, Drehen --- */
  let keyX = 0, keyY = 0, settleAt = 0;          // settleAt: ab wann die Münze langsam zurück in ihre Lage gleitet
  let rx = 0, ry = 0, vx = 0, vy = 0, fx = 0, fy = 0, tfx = 0, tfy = 0, restY = 0, drag = null, spin = null;
  const onWinMove = (e) => {
    if (reduce) return;
    const b = canvas.getBoundingClientRect(); if (!b.width) return;
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * .5)));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * .5)));
    tfy = dx * 34; tfx = dy * 26;
  };
  const onDocLeave = () => { tfx = tfy = 0; };
  window.addEventListener("pointermove", onWinMove);
  document.addEventListener("pointerleave", onDocLeave);

  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  function pick(e){
    const b = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects([...blocks, ...bezels, coreHit, core, ...strandHits, plateau, face, back, bodyMesh, edgeMesh], false);
    return hits.length ? hits[0].object : null;
  }
  const frontShown = () => Math.round(restY / 180) % 2 === 0;

  canvas.addEventListener("pointerdown", (e) => {
    drag = { x:e.clientX, y:e.clientY, lx:e.clientX, ly:e.clientY, moved:false };
    canvas.setPointerCapture(e.pointerId); vx = vy = 0; spin = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag){ hoverPick(e); return; }
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) drag.moved = true;
    if (drag.moved){ ry += dx * .55; rx += dy * .55; vy = dx * .55; vx = dy * .55; }
    drag.lx = e.clientX; drag.ly = e.clientY;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasTap = !drag.moved; drag = null; settleAt = now() + 2.5;
    restY = Math.round(ry / 180) * 180;
    if (!wasTap) return;
    const o = pick(e); if (!o) return;
    if (!frontShown()){ spinBy(180); return; }                         // irgendwo auf der Rückseite: halb zurück
    const k = o.userData.kind;
    if (k === "core") onMaster();
    else if (k === "area") onArea(o.userData.area);
    else spinBy(180);                                                  // Block, schwarze Fläche oder Goldrand: halbe Drehung
  });
  canvas.addEventListener("pointercancel", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => { if (!drag){ onHover(null); hovBlock = -1; hovCore = false; } });

  function hoverPick(e){
    const o = pick(e), k = o && o.userData.kind, front = frontShown();
    hovBlock = front && k === "block" ? o.userData.idx : -1;
    hovCore = front && k === "core";
    onHover(front && k === "area" ? o.userData.area : null);
  }
  function spinBy(deg){ vx = vy = 0; spin = { from:ry, to:Math.round(ry / 180) * 180 + deg, t0:now(), dur:1.05 }; }
  const ease = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /* --- Render-Schleife --- */
  let last = now(), alive = true;
  function frame(){
    if (!alive) return;
    requestAnimationFrame(frame);
    if (!host.offsetParent || document.hidden) { last = now(); return; }   // Modal zu / Tab im Hintergrund: nichts rechnen
    const t = now(), dt = Math.min(.05, t - last); last = t;

    // Drehung
    if (spin){ const p = Math.min(1, (t - spin.t0) / spin.dur); ry = spin.from + (spin.to - spin.from) * ease(p); if (p >= 1){ restY = spin.to; spin = null; } }
    else if (!drag){
      if (keyX) vy += (keyX * 2.8 - vy) * Math.min(1, dt * 10);          // Pfeil links/rechts: sofort weich anlaufen
      if (keyY){ rx += (keyY * 40 - rx) * Math.min(1, dt * 6); vx = 0; } // Pfeil hoch/runter: kippen, solange gehalten
      if (keyX || Math.abs(vx) > .05 || Math.abs(vy) > .05){            // Schwung, unabhängig von der Bildrate
        const f = dt * 60; ry += vy * f; rx += vx * f; const d = keyX ? 1 : Math.pow(.93, f); vx *= d; vy *= d;
        restY = Math.round(ry / 180) * 180; settleAt = t + 2.5; }
      else if (t >= settleAt){                                         // erst nach einer Pause, dann sehr sanft zurück
        vx = vy = 0; const g = Math.min(1, dt * .35);
        ry += (restY - ry) * g; if (!keyY) rx += (0 - rx) * g; }
    }
    rx = Math.max(-75, Math.min(75, rx));
    const k = 1 - Math.pow(.02, dt);                                      // weiches Nachführen (augenartig)
    fx += (tfx - fx) * k; fy += (tfy - fy) * k;
    const sgn = frontShown() ? 1 : -1;
    root.rotation.set((rx + fx) * DEG, (ry + fy * sgn) * DEG, 0, "YXZ");

    if (movement) movement.update(t, dt, tgt.enabled && !tgt.offline && !reduce ? 1 : 0);
    // Rand dreht sich (stoppt bei aus / nicht erreichbar)
    const wantSpin = tgt.enabled && !tgt.offline && !reduce ? 1 : 0;
    spinSpeed += (wantSpin - spinSpeed) * Math.min(1, dt * 2.5);
    blockGroup.rotation.z -= dt * (Math.PI * 2 / 70) * spinSpeed;

    // Blöcke einfärben (gestaffelt)
    blocks.forEach((b) => { const u = b.userData; if (!u.from || t < u.startAt) return;
      const p = Math.min(1, (t - u.startAt) / .45);
      u.col.copy(u.from.col).lerp(u.tCol, p); u.emi = u.from.emi + (u.tEmi - u.from.emi) * p;
      b.material.color.copy(u.col); b.material.emissive.copy(u.col); b.material.emissiveIntensity = u.emi;
      if (p >= 1) u.from = null; });

    // Hover: Strang hebt sich heraus (kommt einem entgegen), Farbe erst nach dem Klick
    const lk = Math.min(1, dt * 9);
    Object.entries(areaGroups).forEach(([id, g]) => {
      const want = hovArea === id && tgt.enabled && frontShown() ? 1 : 0;
      g.userData.lift += (want - g.userData.lift) * Math.min(1, dt * 6);
      const L = g.userData.lift;
      if (Math.abs(L - g.userData.applied) > .002 || (L < .002 && g.userData.applied)){ applyPeel(g.userData.reg, L < .002 ? 0 : L); g.userData.applied = L < .002 ? 0 : L; }
    });
    // Leiterbahnen: außen zuerst an, innen zuerst aus
    segs.forEach((sg) => {
      if (t >= sg.startAt && sg.mix !== sg.target){ sg.mix += Math.sign(sg.target - sg.mix) * dt / .3; sg.mix = Math.max(0, Math.min(1, sg.mix)); }
      const L = areaGroups[sg.area].userData.lift;
      sg.mat.color.copy(sg.base).lerp(LIFTED, L * (1 - sg.mix)).lerp(sg.col, sg.mix);
      sg.mat.emissive.copy(sg.col); sg.mat.emissiveIntensity = sg.mix * .6;
    });
    blocks.forEach((b, i) => { const u = b.userData; u.lift = (u.lift || 0) + ((hovBlock === i ? 1 : 0) - (u.lift || 0)) * lk;
      b.position.z = Z.block + u.lift * .03; });
    coreLift += ((hovCore ? 1 : 0) - coreLift) * lk;
    core.position.z = Z.face + .028 + coreLift * .025; lip.position.z = Z.face + .032 + coreLift * .012;

    // Datenfluss
    flows.forEach((f) => {
      const sg = segs.find((s) => s.area === f.area); const on = tgt.allowed.has(f.area) && sg && sg.mix > .95;
      f.mesh.visible = on;
      if (on){ if (!tgt.offline && !reduce) f.t = (f.t + dt / 1.4) % 1; f.path.getPointAt(f.t, f.mesh.position);
        f.mesh.position.z += peel(f.mesh.position.x, f.mesh.position.y, areaGroups[f.area].userData.applied); }
    });

    // Perlen + Kern
    pearlK += ((tgt.enabled ? 1 : .15) - pearlK) * Math.min(1, dt * 4); pearlMat.emissiveIntensity = pearlK * 1.1;
    const coreWant = !tgt.enabled ? .25 : 1;
    coreK += (coreWant - coreK) * Math.min(1, dt * 4);
    const col = tgt.offline ? RED : WHITE;
    coreMat.emissive.lerp(col, Math.min(1, dt * 6)); coreMat.color.lerp(tgt.offline ? C("#ff6a5c") : C("#fff8e6"), Math.min(1, dt * 6));
    let pulse = tgt.enabled && !tgt.offline && !reduce ? .06 * Math.sin(t * 2.4) : 0;
    let sc = 1;
    if (ignite >= 0){ const p = (t - ignite) / .9; if (p >= 1) ignite = -1; else sc = 1 + Math.sin(p * Math.PI) * 1.1; }
    if (hit >= 0){ const p = (t - hit) / .7; if (p >= 1) hit = -1; else pulse += (1 - p) * .9; }
    coreMat.emissiveIntensity = coreK * 1.15;
    core.scale.setScalar(sc);
    halo.material.color.copy(col);
    halo.material.opacity = Math.max(0, coreK * (.38 + pulse * .6));
    halo.scale.setScalar((.36 + pulse * .2) * (sc > 1 ? sc * .8 : 1));

    renderer.render(scene, camera);
  }

  function resize(){ const w = host.clientWidth; if (!w) return; renderer.setSize(w, w, false); camera.aspect = 1; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();
  requestAnimationFrame(frame);

  return {
    setState,
    destroy(){                                                         // alles freigeben (z. B. vor Neuaufbau)
      alive = false; clearInterval(yearTimer); ro.disconnect();
      window.removeEventListener("pointermove", onWinMove); document.removeEventListener("pointerleave", onDocLeave);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); const ms = o.material ? [].concat(o.material) : [];
        ms.forEach((m) => { Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); }); m.dispose(); }); });
      pmrem.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();   // WebGL-Kontext sofort freigeben
    },
    hover(id){ hovArea = id; },
    ignite(){ ignite = now(); },
    hit(){ hit = now(); },
    flip(){ spinBy(180); },
    setKeys(x, y){ keyX = x; keyY = y; if (x || y) spin = null; settleAt = now() + 2.5; },       // gehaltene Pfeiltasten (-1/0/1)
    spin(){ spinBy(360); },
    _debug:{ root, blocks, segs, camera, core, strandHits, areaGroups, face, get ry(){ return ry; }, get restY(){ return restY; }, pick, render:() => renderer.render(scene, camera) },
  };
}
