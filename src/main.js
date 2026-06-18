import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadKeycap } from './keycap.js';
import { parseSvg, logoFootprint } from './logo.js';
import { FONT_OPTIONS, importFontFile, parseLetter } from './letter.js';
import { buildBodies } from './geometry.js';
import { initManifold } from './manifold.js';
import { buildThreeMF } from './export3mf.js';

const $ = (id) => document.getElementById(id);
const busyEl = $('busy');
const statusEl = $('status');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

// ---------------------------------------------------------------- three setup
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x15171c);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x404654, 1.05));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(12, 30, 18);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fb6ff, 0.5);
fill.position.set(-18, 10, -14);
scene.add(fill);

const grid = new THREE.GridHelper(60, 30, 0x3a4150, 0x262b34);
scene.add(grid);

// Native keycap space is Z-up; rotate the display group so it looks right in Y-up.
const group = new THREE.Group();
group.rotation.x = -Math.PI / 2;
scene.add(group);

const capMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.55, metalness: 0.0 });
const logoMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5, metalness: 0.0 });
const capMesh = new THREE.Mesh(undefined, capMat);
const logoMesh = new THREE.Mesh(undefined, logoMat);
group.add(capMesh, logoMesh);

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// ---------------------------------------------------------------- state
let meta = null;            // keycap metadata from convert step
let keycapGeometry = null;  // original cap geometry (native mm)
let currentLegend = null;   // { contours, box, name }
let lastBodies = null;      // { keycapGeometry, logoGeometry } for export
let lastIconSelection = null;
let currentMode = 'icon';

// debug handles (harmless; used for automated verification)
window.__app = {
  THREE, scene, camera, renderer, capMesh, logoMesh, buildThreeMF,
  get meta() { return meta; },
  get lastBodies() { return lastBodies; },
  get keycapGeometry() { return keycapGeometry; },
};

// paired range + number input -> single value with onChange
function link(rangeId, numId, onChange) {
  const r = $(rangeId);
  const n = $(numId);
  n.value = r.value;
  r.addEventListener('input', () => { n.value = r.value; onChange(); });
  n.addEventListener('input', () => { r.value = n.value; onChange(); });
  return {
    get: () => parseFloat(r.value),
    set: (v) => { r.value = v; n.value = v; },
    setMax: (v) => { r.max = v; },
  };
}

const C = {
  size: link('size', 'sizeNum', scheduleRegen),
  depth: link('depth', 'depthNum', scheduleRegen),
  rot: link('rot', 'rotNum', scheduleRegen),
  offx: link('offx', 'offxNum', scheduleRegen),
  offy: link('offy', 'offyNum', scheduleRegen),
};
$('mirror').addEventListener('change', scheduleRegen);
$('capColor').addEventListener('input', () => { capMat.color.set($('capColor').value); });
$('logoColor').addEventListener('input', () => { logoMat.color.set($('logoColor').value); });

// ---------------------------------------------------------------- geometry
function currentOpts() {
  return {
    widthMM: C.size.get(),
    depth: C.depth.get(),
    centerX: meta.center[0] + C.offx.get(),
    centerY: meta.center[1] + C.offy.get(),
    rotationDeg: C.rot.get(),
    mirror: $('mirror').checked,
  };
}

let regenTimer = null;
let running = false;
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(doRegen, 200);
}

async function doRegen() {
  if (!currentLegend || !meta || !keycapGeometry) return;
  if (running) { scheduleRegen(); return; }
  running = true;
  busyEl.style.display = 'block';
  await new Promise((r) => setTimeout(r, 0)); // let the spinner paint

  try {
    const fp = logoFootprint(currentLegend.box, C.size.get());
    const { keycapGeometry: capG, logoGeometry: logoG, surfaceVariation } =
      await buildBodies(keycapGeometry, meta, currentLegend, currentOpts());

    capMesh.geometry?.dispose();
    logoMesh.geometry?.dispose();
    capMesh.geometry = capG;
    logoMesh.geometry = logoG;
    lastBodies = { keycapGeometry: capG, logoGeometry: logoG };

    $('export').disabled = false;
    const room = Math.min(meta.topExtent[0], meta.topExtent[1]);
    if (Math.max(fp.w, fp.h) > room) {
      setStatus(`Heads up: legend (${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm) is larger than the top (~${room.toFixed(1)} mm) and will be clipped.`, 'warn');
    } else if (surfaceVariation > 0.4) {
      setStatus(`Ready · legend ${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm. Note: top is curved (${surfaceVariation.toFixed(1)} mm) — keep it small so it stays flush.`, 'warn');
    } else {
      setStatus(`Ready · legend ${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm · ${C.depth.get()} mm deep.`);
    }
  } catch (e) {
    console.error(e);
    $('export').disabled = true;
    setStatus('Could not generate this legend (try a simpler icon/letter or smaller size).', 'err');
  } finally {
    busyEl.style.display = 'none';
    running = false;
  }
}

// ---------------------------------------------------------------- icons
async function selectIcon(el, getText, name) {
  document.querySelectorAll('.icon.active').forEach((n) => n.classList.remove('active'));
  el.classList.add('active');
  setStatus('Loading icon…');
  try {
    currentLegend = { ...parseSvg(await getText()), name };
    lastIconSelection = { el, getText, name };
    doRegen();
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't read “${name}”.`, 'err');
  }
}

function addIcon(thumbUrl, getText, name) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.title = name;
  const img = document.createElement('img');
  img.src = thumbUrl;
  img.alt = name;
  el.appendChild(img);
  el.addEventListener('click', () => selectIcon(el, getText, name));
  $('gallery').appendChild(el);
  return el;
}

function setLegendMode(mode) {
  const isLetter = mode === 'letter';
  currentMode = mode;
  $('iconMode').classList.toggle('active', !isLetter);
  $('letterMode').classList.toggle('active', isLetter);
  $('iconPanel').hidden = isLetter;
  $('letterPanel').hidden = !isLetter;

  if (isLetter) {
    selectLetter();
  } else if (lastIconSelection) {
    selectIcon(lastIconSelection.el, lastIconSelection.getText, lastIconSelection.name);
  }
}

function selectLetter() {
  document.querySelectorAll('.icon.active').forEach((n) => n.classList.remove('active'));
  try {
    currentLegend = parseLetter($('letterText').value, $('fontSelect').value);
    setStatus('Generating letter…');
    scheduleRegen();
  } catch (e) {
    console.error(e);
    currentLegend = null;
    $('export').disabled = true;
    setStatus(e.message || 'Could not read this letter.', 'err');
  }
}

function addFontOption(font) {
  const option = document.createElement('option');
  option.value = font.id;
  option.textContent = font.name;
  $('fontSelect').appendChild(option);
}

for (const font of FONT_OPTIONS) addFontOption(font);

$('iconMode').addEventListener('click', () => setLegendMode('icon'));
$('letterMode').addEventListener('click', () => setLegendMode('letter'));
$('letterText').addEventListener('input', selectLetter);
$('fontSelect').addEventListener('change', selectLetter);

$('fontUpload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const font = await importFontFile(file);
    addFontOption(font);
    $('fontSelect').value = font.id;
    setLegendMode('letter');
    setStatus(`Imported font: ${font.name}`);
  } catch (error) {
    console.error(error);
    setStatus('Could not import this font. Try a TTF, OTF, or typeface JSON file.', 'err');
  } finally {
    e.target.value = '';
  }
});

async function loadGallery() {
  const list = await fetch('icons-manifest.json').then((r) => r.json()).catch(() => []);
  let first = null;
  for (const { name, file } of list) {
    const el = addIcon(file, () => fetch(file).then((r) => r.text()), name);
    if (!first) first = el;
  }
  return list[0] ? { el: first, file: list[0].file, name: list[0].name } : null;
}

$('upload').addEventListener('change', async (e) => {
  let firstEl = null;
  for (const file of e.target.files) {
    const text = await file.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const el = addIcon(url, async () => text, file.name.replace(/\.svg$/i, ''));
    if (!firstEl) firstEl = el;
  }
  if (firstEl) firstEl.click();
  e.target.value = '';
});

// ---------------------------------------------------------------- export
$('export').addEventListener('click', () => {
  if (!lastBodies) return;
  const blob = buildThreeMF(lastBodies.keycapGeometry, lastBodies.logoGeometry, {
    keycapColor: $('capColor').value,
    logoColor: $('logoColor').value,
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `keycap-${(currentLegend?.name || 'legend').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.3mf`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Exported 3MF ✓  Open in your slicer and assign two filaments.');
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    initManifold(); // warm up the WASM engine in the background
    const kc = await loadKeycap();
    keycapGeometry = kc.geometry;
    meta = kc.meta;
    capMesh.geometry = keycapGeometry.clone();

    // frame the camera on the cap (native -> display: (x,y,z) -> (x, z, -y))
    const target = new THREE.Vector3(meta.center[0], meta.topZ / 2, -meta.center[1]);
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(20, 17, 28));
    resize();

    // sensible default size for this cap
    const room = Math.min(meta.topExtent[0], meta.topExtent[1]);
    C.size.setMax((room * 0.95).toFixed(1));
    C.size.set(Math.round(room * 0.5 * 10) / 10);

    $('meta').textContent = `Cap ${(meta.bbox.max[0] - meta.bbox.min[0]).toFixed(1)}×${(meta.bbox.max[1] - meta.bbox.min[1]).toFixed(1)}×${meta.topZ.toFixed(1)} mm · ${meta.triangles} tris · from ${meta.generatedFrom}`;

    const firstIcon = await loadGallery();
    if (firstIcon && currentMode === 'icon') {
      selectIcon(firstIcon.el, () => fetch(firstIcon.file).then((r) => r.text()), firstIcon.name);
    } else if (currentMode === 'letter') {
      selectLetter();
    } else {
      setStatus('Add SVG files to public/icons, or use Upload.');
    }
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Failed to load.', 'err');
  }
})();
