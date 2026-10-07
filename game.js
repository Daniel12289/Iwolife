/* ============================================================================
   IWO LIFE  V1.1  — Multiplayer
   An original 3D life-sim / open-world game inspired by Iwo, Osun State, Nigeria.
   The city is a small stylised world, NOT an exact map. All code and shapes are original.

   Systems (search for the banner comments):
     1  CONFIG            tweak asset paths, quality presets, economy + Firebase
     2  HELPERS / STATE
     3  RENDERER, LIGHTS, QUALITY
     4  ASSETS            loadGLB() with automatic placeholder fallback
     5  STATIC BATCHER    merges scenery into few draw calls (vertex-coloured, chunked)
     6  COLLISION         axis-aligned boxes + circle resolver
     7  WORLD             terrain, roads, rail, stream, buildings, market, garage, park, mosque
     8  CHARACTERS        humanoid placeholder, Player, Camera, Vehicle, NPCs
     9  GAMEPLAY          interactions, missions, economy, save, day/night
    10  MULTIPLAYER       Firebase Auth + RTDB, Phone UI, Chat, Wallet, Services, Police, WebRTC
    11  UI + INPUT + MAIN LOOP

   SETUP for online features:
     1. Create a Firebase project → Enable Email/Password Auth + Realtime Database
     2. Paste your web config into CONFIG.firebase below
     3. Use the security rules documented in the README or comments near Net module
   ========================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================== 1. CONFIG ================================ */
const CONFIG = {
  startMoney: 10000,
  signupBonus: 1000000,          // ₦1,000,000 credited on first sign-up
  apartmentPrice: 350000,
  startMinutes: 8 * 60,          // 08:00 AM on Day 1
  minutesPerSecond: 1,           // game minutes per real second (day = 24 real minutes)
  saveKey: 'iwo_life_v1_save',
  settingsKey: 'iwo_life_v1_settings',
  buildsKey: 'iwo_life_v1_builds', // local fallback for guest-built structures
  bounds: 212,                   // walkable half-size of the world
  jobReward: 2000,
  // Player world-development catalog (price, footprint size)
  buildTypes: {
    kiosk:    { price: 45000,  w: 3.2, d: 2.4, h: 2.5, label: 'Roadside Kiosk', icon: '🏪' },
    shop:     { price: 180000, w: 9,   d: 7,   h: 4.2, label: 'Shop',           icon: '🏬' },
    house:    { price: 250000, w: 8,   d: 7,   h: 5.5, label: 'House',          icon: '🏡' },
    workshop: { price: 120000, w: 7,   d: 6,   h: 3.8, label: 'Workshop',       icon: '🔧' },
    stall:    { price: 25000,  w: 2.8, d: 2.2, h: 2.2, label: 'Market Stall',   icon: '🛒' },
    tree:     { price: 5000,   w: 1.2, d: 1.2, h: 4,   label: 'Shade Tree',     icon: '🌳' }
  },
  // Firebase project: tomini-mart
  firebase: {
    apiKey: "AIzaSyAJpJYMooqEs0VKT1YZL-nne-cNv4BcSPI",
    authDomain: "tomini-mart.firebaseapp.com",
    databaseURL: "https://tomini-mart-default-rtdb.firebaseio.com",
    projectId: "tomini-mart",
    storageBucket: "tomini-mart.firebasestorage.app",
    messagingSenderId: "707213630195",
    appId: "1:707213630195:web:687916ead8176c12e93586"
  },
  // path = file, fit = auto-scale rule, rotY = extra rotation (radians) if your model faces the wrong way.
  // Models should face +Z ("forward"). house/shop are fitted into each lot footprint, tree by height.
  assets: {
    player: { path: 'assets/player.glb', fit: { height: 1.8 }, rotY: 0 },
    car:    { path: 'assets/car.glb',    fit: { length: 4.4 }, rotY: 0 },
    house:  { path: 'assets/house.glb',  fit: { footprint: 1 }, rotY: 0 },
    shop:   { path: 'assets/shop.glb',   fit: { footprint: 1 }, rotY: 0 },
    tree:   { path: 'assets/tree.glb',   fit: { height: 1 },    rotY: 0 },
    road:   { path: 'assets/road.glb',   fit: null,             rotY: 0 }
  },
  quality: {
    LOW:    { pixelRatio: 0.75, shadows: false, shadowMap: 0,    far: 150, fog: [40, 130], npcs: 6,  glow: false },
    MEDIUM: { pixelRatio: 1.25, shadows: true,  shadowMap: 1024, far: 230, fog: [60, 210], npcs: 10, glow: true },
    HIGH:   { pixelRatio: 2,    shadows: true,  shadowMap: 2048, far: 340, fog: [90, 320], npcs: 14, glow: true }
  }
};

/* ========================== 2. HELPERS / STATE =========================== */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const approach = (v, t, s) => (v < t ? Math.min(v + s, t) : Math.max(v - s, t));
const fmtMoney = (n) => '₦' + Math.round(n).toLocaleString('en-US');
const UP = new THREE.Vector3(0, 1, 0);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// Seeded RNG so the city is identical on every device (world generation only)
let _seed = 20260;
const rng = () => { _seed = (_seed + 0x6D2B79F5) | 0; let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rr = (a, b) => a + rng() * (b - a);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const G = {
  mode: 'loading',    // loading | welcome | playing
  menuOpen: false, modal: false, phoneOpen: false, inCar: false,
  money: CONFIG.startMoney, minutes: CONFIG.startMinutes,
  inventory: {}, quality: 'LOW', Q: null, time: 0, zone: '',
  // multiplayer
  uid: null, displayName: null, isGuest: true,
  apartment: null,          // { paint, furn } or null
  skills: [],               // [{ skill, rate, desc }]
  buildMode: null           // { type, name } when placing a structure
};

function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem(CONFIG.settingsKey)); if (s && CONFIG.quality[s.quality]) return s; } catch (e) {}
  return { quality: IS_TOUCH ? 'LOW' : 'MEDIUM', fps: false };
}
const settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(CONFIG.settingsKey, JSON.stringify(settings)); } catch (e) {} };

/* ===================== 3. RENDERER, SCENE, LIGHTS ======================== */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality === 'HIGH', powerPreference: 'high-performance' });
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd0f5);
scene.fog = new THREE.Fog(0x8fd0f5, 60, 210);
const camera = new THREE.PerspectiveCamera(65, 1, 0.5, 230);
const clock = new THREE.Clock();

const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x5a4a38, 0.9);
const ambient = new THREE.AmbientLight(0xffffff, 0.12);
const sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
sun.shadow.camera.left = -45; sun.shadow.camera.right = 45; sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 200; sun.shadow.bias = -0.0006;
scene.add(hemi, ambient, sun, sun.target);

const lampDecals = { mesh: null };   // set in world build, toggled by quality
const NPC_LIST = [];                 // filled later; quality changes the visible count

function applyQuality(q) {
  const Q = CONFIG.quality[q]; G.quality = q; G.Q = Q; settings.quality = q;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = Q.shadows;
  sun.castShadow = Q.shadows;
  if (Q.shadows) { sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  camera.far = Q.far; camera.updateProjectionMatrix();
  scene.fog.near = Q.fog[0]; scene.fog.far = Q.fog[1];
  scene.traverse((o) => { if (o.material && !Array.isArray(o.material)) o.material.needsUpdate = true; });
  if (lampDecals.mesh) lampDecals.mesh.visible = Q.glow;
  NPC_LIST.forEach((n, i) => { n.on = i < Q.npcs; if (!n.on) n.g.visible = false; });
  document.querySelectorAll('#qualSeg button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  saveSettings();
}
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

/* ============================== 4. ASSETS ================================ */
const gltfLoader = new GLTFLoader();
const Assets = {};   // key -> normalised wrapper Group (or null if missing)

function fitModel(model, fit) {
  const box = new THREE.Box3();
  const measure = () => { model.updateMatrixWorld(true); box.setFromObject(model); return { size: box.getSize(new THREE.Vector3()), c: box.getCenter(new THREE.Vector3()), min: box.min.clone() }; };
  let m = measure(), s = 1;
  if (fit) {
    if (fit.height) s = fit.height / Math.max(m.size.y, 1e-4);
    else if (fit.length) s = fit.length / Math.max(m.size.x, m.size.z, 1e-4);
    else if (fit.footprint) s = fit.footprint / Math.max(m.size.x, m.size.z, 1e-4);
  }
  model.scale.multiplyScalar(s);
  m = measure();
  model.position.x -= m.c.x; model.position.z -= m.c.z; model.position.y -= m.min.y;
  const wrap = new THREE.Group(); wrap.add(model); wrap.updateMatrixWorld(true);
  wrap.userData.size = m.size.clone();
  return wrap;
}

/* loadGLB(path, position, scale, opts)
   - loads the model, fits it, places it, scales it, enables shadows when asked
   - on ANY error (missing file, bad file, timeout) it uses opts.fallback() (placeholder) and never throws */
function loadGLB(path, position = new THREE.Vector3(), scale = 1, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (obj) => { if (done) return; done = true; clearTimeout(timer); resolve(obj); };
    const fail = (why) => {
      if (done) return;
      console.info('[IwoLife] ' + path + ' not used (' + why + ') - placeholder instead.');
      let fb = null;
      try { fb = opts.fallback ? opts.fallback() : null; } catch (e) { console.warn(e); }
      if (fb) { fb.position.copy(position); fb.scale.multiplyScalar(scale); if (opts.parent !== null) (opts.parent || scene).add(fb); }
      finish(fb);
    };
    const timer = setTimeout(() => fail('timeout'), opts.timeout || 9000);
    try {
      gltfLoader.load(path, (gltf) => {
        if (done) return;
        try {
          const wrap = fitModel(gltf.scene, opts.fit);
          wrap.userData.animations = gltf.animations || [];
          wrap.position.copy(position); wrap.scale.multiplyScalar(scale);
          wrap.traverse((o) => { if (o.isMesh) { o.castShadow = !!opts.shadows; o.receiveShadow = !!opts.shadows; } });
          if (opts.parent !== null) (opts.parent || scene).add(wrap);
          finish(wrap);
        } catch (e) { fail(e.message); }
      }, undefined, (err) => fail((err && err.message) || 'load error'));
    } catch (e) { fail(e.message); }
  });
}

async function loadAssets() {
  const keys = Object.keys(CONFIG.assets); let n = 0;
  await Promise.all(keys.map(async (k) => {
    const a = CONFIG.assets[k];
    Assets[k] = (await loadGLB(a.path, new THREE.Vector3(), 1, { fit: a.fit, parent: null, shadows: true, timeout: 8000 })) || null;
    n++; UI.progress(0.02 + 0.4 * n / keys.length);
  }));
}

// GLB scenery (house/shop/tree) is drawn with InstancedMesh: one draw call per sub-mesh.
const GLBInst = {};
const queueGLB = (kind, m) => (GLBInst[kind] || (GLBInst[kind] = [])).push(m.clone());
function buildGLBInstances() {
  const tmp = new THREE.Matrix4();
  for (const kind in GLBInst) {
    const asset = Assets[kind], list = GLBInst[kind]; if (!asset) continue;
    asset.updateMatrixWorld(true);
    asset.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, o.matrixWorld)));
      im.frustumCulled = false; scene.add(im);
    });
  }
}
function queueBuildingGLB(kind, F, w, d) {
  const A = Assets[kind]; if (!A) return false;
  const sz = A.userData.size, s = Math.min(w / sz.x, d / sz.z);
  queueGLB(kind, new THREE.Matrix4().compose(new THREE.Vector3(F.cx, 0, F.cz),
    new THREE.Quaternion().setFromAxisAngle(UP, F.rot + CONFIG.assets[kind].rotY), new THREE.Vector3(s, s, s)));
  return true;
}

/* ========================== 5. STATIC BATCHER ============================ */
// All static scenery is merged into vertex-coloured chunks (64x64 m) so the GPU draws few meshes
// and frustum culling still works per chunk. 'win' and 'bulb' are separate so they can glow at night.
const MAT = {
  main: new THREE.MeshLambertMaterial({ vertexColors: true }),
  win: new THREE.MeshBasicMaterial({ color: 0x5f7f96 }),
  bulb: new THREE.MeshBasicMaterial({ color: 0x4a4a4a })
};
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 7, 1),
  ico: new THREE.IcosahedronGeometry(1, 0),
  sph: new THREE.SphereGeometry(1, 10, 8),
  pyr: (() => { const g = new THREE.ConeGeometry(1, 1, 4, 1); g.rotateY(Math.PI / 4); return g; })(),
  plane: (() => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; })()
};
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3(), _c = new THREE.Color();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function M(x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}
const Batch = {
  bins: new Map(),
  add(geo, color, m, key = 'main') {
    const id = key + '|' + Math.floor(m.elements[12] / 64) + '|' + Math.floor(m.elements[14] / 64);
    let bin = this.bins.get(id);
    if (!bin) { bin = { key, pos: [], nor: [], col: [], idx: [] }; this.bins.set(id, bin); }
    const P = geo.attributes.position, N = geo.attributes.normal, I = geo.index;
    _nm.getNormalMatrix(m); _c.set(color);
    const base = bin.pos.length / 3;
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m); bin.pos.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize(); bin.nor.push(_n.x, _n.y, _n.z);
      bin.col.push(_c.r, _c.g, _c.b);
    }
    const cnt = I ? I.count : P.count;
    for (let i = 0; i < cnt; i++) bin.idx.push(base + (I ? I.getX(i) : i));
  },
  build() {
    for (const bin of this.bins.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bin.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(bin.nor, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(bin.col, 3));
      const n = bin.pos.length / 3;
      g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(bin.idx) : new Uint16Array(bin.idx), 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, MAT[bin.key]);
      mesh.castShadow = bin.key === 'main'; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false; scene.add(mesh);
    }
    this.bins.clear();
  }
};
const B = (geo, color, x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0, key = 'main') => Batch.add(geo, color, M(x, y, z, sx, sy, sz, ry, rx, rz), key);
const box = (x, yb, z, w, h, d, color, ry = 0, key = 'main') => B(GEO.box, color, x, yb + h / 2, z, w, h, d, ry, 0, 0, key);
const flat = (x, y, z, w, d, color, ry = 0) => B(GEO.plane, color, x, y, z, w, 1, d, ry);

// Local frame: build a thing in its own coordinates (front = +Z) then rotate it into the world.
function Frame(cx, cz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { cx, cz, rot, c, s, swap: Math.abs(s) > 0.7, x: (lx, lz) => cx + lx * c + lz * s, z: (lx, lz) => cz - lx * s + lz * c };
}
const lbox = (F, lx, yb, lz, w, h, d, color, key = 'main', rx = 0, rz = 0) => B(GEO.box, color, F.x(lx, lz), yb + h / 2, F.z(lx, lz), w, h, d, F.rot, rx, rz, key);
const lcyl = (F, lx, yb, lz, r, h, color) => B(GEO.cyl, color, F.x(lx, lz), yb + h / 2, F.z(lx, lz), r, h, r, F.rot);
const lsolid = (F, lx, lz, w, d) => solid(F.x(lx, lz), F.z(lx, lz), F.swap ? d : w, F.swap ? w : d);

/* ============================ 6. COLLISION =============================== */
const Col = {
  boxes: [],
  add(x0, x1, z0, z1) { this.boxes.push({ x0, x1, z0, z1 }); },
  // Push circle p (x,z) out of every box; returns true if anything was hit.
  resolve(p, r) {
    let hit = false;
    for (const b of this.boxes) {
      if (p.x + r < b.x0 || p.x - r > b.x1 || p.z + r < b.z0 || p.z - r > b.z1) continue;
      const cx = clamp(p.x, b.x0, b.x1), cz = clamp(p.z, b.z0, b.z1);
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) { const d = Math.sqrt(d2), k = (r - d) / d; p.x += dx * k; p.z += dz * k; }
      else {
        const l = p.x - b.x0, rt = b.x1 - p.x, t = p.z - b.z0, bt = b.z1 - p.z, mn = Math.min(l, rt, t, bt);
        if (mn === l) p.x = b.x0 - r; else if (mn === rt) p.x = b.x1 + r; else if (mn === t) p.z = b.z0 - r; else p.z = b.z1 + r;
      }
      hit = true;
    }
    return hit;
  },
  test(x, z, r) {
    for (const b of this.boxes) {
      const cx = clamp(x, b.x0, b.x1), cz = clamp(z, b.z0, b.z1);
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    }
    return false;
  }
};
const solid = (x, z, w, d) => Col.add(x - w / 2, x + w / 2, z - d / 2, z + d / 2);

/* ============================== 7. WORLD ================================= */
// Layout (north = -Z, south = +Z). Main road runs east-west along z=0 (think Ibadan Road <-> Ogbomosho Road).
// A railway (Iwo Station) runs along the north edge; a small stream with a bridge lies to the south,
// and the Central Mosque landmark stands beyond the bridge.
const ROADS = [
  { ax: 'x', c: 0,    a: -212, b: 212, w: 14, k: 'main' },
  { ax: 'x', c: -60,  a: -212, b: 212, w: 8,  k: 'sec' },
  { ax: 'x', c: 60,   a: -212, b: 212, w: 8,  k: 'sec' },
  { ax: 'z', c: -120, a: -104, b: 104, w: 10, k: 'cross' },
  { ax: 'z', c: 0,    a: -200, b: 214, w: 10, k: 'cross' },
  { ax: 'z', c: 120,  a: -104, b: 104, w: 10, k: 'cross' }
];
const XB = [-220, -120, 0, 120, 220], ZB = [-110, -60, 0, 60, 110];
// Zone names per block ZONES[xIndex][zIndex]. Edit these to rename areas of the city.
const ZONES = [
  [['Ibadan Road', 'res'],  ['Iwo West', 'res'],     ['Iwo West', 'res'],    ['Stream Side', 'river']],
  [['Cocoa Depot', 'mix'],  ['Iwo Central', 'comm'], ['Old Garage', 'garage'], ['Stream Side', 'river']],
  [['Station Road', 'mix'], ['Oja Iwo', 'market'],   ['Iwo Green', 'park'],  ['Stream Side', 'river']],
  [['Oyo Road', 'res'],     ['Iwo East', 'res'],     ['Iwo East', 'res'],    ['Stream Side', 'river']]
];
const WALLS = [0xe9dcc0, 0xf1d98a, 0xa9cfa0, 0x9ec9e0, 0xe8b4b8, 0xf2f2ee, 0xdc9455, 0xbfd8c8];
const ROOFS = [0x9c4a32, 0x3b6b4a, 0x7d848a, 0x2f5d8a, 0x8a5a2b];
const AWN = [[0xe63946, 0xffffff], [0x2a9d8f, 0xffffff], [0xf4a261, 0x264653], [0x0f9d58, 0xffffff], [0x457b9d, 0xf1faee]];
const SHOP_NAMES = ['Iya Bisi Provisions', 'Aduke Pharmacy', 'Tunde Phones & Gadgets', 'Mama Put Kitchen', 'Fresh Mart Iwo', 'Alhaji Hardware',
  'Bukky Fashion House', 'Olamide Electricals', 'Ayo Cyber Cafe', 'Sweet Mercy Bakery', 'Gbenga Tyres', 'Cocoa Hub Stores'];
let shopNameIdx = 0;
const LAMPS = [], POLE_LINES = [], POIS = [], SIGN_MATS = [];

const terrain = (x, z) => {
  const ax = Math.abs(x), az = Math.abs(z);
  const edge = smooth(0, 140, Math.max(ax, az) - 235);
  let y = edge * (Math.sin(x * 0.021) + Math.cos(z * 0.026) + Math.sin((x + z) * 0.012) + 1.6) * 7;
  if (ax < 400) y -= 2.4 * (1 - smooth(13, 22, Math.abs(z - 130)));   // stream valley
  return y;
};
function groundY(x, z) {
  if (Math.abs(x) <= 6.6 && z >= 106 && z <= 154) return 0.06;       // bridge deck
  const y = terrain(x, z);
  return y > -0.3 ? y + 0.06 : y;
}
function zoneAt(x, z) {
  if (z < -104) return 'Iwo Station';
  if (z > 150) return 'Central Mosque';
  if (z > 108) return 'Iwo Stream';
  let i = 0, j = 0;
  for (let k = 1; k < 4; k++) { if (x >= XB[k]) i = k; if (z >= ZB[k]) j = k; }
  return ZONES[i][j][0];
}

/* ---- sign textures (canvas, tiny) ---- */
function makeSign(text, o = {}) {
  const w = o.w || 6, h = o.h || 1.2, cw = 512, ch = Math.max(64, Math.round(512 * h / w));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = o.bg || '#0b3d2e'; g.fillRect(0, 0, cw, ch);
  g.strokeStyle = o.edge || '#f5b82e'; g.lineWidth = 6; g.strokeRect(5, 5, cw - 10, ch - 10);
  let fs = ch * 0.5; g.font = 'bold ' + fs + 'px system-ui,sans-serif';
  while (g.measureText(text).width > cw - 36 && fs > 12) { fs -= 2; g.font = 'bold ' + fs + 'px system-ui,sans-serif'; }
  g.fillStyle = o.fg || '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, cw / 2, ch / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: o.double ? THREE.DoubleSide : THREE.FrontSide });
  SIGN_MATS.push(mat);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); scene.add(m); return m;
}
function signAt(F, lx, y, lz, mesh) { mesh.position.set(F.x(lx, lz), y, F.z(lx, lz)); mesh.rotation.y = F.rot; return mesh; }

/* ---- terrain ---- */
function buildTerrain() {
  const S = 900, N = 180, g = new THREE.PlaneGeometry(S, S, N, N); g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  const grass = new THREE.Color(0x6c9a3e), dark = new THREE.Color(0x3e7a35), mid = new THREE.Color(0x5c9c3d), laterite = new THREE.Color(0xa86a3c), pale = new THREE.Color(0xb98050);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = terrain(x, z); pos.setY(i, y);
    const ax = Math.abs(x), az = Math.abs(z), rd = Math.abs(z - 130);
    const n = Math.sin(x * 0.09) * Math.cos(z * 0.07) + Math.sin(x * 0.031 + z * 0.027);
    if (rd < 22) c.set(y < -1.2 ? 0x5d6b4a : 0xcdb88a);
    else if (z > 150 && ax < 235 && az < 235) c.set(0x4d8a3c).lerp(grass, smooth(-1, 1, n) * 0.5);
    else if (ax < 225 && az <= 111) { c.copy(laterite); if (n > 0.7) c.lerp(grass, 0.8); else if (n > 0.2) c.lerp(pale, 0.5); else if (n < -0.9) c.lerp(grass, 0.35); }
    else c.copy(mid).lerp(dark, smooth(0, 25, y)).lerp(grass, smooth(-1, 1, n) * 0.4);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = true; scene.add(mesh);
}

/* ---- roads ---- */
function intervalsFor(r) {
  const out = [];
  for (const o of ROADS) { if (o.ax === r.ax || r.c < o.a || r.c > o.b) continue; out.push([o.c - o.w / 2, o.c + o.w / 2]); }
  return out.sort((p, q) => p[0] - q[0]);
}
function segs(r, extra = 0) {
  const res = []; let cur = r.a;
  for (const [s, e] of intervalsFor(r)) { if (s - extra > cur) res.push([cur, s - extra]); cur = Math.max(cur, e + extra); }
  if (cur < r.b) res.push([cur, r.b]);
  return res;
}
// Rectangle along road r between t0..t1 (along) and off0..off1 (across). y = plane height, or box bottom when h>0.
function stripe(r, t0, t1, off0, off1, y, color, h = 0) {
  const len = t1 - t0, wid = off1 - off0, t = (t0 + t1) / 2, o = (off0 + off1) / 2;
  const x = r.ax === 'x' ? t : r.c + o, z = r.ax === 'x' ? r.c + o : t;
  const sx = r.ax === 'x' ? len : wid, sz = r.ax === 'x' ? wid : len;
  if (h > 0) B(GEO.box, color, x, y + h / 2, z, sx, h, sz); else B(GEO.plane, color, x, y, z, sx, 1, sz);
}
function placeLamp(x, z, dx, dz) {
  B(GEO.cyl, 0x6d7378, x, 3.25, z, 0.09, 6.5, 0.09);
  B(GEO.box, 0x555a5e, x, 0.2, z, 0.3, 0.4, 0.3);
  const a = Math.atan2(-dz, dx);
  B(GEO.box, 0x6d7378, x + dx * 0.8, 6.45, z + dz * 0.8, 1.7, 0.1, 0.1, a);
  B(GEO.box, 0xffffff, x + dx * 1.55, 6.35, z + dz * 1.55, 0.55, 0.14, 0.28, a, 0, 0, 'bulb');
  solid(x, z, 0.35, 0.35); LAMPS.push({ x: x + dx * 1.6, z: z + dz * 1.6 });
}
function placePole(x, z, ax) {
  B(GEO.cyl, 0x7a5a3a, x, 4.5, z, 0.12, 9, 0.12);
  if (ax === 'x') B(GEO.box, 0x6b4f33, x, 8.3, z, 0.12, 0.12, 2.0); else B(GEO.box, 0x6b4f33, x, 8.3, z, 2.0, 0.12, 0.12);
  solid(x, z, 0.35, 0.35);
}
function buildRoad(r) {
  const half = r.w / 2, edge = (sd, a, b) => (sd > 0 ? [half + a, half + b] : [-half - b, -half - a]);
  const yR = r.k === 'main' ? 0.05 : r.k === 'sec' ? 0.052 : 0.054;
  stripe(r, r.a, r.b, -half, half, yR, 0x3b3e42);
  const cA = r.k === 'main' ? 0xf2c230 : 0xf2f2ee, cB = 0x1a1a1a;   // yellow/black on the main road, white/black elsewhere
  for (const sd of [-1, 1]) {
    for (const [s, e] of segs(r, 0)) {
      let k = 0;
      for (let t = s; t < e - 0.05; t += 2, k++) { const [o0, o1] = edge(sd, 0, 0.35); stripe(r, t, Math.min(t + 2, e), o0, o1, 0, (k & 1) ? cB : cA, 0.16); }
      for (let t = s; t < e; t += 30) { const [o0, o1] = edge(sd, 0.35, 3); stripe(r, t, Math.min(t + 30, e), o0, o1, 0, 0xb9b6ac, 0.10); }
      const [g0, g1] = edge(sd, 3, 4);
      stripe(r, s, e, g0, g1, 0.03, 0x4a4f52);                                     // concrete drainage gutter
      for (let t = s + 3; t < e - 5; t += 11) stripe(r, t, t + 4.5, g0 + 0.03, g1 - 0.03, 0.03, 0xa6a398, 0.09);   // gutter slabs
      const [l0, l1] = edge(sd, -0.5, -0.35); stripe(r, s, e, l0, l1, 0.08, 0xf0f0ea);   // edge line
    }
  }
  for (const [s, e] of segs(r, 6)) for (let t = s + 1; t < e - 3.5; t += 7) stripe(r, t, t + 3.5, -0.1, 0.1, 0.08, cA);
  const brk = intervalsFor(r), nearBreak = (t) => brk.some(([s, e]) => t > s - 9 && t < e + 9);
  const onBridge = (t) => r.ax === 'z' && r.c === 0 && t > 98 && t < 162;
  const wp = (t, off) => (r.ax === 'x' ? [t, r.c + off] : [r.c + off, t]);
  for (const sd of [-1, 1]) {
    const off = sd * (half + 3.5);
    for (let t = r.a + (sd < 0 ? 20 : 35); t < r.b - 10; t += 30) {
      if (nearBreak(t) || onBridge(t)) continue;
      const [x, z] = wp(t, off); placeLamp(x, z, r.ax === 'x' ? 0 : -sd, r.ax === 'x' ? -sd : 0);
    }
  }
  if (r.k === 'main' || (r.k === 'cross' && r.c === 0)) {
    const sd = r.k === 'main' ? -1 : 1, off = sd * (half + 3.5), pts = [];
    for (let t = r.a + 5; t < r.b - 10; t += 30) { if (nearBreak(t) || onBridge(t)) continue; const [x, z] = wp(t, off); placePole(x, z, r.ax); pts.push([x, z, r.ax]); }
    POLE_LINES.push(pts);
  }
}
function buildCrossings() {
  const main = ROADS[0];
  for (const o of ROADS) {
    if (o.ax !== 'z' || o.a > 0 || o.b < 0) continue;
    const cx = o.c;
    for (const sd of [-1, 1]) {
      for (let z = -5.8; z <= 5.8; z += 1.2) flat(cx + sd * (o.w / 2 + 2.7), 0.075, z, 3, 0.6, 0xf4f4f0);        // zebra across the main road
      for (let x = -3.6; x <= 3.6; x += 1.2) flat(cx + x, 0.075, sd * (main.w / 2 + 2.2), 0.6, 3, 0xf4f4f0);    // zebra across the side street
    }
  }
}

/* ---- railway ---- */
function buildRail() {
  const z0 = -110;
  for (const [a, b] of [[-212, -6], [6, 212]]) {
    for (let x0 = a; x0 < b; x0 += 40) {
      const x1 = Math.min(x0 + 40, b), cx = (x0 + x1) / 2, len = x1 - x0;
      box(cx, 0, z0, len, 0.15, 6, 0x7b756c);
      for (let x = x0 + 0.6; x < x1; x += 1.15) box(x, 0.15, z0, 0.35, 0.1, 2.4, 0x5a4632);
      box(cx, 0.25, z0 - 0.72, len, 0.12, 0.12, 0x8d9094); box(cx, 0.25, z0 + 0.72, len, 0.12, 0.12, 0x8d9094);
    }
  }
  box(0, 0.05, z0 - 0.72, 12, 0.06, 0.12, 0x8d9094); box(0, 0.05, z0 + 0.72, 12, 0.06, 0.12, 0x8d9094);   // level crossing
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 7.6, z = z0 + sz * 4;
    B(GEO.cyl, 0x444444, x, 1.5, z, 0.07, 3, 0.07); B(GEO.box, 0xf4f4f0, x, 2.9, z, 1.5, 0.22, 0.06, 0, 0, 0.62); B(GEO.box, 0xf4f4f0, x, 2.9, z, 1.5, 0.22, 0.06, 0, 0, -0.62);
    B(GEO.sph, 0xd62828, x, 2.2, z, 0.14, 0.14, 0.14); solid(x, z, 0.3, 0.3);
  }
  for (const wx of [-150, -137]) {   // parked freight wagons
    box(wx, 0.55, z0, 11, 2.7, 2.7, 0x8a3b2c); box(wx, 0.35, z0, 11.4, 0.25, 2.8, 0x3b3b3b);
    for (const k of [-4, -2.5, 2.5, 4]) for (const s of [-1, 1]) box(wx + k, 0.15, z0 + s * 0.72, 0.7, 0.45, 0.12, 0x222222);
    solid(wx, z0, 11, 2.7);
  }
  // Iwo Station platform + shelter on the north side
  box(70, 0, -115.8, 50, 0.35, 3, 0xb4afa3); solid(70, -115.8, 50, 3);
  box(70, 2.8, -115.8, 16, 0.15, 3.6, 0x0f7d4a);
  for (const px of [62.5, 77.5]) for (const pz of [-117.2, -114.4]) B(GEO.cyl, 0x4a4a4a, px, 1.6, pz, 0.08, 3.1, 0.08);
  box(70, 0.35, -116.8, 6, 0.45, 0.5, 0x8a6a45);
  const sg = makeSign('IWO STATION', { w: 7, h: 1, bg: '#16346e' }); sg.position.set(70, 3.5, -113.9);
  POIS.push({ x: 70, z: -112, t: 'land' });
}

/* ---- stream + bridge ---- */
const RIVER = { water: null };
function buildRiver() {
  const geo = new THREE.PlaneGeometry(900, 39); geo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x2f8f8a, transparent: true, opacity: 0.88 }));
  water.position.set(0, -0.75, 130); scene.add(water); RIVER.water = water;
  Col.add(-450, -6.4, 111, 149); Col.add(6.4, 450, 111, 149);          // can't swim: block everything except the bridge
  box(0, -0.4, 130, 13, 0.44, 46, 0x9b9a92);                            // bridge deck
  for (const sd of [-1, 1]) {
    for (let k = 0, z = 108; z < 152; z += 2, k++) box(sd * 6.0, 0.04, z + 1, 0.4, 0.7, 2, (k & 1) ? 0x1a1a1a : 0xf2f2ee);
    Col.add(sd > 0 ? 5.8 : -6.3, sd > 0 ? 6.3 : -5.8, 107, 153);
    for (const pz of [115, 130, 145]) box(sd * 4.3, -2.4, pz, 1, 2.0, 1, 0x8a8880);
    for (const lz of [112, 148]) placeLamp(sd * 5.9, lz, -sd, 0);
  }
  for (let i = 0; i < 12; i++) { const x = rr(-150, 150); if (Math.abs(x) < 10) continue; const s = rr(0.6, 1.4); B(GEO.ico, 0x6f7a70, x, -0.7, rr(118, 142), s, s * 0.7, s, rr(0, 3)); }
}

/* ---- vegetation ---- */
const GREENS = [0x2f7d32, 0x3f9142, 0x2a6b30, 0x4fa04a];
function tree(x, z, kind) {
  if (kind == null || kind < 0) { const r = rng(); kind = r < 0.62 ? 0 : r < 0.9 ? 1 : 2; }
  const s = rr(0.85, 1.25);
  if (Assets.tree && kind < 2) {
    const h = (kind === 1 ? 9 : 7) * s;
    queueGLB('tree', new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(UP, rr(0, 6.28) + CONFIG.assets.tree.rotY), new THREE.Vector3(h, h, h)));
  } else if (kind === 0) {           // broadleaf (mango / neem style)
    B(GEO.cyl, 0x6b4a2b, x, 1.5 * s, z, 0.26 * s, 3 * s, 0.26 * s);
    B(GEO.ico, pick(GREENS), x, 4.1 * s, z, 2.3 * s, 1.7 * s, 2.3 * s, rr(0, 3));
    B(GEO.ico, pick(GREENS), x + 0.9 * s, 3.4 * s, z + 0.3 * s, 1.5 * s, 1.2 * s, 1.5 * s);
    B(GEO.ico, pick(GREENS), x - 0.8 * s, 3.6 * s, z - 0.5 * s, 1.6 * s, 1.2 * s, 1.6 * s);
  } else if (kind === 1) {           // palm
    B(GEO.cyl, 0x8a6a45, x, 3.5 * s, z, 0.2 * s, 7 * s, 0.2 * s);
    for (let k = 0; k < 7; k++) { const a = k * (Math.PI * 2 / 7) + rr(0, 0.4); B(GEO.box, 0x3a8f3a, x + Math.cos(a) * 1.3 * s, 7 * s, z - Math.sin(a) * 1.3 * s, 2.8 * s, 0.06, 0.5 * s, a, 0, -0.4); }
  } else B(GEO.ico, pick(GREENS), x, 0.5, z, 1.1 * s, 0.8 * s, 1.1 * s);
  solid(x, z, kind === 2 ? 0.9 : 0.6, kind === 2 ? 0.9 : 0.6);
}

/* ---- parked vehicles (static, batched). Long axis = local Z ---- */
function wheel(F, lx, lz, r) { B(GEO.cyl, 0x1b1b1b, F.x(lx, lz), r, F.z(lx, lz), r, 0.25, r, F.rot, 0, Math.PI / 2); }
function vehicleStatic(F, kind, color) {
  if (kind === 'bus') {
    lbox(F, 0, 0.5, 0, 2.1, 1.9, 5.4, color); lbox(F, 0, 1.0, 0, 2.12, 0.3, 5.42, 0x1a1a1a);
    lbox(F, 0, 1.6, -0.3, 2.14, 0.7, 4.4, 0, 'win'); lbox(F, 0, 2.4, 0, 2.0, 0.1, 5.2, 0xf2f2ee);
    for (const sx of [-1, 1]) for (const lz of [-1.8, 1.8]) wheel(F, sx * 1.0, lz, 0.4);
    lsolid(F, 0, 0, 2.1, 5.6);
  } else if (kind === 'keke') {
    lbox(F, 0, 0.4, 0, 1.3, 1.1, 2.2, 0xf2c230); lbox(F, 0, 1.55, 0, 1.4, 0.1, 2.4, 0x1a1a1a);
    lbox(F, 0, 1.0, 0.3, 1.34, 0.5, 1.0, 0, 'win'); wheel(F, 0, 1.0, 0.3); wheel(F, -0.65, -0.8, 0.3); wheel(F, 0.65, -0.8, 0.3);
    lsolid(F, 0, 0, 1.4, 2.6);
  } else {
    lbox(F, 0, 0.34, 0, 1.8, 0.62, 4.3, color); lbox(F, 0, 0.95, -0.3, 1.6, 0.6, 2.2, color);
    lbox(F, 0, 1.05, -0.3, 1.64, 0.36, 2.0, 0, 'win');
    for (const sx of [-1, 1]) for (const lz of [-1.35, 1.4]) wheel(F, sx * 0.9, lz, 0.34);
    lsolid(F, 0, 0, 1.9, 4.4);
  }
}
const CAR_COLORS = [0xf2f2ee, 0x1f4e79, 0xb02a2a, 0x2a2a2a, 0x9aa0a6, 0x2e7d4f];
const parkVehicle = (x, z, rot, kind, color) => vehicleStatic(Frame(x, z, rot), kind, color == null ? pick(CAR_COLORS) : color);

/* ---- buildings ---- */
function buildCompound(L, LW, LD, open) {
  const H = 1.8, T = 0.25, col = 0xd9d4c6, gap = 4, fz = LD / 2 - 0.6;
  lbox(L, 0, 0, -LD / 2 + 0.15, LW, H, T, col); lsolid(L, 0, -LD / 2 + 0.15, LW, T);
  const sw = (LW - gap) / 2;
  for (const s of [-1, 1]) {
    lbox(L, s * (LW / 2 - 0.15), 0, 0, T, H, LD, col); lsolid(L, s * (LW / 2 - 0.15), 0, T, LD);
    lbox(L, s * (gap / 2 + sw / 2), 0, fz, sw, H, T, col); lsolid(L, s * (gap / 2 + sw / 2), fz, sw, T);
    lbox(L, s * gap / 2, 0, fz, 0.5, 2.3, 0.5, 0xeee9da); lbox(L, s * gap / 2, 2.3, fz, 0.7, 0.15, 0.7, 0xcfc9b8);
  }
  if (!open) { lbox(L, 0, 0.1, fz, gap - 0.5, 1.9, 0.08, 0x2f3b47); lsolid(L, 0, fz, gap - 0.5, 0.3); }
}
function buildHouse(F, w, d, o) {
  lsolid(F, 0, 0, w, d);
  if (queueBuildingGLB('house', F, w, d)) return;
  const st = o.storeys || 1, h = st * 3.1, trim = 0xf2efe6;
  lbox(F, 0, 0, 0, w + 0.3, 0.45, d + 0.3, 0x8d8a82);
  lbox(F, 0, 0.45, 0, w, h - 0.45, d, o.wall);
  lbox(F, 0, h - 0.25, 0, w + 0.25, 0.25, d + 0.25, trim);
  for (let s = 0; s < st; s++) {
    const y = 0.9 + s * 3.1, n = Math.max(2, Math.floor(w / 3.4));
    for (let i = 0; i < n; i++) {
      const lx = -w / 2 + (i + 0.5) * w / n; if (s === 0 && Math.abs(lx) < 1.3) continue;
      lbox(F, lx, y, d / 2 + 0.03, 1.15, 1.15, 0.08, 0, 'win'); lbox(F, lx, y - 0.1, d / 2 + 0.03, 1.35, 0.08, 0.12, trim);
    }
    for (const sx of [-1, 1]) lbox(F, sx * (w / 2 + 0.03), y, 0, 0.08, 1.15, 1.15, 0, 'win');
  }
  lbox(F, 0, 0.45, d / 2 + 0.04, 1.25, 2.2, 0.1, o.door || 0x4a2f1e);
  lbox(F, 0, 0, d / 2 + 0.9, w * 0.7, 0.18, 1.8, 0xc7c2b6);                                    // veranda
  for (const s of [-1, 1]) lbox(F, s * w * 0.3, 0.18, d / 2 + 1.65, 0.22, 2.7, 0.22, trim);
  lbox(F, 0, 2.9, d / 2 + 0.95, w * 0.74, 0.16, 2.1, o.roof);
  if (st > 1) { lbox(F, 0, 3.1, d / 2 + 0.55, w * 0.5, 0.12, 1.1, trim); lbox(F, 0, 3.9, d / 2 + 1.05, w * 0.5, 0.07, 0.07, 0x30343a); }
  if (o.flat) {
    lbox(F, 0, h, d / 2 + 0.1, w + 0.3, 0.5, 0.18, trim); lbox(F, 0, h, -d / 2 - 0.1, w + 0.3, 0.5, 0.18, trim);
    lbox(F, w / 2 + 0.1, h, 0, 0.18, 0.5, d, trim); lbox(F, -w / 2 - 0.1, h, 0, 0.18, 0.5, d, trim);
    lbox(F, w / 2 - 1.3, h, -d / 2 + 1.3, 1.3, 0.7, 1.3, 0x8a8a8a);
    B(GEO.cyl, 0x1c1c1c, F.x(w / 2 - 1.3, -d / 2 + 1.3), h + 1.25, F.z(w / 2 - 1.3, -d / 2 + 1.3), 0.6, 1.1, 0.6);   // water tank
  } else {
    lbox(F, 0, h, 0, w + 0.8, 0.18, d + 0.8, o.roof);
    const rise = 1.8; B(GEO.pyr, o.roof, F.cx, h + 0.18 + rise / 2, F.cz, (w + 0.8) * 0.7071, rise, (d + 0.8) * 0.7071, F.rot);
  }
}
function buildShop(F, w, d, o) {
  lsolid(F, 0, 0, w, d);
  if (queueBuildingGLB('shop', F, w, d)) return;
  const h = 4.6;
  lbox(F, 0, 0, 0, w + 0.3, 0.4, d + 0.3, 0x8d8a82); lbox(F, 0, 0.4, 0, w, h - 0.4, d, o.wall); lbox(F, 0, h - 0.2, 0, w + 0.3, 0.2, d + 0.3, 0xf2efe6);
  lbox(F, -w * 0.18, 0.4, d / 2 + 0.04, w * 0.55, 2.3, 0.1, 0x5d7b94);
  for (let k = 0; k < 7; k++) lbox(F, -w * 0.18, 0.4 + k * 0.33, d / 2 + 0.1, w * 0.55, 0.03, 0.04, 0x486377);
  lbox(F, w * 0.3, 0.4, d / 2 + 0.04, 1.3, 2.2, 0.1, 0x3a2a1e); lbox(F, w * 0.3, 1.1, d / 2 + 0.09, 0.9, 0.9, 0.06, 0, 'win');
  const n = Math.max(4, Math.round(w / 1.2)), sw = w / n;
  for (let k = 0; k < n; k++) lbox(F, -w / 2 + sw * (k + 0.5), 2.75, d / 2 + 1.1, sw, 0.08, 2.2, (k & 1) ? o.awn[1] : o.awn[0], 'main', 0.22, 0);
  for (const s of [-1, 1]) lbox(F, s * (w / 2 - 0.2), 0, d / 2 + 2.0, 0.12, 2.5, 0.12, 0x555555);
  for (let k = 0; k < 3; k++) lbox(F, -w / 2 + 1.2 + k * 1.0, 0, d / 2 + 1.4, 0.7, 0.5 + k * 0.1, 0.6, pick([0xe9c46a, 0xe76f51, 0x2a9d8f]));
  lbox(F, 0, h, 0, w + 0.3, 0.5, d + 0.3, 0xe5e1d6);
  signAt(F, 0, h - 0.9, d / 2 + 0.07, makeSign(o.name, { w: Math.min(w - 0.6, 7), h: 1.0, bg: o.signBg || '#0b3d2e' }));
}

/* ---- interactables registry (filled by world builders, used by Interact) ---- */
const INTERACTABLES = [];
function addInteract(o) { INTERACTABLES.push(o); }

/* ---- city blocks ---- */
const LOT_OVERRIDE = { '1,1,2,1': 'home', '1,1,1,1': 'shop' };
const KIND_W = { res: [0.55, 0.05], mix: [0.35, 0.3], comm: [0.15, 0.55], river: [0.3, 0] };
const HOME = { x: -47.25, z: -12.2 };    // player spawn (gate of the player's home)

function buildLot(i, j, a, b, cx, cz, lw, ld, R, zk) {
  const key = i + ',' + j + ',' + a + ',' + b;
  const dW = cx - R.x0, dE = R.x1 - cx, dN = cz - R.z0, dS = R.z1 - cz, mn = Math.min(dW, dE, dN, dS);
  let rot = 0; if (mn === dS) rot = 0; else if (mn === dN) rot = Math.PI; else if (mn === dE) rot = Math.PI / 2; else rot = -Math.PI / 2;
  const sw = rot === Math.PI / 2 || rot === -Math.PI / 2, LW = sw ? ld : lw, LD = sw ? lw : ld, L = Frame(cx, cz, rot);
  let type = LOT_OVERRIDE[key];
  if (!type) { const [wh, ws] = KIND_W[zk], r = rng(); type = r < wh ? 'house' : r < wh + ws ? 'shop' : 'empty'; }
  if ((type === 'house' || type === 'home') && (LD < 15 || LW < 13)) type = 'empty';
  if (type === 'shop' && (LD < 10 || LW < 11)) type = 'empty';

  if (type === 'house' || type === 'home') {
    const home = type === 'home';
    const w = home ? 11 : Math.min(8 + rng() * 3, LW - 5), d = home ? 9 : Math.min(7 + rng() * 2.2, LD - 9);
    if (d < 5.5) type = 'empty';
    else {
      const zb = LD / 2 - 4.6 - d / 2, BF = Frame(L.x(0, zb), L.z(0, zb), rot);
      buildCompound(L, LW, LD, home);
      buildHouse(BF, w, d, { wall: home ? 0xf2efe4 : pick(WALLS), roof: home ? 0x2e7d4f : pick(ROOFS), flat: !home && rng() < 0.55, storeys: !home && rng() < 0.3 ? 2 : 1, door: home ? 0x1f5d3a : undefined });
      if (rng() < 0.4) tree(L.x(-(LW / 2 - 2.2), LD / 2 - 2.4), L.z(-(LW / 2 - 2.2), LD / 2 - 2.4), 0);
      if (rng() < 0.3) parkVehicle(L.x(LW / 2 - 2.6, LD / 2 - 5), L.z(LW / 2 - 2.6, LD / 2 - 5), rot, 'car');
      const gx = L.x(0, LD / 2 + 0.5), gz = L.z(0, LD / 2 + 0.5);
      if (home) {
        addInteract({ id: 'home', x: gx, z: gz, r: 3.8, label: 'ENTER HOME', actions: [{ label: 'ENTER', fn: () => Panels.home() }] });
        POIS.push({ x: gx, z: gz, t: 'home' });
      } else {
        addInteract({ id: 'house' + key, x: gx, z: gz, r: 3.6, label: 'KNOCK', actions: [{ label: 'KNOCK', fn: () => UI.toast(pick(['Nobody is home right now.', 'A voice from inside: "Come back later!"', 'The gate is locked.'])) }] });
      }
      return;
    }
  }
  if (type === 'shop') {
    const w = Math.min(9 + rng() * 3, LW - 3), d = Math.min(7 + rng(), LD - 3), zb = LD / 2 - 1.6 - d / 2, BF = Frame(L.x(0, zb), L.z(0, zb), rot);
    const name = SHOP_NAMES[shopNameIdx++ % SHOP_NAMES.length];
    buildShop(BF, w, d, { wall: pick(WALLS), awn: pick(AWN), name, signBg: pick(['#0b3d2e', '#16346e', '#6a1b1b', '#3d2a0b']) });
    if (rng() < 0.5) tree(L.x(LW / 2 - 2, -LD / 2 + 3), L.z(LW / 2 - 2, -LD / 2 + 3), 0);
    const gx = L.x(0, LD / 2 + 0.3), gz = L.z(0, LD / 2 + 0.3);
    addInteract({ id: 'shop' + key, x: gx, z: gz, r: 4.2, label: 'ENTER SHOP', actions: [
      { label: 'ENTER', fn: () => Panels.shop(name, 'buy') }, { label: 'BUY', fn: () => Panels.shop(name, 'buy') }, { label: 'SELL', fn: () => Panels.shop(name, 'sell') }] });
    POIS.push({ x: gx, z: gz, t: 'shop' });
    return;
  }
  // empty lot: trees, bushes, the odd roadside kiosk
  const cnt = 1 + Math.floor(rng() * 3);
  for (let k = 0; k < cnt; k++) tree(L.x(rr(-LW / 2 + 3, LW / 2 - 3), rr(-LD / 2 + 3, LD / 2 - 3)), L.z(rr(-LW / 2 + 3, LW / 2 - 3), rr(-LD / 2 + 3, LD / 2 - 3)));
  if (rng() < 0.25) {
    const kx = rr(-LW / 4, LW / 4), kz = LD / 2 - 3;
    lbox(L, kx, 0, kz, 3, 2.4, 2.2, pick([0xe76f51, 0x2a9d8f, 0xf4a261])); lbox(L, kx, 2.4, kz, 3.4, 0.15, 2.6, 0x2b2b2b); lsolid(L, kx, kz, 3, 2.2);
  }
}
function buildBlocks() {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const [, kind] = ZONES[i][j];
    if (kind === 'market' || kind === 'garage' || kind === 'park') continue;
    const x0 = XB[i] + [8, 9, 9, 9][i], x1 = XB[i + 1] - [9, 9, 9, 8][i], z0 = ZB[j] + [6, 8, 11, 8][j], z1 = ZB[j + 1] - [8, 11, 8, 6][j];
    const nx = Math.max(1, Math.round((x1 - x0) / 26)), nz = Math.max(1, Math.round((z1 - z0) / 21)), lw = (x1 - x0) / nx, ld = (z1 - z0) / nz;
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) buildLot(i, j, a, b, x0 + lw * (a + 0.5), z0 + ld * (b + 0.5), lw, ld, { x0, x1, z0, z1 }, kind);
  }
}

/* ---- Oja Iwo market + palace (inspired, simplified) ---- */
function buildMarket() {
  flat(60, 0.06, -28, 76, 32, 0xcdbf9f);
  const P = Frame(60, -47.5, 0);
  lsolid(P, 0, 0, 30, 8);
  lbox(P, 0, 0, 0, 31, 0.5, 9, 0xb9b4a6); lbox(P, 0, 0.5, 0, 30, 4.2, 8, 0xf6f3ea); lbox(P, 0, 4.5, 0, 31, 0.35, 9, 0x0f7d4a);
  for (let k = -6; k <= 6; k++) lcyl(P, k * 2.3, 0.5, 4.6, 0.28, 4.0, 0xffffff);
  lbox(P, 0, 4.55, 5.2, 30, 0.25, 2.6, 0xcf3b2e);
  lbox(P, 0, 0.5, 4.05, 2.2, 3, 0.1, 0x5a3a22);
  for (const s of [-1, 1]) for (const k of [-1, 0, 1]) lbox(P, s * (7 + k * 3.2), 1.6, 4.03, 1.2, 1.3, 0.08, 0, 'win');
  B(GEO.pyr, 0x0f7d4a, 60, 4.85 + 1.5, -47.5, 32 * 0.7071, 3, 10 * 0.7071);
  signAt(P, 0, 3.9, 4.12, makeSign("OLUWO'S PALACE (INSPIRED)", { w: 8, h: 1, bg: '#16346e' }));
  addInteract({ id: 'palace', x: 60, z: -39, r: 5.5, label: 'VIEW LANDMARK', actions: [{ label: 'VIEW', fn: () => Panels.info("Oluwo's Palace (inspired)",
    'A simplified, original tribute to the palace area at the heart of Iwo, close to the market. Iwo is the seat of the Oluwo, a traditional ruler. This is a stylised model, not an exact reconstruction.') }] });
  POIS.push({ x: 60, z: -39, t: 'land' });
  const fruit = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xe9c46a, 0x8338ec], goods = [0xe9c46a, 0xe76f51, 0x2a9d8f, 0xf4f1de, 0x9b5de5];
  for (let c = 0; c < 7; c++) for (let r = 0; r < 3; r++) {
    const x = 33 + c * 10, z = -35 + r * 9, F = Frame(x, z, 0);
    lbox(F, 0, 0, 0, 3.2, 0.95, 1.8, 0x8a6a45); lsolid(F, 0, 0, 3.2, 1.8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) lcyl(F, sx * 1.5, 0, sz * 0.8, 0.05, 2.2, 0x6b5a45);
    B(GEO.pyr, pick(fruit), x, 2.45, z, 3.8 / 1.414, 0.9, 2.8 / 1.414);
    for (let k = 0; k < 3; k++) lbox(F, -1 + k, 0.95, 0, 0.7, 0.35, 0.6, pick(goods));
  }
  const store = Frame(20, -31, Math.PI / 2);
  buildShop(store, 9, 7.5, { wall: 0xf1d98a, awn: AWN[0], name: 'OJA IWO GENERAL STORE', signBg: '#6a1b1b' });
  const gx = 28.5, gz = -31;
  addInteract({ id: 'shopOja', x: gx, z: gz, r: 4.2, label: 'ENTER SHOP', actions: [
    { label: 'ENTER', fn: () => Panels.shop('Oja Iwo General Store', 'buy') }, { label: 'BUY', fn: () => Panels.shop('Oja Iwo General Store', 'buy') }, { label: 'SELL', fn: () => Panels.shop('Oja Iwo General Store', 'sell') }] });
  POIS.push({ x: gx, z: gz, t: 'shop' });
  const store2 = Frame(101, -31, -Math.PI / 2);
  buildShop(store2, 9, 7.5, { wall: 0xa9cfa0, awn: AWN[3], name: 'ADIRE & ANKARA HOUSE', signBg: '#16346e' });
  addInteract({ id: 'shopAdire', x: 92.5, z: -31, r: 4.2, label: 'ENTER SHOP', actions: [
    { label: 'ENTER', fn: () => Panels.shop('Adire & Ankara House', 'buy') }, { label: 'BUY', fn: () => Panels.shop('Adire & Ankara House', 'buy') }, { label: 'SELL', fn: () => Panels.shop('Adire & Ankara House', 'sell') }] });
  POIS.push({ x: 92.5, z: -31, t: 'shop' });
  for (const [tx, tz] of [[18, -14], [102, -14], [18, -48], [102, -48]]) tree(tx, tz, 1);
}

/* ---- Old Garage (motor park) + dispatch office ---- */
function buildGarage() {
  flat(-60, 0.055, 32, 98, 38, 0x5b5c58);
  for (let x = -90; x <= -20; x += 10) flat(x, 0.07, 22, 0.15, 7, 0xe8e8e0);
  for (let k = 0; k < 6; k++) parkVehicle(-85 + k * 11, 24, 0, 'bus', k % 2 ? 0xf2c230 : 0xe8a317);
  for (const x of [-75, -64, -53]) parkVehicle(x, 44, rr(-0.4, 0.4), 'keke');
  parkVehicle(-30, 46, Math.PI / 2, 'car'); parkVehicle(-40, 47, 0, 'car');
  const D = Frame(-100, 40, Math.PI / 2);
  lbox(D, 0, 0, 0, 12.3, 0.4, 8.3, 0x8d8a82); lbox(D, 0, 0.4, 0, 12, 3.4, 8, 0xe8dcc0); lbox(D, 0, 3.8, 0, 12.4, 0.3, 8.4, 0x9c4a32);
  lbox(D, -2, 0.4, 4.04, 1.3, 2.3, 0.1, 0x3a2a1e); lbox(D, 2.5, 1.2, 4.04, 2.4, 1.2, 0.08, 0, 'win');
  lbox(D, 0, 0, 5.2, 11, 0.15, 2.2, 0xc7c2b6); lbox(D, 0, 3.0, 5.2, 11, 0.15, 2.4, 0xb23a2e);
  for (const s of [-1, 1]) lcyl(D, s * 5.2, 0.15, 6.1, 0.12, 2.9, 0xf2efe6);
  lsolid(D, 0, 0, 12, 8);
  signAt(D, 0, 3.9, 4.25, makeSign('OLD GARAGE DISPATCH', { w: 7, h: 0.9, bg: '#8a5a00' }));
  const dx = D.x(0, 6.6), dz = D.z(0, 6.6);
  addInteract({ id: 'depot', x: dx, z: dz, r: 5, label: 'START WORK', actions: [{ label: 'WORK', fn: () => Missions.start() }, { label: 'TALK', fn: () => UI.say('Dispatcher', 'Delivery Driver job: pick a parcel, drive it to the marker, earn ' + fmtMoney(CONFIG.jobReward) + '.') }] });
  POIS.push({ x: dx, z: dz, t: 'job' });
  const gate = Frame(-60, 13, Math.PI);
  for (const s of [-1, 1]) { lbox(gate, s * 12, 0, 0, 0.6, 5.5, 0.6, 0x4a4a4a); lsolid(gate, s * 12, 0, 0.8, 0.8); }
  lbox(gate, 0, 5.2, 0, 25, 0.5, 0.5, 0x4a4a4a);
  signAt(gate, 0, 5.5, 0.35, makeSign('OLD GARAGE', { w: 10, h: 1.4, bg: '#1b1b1b', fg: '#f2c230', double: true }));
}

/* ---- Iwo Green (park with a football pitch) ---- */
function buildPark() {
  flat(60, 0.04, 31.5, 100, 40, 0x5b9a3c);
  for (let k = 0; k < 8; k++) flat(60 - 17.5 + k * 5, 0.06, 32, 5, 24, k & 1 ? 0x4f9f3a : 0x57a842);
  for (const [x, z, w, d] of [[60, 20, 40, 0.2], [60, 44, 40, 0.2], [40, 32, 0.2, 24], [80, 32, 0.2, 24], [60, 32, 0.2, 24]]) flat(x, 0.075, z, w, d, 0xf4f4ee);
  for (const sx of [-1, 1]) { const x = 60 + sx * 20; box(x, 0, 28.5, 0.15, 2.4, 0.15, 0xf4f4ee); box(x, 0, 35.5, 0.15, 2.4, 0.15, 0xf4f4ee); box(x, 2.4, 32, 0.15, 0.15, 7.2, 0xf4f4ee); }
  for (let x = 16; x <= 106; x += 13) { tree(x, 14.5, -1); tree(x, 49.5, -1); }
  for (const x of [30, 90]) { box(x, 0.4, 17.5, 2, 0.1, 0.5, 0x8a6a45); box(x, 0, 17.5, 0.15, 0.4, 0.4, 0x444444); }
  B(GEO.pyr, 0x9c4a32, 22, 3.4, 26, 3.4, 1.4, 3.4);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { B(GEO.cyl, 0xf2efe6, 22 + sx * 1.8, 1.4, 26 + sz * 1.8, 0.1, 2.8, 0.1); }
  box(22, 0, 26, 4.4, 0.12, 4.4, 0xcdbf9f);
}

/* ---- Central Mosque landmark (simplified original tribute) beyond the bridge ---- */
function buildMosque() {
  const cx = 0, cz = 178;
  B(GEO.cyl, 0xd9ccb0, cx, 0.03, cz, 22, 0.06, 22); B(GEO.cyl, 0xf2eee2, cx, 0.07, cz, 12, 0.06, 12);
  flat(0, 0.07, 158, 8, 14, 0xd9ccb0);
  const F = Frame(cx, cz + 4, 0);                                 // prayer hall, entrance faces the bridge (north)
  const N = Frame(cx, cz + 4, Math.PI);
  lbox(N, 0, 0, 0, 18, 0.5, 14, 0xbdb7a8);
  lbox(N, 0, 0.5, 0, 16, 6, 12, 0xf7f5ee);
  lbox(N, 0, 6.5, 0, 16.6, 0.4, 12.6, 0x0f7d4a);
  lbox(N, 0, 0.5, 6.05, 3.4, 4.2, 0.1, 0x16346e);
  for (const k of [-6, -3, 3, 6]) lbox(N, k, 2.2, 6.05, 1.2, 2.2, 0.08, 0, 'win');
  for (const k of [-5, -2.5, 2.5, 5]) lcyl(N, k, 0.5, 7.2, 0.3, 4.2, 0xffffff);
  lbox(N, 0, 4.7, 7.2, 14, 0.3, 2.4, 0xe5e1d6);
  B(GEO.sph, 0x0f9d58, cx, 7.2, cz + 4, 5, 3.6, 5);                // main dome
  B(GEO.cyl, 0xf5b82e, cx, 11.3, cz + 4, 0.12, 1.2, 0.12); B(GEO.sph, 0xf5b82e, cx, 11.9, cz + 4, 0.35, 0.35, 0.35);
  for (const sx of [-1, 1]) {                                      // twin minarets
    const x = cx + sx * 10.5, z = cz + 0.5;
    B(GEO.cyl, 0xf7f5ee, x, 7, z, 1.1, 14, 1.1); B(GEO.cyl, 0x0f7d4a, x, 10.5, z, 1.4, 0.4, 1.4); B(GEO.cyl, 0x0f7d4a, x, 14.1, z, 1.3, 0.4, 1.3);
    B(GEO.sph, 0x0f9d58, x, 15, z, 1.2, 1.6, 1.2); B(GEO.sph, 0xf5b82e, x, 16.6, z, 0.25, 0.25, 0.25);
    solid(x, z, 2.2, 2.2);
  }
  solid(cx, cz + 4, 18, 14);
  signAt(N, 0, 5.4, 6.3, makeSign('IWO CENTRAL MOSQUE (INSPIRED)', { w: 9, h: 1, bg: '#0b3d2e' }));
  addInteract({ id: 'mosque', x: cx, z: cz - 6, r: 6, label: 'VIEW LANDMARK', actions: [{ label: 'VIEW', fn: () => Panels.info('Iwo Central Mosque (inspired)',
    'A simplified, original tribute to the Central Mosque, one of the best-known landmarks of Iwo. Iwo is recognised as an important centre of Islamic history and learning in Yoruba land. This model is stylised and not an exact reconstruction.') }] });
  POIS.push({ x: cx, z: cz - 6, t: 'land' });
  for (let i = 0; i < 40; i++) {                                    // gardens around the plaza
    const x = rr(-70, 70), z = rr(156, 205);
    if (Math.hypot(x - cx, z - cz) < 22 || (Math.abs(x) < 6 && z < 170)) continue; tree(x, z);
  }
  for (let x = -90; x <= 90; x += 15) if (Math.abs(x) > 12) { tree(x + rr(-3, 3), 104.5); tree(x + rr(-3, 3), 155.5); }
}

function buildStreetTrees() {
  for (const r of ROADS) {
    const half = r.w / 2, br = intervalsFor(r), step = r.k === 'main' ? 26 : 40;
    for (const sd of [-1, 1]) for (let t = r.a + 13; t < r.b - 10; t += step) {
      if (br.some(([s, e]) => t > s - 12 && t < e + 12)) continue;
      if (r.ax === 'z' && r.c === 0 && t > 95 && t < 165) continue;
      if (r.ax === 'z' && t < -108 && t > -114) continue;
      const off = sd * (half + 2.7), x = r.ax === 'x' ? t : r.c + off, z = r.ax === 'x' ? r.c + off : t;
      tree(x, z, 0);
    }
  }
  for (let i = 0; i < 70; i++) { const x = rr(-210, 210), z = rr(-205, -122); if (Math.abs(x) < 8) continue; tree(x, z); }
}
function buildGantry() {
  const F = Frame(-100, 0, Math.PI / 2);
  for (const s of [-1, 1]) { lbox(F, s * 9.5, 0, 0, 0.6, 6, 0.6, 0x4a4f52); lsolid(F, s * 9.5, 0, 0.8, 0.8); }
  lbox(F, 0, 5.6, 0, 20, 0.5, 0.5, 0x4a4f52);
  signAt(F, 0, 5.0, 0.3, makeSign('WELCOME TO IWO', { w: 14, h: 1.5, bg: '#0b3d2e', double: true }));
  // direction sign to the neighbouring cities (names only, no real distances)
  const D = Frame(110, 0, -Math.PI / 2);
  for (const s of [-1, 1]) { lbox(D, s * 9.5, 0, 0, 0.6, 6, 0.6, 0x4a4f52); lsolid(D, s * 9.5, 0, 0.8, 0.8); }
  lbox(D, 0, 5.6, 0, 20, 0.5, 0.5, 0x4a4f52);
  signAt(D, 0, 5.0, 0.3, makeSign('OGBOMOSHO  -  OYO', { w: 14, h: 1.5, bg: '#16346e', double: true }));
}
function buildLampDecals() {
  if (!LAMPS.length) return;
  const g = new THREE.CircleGeometry(4.5, 14); g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const im = new THREE.InstancedMesh(g, mat, LAMPS.length), m = new THREE.Matrix4();
  LAMPS.forEach((l, i) => { m.makeTranslation(l.x, 0.1, l.z); im.setMatrixAt(i, m); });
  im.frustumCulled = false; scene.add(im); lampDecals.mesh = im; lampDecals.mat = mat;
}
function buildWires() {
  const pts = [], a = new THREE.Vector3();
  for (const line of POLE_LINES) for (let i = 0; i < line.length - 1; i++) {
    const [x1, z1, ax] = line[i], [x2, z2] = line[i + 1];
    for (const o of [-0.9, 0, 0.9]) {
      const ox = ax === 'x' ? 0 : o, oz = ax === 'x' ? o : 0, mx = (x1 + x2) / 2 + ox, mz = (z1 + z2) / 2 + oz;
      pts.push(x1 + ox, 8.3, z1 + oz, mx, 7.9, mz, mx, 7.9, mz, x2 + ox, 8.3, z2 + oz);
    }
  }
  if (!pts.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1b1b1b })); l.frustumCulled = false; scene.add(l);
}
const stars = (() => {
  const arr = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) { const u = Math.random() * Math.PI * 2, y = Math.random() * 0.9 + 0.05, r = Math.sqrt(1 - y * y); arr[i * 3] = Math.cos(u) * r * 100; arr[i * 3 + 1] = y * 100; arr[i * 3 + 2] = Math.sin(u) * r * 100; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  p.frustumCulled = false; scene.add(p); return p;
})();

const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function buildWorld() {
  buildTerrain(); UI.progress(0.45); await tick();
  ROADS.forEach(buildRoad); buildCrossings(); UI.progress(0.52); await tick();
  buildRail(); buildRiver(); UI.progress(0.58); await tick();
  buildBlocks(); UI.progress(0.72); await tick();
  buildMarket(); buildGarage(); buildPark(); UI.progress(0.8); await tick();
  buildMosque(); buildStreetTrees(); buildGantry(); UI.progress(0.86); await tick();
  Batch.build(); buildGLBInstances(); buildLampDecals(); buildWires();
  if (Assets.road) { Assets.road.position.set(0, 0.06, 0); scene.add(Assets.road); }
  UI.progress(0.9); await tick();
}

/* ============================ 8. CHARACTERS ============================== */
const UNIT = { box: new THREE.BoxGeometry(1, 1, 1), sph: new THREE.SphereGeometry(1, 8, 6), cyl: new THREE.CylinderGeometry(1, 1, 1, 8, 1) };
function cgeo(base, color, tx, ty, tz, sx, sy, sz) {
  const g = base.clone(); g.scale(sx, sy, sz); g.translate(tx, ty, tz); g.deleteAttribute('uv');
  const n = g.attributes.position.count, c = new Float32Array(n * 3); _c.set(color);
  for (let i = 0; i < n; i++) { c[i * 3] = _c.r; c[i * 3 + 1] = _c.g; c[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
}
// Low-poly humanoid: 5 meshes (merged body + 4 limbs) sharing one material.
function makeHumanoid(o) {
  const g = new THREE.Group();
  const parts = [cgeo(UNIT.box, o.shirt, 0, 1.2, 0, 0.5, 0.62, 0.28), cgeo(UNIT.sph, o.skin, 0, 1.62, 0, 0.15, 0.17, 0.15), cgeo(UNIT.sph, o.hair, 0, 1.68, -0.01, 0.165, 0.12, 0.165)];
  if (o.female) { parts.push(cgeo(UNIT.cyl, o.shirt, 0, 0.88, 0, 0.3, 0.5, 0.22)); parts.push(cgeo(UNIT.sph, o.gele, 0, 1.78, 0, 0.2, 0.1, 0.2)); }
  const mk = (geo) => { const m = new THREE.Mesh(geo, MAT.main); m.castShadow = true; g.add(m); return m; };
  const body = mk(mergeGeometries(parts));
  const legG = cgeo(UNIT.box, o.female ? o.skin : o.pants, 0, -0.4, 0, 0.2, 0.8, 0.22);
  const armG = mergeGeometries([cgeo(UNIT.box, o.shirt, 0, -0.12, 0, 0.15, 0.26, 0.17), cgeo(UNIT.box, o.skin, 0, -0.4, 0, 0.12, 0.3, 0.14)]);
  const legL = mk(legG), legR = mk(legG), armL = mk(armG), armR = mk(armG);
  legL.position.set(-0.13, 0.82, 0); legR.position.set(0.13, 0.82, 0); armL.position.set(-0.34, 1.46, 0); armR.position.set(0.34, 1.46, 0);
  return { g, body, legL, legR, armL, armR };
}
function animHuman(h, phase, amp, t, wave) {
  const s = Math.sin(phase) * 0.7 * amp;
  h.legL.rotation.x = s; h.legR.rotation.x = -s; h.armL.rotation.x = -s * 0.8; h.armR.rotation.x = s * 0.8;
  h.armR.rotation.z = wave ? 2.4 + Math.sin(t * 9) * 0.3 : 0;
  h.body.scale.y = 1 + Math.sin(t * 2) * 0.012;
}
const SKINS = [0x6b4226, 0x8d5524, 0x5a3825, 0xa0673a, 0x4a2c1a];
const SHIRTS = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xe9c46a, 0x8338ec, 0xffffff, 0x0f9d58, 0x16346e];
const PANTS = [0x1d2433, 0x3a3a3a, 0x4a3b2a, 0x2b3a55];

/* ------------------------------ Player --------------------------------- */
const Player = {
  pos: new THREE.Vector3(), vx: 0, vz: 0, vy: 0, face: 0, grounded: true, r: 0.42, speed: 0, phase: 0,
  group: null, rig: null, mixer: null, actions: {}, cur: null,
  init() {
    this.group = new THREE.Group();
    if (Assets.player) {
      const m = cloneSkinned(Assets.player); m.rotation.y = CONFIG.assets.player.rotY; this.group.add(m);
      m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const clips = Assets.player.userData.animations || [];
      if (clips.length) {
        this.mixer = new THREE.AnimationMixer(m);
        const f = (re) => clips.find((c) => re.test(c.name));
        const idle = f(/idle|stand/i), walk = f(/walk/i) || f(/run/i) || clips[0], run = f(/run|sprint/i) || walk;
        this.actions = { idle: idle && this.mixer.clipAction(idle), walk: walk && this.mixer.clipAction(walk), run: run && this.mixer.clipAction(run) };
      }
    } else {
      this.rig = makeHumanoid({ skin: 0x7a4a2b, shirt: 0x0f9d58, pants: 0x1d2433, hair: 0x111111 }); this.group.add(this.rig.g);
    }
    scene.add(this.group);
  },
  spawn(x, z, face) { this.pos.set(x, groundY(x, z), z); this.vx = this.vz = this.vy = 0; this.face = face; this.grounded = true; this.sync(0); },
  update(dt) {
    const mv = Input.move(), len = Math.min(1, Math.hypot(mv.x, mv.y));
    const f = { x: -Math.sin(Cam.yaw), z: -Math.cos(Cam.yaw) }, rt = { x: Math.cos(Cam.yaw), z: -Math.sin(Cam.yaw) };
    let dx = f.x * mv.y + rt.x * mv.x, dz = f.z * mv.y + rt.z * mv.x; const dl = Math.hypot(dx, dz) || 1;
    const sp = (Input.sprint() ? 8.2 : 4.6) * len;
    const tvx = dx / dl * sp, tvz = dz / dl * sp, acc = (len > 0.05 ? 30 : 22) * dt;
    this.vx = approach(this.vx, tvx, acc); this.vz = approach(this.vz, tvz, acc);
    this.pos.x += this.vx * dt; this.pos.z += this.vz * dt;
    const p = { x: this.pos.x, z: this.pos.z };
    Col.resolve(p, this.r); Vehicle.pushOut(p, this.r);
    this.pos.x = clamp(p.x, -CONFIG.bounds, CONFIG.bounds); this.pos.z = clamp(p.z, -CONFIG.bounds, CONFIG.bounds);
    const gy = groundY(this.pos.x, this.pos.z);
    if (Input.consumeJump() && this.grounded) { this.vy = 7.2; this.grounded = false; }
    this.vy -= 24 * dt; this.pos.y += this.vy * dt;
    if (this.pos.y <= gy) { this.pos.y = gy; this.vy = 0; this.grounded = true; } else if (this.pos.y > gy + 0.05) this.grounded = false;
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed > 0.4) this.face += angDiff(this.face, Math.atan2(this.vx, this.vz)) * Math.min(1, dt * 14);
    this.sync(dt);
  },
  sync(dt) {
    this.group.position.copy(this.pos); this.group.rotation.y = this.face;
    this.phase += dt * this.speed * 2.1;
    if (this.mixer) {
      const want = this.speed < 0.3 ? (this.actions.idle ? 'idle' : 'walk') : this.speed > 6.2 ? 'run' : 'walk', a = this.actions[want];
      if (a && this.cur !== a) { if (this.cur) this.cur.fadeOut(0.2); a.reset().fadeIn(0.2).play(); this.cur = a; }
      if (this.cur) this.cur.timeScale = want === 'walk' && this.speed < 0.3 ? 0 : 1;
      this.mixer.update(dt);
    } else if (this.rig) animHuman(this.rig, this.phase, Math.min(this.speed / 5, 1.2), G.time, !this.grounded);
  }
};

/* ------------------------------ Camera --------------------------------- */
const Cam = {
  yaw: Math.PI, pitch: 0.38, zoom: 1, dist: 6.2, manual: 0, look: new THREE.Vector3(), des: new THREE.Vector3(), init: false,
  rotate(dx, dy, s) { this.yaw -= dx * s; this.pitch = clamp(this.pitch + dy * s, 0.08, 1.25); this.manual = 1.8; },
  reset() { this.yaw = (G.inCar ? Vehicle.h : Player.face) + Math.PI; this.pitch = 0.38; this.zoom = 1; },
  update(dt) {
    let tx, ty, tz;
    if (G.inCar) { tx = Vehicle.x; ty = Vehicle.y + 1.2; tz = Vehicle.z; } else { tx = Player.pos.x; ty = Player.pos.y + 1.45; tz = Player.pos.z; }
    this.manual = Math.max(0, this.manual - dt);
    if (G.inCar && this.manual <= 0) this.yaw += angDiff(this.yaw, Vehicle.h + Math.PI + (Vehicle.speed < -1 ? Math.PI : 0)) * Math.min(1, dt * 2.2);
    this.dist = lerp(this.dist, (G.inCar ? 9 : 6.2) * this.zoom, 1 - Math.exp(-6 * dt));
    const cp = Math.cos(this.pitch);
    this.des.set(tx + Math.sin(this.yaw) * cp * this.dist, ty + Math.sin(this.pitch) * this.dist, tz + Math.cos(this.yaw) * cp * this.dist);
    const gy = groundY(this.des.x, this.des.z) + 0.5; if (this.des.y < gy) this.des.y = gy;
    if (!this.init) { camera.position.copy(this.des); this.look.set(tx, ty, tz); this.init = true; }
    const k = 1 - Math.exp(-16 * dt);
    camera.position.lerp(this.des, k); this.look.lerp(_p.set(tx, ty, tz), k);
    camera.lookAt(this.look);
    const fov = 65 + (G.inCar ? Math.min(Math.abs(Vehicle.speed), 25) * 0.5 : 0);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = lerp(camera.fov, fov, 0.1); camera.updateProjectionMatrix(); }
  }
};

/* ------------------------------ Vehicle -------------------------------- */
const CAR_R = 1.0, CAR_OFF = 1.15;
function makeCarMesh() {
  const g = new THREE.Group(), Y = 0xf2c230;   // yellow body, black stripe: classic Nigerian taxi look
  const body = mergeGeometries([
    cgeo(UNIT.box, Y, 0, 0.65, 0, 1.8, 0.6, 4.3), cgeo(UNIT.box, 0x1a1a1a, 0, 0.72, 0, 1.82, 0.14, 4.32),
    cgeo(UNIT.box, Y, 0, 1.25, -0.3, 1.6, 0.6, 2.2), cgeo(UNIT.box, 0x1d2a33, 0, 1.27, -0.3, 1.64, 0.36, 1.95),
    cgeo(UNIT.box, 0x1a1a1a, 0, 0.42, 2.2, 1.9, 0.22, 0.2), cgeo(UNIT.box, 0x1a1a1a, 0, 0.42, -2.2, 1.9, 0.22, 0.2),
    cgeo(UNIT.box, 0xfff3c0, -0.6, 0.78, 2.16, 0.35, 0.18, 0.08), cgeo(UNIT.box, 0xfff3c0, 0.6, 0.78, 2.16, 0.35, 0.18, 0.08),
    cgeo(UNIT.box, 0xd22222, -0.6, 0.78, -2.16, 0.35, 0.18, 0.08), cgeo(UNIT.box, 0xd22222, 0.6, 0.78, -2.16, 0.35, 0.18, 0.08),
    cgeo(UNIT.box, 0xf4f4f0, 0, 1.65, -0.3, 0.5, 0.18, 0.25)
  ]);
  const bm = new THREE.Mesh(body, MAT.main); bm.castShadow = true; g.add(bm);
  const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10); wg.rotateZ(Math.PI / 2);
  const wm = new THREE.MeshLambertMaterial({ color: 0x1b1b1b }), wheels = [], fronts = [];
  for (const sx of [-1, 1]) {
    const pv = new THREE.Group(); pv.position.set(sx * 0.9, 0.34, 1.4); const w = new THREE.Mesh(wg, wm); pv.add(w); g.add(pv); fronts.push(pv); wheels.push(w);
    const w2 = new THREE.Mesh(wg, wm); w2.position.set(sx * 0.9, 0.34, -1.35); g.add(w2); wheels.push(w2);
  }
  const cg = new THREE.PlaneGeometry(3.4, 8); cg.rotateX(-Math.PI / 2);
  const cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  cone.position.set(0, 0.12, 6.4); cone.frustumCulled = false; g.add(cone);
  return { g, wheels, fronts, cone };
}
const Vehicle = {
  x: 0, y: 0, z: 0, h: 0, speed: 0, steer: 0, group: null, wheels: [], fronts: [], cone: null, hit: false,
  init() {
    this.group = new THREE.Group();
    if (Assets.car) {
      const m = cloneSkinned(Assets.car); m.rotation.y = CONFIG.assets.car.rotY; this.group.add(m);
      m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const cg = new THREE.PlaneGeometry(3.4, 8); cg.rotateX(-Math.PI / 2);
      this.cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.cone.position.set(0, 0.12, 6.4); this.cone.frustumCulled = false; this.group.add(this.cone);
    } else { const c = makeCarMesh(); this.group.add(c.g); this.wheels = c.wheels; this.fronts = c.fronts; this.cone = c.cone; }
    scene.add(this.group);
  },
  place(x, z, h) { this.x = x; this.z = z; this.h = h; this.speed = 0; this.steer = 0; this.y = groundY(x, z); this.sync(); },
  update(dt, driven) {
    if (driven) {
      const thr = Input.throttle(), brake = Input.brake(), maxV = 26;
      if (thr > 0.05) { if (this.speed < -0.5) this.speed += 30 * dt; else this.speed += 11 * thr * dt * (1 - Math.max(0, this.speed) / (maxV + 2)); }
      else if (thr < -0.05) { if (this.speed > 0.5) this.speed -= 30 * -thr * dt; else this.speed = Math.max(this.speed + 7 * thr * dt, -9); }
      else this.speed = approach(this.speed, 0, 3.2 * dt);
      if (brake) this.speed = approach(this.speed, 0, 34 * dt);
      this.speed = clamp(this.speed, -9, maxV);
    } else this.speed = approach(this.speed, 0, 16 * dt);
    const maxSteer = 0.62 / (1 + Math.abs(this.speed) * 0.07), sIn = driven ? Input.steerAxis() : 0;
    this.steer += (sIn * maxSteer - this.steer) * Math.min(1, 8 * dt);
    this.h += -(this.speed * Math.tan(this.steer) / 2.7) * dt;
    this.x += Math.sin(this.h) * this.speed * dt; this.z += Math.cos(this.h) * this.speed * dt;
    const sx = Math.sin(this.h) * CAR_OFF, sz = Math.cos(this.h) * CAR_OFF;
    const pF = { x: this.x + sx, z: this.z + sz }, pR = { x: this.x - sx, z: this.z - sz };
    const hit = Col.resolve(pF, CAR_R) | Col.resolve(pR, CAR_R);
    this.x = (pF.x + pR.x) / 2; this.z = (pF.z + pR.z) / 2;
    if (hit) this.speed *= 0.6;
    this.x = clamp(this.x, -CONFIG.bounds, CONFIG.bounds); this.z = clamp(this.z, -CONFIG.bounds, CONFIG.bounds);
    this.y = groundY(this.x, this.z);
    for (const w of this.wheels) w.rotation.x += this.speed * dt / 0.34;
    for (const f of this.fronts) f.rotation.y = -this.steer;
    this.sync();
  },
  sync() {
    this.group.position.set(this.x, this.y, this.z); this.group.rotation.y = this.h;
    this.group.rotation.z = -this.steer * this.speed * 0.012;
  },
  pushOut(p, r) {   // keep pedestrians out of the parked/driving car
    const sx = Math.sin(this.h) * CAR_OFF, sz = Math.cos(this.h) * CAR_OFF;
    for (const k of [1, -1]) {
      const cx = this.x + sx * k, cz = this.z + sz * k, dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz), m = CAR_R + r;
      if (d < m) { const s = d > 1e-5 ? (m - d) / d : 0; p.x += d > 1e-5 ? dx * s : m; p.z += d > 1e-5 ? dz * s : 0; }
    }
  }
};
function enterCar() {
  if (G.inCar) return;
  G.inCar = true; Player.group.visible = false; Player.speed = 0; Player.vx = Player.vz = 0;
  $('tJump').textContent = 'BRAKE'; $('speedo').hidden = false; Cam.manual = 0;
  UI.toast(IS_TOUCH ? 'Joystick: gas / steer. BRAKE button. CAR to exit.' : 'W/S gas & reverse, A/D steer, SPACE brake, F exit');
}
function exitCar() {
  if (!G.inCar) return;
  if (Math.abs(Vehicle.speed) > 7) { UI.toast('SLOW DOWN FIRST'); return; }
  G.inCar = false; Vehicle.speed = 0;
  const p = { x: Vehicle.x + Math.cos(Vehicle.h) * 2.4, z: Vehicle.z - Math.sin(Vehicle.h) * 2.4 };
  Col.resolve(p, Player.r); Player.pos.set(p.x, groundY(p.x, p.z), p.z); Player.face = Vehicle.h; Player.group.visible = true;
  $('tJump').textContent = 'JUMP'; $('speedo').hidden = true; Cam.manual = 0;
}
function toggleCar() {
  if (G.inCar) { exitCar(); return; }
  if (Math.hypot(Player.pos.x - Vehicle.x, Player.pos.z - Vehicle.z) < 4) enterCar(); else UI.toast('No vehicle nearby');
}

/* -------------------------------- NPCs --------------------------------- */
const NPC_NAMES = ['Tunde', 'Bisi', 'Femi', 'Kemi', 'Seun', 'Ade', 'Sade', 'Dayo', 'Yemi', 'Lola', 'Wale', 'Nike', 'Bayo', 'Funmi', 'Tola', 'Segun'];
const NPC_LINES = ['Welcome to Iwo!', 'Where are you heading?', 'The market is this way. Follow the main road east.',
  'Old Garage has delivery jobs. Ask at the dispatch office.', 'Have you seen the Central Mosque? Cross the bridge to the south.',
  'Cocoa is big business around here.', 'The sun is hot today. Buy some zobo at the market.', 'Mind the road at night o!',
  'Iwo is a small town with a big heart.', 'If you need money, drive a delivery.'];
const NPC_REGIONS = [   // minX, maxX, minZ, maxZ  (sidewalks first so some NPCs are near the start)
  [-70, 30, -9.8, -7.6], [-110, -20, 7.6, 9.8], [30, 100, -10, -8], [60, 110, 7.6, 9.8],
  [24, 96, -42, -14], [-108, -12, 15, 50], [14, 108, 14, 50], [5.4, 8, -100, -14], [-8, -5.4, 14, 100], [-12, 12, 158, 195], [-150, -80, -9.8, -7.6], [-8, 8, 62, 100]
];
const NPCs = {
  init() {
    for (let i = 0; i < 14; i++) {
      const reg = NPC_REGIONS[i % NPC_REGIONS.length], female = i % 2 === 1;
      const rig = makeHumanoid({ skin: SKINS[i % SKINS.length], shirt: SHIRTS[(i * 3) % SHIRTS.length], pants: PANTS[i % PANTS.length], hair: 0x151515, female, gele: SHIRTS[(i * 5 + 2) % SHIRTS.length] });
      const n = { g: rig.g, rig, reg, name: NPC_NAMES[i], state: 'idle', t: Math.random() * 3, tx: 0, tz: 0, speed: 1.1 + Math.random() * 0.5, phase: Math.random() * 6, face: Math.random() * 6, wave: false,
        lines: NPC_LINES.slice().sort(() => Math.random() - 0.5).slice(0, 5), li: 0, lastTalk: -99, lx: 0, lz: 0, stuckT: 0, on: true, seed: i, greeted: false };
      let tries = 0;
      do { n.g.position.set(lerp(reg[0], reg[1], Math.random()), 0.06, lerp(reg[2], reg[3], Math.random())); tries++; } while (Col.test(n.g.position.x, n.g.position.z, 0.5) && tries < 12);
      n.lx = n.g.position.x; n.lz = n.g.position.z;
      n.interact = { id: 'npc' + i, x: 0, z: 0, r: 2.8, label: 'TALK', actions: [{ label: 'TALK', fn: () => this.say(n, true) }], npc: n };
      scene.add(n.g); NPC_LIST.push(n);
    }
  },
  pick(n) {
    for (let k = 0; k < 10; k++) {
      const x = lerp(n.reg[0], n.reg[1], Math.random()), z = lerp(n.reg[2], n.reg[3], Math.random());
      if (!Col.test(x, z, 0.5)) { n.tx = x; n.tz = z; return; }
    }
    n.tx = n.g.position.x; n.tz = n.g.position.z;
  },
  greeting() { const h = Math.floor((G.minutes % 1440) / 60); return h < 12 ? 'E kaaro! Good morning.' : h < 17 ? 'E kaasan! Good afternoon.' : 'E kuurole! Good evening.'; },
  say(n, force) {
    const line = !n.greeted ? this.greeting() : n.lines[n.li++ % n.lines.length]; n.greeted = true;
    n.state = 'talk'; n.t = 4; n.lastTalk = G.time; UI.say(n.name, line);
  },
  update(dt) {
    const rx = G.inCar ? Vehicle.x : Player.pos.x, rz = G.inCar ? Vehicle.z : Player.pos.z;
    for (const n of NPC_LIST) {
      if (!n.on) continue;
      const g = n.g, dx0 = g.position.x - rx, dz0 = g.position.z - rz, d2 = dx0 * dx0 + dz0 * dz0;
      if (d2 > 95 * 95) { g.visible = false; continue; }
      g.visible = true; n.t -= dt; let moving = false;
      if (n.state === 'talk') {
        n.face += angDiff(n.face, Math.atan2(rx - g.position.x, rz - g.position.z)) * Math.min(1, dt * 8);
        if (n.t <= 0) { n.state = 'idle'; n.t = 1 + Math.random() * 2; }
      } else if (n.state === 'idle') {
        if (n.t <= 0) { this.pick(n); n.state = 'walk'; n.stuckT = 0; n.lx = g.position.x; n.lz = g.position.z; }
      } else {
        const dx = n.tx - g.position.x, dz = n.tz - g.position.z, d = Math.hypot(dx, dz);
        if (d < 0.35) { n.state = 'idle'; n.t = 2 + Math.random() * 4; n.wave = Math.random() < 0.2; }
        else {
          moving = true;
          const p = { x: g.position.x + dx / d * n.speed * dt, z: g.position.z + dz / d * n.speed * dt };
          Col.resolve(p, 0.35); Vehicle.pushOut(p, 0.35); g.position.x = p.x; g.position.z = p.z;
          n.face += angDiff(n.face, Math.atan2(dx, dz)) * Math.min(1, dt * 8);
          n.stuckT += dt;
          if (n.stuckT > 1.2) { if (Math.hypot(g.position.x - n.lx, g.position.z - n.lz) < 0.4) this.pick(n); n.lx = g.position.x; n.lz = g.position.z; n.stuckT = 0; }
        }
      }
      if (d2 < 2.8 * 2.8 && !G.inCar && !G.modal && G.time - n.lastTalk > 14 && n.state !== 'talk') this.say(n);
      g.rotation.y = n.face; n.phase += dt * (moving ? n.speed * 4.6 : 0);
      animHuman(n.rig, n.phase, moving ? 0.9 : 0, G.time + n.seed, !moving && n.wave);
      n.interact.x = g.position.x; n.interact.z = g.position.z;
    }
  }
};

/* ============================ 9. GAMEPLAY ================================ */

/* ----------------------------- Economy --------------------------------- */
const SHOP_ITEMS = [
  { id: 'zobo', name: 'Zobo Drink', price: 300 }, { id: 'puff', name: 'Puff-Puff Pack', price: 500 }, { id: 'moi', name: 'Moi Moi', price: 700 },
  { id: 'credit', name: 'Airtime Recharge', price: 1000 }, { id: 'suya', name: 'Suya (spicy beef)', price: 1500 }, { id: 'ankara', name: 'Ankara Fabric', price: 4500 }
];
const Economy = {
  add(n) { G.money += n; UI.flashMoney(n > 0); Net.syncMoney(); },
  spend(n) { if (G.money < n) return false; G.money -= n; UI.flashMoney(false); Net.syncMoney(); return true; },
  buy(id) { const it = SHOP_ITEMS.find((i) => i.id === id); if (!it) return; if (!this.spend(it.price)) { UI.toast('NOT ENOUGH MONEY'); return; } G.inventory[id] = (G.inventory[id] || 0) + 1; },
  sell(id) { const it = SHOP_ITEMS.find((i) => i.id === id); if (!it || !G.inventory[id]) return; G.inventory[id]--; this.add(Math.floor(it.price * 0.5)); }
};

/* ----------------------------- Missions -------------------------------- */
const DROPS = [
  { name: 'Ibadan Road Junction', x: -170, z: -8.7 }, { name: 'Cocoa Depot Gate', x: -113.3, z: -35 }, { name: 'Iwo Central Bus Stop', x: -60, z: 8.7 },
  { name: 'Oja Iwo Market Gate', x: 75, z: -8.7 }, { name: 'Station Road Crossing', x: 6.7, z: -85 }, { name: 'Oyo Road Close', x: 170, z: 8.7 }, { name: 'Stream Bridge Head', x: 6.7, z: 98 }
];
const Missions = {
  active: null, completed: [], last: -1, marker: null, objT: 0,
  init() {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 50, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0xf5b82e, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    beam.position.y = 25; g.add(beam);
    const ringG = new THREE.RingGeometry(1.6, 2.2, 24); ringG.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({ color: 0xf5b82e, transparent: true, opacity: 0.8, side: THREE.DoubleSide, fog: false }));
    ring.position.y = 0.15; g.add(ring); g.visible = false; scene.add(g); this.marker = g; this.ring = ring;
  },
  drop() { return this.active ? DROPS[this.active.drop] : null; },
  begin(idx, silent) {
    this.active = { id: 'delivery', drop: idx, reward: CONFIG.jobReward }; this.last = idx;
    const d = DROPS[idx]; this.marker.position.set(d.x, groundY(d.x, d.z), d.z); this.marker.visible = true;
    $('objective').hidden = false; this.objT = 0;
    if (!silent) UI.big('MISSION STARTED', 'Delivery Driver');
  },
  start() {
    if (this.active) { UI.toast('Finish your current delivery first.'); return; }
    let i; do { i = Math.floor(Math.random() * DROPS.length); } while (i === this.last);
    this.begin(i); UI.say('Dispatcher', 'Parcel loaded! Deliver to ' + DROPS[i].name + '. A car helps, press F near it.');
  },
  complete() {
    this.completed.push({ id: 'delivery', day: Math.floor(G.minutes / 1440) + 1 });
    this.active = null; this.marker.visible = false; $('objective').hidden = true;
    Economy.add(CONFIG.jobReward); UI.big('MISSION COMPLETE', '+' + fmtMoney(CONFIG.jobReward));
  },
  update(dt) {
    if (!this.active) return;
    const d = this.drop(), px = G.inCar ? Vehicle.x : Player.pos.x, pz = G.inCar ? Vehicle.z : Player.pos.z;
    const dist = Math.hypot(d.x - px, d.z - pz);
    this.ring.scale.setScalar(1 + Math.sin(G.time * 4) * 0.12);
    if (dist < 4.5) { this.complete(); return; }
    this.objT -= dt;
    if (this.objT <= 0) {
      this.objT = 0.25;
      // arrow relative to where the camera is looking (positive angle = target is to the left)
      const fwd = Math.atan2(-Math.sin(Cam.yaw), -Math.cos(Cam.yaw)), to = Math.atan2(d.x - px, d.z - pz), rel = angDiff(fwd, to);
      const arrows = ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'];
      const arrow = arrows[((Math.round(-rel / (Math.PI / 4)) % 8) + 8) % 8];
      $('objText').textContent = 'Deliver the package to the marked location: ' + d.name + '  ' + arrow + '  ' + Math.round(dist) + ' m';
    }
  },
  restore(m) { if (m && DROPS[m.drop]) this.begin(m.drop, true); }
};

/* ----------------------------- Day / night ----------------------------- */
const DayNight = {
  sky: new THREE.Color(), cDay: new THREE.Color(0x8fd0f5), cDusk: new THREE.Color(0xff9a5c), cNight: new THREE.Color(0x070b1c),
  sunCol: new THREE.Color(0xfff2d6), moonCol: new THREE.Color(0x9db4ff), sunset: new THREE.Color(0xffa066), tmp: new THREE.Color(),
  wDay: new THREE.Color(0x5f7f96), wNight: new THREE.Color(0xffd070), bDay: new THREE.Color(0x4a4a4a), bNight: new THREE.Color(0xffe9b0), day: 1, lamp: 0,
  update(dt) { G.minutes += dt * CONFIG.minutesPerSecond; this.apply(); },
  apply() {
    const tod = (G.minutes % 1440) / 60, ang = (tod - 6) / 12 * Math.PI, elev = Math.sin(ang);
    const w = smooth(-0.08, 0.38, elev), dusk = Math.exp(-Math.pow(elev / 0.22, 2));
    this.day = w; this.lamp = 1 - smooth(0.1, 0.5, w);
    this.sky.copy(this.cNight).lerp(this.cDay, w).lerp(this.cDusk, dusk * 0.55);
    scene.background.copy(this.sky); scene.fog.color.copy(this.sky);
    hemi.intensity = 0.34 + 0.6 * w; hemi.color.copy(this.sky).lerp(this.tmp.set(0xffffff), 0.4);
    ambient.intensity = 0.1 + 0.1 * (1 - w);
    sun.intensity = 0.25 + 1.0 * w; sun.color.copy(this.moonCol).lerp(this.sunCol, w).lerp(this.sunset, dusk * 0.5 * w);
    const rx = Player.pos.x, rz = Player.pos.z;
    sun.target.position.set(Math.round(rx / 2) * 2, 0, Math.round(rz / 2) * 2);
    this._d = this._d || new THREE.Vector3(); this._d.set(Math.cos(ang) * 0.9, Math.max(Math.abs(elev), 0.25), 0.5).normalize().multiplyScalar(80);
    sun.position.copy(sun.target.position).add(this._d);
    MAT.bulb.color.copy(this.bDay).lerp(this.bNight, this.lamp);
    MAT.win.color.copy(this.wDay).lerp(this.wNight, this.lamp * 0.9);
    if (lampDecals.mat) lampDecals.mat.opacity = 0.38 * this.lamp;
    if (Vehicle.cone) Vehicle.cone.material.opacity = 0.3 * this.lamp;
    stars.material.opacity = Math.pow(1 - w, 2); stars.position.copy(camera.position);
  }
};

/* ------------------------------ Save system ---------------------------- */
const Save = {
  has() { try { return !!localStorage.getItem(CONFIG.saveKey); } catch (e) { return false; } },
  save() {
    const data = { v: 2, money: G.money, minutes: G.minutes, inventory: G.inventory,
      player: { x: Player.pos.x, y: Player.pos.y, z: Player.pos.z, face: Player.face },
      vehicle: { x: Vehicle.x, z: Vehicle.z, h: Vehicle.h }, inCar: G.inCar,
      apartment: G.apartment, skills: G.skills,
      mission: Missions.active ? { drop: Missions.active.drop } : null, completed: Missions.completed };
    try { localStorage.setItem(CONFIG.saveKey, JSON.stringify(data)); UI.toast('GAME SAVED'); } catch (e) { UI.toast('SAVE FAILED'); }
    Net.syncProfile();
  },
  load() {
    let d; try { d = JSON.parse(localStorage.getItem(CONFIG.saveKey)); } catch (e) { d = null; }
    if (!d) { UI.toast('NO SAVE FOUND'); return false; }
    if (G.inCar) exitCar();
    if (!G.uid) G.money = d.money;
    G.minutes = d.minutes; G.inventory = d.inventory || {};
    if (d.apartment) G.apartment = d.apartment;
    if (d.skills) G.skills = d.skills;
    Player.pos.set(d.player.x, d.player.y, d.player.z); Player.face = d.player.face; Player.vx = Player.vz = Player.vy = 0;
    Vehicle.place(d.vehicle.x, d.vehicle.z, d.vehicle.h);
    Missions.completed = d.completed || []; Missions.active = null; Missions.marker.visible = false; $('objective').hidden = true;
    if (d.mission) Missions.restore(d.mission);
    if (d.inCar) enterCar();
    Cam.reset(); DayNight.apply(); UI.toast('GAME LOADED'); return true;
  }
};

/* ----------------------------- Interactions ---------------------------- */
const carInteract = { id: 'car', x: 0, z: 0, r: 3.8, label: 'ENTER CAR', key: 'F', actions: [{ label: 'ENTER', fn: enterCar }] };
const exitInteract = { id: 'exit', label: 'EXIT CAR', key: 'F', actions: [{ label: 'EXIT', fn: exitCar }] };
const Interact = {
  cur: null,
  update() {
    if (G.modal || G.phoneOpen) { UI.setPrompt(null); this.cur = null; return; }
    if (G.inCar) { this.cur = exitInteract; UI.setPrompt(exitInteract); return; }
    const px = Player.pos.x, pz = Player.pos.z; let best = null, bd = 1e9;
    for (const o of INTERACTABLES) { const d = Math.hypot(px - o.x, pz - o.z); if (d < o.r && d < bd) { bd = d; best = o; } }
    carInteract.x = Vehicle.x; carInteract.z = Vehicle.z;
    let d = Math.hypot(px - Vehicle.x, pz - Vehicle.z); if (d < carInteract.r && d < bd) { bd = d; best = carInteract; }
    for (const n of NPC_LIST) { if (!n.on || !n.g.visible) continue; d = Math.hypot(px - n.g.position.x, pz - n.g.position.z); if (d < n.interact.r && d < bd) { bd = d; best = n.interact; } }
    this.cur = best; UI.setPrompt(best);
  },
  use(i = 0) { const o = this.cur; if (!o || G.modal) return; const a = o.actions[i]; if (a) a.fn(); }
};

/* ----------------------------- Panels (modals) ------------------------- */
const Panels = {
  tab: 'buy', shopName: '',
  home() {
    UI.modal('<h2>YOUR HOME</h2><p class="note">Rest until morning or save your progress.</p>' +
      '<button class="btn" data-act="sleep">SLEEP UNTIL MORNING</button><button class="btn" data-act="save">SAVE GAME</button><button class="btn" data-act="close">LEAVE</button>');
  },
  info(title, text) { UI.modal('<h2>' + title + '</h2><p class="note">' + text + '</p><button class="btn" data-act="close">CLOSE</button>'); },
  shop(name, tab) {
    this.shopName = name; this.tab = tab || 'buy';
    let rows = '';
    if (this.tab === 'buy') rows = SHOP_ITEMS.map((i) => '<div class="row"><div class="nm">' + i.name + '<small>' + fmtMoney(i.price) + '</small></div><button data-act="buy:' + i.id + '"' + (G.money < i.price ? ' disabled' : '') + '>BUY</button></div>').join('');
    else {
      const owned = SHOP_ITEMS.filter((i) => G.inventory[i.id] > 0);
      rows = owned.length ? owned.map((i) => '<div class="row"><div class="nm">' + i.name + ' x' + G.inventory[i.id] + '<small>Sell for ' + fmtMoney(Math.floor(i.price * 0.5)) + '</small></div><button data-act="sell:' + i.id + '">SELL</button></div>').join('') : '<p class="note">You have nothing to sell yet. Buy something first.</p>';
    }
    UI.modal('<h2>' + name + '</h2><div class="wallet">' + fmtMoney(G.money) + '</div><div class="tabs"><button class="' + (this.tab === 'buy' ? 'on' : '') + '" data-act="tab:buy">BUY</button><button class="' + (this.tab === 'sell' ? 'on' : '') + '" data-act="tab:sell">SELL</button></div>' + rows + '<button class="btn" data-act="close">CLOSE</button>');
  },
  handle(act) {
    const [a, v] = act.split(':');
    if (a === 'close') UI.closeModal();
    else if (a === 'save') Save.save();
    else if (a === 'sleep') {
      const day = Math.floor(G.minutes / 1440), tod = G.minutes % 1440;
      G.minutes = (day + (tod >= 7 * 60 ? 1 : 0)) * 1440 + 7 * 60; DayNight.apply(); UI.closeModal(); UI.big('GOOD MORNING', 'DAY ' + (Math.floor(G.minutes / 1440) + 1));
    } else if (a === 'tab') this.shop(this.shopName, v);
    else if (a === 'buy') { Economy.buy(v); this.shop(this.shopName, 'buy'); }
    else if (a === 'sell') { Economy.sell(v); this.shop(this.shopName, 'sell'); }
  }
};

/* ======================== 10. MULTIPLAYER (Firebase + Phone + WebRTC) ===== */
/*
  Security rules (paste into Firebase Realtime Database → Rules):
  {
    "rules": {
      "users": { "$uid": { ".read": "auth != null", ".write": "auth != null && auth.uid === $uid" } },
      "presence": { ".read": "auth != null", "$uid": { ".write": "auth != null && auth.uid === $uid" } },
      "chats": {
        "$chatId": {
          ".read": "auth != null",
          "messages": { "$mid": { ".write": "auth != null && (!data.exists() || data.child('from').val() === auth.uid)" } }
        }
      },
      "services": { ".read": "auth != null", "$id": { ".write": "auth != null" } },
      "builds": {
        ".read": true,
        "$id": {
          ".write": "auth != null && (!data.exists() || data.child('uid').val() === auth.uid)",
          ".validate": "newData.hasChildren(['type','x','z','uid','t'])"
        }
      },
      "reports": { ".read": false, ".write": "auth != null" },
      "signaling": { "$room": { ".read": "auth != null", ".write": "auth != null" } }
    }
  }
*/
const Net = {
  ready: false, db: null, auth: null, unsub: [],
  peers: {},          // uid -> presence data
  chatPartner: null,  // { uid, name }
  chatUnsub: null,
  pc: null,           // RTCPeerConnection
  localStream: null,
  _authReady: null,   // Promise that resolves when first auth state is known

  init() {
    if (typeof firebase === 'undefined') {
      console.warn('[IwoLife] Firebase SDK not loaded — online features disabled.');
      this._authReady = Promise.resolve(null);
      return false;
    }
    try {
      const cfg = CONFIG.firebase;
      if (!cfg || !cfg.apiKey || cfg.apiKey === 'YOUR_API_KEY') {
        console.info('[IwoLife] Firebase config not set — running in offline/guest mode.');
        this._authReady = Promise.resolve(null);
        return false;
      }
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      this.auth = firebase.auth();
      this.db = firebase.database();
      // Persist session across browser restarts (default is LOCAL, set explicitly)
      try {
        this.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      } catch (e) { console.warn('[IwoLife] setPersistence:', e.message); }
      this.ready = true;

      // Resolve once Firebase has restored any existing session (or confirmed none)
      this._authReady = new Promise((resolve) => {
        const unsub = this.auth.onAuthStateChanged((user) => {
          unsub(); // only need the first emission
          resolve(user || null);
        });
      });
      return true;
    } catch (e) {
      console.warn('[IwoLife] Firebase init failed:', e.message);
      this._authReady = Promise.resolve(null);
      return false;
    }
  },

  /** Wait until auth session restore finishes. Returns User or null. */
  async waitAuth() {
    if (!this._authReady) return null;
    return this._authReady;
  },

  /** Map Firebase error codes to short player-facing messages */
  authError(err) {
    const code = (err && err.code) || '';
    const map = {
      'auth/email-already-in-use': 'That email is already registered. Sign in instead.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/user-not-found': 'No account with that email. Create one first.',
      'auth/wrong-password': 'Wrong password. Try again.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/invalid-login-credentials': 'Wrong email or password.',
      'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
      'auth/network-request-failed': 'Network error. Check your internet connection.',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase Console.',
      'auth/missing-password': 'Please enter your password.',
      'auth/missing-email': 'Please enter your email.'
    };
    return map[code] || (err && err.message) || 'Authentication failed';
  },

  async signUp(email, pass, name) {
    if (!this.ready) throw new Error('Online services not configured — add your Firebase config in game.js');
    email = (email || '').trim().toLowerCase();
    pass = pass || '';
    name = (name || '').trim().slice(0, 20);
    if (!email || !email.includes('@')) throw Object.assign(new Error('invalid-email'), { code: 'auth/invalid-email' });
    if (pass.length < 6) throw Object.assign(new Error('weak-password'), { code: 'auth/weak-password' });

    const cred = await this.auth.createUserWithEmailAndPassword(email, pass);
    const uid = cred.user.uid;
    const profile = {
      displayName: name || email.split('@')[0].slice(0, 20),
      money: CONFIG.signupBonus,
      apartment: null,
      skills: [],
      createdAt: Date.now(),
      bonusClaimed: true
    };
    await this.db.ref('users/' + uid).set(profile);
    try { await cred.user.updateProfile({ displayName: profile.displayName }); } catch (e) {}
    try { localStorage.setItem('iwo_last_email', email); } catch (e) {}
    return { uid, ...profile };
  },

  async signIn(email, pass) {
    if (!this.ready) throw new Error('Online services not configured — add your Firebase config in game.js');
    email = (email || '').trim().toLowerCase();
    pass = pass || '';
    if (!email || !pass) throw Object.assign(new Error('missing'), { code: 'auth/missing-password' });

    const cred = await this.auth.signInWithEmailAndPassword(email, pass);
    const snap = await this.db.ref('users/' + cred.user.uid).once('value');
    let data = snap.val();
    if (!data) {
      data = {
        displayName: cred.user.displayName || email.split('@')[0].slice(0, 20),
        money: CONFIG.signupBonus,
        apartment: null,
        skills: [],
        createdAt: Date.now(),
        bonusClaimed: true
      };
      await this.db.ref('users/' + cred.user.uid).set(data);
    }
    try { localStorage.setItem('iwo_last_email', email); } catch (e) {}
    return { uid: cred.user.uid, ...data };
  },

  async loadProfile(uid, fallbackName) {
    const snap = await this.db.ref('users/' + uid).once('value');
    let data = snap.val();
    if (!data) {
      data = {
        displayName: fallbackName || 'Player',
        money: CONFIG.signupBonus,
        apartment: null,
        skills: [],
        createdAt: Date.now(),
        bonusClaimed: true
      };
      await this.db.ref('users/' + uid).set(data);
    }
    return { uid, ...data };
  },

  async signOut() {
    this.stopPresence();
    this.closeChat();
    this.endCall();
    if (this.ready && this.auth.currentUser) {
      try { await this.auth.signOut(); } catch (e) { console.warn(e); }
    }
    G.uid = null; G.displayName = null; G.isGuest = true;
    G.apartment = null; G.skills = [];
  },

  applyProfile(p) {
    G.uid = p.uid;
    G.displayName = p.displayName || 'Player';
    G.isGuest = false;
    G.money = typeof p.money === 'number' ? p.money : CONFIG.signupBonus;
    G.apartment = p.apartment || null;
    G.skills = Array.isArray(p.skills) ? p.skills : [];
    UI.set('money', fmtMoney(G.money));
  },

  async syncMoney() {
    if (!this.ready || !G.uid) return;
    try { await this.db.ref('users/' + G.uid + '/money').set(G.money); } catch (e) { console.warn(e); }
  },

  async syncProfile() {
    if (!this.ready || !G.uid) return;
    try {
      await this.db.ref('users/' + G.uid).update({
        money: G.money,
        apartment: G.apartment,
        skills: G.skills,
        displayName: G.displayName
      });
    } catch (e) { console.warn(e); }
  },

  startPresence() {
    if (!this.ready || !G.uid) return;
    const ref = this.db.ref('presence/' + G.uid);
    const data = () => ({
      name: G.displayName,
      online: true,
      t: Date.now(),
      zone: G.zone || ''
    });
    ref.set(data());
    ref.onDisconnect().update({ online: false, t: Date.now() });
    const tick = setInterval(() => { if (G.uid) ref.update({ t: Date.now(), zone: G.zone || '' }); }, 25000);
    this.unsub.push(() => clearInterval(tick));

    const all = this.db.ref('presence');
    const onVal = (snap) => {
      const v = snap.val() || {};
      this.peers = {};
      const now = Date.now();
      for (const uid in v) {
        if (uid === G.uid) continue;
        const p = v[uid];
        if (p && p.online && now - (p.t || 0) < 90000) this.peers[uid] = p;
      }
      Phone.refreshPlayers();
    };
    all.on('value', onVal);
    this.unsub.push(() => all.off('value', onVal));
  },

  stopPresence() {
    this.unsub.forEach((fn) => { try { fn(); } catch (e) {} });
    this.unsub = [];
    if (this.ready && G.uid) {
      try { this.db.ref('presence/' + G.uid).update({ online: false, t: Date.now() }); } catch (e) {}
    }
  },

  chatId(a, b) { return [a, b].sort().join('_'); },

  openChat(uid, name) {
    this.closeChat();
    this.chatPartner = { uid, name };
    $('chatWith').textContent = name;
    $('chatMessages').innerHTML = '';
    Phone.show('chatRoom');
    if (!this.ready || !G.uid) {
      $('chatMessages').innerHTML = '<p class="note pad">Sign in to chat with other players.</p>';
      return;
    }
    const cid = this.chatId(G.uid, uid);
    const ref = this.db.ref('chats/' + cid + '/messages').orderByChild('t').limitToLast(80);
    const onVal = (snap) => {
      const box = $('chatMessages');
      box.innerHTML = '';
      const msgs = [];
      snap.forEach((c) => { msgs.push(c.val()); });
      msgs.sort((a, b) => (a.t || 0) - (b.t || 0));
      msgs.forEach((m) => {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.from === G.uid ? 'me' : 'them');
        const time = m.t ? new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        div.innerHTML = (m.text || '') + '<span class="t">' + time + '</span>';
        box.appendChild(div);
      });
      box.scrollTop = box.scrollHeight;
    };
    ref.on('value', onVal);
    this.chatUnsub = () => ref.off('value', onVal);
  },

  closeChat() {
    if (this.chatUnsub) { this.chatUnsub(); this.chatUnsub = null; }
    this.chatPartner = null;
  },

  async sendChat(text) {
    text = (text || '').trim().slice(0, 500);
    if (!text || !this.chatPartner || !this.ready || !G.uid) return;
    const cid = this.chatId(G.uid, this.chatPartner.uid);
    await this.db.ref('chats/' + cid + '/messages').push({
      from: G.uid, text, t: Date.now()
    });
  },

  async loadUsersForChat() {
    const list = $('chatUsers');
    list.innerHTML = '';
    if (!this.ready) {
      list.innerHTML = '<p class="note pad">Online chat requires Firebase configuration.</p>';
      return;
    }
    // Prefer online peers; also show a few recent users from presence history
    const entries = Object.entries(this.peers);
    if (!entries.length) {
      list.innerHTML = '<p class="note pad">No other players online right now. Invite a friend!</p>';
      return;
    }
    entries.forEach(([uid, p]) => {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="av">' + (p.name || '?')[0].toUpperCase() + '</div><div class="meta"><b>' + (p.name || 'Player') + '</b><small><span class="dot-on"></span>Online' + (p.zone ? ' · ' + p.zone : '') + '</small></div>';
      item.addEventListener('click', () => this.openChat(uid, p.name || 'Player'));
      list.appendChild(item);
    });
  },

  async postService(skill, rate, desc) {
    if (!this.ready || !G.uid) throw new Error('Sign in required');
    const id = this.db.ref('services').push().key;
    const entry = { id, uid: G.uid, name: G.displayName, skill, rate: +rate || 0, desc: (desc || '').slice(0, 200), t: Date.now() };
    await this.db.ref('services/' + id).set(entry);
    G.skills = G.skills.filter((s) => s.skill !== skill);
    G.skills.push({ skill, rate: entry.rate, desc: entry.desc, id });
    await this.syncProfile();
    return entry;
  },

  async loadServices() {
    const box = $('svcBrowse');
    box.innerHTML = '<p class="note pad">Loading...</p>';
    if (!this.ready) { box.innerHTML = '<p class="note pad">Sign in to browse services.</p>'; return; }
    const snap = await this.db.ref('services').orderByChild('t').limitToLast(40).once('value');
    const rows = [];
    snap.forEach((c) => rows.push(c.val()));
    rows.reverse();
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<p class="note pad">No services posted yet. Be the first!</p>'; return; }
    rows.forEach((s) => {
      if (!s || s.uid === G.uid) return;
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="meta"><b>' + (s.skill || 'Service') + '</b><small>' + (s.name || 'Player') + ' · ' + fmtMoney(s.rate || 0) + '</small><small style="display:block;margin-top:2px">' + (s.desc || '') + '</small></div><button class="btn" style="width:auto;margin:0;padding:.5em .8em;font-size:11px">CHAT</button>';
      item.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); this.openChat(s.uid, s.name || 'Player'); });
      box.appendChild(item);
    });
  },

  renderMySkills() {
    const box = $('svcMine');
    box.innerHTML = '';
    if (!G.skills.length) { box.innerHTML = '<p class="note pad">You have not posted any skills yet.</p>'; return; }
    G.skills.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="meta"><b>' + s.skill + '</b><small>' + fmtMoney(s.rate) + '</small></div>';
      box.appendChild(item);
    });
  },

  async submitReport(targetUid, reason, note) {
    if (!this.ready || !G.uid) throw new Error('Sign in required');
    if (!targetUid) throw new Error('Select a player');
    await this.db.ref('reports').push({
      from: G.uid, fromName: G.displayName,
      target: targetUid, reason, note: (note || '').slice(0, 300), t: Date.now()
    });
  },

  // ----- WebRTC voice call (simple 1:1 via Firebase signaling) -----
  async startCall() {
    if (!this.chatPartner || !this.ready || !G.uid) return;
    Phone.show('call');
    $('callName').textContent = this.chatPartner.name;
    $('callStatus').textContent = 'Calling...';
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      $('callStatus').textContent = 'Microphone access denied';
      return;
    }
    const room = this.chatId(G.uid, this.chatPartner.uid);
    const sig = this.db.ref('signaling/' + room);
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.localStream.getTracks().forEach((t) => this.pc.addTrack(t, this.localStream));
    this.pc.ontrack = (ev) => { const a = $('remoteAudio'); a.srcObject = ev.streams[0]; };
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) sig.child('candidates').push({ from: G.uid, c: ev.candidate.toJSON() });
    };
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await sig.child('offer').set({ from: G.uid, sdp: offer });
    $('callStatus').textContent = 'Ringing...';

    sig.child('answer').on('value', async (snap) => {
      const v = snap.val();
      if (!v || v.from === G.uid || !this.pc || this.pc.currentRemoteDescription) return;
      await this.pc.setRemoteDescription(new RTCSessionDescription(v.sdp));
      $('callStatus').textContent = 'Connected';
    });
    sig.child('candidates').on('child_added', async (snap) => {
      const v = snap.val();
      if (!v || v.from === G.uid || !this.pc) return;
      try { await this.pc.addIceCandidate(new RTCIceCandidate(v.c)); } catch (e) {}
    });
    this._sigCleanup = () => { sig.off(); sig.remove(); };
  },

  async answerCall(room, offerFrom) {
    // simplified: caller-driven; full bidirectional answer can be extended
  },

  endCall() {
    if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
    if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
    if (this._sigCleanup) { try { this._sigCleanup(); } catch (e) {} this._sigCleanup = null; }
    const a = $('remoteAudio'); if (a) a.srcObject = null;
    if (Phone.current === 'call') Phone.show('chatRoom');
  }
};

/* -------------------- World development (player-built structures) -------- */
const BUILD_MATS = {
  wall: new THREE.MeshLambertMaterial({ color: 0xe9dcc0 }),
  roof: new THREE.MeshLambertMaterial({ color: 0x9c4a32 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x2b2b2b }),
  awn: new THREE.MeshLambertMaterial({ color: 0xe63946 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x8a6a45 }),
  green: new THREE.MeshLambertMaterial({ color: 0x3e7a35 }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x5c4033 }),
  ghostOk: new THREE.MeshBasicMaterial({ color: 0x22d37a, transparent: true, opacity: 0.45, depthWrite: false }),
  ghostBad: new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.45, depthWrite: false })
};
const WorldDev = {
  items: {},          // id -> { data, group }
  ghost: null,
  _loaded: false,

  // Build a simple procedural mesh for a structure type
  makeMesh(type, paint) {
    const def = CONFIG.buildTypes[type];
    if (!def) return null;
    const g = new THREE.Group();
    const wallCol = paint ? parseInt(paint, 16) || parseInt(String(paint).replace('0x', ''), 16) : null;
    const wallMat = wallCol ? new THREE.MeshLambertMaterial({ color: wallCol }) : BUILD_MATS.wall;
    const w = def.w, d = def.d, h = def.h;

    if (type === 'tree') {
      const trunk = new THREE.Mesh(GEO.cyl, BUILD_MATS.trunk);
      trunk.scale.set(0.18, 1.6, 0.18); trunk.position.y = 0.8; g.add(trunk);
      const canopy = new THREE.Mesh(GEO.ico, BUILD_MATS.green);
      canopy.scale.set(1.1, 1.0, 1.1); canopy.position.y = 2.4; g.add(canopy);
      return g;
    }
    if (type === 'kiosk' || type === 'stall') {
      const body = new THREE.Mesh(GEO.box, wallMat);
      body.scale.set(w, h * 0.7, d); body.position.y = h * 0.35; g.add(body);
      const roof = new THREE.Mesh(GEO.box, BUILD_MATS.dark);
      roof.scale.set(w + 0.4, 0.12, d + 0.3); roof.position.y = h * 0.75; g.add(roof);
      if (type === 'stall') {
        const poleL = new THREE.Mesh(GEO.cyl, BUILD_MATS.wood);
        poleL.scale.set(0.06, h * 0.9, 0.06); poleL.position.set(-w / 2 + 0.15, h * 0.45, d / 2); g.add(poleL);
        const poleR = poleL.clone(); poleR.position.x = w / 2 - 0.15; g.add(poleR);
      }
      return g;
    }
    // shop / house / workshop
    const storeys = type === 'house' ? 1.35 : 1;
    const bodyH = h * 0.72 * storeys;
    const body = new THREE.Mesh(GEO.box, wallMat);
    body.scale.set(w, bodyH, d); body.position.y = bodyH / 2; g.add(body);
    const roof = new THREE.Mesh(type === 'house' ? GEO.pyr : GEO.box, BUILD_MATS.roof);
    if (type === 'house') {
      roof.scale.set(w * 0.72, h * 0.28, d * 0.72); roof.position.y = bodyH + h * 0.14;
    } else {
      roof.scale.set(w + 0.3, 0.18, d + 0.3); roof.position.y = bodyH + 0.1;
    }
    g.add(roof);
    if (type === 'shop' || type === 'workshop') {
      const awn = new THREE.Mesh(GEO.box, BUILD_MATS.awn);
      awn.scale.set(w * 0.9, 0.08, 0.7); awn.position.set(0, bodyH * 0.55, d / 2 + 0.35); g.add(awn);
    }
    // door suggestion
    const door = new THREE.Mesh(GEO.box, BUILD_MATS.dark);
    door.scale.set(1.1, 1.9, 0.08); door.position.set(0, 0.95, d / 2 + 0.05); g.add(door);
    return g;
  },

  canPlace(x, z, type) {
    const def = CONFIG.buildTypes[type];
    if (!def) return false;
    const r = Math.max(def.w, def.d) * 0.55 + 0.4;
    if (Math.abs(x) > CONFIG.bounds - r || Math.abs(z) > CONFIG.bounds - r) return false;
    // keep off main road strip (z≈0, width 14) and cross roads roughly
    if (Math.abs(z) < 8 + r * 0.3 && Math.abs(x) < 200) return false;
    if (Math.abs(x) < 6 && Math.abs(z) < 200) return false;
    if (Col.test(x, z, r)) return false;
    // not overlapping another player build
    for (const id in this.items) {
      const b = this.items[id].data;
      const bd = CONFIG.buildTypes[b.type];
      if (!bd) continue;
      const br = Math.max(bd.w, bd.d) * 0.55;
      if (Math.hypot(x - b.x, z - b.z) < r + br + 0.5) return false;
    }
    return true;
  },

  spawn(data, announce) {
    if (!data || !data.id || this.items[data.id]) return;
    const def = CONFIG.buildTypes[data.type];
    if (!def) return;
    const group = this.makeMesh(data.type, data.paint);
    if (!group) return;
    const gy = typeof groundY === 'function' ? groundY(data.x, data.z) : 0;
    group.position.set(data.x, gy, data.z);
    group.rotation.y = data.rot || 0;
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(group);
    solid(data.x, data.z, def.w * 0.92, def.d * 0.92);

    // Interactable
    if (data.type === 'shop' || data.type === 'kiosk' || data.type === 'stall') {
      const shopName = data.name || ((data.ownerName || 'Player') + "'s " + def.label);
      addInteract({
        id: 'pbuild_' + data.id, x: data.x, z: data.z, r: Math.max(def.w, def.d) * 0.6 + 1.5,
        label: 'ENTER ' + (data.type === 'shop' ? 'SHOP' : def.label.toUpperCase()),
        actions: [
          { label: 'ENTER', fn: () => Panels.shop(shopName, 'buy') },
          { label: 'BUY', fn: () => Panels.shop(shopName, 'buy') },
          { label: 'SELL', fn: () => Panels.shop(shopName, 'sell') }
        ]
      });
      POIS.push({ x: data.x, z: data.z, t: 'shop' });
    } else if (data.type === 'house' || data.type === 'workshop') {
      addInteract({
        id: 'pbuild_' + data.id, x: data.x, z: data.z, r: Math.max(def.w, def.d) * 0.55 + 1.2,
        label: data.type === 'house' ? 'VIEW HOUSE' : 'VIEW WORKSHOP',
        actions: [{ label: 'LOOK', fn: () => UI.toast((data.ownerName || 'Someone') + ' built this ' + def.label.toLowerCase() + (data.name ? ': ' + data.name : '') + '.') }]
      });
      POIS.push({ x: data.x, z: data.z, t: data.type === 'house' ? 'home' : 'land' });
    }

    this.items[data.id] = { data, group };
    if (announce) UI.toast((data.ownerName || 'A player') + ' built a ' + def.label.toLowerCase() + '!');
  },

  startPlace(type, name) {
    if (!CONFIG.buildTypes[type]) return;
    this.cancelPlace();
    G.buildMode = { type, name: (name || '').slice(0, 32) };
    const ghost = this.makeMesh(type);
    if (!ghost) return;
    ghost.traverse((o) => {
      if (o.isMesh) { o.material = BUILD_MATS.ghostOk; o.castShadow = false; o.receiveShadow = false; }
    });
    scene.add(ghost);
    this.ghost = ghost;
    Phone.close();
    UI.toast('Walk to a clear spot · Press E to place · ESC to cancel');
    UI.setPrompt({ id: 'buildplace', label: 'PLACE ' + CONFIG.buildTypes[type].label.toUpperCase(), key: 'E', actions: [{ label: 'PLACE', fn: () => this.confirmPlace() }] });
  },

  cancelPlace() {
    G.buildMode = null;
    if (this.ghost) { scene.remove(this.ghost); this.ghost = null; }
    UI.setPrompt(null);
  },

  updateGhost() {
    if (!this.ghost || !G.buildMode) return;
    const face = G.inCar ? Vehicle.h : Player.face;
    const dist = Math.max(CONFIG.buildTypes[G.buildMode.type].d, 4) * 0.7 + 2.5;
    const px = G.inCar ? Vehicle.x : Player.pos.x;
    const pz = G.inCar ? Vehicle.z : Player.pos.z;
    const x = px + Math.sin(face) * dist;
    const z = pz + Math.cos(face) * dist;
    const gy = typeof groundY === 'function' ? groundY(x, z) : 0;
    this.ghost.position.set(x, gy, z);
    this.ghost.rotation.y = face;
    const ok = this.canPlace(x, z, G.buildMode.type);
    this.ghost.traverse((o) => {
      if (o.isMesh) o.material = ok ? BUILD_MATS.ghostOk : BUILD_MATS.ghostBad;
    });
    this._ghostPos = { x, z, rot: face, ok };
  },

  async confirmPlace() {
    if (!G.buildMode || !this._ghostPos || !this._ghostPos.ok) {
      UI.toast('Cannot build here — find a clear open area off the road');
      return;
    }
    const type = G.buildMode.type;
    const def = CONFIG.buildTypes[type];
    if (G.money < def.price) { UI.toast('Not enough money (' + fmtMoney(def.price) + ')'); return; }
    const { x, z, rot } = this._ghostPos;
    const id = (G.uid || 'guest') + '_' + Date.now().toString(36);
    const data = {
      id, type, x, z, rot,
      name: G.buildMode.name || '',
      paint: pick(WALLS).toString(16),
      uid: G.uid || 'guest',
      ownerName: G.displayName || 'Guest',
      t: Date.now()
    };
    if (!Economy.spend(def.price)) return;
    this.cancelPlace();
    this.spawn(data, false);
    UI.big('BUILT!', def.label + ' · −' + fmtMoney(def.price));
    // Persist
    try {
      if (Net.ready && G.uid) {
        await Net.db.ref('builds/' + id).set(data);
      } else {
        const list = JSON.parse(localStorage.getItem(CONFIG.buildsKey) || '[]');
        list.push(data);
        localStorage.setItem(CONFIG.buildsKey, JSON.stringify(list.slice(-80)));
      }
    } catch (e) { console.warn('[WorldDev] save failed', e); }
    Phone.refreshBuildCatalog && Phone.refreshBuildCatalog();
  },

  async loadAll() {
    if (this._loaded) return;
    this._loaded = true;
    // Local guest builds
    try {
      const local = JSON.parse(localStorage.getItem(CONFIG.buildsKey) || '[]');
      local.forEach((d) => this.spawn(d, false));
    } catch (e) {}
    // Shared world from Firebase
    if (!Net.ready || !Net.db) return;
    try {
      const snap = await Net.db.ref('builds').once('value');
      const val = snap.val() || {};
      Object.keys(val).forEach((id) => {
        const d = val[id];
        if (d) { d.id = d.id || id; this.spawn(d, false); }
      });
      // Live updates — new builds by other players
      Net.db.ref('builds').on('child_added', (s) => {
        const d = s.val();
        if (!d) return;
        d.id = d.id || s.key;
        if (!this.items[d.id]) this.spawn(d, d.uid !== G.uid);
      });
    } catch (e) { console.warn('[WorldDev] load failed', e); }
  },

  myBuilds() {
    return Object.values(this.items).filter((it) => it.data.uid === (G.uid || 'guest')).map((it) => it.data);
  }
};

/* ------------------------------ Phone UI -------------------------------- */
const Phone = {
  current: 'home',
  open() {
    if (G.mode !== 'playing') return;
    G.phoneOpen = true;
    $('phone').hidden = false;
    this.show('home');
    this.refreshHome();
    Input.joy.x = Input.joy.y = 0;
  },
  close() {
    G.phoneOpen = false;
    $('phone').hidden = true;
    Net.closeChat();
    Net.endCall();
  },
  toggle() { G.phoneOpen ? this.close() : this.open(); },
  show(screen) {
    this.current = screen;
    ['phoneHome', 'phoneChatList', 'phoneChatRoom', 'phoneWalletApp', 'phoneServices', 'phoneApartment', 'phonePolice', 'phonePlayers', 'phoneCall']
      .forEach((id) => { const el = $(id); if (el) el.hidden = true; });
    const map = {
      home: 'phoneHome', chatList: 'phoneChatList', chatRoom: 'phoneChatRoom',
      wallet: 'phoneWalletApp', services: 'phoneServices', apartment: 'phoneApartment',
      police: 'phonePolice', players: 'phonePlayers', call: 'phoneCall'
    };
    const el = $(map[screen]);
    if (el) el.hidden = false;
    if (screen === 'chatList') Net.loadUsersForChat();
    if (screen === 'services') { Net.loadServices(); Net.renderMySkills(); this.svcTab('browse'); }
    if (screen === 'apartment') this.refreshApt();
    if (screen === 'police') this.refreshReportUsers();
    if (screen === 'players') this.refreshPlayers();
    if (screen === 'wallet') this.refreshHome();
  },
  refreshHome() {
    $('phoneName').textContent = G.displayName || (G.isGuest ? 'Guest' : 'Player');
    $('phoneWallet').textContent = fmtMoney(G.money);
    $('walletBal').textContent = fmtMoney(G.money);
    $('walletUid').textContent = G.uid ? 'ID: ' + G.uid.slice(0, 8) + '…' : 'Guest (offline)';
    $('phoneAvatar').textContent = (G.displayName || 'G')[0].toUpperCase();
    const mm = Math.floor(G.minutes % 1440);
    let h = Math.floor(mm / 60); const mi = mm % 60;
    h = h % 12 || 12;
    $('phoneTime').textContent = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  },
  refreshApt() {
    const owned = !!G.apartment;
    $('aptOwned').hidden = !owned;
    $('aptBuy').hidden = owned;
    if (owned) {
      if (G.apartment.paint) $('aptPaint').value = G.apartment.paint;
      if (G.apartment.furn) $('aptFurn').value = G.apartment.furn;
    }
  },
  refreshPlayers() {
    const box = $('playersList');
    box.innerHTML = '';
    const entries = Object.entries(Net.peers);
    if (!entries.length) {
      box.innerHTML = '<p class="note pad">No other players online.</p>';
      return;
    }
    entries.forEach(([uid, p]) => {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="av">' + (p.name || '?')[0].toUpperCase() + '</div><div class="meta"><b>' + (p.name || 'Player') + '</b><small><span class="dot-on"></span>' + (p.zone || 'Iwo') + '</small></div>';
      item.addEventListener('click', () => Net.openChat(uid, p.name || 'Player'));
      box.appendChild(item);
    });
  },
  refreshReportUsers() {
    const sel = $('reportUser');
    sel.innerHTML = '<option value="">Select player...</option>';
    Object.entries(Net.peers).forEach(([uid, p]) => {
      const o = document.createElement('option');
      o.value = uid; o.textContent = p.name || uid.slice(0, 8);
      sel.appendChild(o);
    });
  },
  svcTab(t) {
    document.querySelectorAll('.phone-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.stab === t));
    $('svcBrowse').hidden = t !== 'browse';
    $('svcMine').hidden = t !== 'mine';
    $('svcPost').hidden = t !== 'post';
    if (t === 'browse') Net.loadServices();
    if (t === 'mine') Net.renderMySkills();
  },
  bind() {
    $('phoneClose').addEventListener('click', () => this.close());
    $('btnPhone').addEventListener('click', () => this.toggle());
    if ($('tPhone')) $('tPhone').addEventListener('click', () => this.toggle());

    document.querySelectorAll('#phone .app').forEach((b) => {
      b.addEventListener('click', () => this.show(b.dataset.app));
    });
    document.querySelectorAll('#phone .back').forEach((b) => {
      b.addEventListener('click', () => this.show(b.dataset.back));
    });

    $('chatSend').addEventListener('click', async () => {
      const t = $('chatText').value;
      $('chatText').value = '';
      try { await Net.sendChat(t); } catch (e) { UI.toast('Send failed'); }
    });
    $('chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('chatSend').click(); }
    });
    $('chatRefresh').addEventListener('click', () => Net.loadUsersForChat());
    $('chatCall').addEventListener('click', () => Net.startCall());
    $('callHang').addEventListener('click', () => Net.endCall());

    document.querySelectorAll('.phone-tabs button').forEach((b) => {
      b.addEventListener('click', () => this.svcTab(b.dataset.stab));
    });
    $('svcSubmit').addEventListener('click', async () => {
      const skill = $('svcSkill').value.trim();
      const rate = $('svcRate').value;
      const desc = $('svcDesc').value.trim();
      if (!skill) { UI.toast('Enter a skill name'); return; }
      try {
        await Net.postService(skill, rate, desc);
        UI.toast('Skill posted');
        $('svcSkill').value = ''; $('svcRate').value = ''; $('svcDesc').value = '';
        this.svcTab('mine');
      } catch (e) { UI.toast(e.message || 'Failed'); }
    });

    $('aptPurchase').addEventListener('click', async () => {
      if (G.apartment) return;
      if (G.money < CONFIG.apartmentPrice) { UI.toast('Not enough money'); return; }
      G.money -= CONFIG.apartmentPrice;
      G.apartment = { paint: '0xe9dcc0', furn: 'basic' };
      UI.set('money', fmtMoney(G.money));
      UI.flashMoney(false);
      await Net.syncProfile();
      UI.toast('Apartment purchased!');
      this.refreshApt();
      this.refreshHome();
    });
    $('aptSave').addEventListener('click', async () => {
      if (!G.apartment) return;
      const paint = $('aptPaint').value;
      let furn = $('aptFurn').value;
      let extra = 0;
      if (furn === 'modern' && G.apartment.furn !== 'modern' && G.apartment.furn !== 'luxury') extra = 50000;
      if (furn === 'luxury' && G.apartment.furn !== 'luxury') extra = 200000;
      if (extra && G.money < extra) { UI.toast('Not enough for upgrade'); return; }
      if (extra) { G.money -= extra; UI.set('money', fmtMoney(G.money)); UI.flashMoney(false); }
      G.apartment = { paint, furn };
      await Net.syncProfile();
      UI.toast('Apartment design saved');
      this.refreshHome();
    });

    $('reportSubmit').addEventListener('click', async () => {
      try {
        await Net.submitReport($('reportUser').value, $('reportReason').value, $('reportNote').value);
        UI.toast('Report submitted');
        $('reportNote').value = '';
      } catch (e) { UI.toast(e.message || 'Failed'); }
    });
  }
};

/* Auth UI helpers */
const AuthUI = {
  busy: false,
  signupMode: false,

  showError(msg) {
    const e = $('authError');
    e.textContent = msg || '';
    e.hidden = !msg;
  },

  setBusy(on) {
    this.busy = !!on;
    const ids = ['btnLogin', 'btnSignup', 'btnGuest', 'btnLogout', 'btnPlay', 'btnContinue'];
    ids.forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !!on;
    });
    if (on) {
      if ($('btnLogin') && !this.signupMode) $('btnLogin').textContent = 'SIGNING IN…';
      if ($('btnSignup') && this.signupMode) $('btnSignup').textContent = 'CREATING…';
    } else {
      this.refreshLabels();
    }
  },

  refreshLabels() {
    if (this.signupMode) {
      $('btnSignup').textContent = 'CONFIRM CREATE ACCOUNT';
      $('btnLogin').textContent = 'BACK TO SIGN IN';
    } else {
      $('btnSignup').textContent = 'CREATE ACCOUNT';
      $('btnLogin').textContent = 'SIGN IN';
    }
  },

  enterSignupMode() {
    this.signupMode = true;
    $('authName').classList.add('show');
    $('authName').hidden = false;
    this.refreshLabels();
    this.showError('');
  },

  enterLoginMode() {
    this.signupMode = false;
    $('authName').classList.remove('show');
    $('authName').hidden = true;
    this.refreshLabels();
    this.showError('');
  },

  showReady(profile) {
    $('authPanel').hidden = true;
    $('authReady').hidden = false;
    const name = (profile && (profile.displayName || profile.uid)) || G.displayName || 'Player';
    $('authUserLabel').textContent = 'Signed in as ' + name;
    $('btnContinue').hidden = !Save.has();
    this.setBusy(false);
  },

  showForm() {
    $('authPanel').hidden = false;
    $('authReady').hidden = true;
    this.enterLoginMode();
    this.setBusy(false);
    // Prefill last used email
    try {
      const last = localStorage.getItem('iwo_last_email');
      if (last && $('authEmail') && !$('authEmail').value) $('authEmail').value = last;
    } catch (e) {}
    const offline = $('authOfflineHint');
    if (offline) offline.hidden = !!Net.ready;
  },

  bind() {
    // Enter key submits the visible primary action
    const trySubmit = (e) => {
      if (e.key !== 'Enter' || this.busy) return;
      e.preventDefault();
      if (this.signupMode) $('btnSignup').click();
      else $('btnLogin').click();
    };
    $('authEmail').addEventListener('keydown', trySubmit);
    $('authPass').addEventListener('keydown', trySubmit);
    $('authName').addEventListener('keydown', trySubmit);

    $('btnSignup').addEventListener('click', async () => {
      if (this.busy) return;
      if (!this.signupMode) {
        this.enterSignupMode();
        return;
      }
      const email = $('authEmail').value.trim();
      const pass = $('authPass').value;
      const name = $('authName').value.trim();
      if (!email || pass.length < 6) {
        this.showError('Valid email + password (6+ characters) required');
        return;
      }
      this.setBusy(true);
      this.showError('');
      try {
        const p = await Net.signUp(email, pass, name);
        Net.applyProfile(p);
        this.showReady(p);
        UI.toast('Welcome! ₦1,000,000 credited to your wallet');
      } catch (e) {
        this.setBusy(false);
        this.showError(Net.authError(e));
      }
    });

    $('btnLogin').addEventListener('click', async () => {
      if (this.busy) return;
      if (this.signupMode) {
        this.enterLoginMode();
        return;
      }
      const email = $('authEmail').value.trim();
      const pass = $('authPass').value;
      if (!email || !pass) {
        this.showError('Enter email and password');
        return;
      }
      this.setBusy(true);
      this.showError('');
      try {
        const p = await Net.signIn(email, pass);
        Net.applyProfile(p);
        this.showReady(p);
        UI.toast('Welcome back, ' + (p.displayName || 'Player'));
      } catch (e) {
        this.setBusy(false);
        this.showError(Net.authError(e));
      }
    });

    $('btnGuest').addEventListener('click', () => {
      if (this.busy) return;
      G.isGuest = true;
      G.uid = null;
      G.displayName = 'Guest';
      G.money = CONFIG.startMoney;
      G.apartment = null;
      G.skills = [];
      $('authPanel').hidden = true;
      $('authReady').hidden = false;
      $('authUserLabel').textContent = 'Playing as Guest (offline — chat & wallet cloud sync disabled)';
      $('btnContinue').hidden = !Save.has();
    });

    $('btnLogout').addEventListener('click', async () => {
      if (this.busy) return;
      this.setBusy(true);
      try {
        await Net.signOut();
      } catch (e) {}
      G.money = CONFIG.startMoney;
      this.showForm();
    });
  }
};

/* ======================== 11. UI + INPUT + MAIN LOOP ===================== */
const clockStr = (m) => { const mm = Math.floor(m % 1440); let h = Math.floor(mm / 60); const mi = mm % 60, ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ' ' + ap; };
const UI = {
  cache: {}, timers: {}, _pid: null, miniBase: null, miniT: 0,
  set(id, v) { if (this.cache[id] !== v) { this.cache[id] = v; $(id).textContent = v; } },
  progress(p) { const pc = Math.round(clamp(p, 0, 1) * 100); $('loadBar').style.width = pc + '%'; $('loadPct').textContent = pc + '%'; },
  flash(el, ms, cls) { el.classList.add(cls || 'show'); clearTimeout(this.timers[el.id]); this.timers[el.id] = setTimeout(() => el.classList.remove(cls || 'show'), ms); },
  toast(t, ms = 2200) { const e = $('toast'); e.textContent = t; this.flash(e, ms); },
  big(title, sub, ms = 3200) { const e = $('bigToast'); e.querySelector('h1').textContent = title; e.querySelector('p').textContent = sub || ''; this.flash(e, ms); },
  zone(name) { const e = $('zoneBanner'); e.textContent = name.toUpperCase(); this.flash(e, 2600); },
  say(who, text, ms = 4200) { const e = $('dialogue'); e.querySelector('b').textContent = who.toUpperCase(); e.querySelector('p').textContent = text; e.hidden = false; clearTimeout(this.timers.dlg); this.timers.dlg = setTimeout(() => { e.hidden = true; }, ms); },
  flashMoney(up) { const e = $('money'); e.classList.remove('up', 'down'); e.classList.add(up ? 'up' : 'down'); clearTimeout(this.timers.mny); this.timers.mny = setTimeout(() => e.classList.remove('up', 'down'), 700); },
  setPrompt(o) {
    const id = o ? o.id : null; if (id === this._pid) return; this._pid = id;
    const p = $('prompt'), chips = $('chips'); chips.innerHTML = '';
    if (!o) { p.hidden = true; return; }
    const touch = document.body.classList.contains('touch');
    p.textContent = (touch ? 'TAP TO ' : 'PRESS ' + (o.key || 'E') + ' TO ') + o.label; p.hidden = false;
    o.actions.slice(1).forEach((a, i) => { const b = document.createElement('button'); b.textContent = a.label; b.dataset.i = i + 1; chips.appendChild(b); });
  },
  modal(html) { G.modal = true; $('modalBody').innerHTML = html; $('modal').hidden = false; Input.joy.x = Input.joy.y = 0; },
  closeModal() { G.modal = false; $('modal').hidden = true; },
  openMenu() { G.menuOpen = true; $('menu').hidden = false; this.menuPanel('Main'); },
  closeMenu() { G.menuOpen = false; $('menu').hidden = true; },
  menuPanel(n) { ['Main', 'Settings', 'About'].forEach((k) => { $('menu' + k).hidden = k !== n; }); },
  update(dt) {
    this.set('money', fmtMoney(G.money)); this.set('day', 'DAY ' + (Math.floor(G.minutes / 1440) + 1)); this.set('clock', clockStr(G.minutes));
    if (G.inCar) this.set('speedo', Math.round(Math.abs(Vehicle.speed) * 3.6) + ' km/h');
    this.miniT -= dt; if (this.miniT <= 0) { this.miniT = 0.1; this.drawMini(); }
    const z = zoneAt(G.inCar ? Vehicle.x : Player.pos.x, G.inCar ? Vehicle.z : Player.pos.z);
    if (z !== G.zone) { G.zone = z; this.zone(z); }
  },
  buildMiniBase() {
    const S = 2, W = 460 * S, c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d'), P = (v) => (v + 230) * S;
    g.fillStyle = '#16241c'; g.fillRect(0, 0, W, W);
    g.fillStyle = '#235f70'; g.fillRect(0, P(111), W, 38 * S);
    g.fillStyle = '#1d3a22'; g.fillRect(P(-70), P(153), 140 * S, 60 * S);
    g.fillStyle = '#3a3226'; g.fillRect(P(23), P(-44), 74 * S, 32 * S); g.fillRect(P(-109), P(13), 98 * S, 38 * S);
    g.fillStyle = '#244a2a'; g.fillRect(P(10), P(12), 100 * S, 40 * S);
    g.strokeStyle = '#8a8d90'; g.lineWidth = 2 * S; g.setLineDash([6 * S, 4 * S]); g.beginPath(); g.moveTo(P(-212), P(-110)); g.lineTo(P(212), P(-110)); g.stroke(); g.setLineDash([]);
    for (const r of ROADS) {
      g.strokeStyle = r.k === 'main' ? '#d7dbd9' : '#aeb4b1'; g.lineWidth = r.w * S; g.beginPath();
      if (r.ax === 'x') { g.moveTo(P(r.a), P(r.c)); g.lineTo(P(r.b), P(r.c)); } else { g.moveTo(P(r.c), P(r.a)); g.lineTo(P(r.c), P(r.b)); }
      g.stroke();
    }
    this.miniBase = c;
  },
  drawMini() {
    const cv = $('minimap'), g = cv.getContext('2d'), W = cv.width, cx = W / 2, k = W / 130, phi = Cam.yaw;
    const px = G.inCar ? Vehicle.x : Player.pos.x, pz = G.inCar ? Vehicle.z : Player.pos.z;
    if (!this.miniBase) this.buildMiniBase();
    g.clearRect(0, 0, W, W); g.save(); g.translate(cx, cx); g.rotate(phi); g.scale(k, k); g.translate(-px, -pz); g.drawImage(this.miniBase, -230, -230, 460, 460); g.restore();
    const cs = Math.cos(phi), sn = Math.sin(phi);
    const sc = (x, z) => { const dx = x - px, dz = z - pz; return [cx + (dx * cs - dz * sn) * k, cx + (dx * sn + dz * cs) * k]; };
    const dot = (x, z, col, r) => { const [sx, sy] = sc(x, z); if (Math.hypot(sx - cx, sy - cx) > cx - 4) return; g.fillStyle = col; g.beginPath(); g.arc(sx, sy, r, 0, 6.283); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); };
    const col = { shop: '#19c37d', home: '#4aa3ff', job: '#ffc83d', land: '#c77dff' };
    for (const p of POIS) dot(p.x, p.z, col[p.t], 4);
    if (!G.inCar) dot(Vehicle.x, Vehicle.z, '#ffffff', 3.5);
    const d = Missions.drop();
    if (d) { let [sx, sy] = sc(d.x, d.z); const dx = sx - cx, dy = sy - cx, m = Math.hypot(dx, dy), lim = cx - 8; if (m > lim) { sx = cx + dx / m * lim; sy = cx + dy / m * lim; } g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(sx, sy, 5.5, 0, 6.283); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
    const f = G.inCar ? Vehicle.h : Player.face, vx = Math.sin(f), vz = Math.cos(f), rx = vx * cs - vz * sn, rz = vx * sn + vz * cs, a = Math.atan2(rx, -rz);
    g.save(); g.translate(cx, cx); g.rotate(a); g.fillStyle = '#fff'; g.strokeStyle = '#0f9d58'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath(); g.fill(); g.stroke(); g.restore();
  }
};

/* -------------------------------- Input -------------------------------- */
const Input = {
  keys: new Set(), joy: { x: 0, y: 0 }, jumpQ: false, sprintT: false, brakeT: false, _mv: { x: 0, y: 0 },
  on() { return G.mode === 'playing' && !G.menuOpen && !G.modal && !G.phoneOpen; },
  k(...c) { return c.some((x) => this.keys.has(x)); },
  move() {
    const o = this._mv; o.x = o.y = 0; if (!this.on()) return o;
    let x = (this.k('KeyD', 'ArrowRight') ? 1 : 0) - (this.k('KeyA', 'ArrowLeft') ? 1 : 0), y = (this.k('KeyW', 'ArrowUp') ? 1 : 0) - (this.k('KeyS', 'ArrowDown') ? 1 : 0);
    x += this.joy.x; y += this.joy.y; const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    o.x = x; o.y = y; return o;
  },
  sprint() { return this.on() && (this.k('ShiftLeft', 'ShiftRight') || this.sprintT); },
  consumeJump() { const j = this.jumpQ || (this.on() && this.k('Space')); this.jumpQ = false; if (this.k('Space')) this.keys.delete('Space'); return j && this.on(); },
  throttle() { return this.on() ? clamp((this.k('KeyW', 'ArrowUp') ? 1 : 0) - (this.k('KeyS', 'ArrowDown') ? 1 : 0) + this.joy.y, -1, 1) : 0; },
  steerAxis() { return this.on() ? clamp((this.k('KeyD', 'ArrowRight') ? 1 : 0) - (this.k('KeyA', 'ArrowLeft') ? 1 : 0) + this.joy.x, -1, 1) : 0; },
  brake() { return this.on() && (this.k('Space') || this.brakeT); }
};
function setMode(m) { document.body.classList.toggle('touch', m === 'touch'); document.body.classList.toggle('desktop', m !== 'touch'); UI._pid = '__refresh'; }

function bindInput() {
  setMode(IS_TOUCH ? 'touch' : 'desktop');
  addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.code === 'Escape') {
      if (G.phoneOpen) { Phone.close(); return; }
      if (G.modal) { UI.closeModal(); return; }
      if (G.mode === 'playing') { G.menuOpen ? UI.closeMenu() : UI.openMenu(); }
      return;
    }
    if (e.repeat) return;
    if (G.mode === 'playing' && !G.menuOpen && !G.phoneOpen) {
      if (e.code === 'KeyE') Interact.use(0);
      else if (e.code === 'KeyF' && !G.modal) toggleCar();
      else if (e.code === 'KeyR') Cam.reset();
      else if (e.code === 'KeyP') Phone.toggle();
    }
    if (e.code === 'Space' && !G.inCar && !Input.jumpQ && Input.on()) Input.jumpQ = true;
    Input.keys.add(e.code);
  });
  addEventListener('keyup', (e) => Input.keys.delete(e.code));
  addEventListener('blur', () => Input.keys.clear());
  // camera drag (mouse or touch) on the canvas; UI elements sit above it
  const drag = new Map();
  canvas.addEventListener('pointerdown', (e) => { if (G.mode !== 'playing' || G.menuOpen) return; if (e.pointerType === 'touch') setMode('touch'); else if (!IS_TOUCH) setMode('desktop'); drag.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { canvas.setPointerCapture(e.pointerId); } catch (er) {} });
  canvas.addEventListener('pointermove', (e) => { const d = drag.get(e.pointerId); if (!d || !Input.on()) return; Cam.rotate(e.clientX - d.x, e.clientY - d.y, e.pointerType === 'touch' ? 0.0065 : 0.005); d.x = e.clientX; d.y = e.clientY; });
  const end = (e) => drag.delete(e.pointerId);
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { if (Input.on()) Cam.zoom = clamp(Cam.zoom + e.deltaY * 0.001, 0.6, 1.7); }, { passive: true });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // virtual joystick
  const zone = $('joyZone'), base = $('joyBase'), knob = $('joyKnob'); let jid = null;
  const jmove = (e) => {
    const r = base.getBoundingClientRect(), R = r.width / 2; let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R); const m = Math.hypot(dx, dy);
    if (m > R) { dx = dx / m * R; dy = dy / m * R; }
    Input.joy.x = dx / R; Input.joy.y = -dy / R; knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  };
  const jend = (e) => { if (e.pointerId !== jid) return; jid = null; Input.joy.x = Input.joy.y = 0; knob.style.transform = ''; };
  zone.addEventListener('pointerdown', (e) => { e.preventDefault(); jid = e.pointerId; zone.setPointerCapture(e.pointerId); jmove(e); });
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === jid) jmove(e); });
  zone.addEventListener('pointerup', jend); zone.addEventListener('pointercancel', jend);
  // touch buttons
  const press = (id, down, up) => { const b = $(id); b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); down(b); }); const u = () => up && up(b); b.addEventListener('pointerup', u); b.addEventListener('pointercancel', u); };
  press('tAction', () => { if (Input.on()) Interact.use(0); });
  press('tJump', (b) => { if (!Input.on()) return; if (G.inCar) { Input.brakeT = true; b.classList.add('on'); } else Input.jumpQ = true; }, (b) => { Input.brakeT = false; b.classList.remove('on'); });
  press('tSprint', (b) => { Input.sprintT = !Input.sprintT; b.classList.toggle('on', Input.sprintT); });
  press('tCar', () => { if (Input.on()) toggleCar(); });
  $('prompt').addEventListener('click', () => { if (G.inCar) exitCar(); else Interact.use(0); });
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) Interact.use(+b.dataset.i); });
  $('btnCam').addEventListener('click', () => Cam.reset());
  $('btnMenu').addEventListener('click', () => UI.openMenu());
  $('modalBody').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) Panels.handle(b.dataset.act); });
  $('menu').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]'); if (q) { applyQuality(q.dataset.q); return; }
    const b = e.target.closest('[data-menu]'); if (!b) return; const a = b.dataset.menu;
    if (a === 'play') UI.closeMenu(); else if (a === 'settings') UI.menuPanel('Settings'); else if (a === 'about') UI.menuPanel('About'); else if (a === 'back') UI.menuPanel('Main');
    else if (a === 'save') { Save.save(); UI.closeMenu(); } else if (a === 'load') { if (Save.load()) UI.closeMenu(); }
    else if (a === 'fps') { settings.fps = !settings.fps; $('fps').hidden = !settings.fps; $('fpsState').textContent = settings.fps ? 'ON' : 'OFF'; saveSettings(); }
  });
}

/* ------------------------------- Main loop ----------------------------- */
let fpsAcc = 0, fpsN = 0, slow = 0;
function perfWatch(dt) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { if (settings.fps) $('fps').textContent = Math.round(fpsN / fpsAcc) + ' FPS'; fpsAcc = 0; fpsN = 0; }
  if (G.time < 6) return;
  if (dt > 0.045) slow++; else slow = Math.max(0, slow - 0.5);
  if (slow > 150 && G.quality !== 'LOW') { const nq = G.quality === 'HIGH' ? 'MEDIUM' : 'LOW'; applyQuality(nq); UI.toast('Graphics set to ' + nq + ' for smoother play'); slow = 0; }
}
function update(dt) {
  G.time += dt;
  DayNight.update(dt);
  if (G.inCar) { Vehicle.update(dt, true); Player.pos.set(Vehicle.x, Vehicle.y, Vehicle.z); } else { Player.update(dt); Vehicle.update(dt, false); }
  NPCs.update(dt); Missions.update(dt); Cam.update(dt); Interact.update(); UI.update(dt); perfWatch(dt);
}
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (G.mode === 'playing') { if (!G.menuOpen && !G.phoneOpen) update(dt); }
  else if (G.mode === 'welcome') { Cam.yaw += dt * 0.12; Cam.update(dt); NPCs.update(dt); stars.position.copy(camera.position); }
  renderer.render(scene, camera);
}

/* --------------------------------- Boot -------------------------------- */
async function boot() {
  UI.progress(0.02); bindInput(); Phone.bind(); AuthUI.bind();
  Net.init();
  applyQuality(settings.quality);
  $('fps').hidden = !settings.fps; $('fpsState').textContent = settings.fps ? 'ON' : 'OFF';
  await loadAssets();
  await buildWorld();
  Player.init(); Vehicle.init(); Missions.init(); NPCs.init();
  Player.spawn(HOME.x, HOME.z, 0);
  Vehicle.place(-44, -5.2, Math.PI / 2);
  applyQuality(G.quality);            // re-run so shadows, NPC count and glow apply to everything just built
  Cam.reset(); DayNight.apply(); onResize();
  UI.progress(1); await tick();
  window.__osogboBooted = true; window.__iwoBooted = true;
  G.mode = 'welcome';
  $('loadView').hidden = true; $('welcome').hidden = false;

  // Wait for Firebase to restore any existing session (fixes "next time login")
  try {
    const user = await Net.waitAuth();
    if (user && Net.ready) {
      const profile = await Net.loadProfile(user.uid, user.displayName || user.email);
      Net.applyProfile(profile);
      AuthUI.showReady(profile);
    } else {
      AuthUI.showForm();
    }
  } catch (e) {
    console.warn('[IwoLife] Auth restore failed:', e);
    AuthUI.showForm();
  }

  $('btnPlay').addEventListener('click', () => { startPlay(false); });
  $('btnContinue').addEventListener('click', () => { startPlay(true); });
  frame();
}
function startPlay(cont) {
  G.mode = 'playing'; clock.getDelta();
  $('loading').classList.add('gone'); setTimeout(() => { $('loading').hidden = true; }, 700);
  $('hud').hidden = false; UI._pid = '__refresh';
  if (!G.isGuest && G.uid) Net.startPresence();
  if (cont) Save.load();
  else {
    Cam.reset();
    const msg = G.isGuest
      ? 'Welcome to Iwo! You are offline. Sign in next time for chat, wallet cloud save and services.'
      : 'Welcome to Iwo, ' + (G.displayName || 'Player') + '! Open your phone (P) to chat, check wallet, post skills or buy an apartment.';
    UI.say('Welcome', msg);
  }
}
boot().catch((err) => {
  console.error(err);
  const s = $('loadSub'); if (s) { s.classList.remove('pulse'); s.textContent = 'Something went wrong while loading: ' + (err && err.message ? err.message : err); }
});
