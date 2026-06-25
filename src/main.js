import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadKeycap } from './keycap.js';
import { parseSvg, logoFootprint } from './logo.js';
import { FONT_OPTIONS, importFontFile, parseLetter, loadBundledFonts } from './letter.js';
import { buildBodies } from './geometry.js';
import { initManifold, geomToManifold, manifoldToGeom, creaseNormals } from './manifold.js';
import { buildThreeMF } from './export3mf.js';
import { LUCIDE_ICONS, buildSvg, svgDataUrl } from './lucideIcons.js';
import { zipSync } from 'fflate';

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
renderer.setClearColor(0x3a3f47); // grey viewport so the cap + grid read clearly
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

// Infinite ground grid: a big camera-following plane whose shader draws grid lines from
// world XZ and fades with distance, so it reads as endless at any cap size (1u .. spacebar).
const GRID_MINOR = 5, GRID_MAJOR = 25, GRID_EXTENT = 12000;
const gridMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  extensions: { derivatives: true }, // fwidth (no-op/core on WebGL2)
  uniforms: {
    uColor:  { value: new THREE.Color(0x4d535d) },
    uColor2: { value: new THREE.Color(0x626a76) },
    uSize1:  { value: GRID_MINOR },
    uSize2:  { value: GRID_MAJOR },
    uFade:   { value: 120 },
    uCam:    { value: new THREE.Vector3() },
  },
  vertexShader: `
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    precision highp float;
    varying vec3 vWorld;
    uniform vec3 uColor; uniform vec3 uColor2;
    uniform float uSize1; uniform float uSize2; uniform float uFade;
    uniform vec3 uCam;
    float gridLine(vec2 p, float size) {
      vec2 r = p / size;
      vec2 g = abs(fract(r - 0.5) - 0.5) / fwidth(r);
      return 1.0 - min(min(g.x, g.y), 1.0);
    }
    void main() {
      vec2 p = vWorld.xz;
      float d = 1.0 - clamp(length(p - uCam.xz) / uFade, 0.0, 1.0);
      float g1 = gridLine(p, uSize1);
      float g2 = gridLine(p, uSize2);
      float a = max(g1 * 0.45, g2) * pow(d, 2.0);
      if (a <= 0.001) discard;
      vec3 col = mix(uColor, uColor2, step(0.5, g2));
      gl_FragColor = vec4(col, a);
    }
  `,
});
const grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gridMat);
grid.rotation.x = -Math.PI / 2;
grid.scale.set(GRID_EXTENT, GRID_EXTENT, 1);
grid.frustumCulled = false;
grid.renderOrder = -1;
scene.add(grid);

// Native keycap space is Z-up; rotate the display group so it looks right in Y-up.
const group = new THREE.Group();
group.rotation.x = -Math.PI / 2;
scene.add(group);

const capMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.55, metalness: 0.0 });
const logoMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5, metalness: 0.0 });
const capMesh = new THREE.Mesh(undefined, capMat);
const logoMesh = new THREE.Mesh(undefined, logoMat);
// The stem is a constant body; only its material swaps (cap colour normally, legend
// colour in shine-through). It shares the cap/logo materials so colour edits follow.
const stemMesh = new THREE.Mesh(undefined, capMat);
group.add(capMesh, logoMesh, stemMesh);

// Point the stem at the right shared material for the current shine-through state.
// (Single-colour mode prints everything in the cap filament, so the stem stays capMat.)
function updateStemMaterial() {
  stemMesh.material = $('through').checked ? logoMat : capMat;
}

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
  // Follow the camera (snapped to the major spacing) and fade relative to zoom so the
  // grid always extends past the cap, whether it's a 1u or a 6.5u spacebar.
  const dist = camera.position.distanceTo(controls.target);
  gridMat.uniforms.uFade.value = Math.max(dist * 3, 60);
  gridMat.uniforms.uCam.value.copy(camera.position);
  grid.position.set(
    Math.round(camera.position.x / GRID_MAJOR) * GRID_MAJOR,
    0,
    Math.round(camera.position.z / GRID_MAJOR) * GRID_MAJOR
  );
  renderer.render(scene, camera);
})();

// ---------------------------------------------------------------- state
let meta = null;            // keycap metadata from convert step
let shellGeometry = null;   // cap shell geometry, stem removed (native mm)
let stemGeometry = null;    // switch stem body (constant; recoloured, never carved)
let currentLegend = null;   // { contours, box, name }
let lastBodies = null;      // { keycapGeometry, logoGeometry } for export
let lastIconSelection = null;
let currentMode = 'icon';
let currentUnit = 1;        // size of the active keycap (drives the letter limit)

// debug handles (harmless; used for automated verification)
window.__app = {
  THREE, scene, camera, renderer, capMesh, logoMesh, stemMesh, buildThreeMF,
  get meta() { return meta; },
  get lastBodies() { return lastBodies; },
  get shellGeometry() { return shellGeometry; },
  get stemGeometry() { return stemGeometry; },
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
// Shine-through and single-colour are mutually exclusive: one prints the legend in a second
// (transparent) filament, the other engraves it in the single cap filament.
$('through').addEventListener('change', () => {
  if ($('through').checked) $('single').checked = false;
  applyModeFlags(); scheduleRegen();
});
$('single').addEventListener('change', () => {
  if ($('single').checked) $('through').checked = false;
  applyModeFlags(); scheduleRegen();
});
$('capColor').addEventListener('input', () => { capMat.color.set($('capColor').value); });
$('logoColor').addEventListener('input', () => { logoMat.color.set($('logoColor').value); });

// ---------------------------------------------------------------- resets
// Stock values for the per-section reset buttons. `size` is replaced at boot
// once we know the sensible default for this cap's geometry.
const DEFAULTS = {
  size: 8, depth: 0.5, rot: 0, offx: 0, offy: 0,
  mirror: false, through: false, single: false,
  capColor: '#1c1c1e', logoColor: '#f2f2f2',
};

// Reflect the current shine-through / single-colour state on dependent inputs.
// Shine-through prints the legend through the wall, so depth no longer applies.
// Single-colour engraves the legend in the cap filament, so the legend colour is moot.
function applyModeFlags() {
  $('depth').disabled = $('through').checked;
  $('depthNum').disabled = $('through').checked;
  $('logoColor').disabled = $('single').checked;
  updateStemMaterial();
}

function resetPlacement() {
  C.size.set(DEFAULTS.size);
  C.depth.set(DEFAULTS.depth);
  C.rot.set(DEFAULTS.rot);
  C.offx.set(DEFAULTS.offx);
  C.offy.set(DEFAULTS.offy);
  $('mirror').checked = DEFAULTS.mirror;
  $('through').checked = DEFAULTS.through;
  $('single').checked = DEFAULTS.single;
  applyModeFlags();
  scheduleRegen();
}

function resetColors() {
  $('capColor').value = DEFAULTS.capColor;
  $('logoColor').value = DEFAULTS.logoColor;
  capMat.color.set(DEFAULTS.capColor);
  logoMat.color.set(DEFAULTS.logoColor);
}

function resetLegend() {
  if (currentMode !== 'icon') setLegendMode('icon');
  searchEl.value = '';
  rebuildGallery();
  const first = defaultLucideIcon();
  if (first) selectIcon(first.el || galleryEl.firstElementChild, first.getText, first.name);
}

$('resetPlacement').addEventListener('click', resetPlacement);
$('resetColors').addEventListener('click', resetColors);
$('resetLegend').addEventListener('click', resetLegend);

// ---------------------------------------------------------------- geometry
function currentOpts() {
  return {
    widthMM: C.size.get(),
    depth: C.depth.get(),
    centerX: meta.center[0] + C.offx.get(),
    centerY: meta.center[1] + C.offy.get(),
    rotationDeg: C.rot.get(),
    mirror: $('mirror').checked,
    through: $('through').checked,
    singleColor: $('single').checked,
  };
}

let regenTimer = null;
let running = false;
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(doRegen, 200);
}

async function doRegen() {
  if (!currentLegend || !meta || !shellGeometry) return;
  if (running) { scheduleRegen(); return; }
  running = true;
  busyEl.style.display = 'block';
  await new Promise((r) => setTimeout(r, 0)); // let the spinner paint

  try {
    const fp = logoFootprint(currentLegend.box, C.size.get());
    const { keycapGeometry: capG, logoGeometry: logoG, surfaceVariation } =
      await buildBodies(shellGeometry, meta, currentLegend, currentOpts());

    // Preview meshes get creased normals (cosmetic); export keeps the clean indexed solids.
    capMesh.geometry?.dispose();
    logoMesh.geometry?.dispose();
    lastBodies?.keycapGeometry?.dispose();
    lastBodies?.logoGeometry?.dispose();
    capMesh.geometry = creaseNormals(capG);
    // Single-colour mode returns no legend body — hide the legend mesh; the icon is now a
    // recess carved into the cap geometry itself.
    if (logoG) {
      logoMesh.geometry = creaseNormals(logoG);
      logoMesh.visible = true;
    } else {
      logoMesh.geometry = undefined;
      logoMesh.visible = false;
    }
    updateStemMaterial();
    lastBodies = { keycapGeometry: capG, logoGeometry: logoG };

    $('export').disabled = false;
    const room = Math.min(meta.topExtent[0], meta.topExtent[1]);
    if (Math.max(fp.w, fp.h) > room) {
      setStatus(`Heads up: legend (${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm) is larger than the top (~${room.toFixed(1)} mm) and will be clipped.`, 'warn');
    } else if (surfaceVariation > 0.4) {
      setStatus(`Ready · legend ${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm. Note: top is curved (${surfaceVariation.toFixed(1)} mm) — keep it small so it stays flush.`, 'warn');
    } else if ($('through').checked) {
      setStatus(`Ready · legend ${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm · shine-through: legend + stem print in the legend filament (use transparent to light up).`);
    } else if ($('single').checked) {
      setStatus(`Ready · legend ${fp.w.toFixed(1)}×${fp.h.toFixed(1)} mm · single colour: legend engraved ${C.depth.get()} mm deep — prints in one filament.`);
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
    updateSizeMax();
    doRegen();
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't read “${name}”.`, 'err');
  }
}

function makeIconEl(thumbUrl, getText, name) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.title = name;
  const img = document.createElement('img');
  img.src = thumbUrl;
  img.alt = name;
  el.appendChild(img);
  el.addEventListener('click', () => selectIcon(el, getText, name));
  return el;
}

function setLegendMode(mode) {
  currentMode = mode;
  $('iconMode').classList.toggle('active', mode === 'icon');
  $('uploadMode').classList.toggle('active', mode === 'upload');
  $('letterMode').classList.toggle('active', mode === 'letter');
  $('iconPanel').hidden = mode !== 'icon';
  $('uploadPanel').hidden = mode !== 'upload';
  $('letterPanel').hidden = mode !== 'letter';

  if (mode === 'letter') {
    selectLetter();
  } else if (lastIconSelection) {
    selectIcon(lastIconSelection.el, lastIconSelection.getText, lastIconSelection.name);
  }
}

// Bigger caps fit longer legends; 1u stays at 4 characters, scaling up with the unit.
function letterMaxLen(unit) {
  return Math.max(4, Math.round((unit || 1) * 4));
}

// Push the current unit's character cap onto the letter input, trimming any overflow.
function applyLetterLimit() {
  const input = $('letterText');
  const max = letterMaxLen(currentUnit);
  input.maxLength = max;
  if (input.value.length > max) {
    input.value = input.value.slice(0, max);
    if (currentMode === 'letter') selectLetter();
  }
}

function selectLetter() {
  document.querySelectorAll('.icon.active').forEach((n) => n.classList.remove('active'));
  try {
    currentLegend = parseLetter($('letterText').value, $('fontSelect').value, letterMaxLen(currentUnit));
    updateSizeMax();
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
loadBundledFonts(addFontOption); // append the bundled open-source fonts as they parse

$('iconMode').addEventListener('click', () => setLegendMode('icon'));
$('uploadMode').addEventListener('click', () => setLegendMode('upload'));
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

// Curated set shown first when no search is active — picked for keycap legends:
// clipboard/edit ops, media keys, navigation, and common app-launcher symbols.
const POPULAR_LUCIDE = [
  // File & clipboard
  'copy', 'clipboard', 'clipboard-paste', 'scissors', 'trash-2', 'save',
  'file', 'files', 'folder', 'folder-open', 'archive', 'download', 'upload',
  // Edit
  'undo-2', 'redo-2', 'search', 'replace', 'eraser', 'pencil', 'type',
  'bold', 'italic', 'underline',
  // Navigation
  'home', 'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right',
  'corner-down-left', 'chevron-up', 'chevron-down',
  // Keys & input
  'keyboard', 'mouse', 'command', 'delete',
  // Media
  'play', 'pause', 'skip-back', 'skip-forward', 'volume-2', 'volume-x',
  'mic', 'mic-off', 'music', 'headphones',
  // Display / system
  'sun', 'moon', 'monitor', 'lock', 'unlock', 'eye', 'eye-off',
  'power', 'wifi', 'bluetooth', 'battery',
  // Apps
  'terminal', 'code', 'settings', 'bell', 'calendar', 'mail',
  'message-circle', 'phone', 'camera', 'image',
  // Symbols & fun
  'star', 'heart', 'bookmark', 'flag', 'check', 'x', 'plus', 'minus',
  'refresh-cw', 'rotate-cw', 'flame', 'zap', 'rocket', 'ghost', 'skull',
  'coffee', 'gamepad-2', 'trophy', 'crown',
];

const GALLERY_PAGE = 240;
const galleryEl = $('gallery');
const uploadGalleryEl = $('uploadGallery');
const searchEl = $('iconSearch');
const searchClearEl = $('iconSearchClear');
const countEl = $('iconCount');

let lucideShown = 0;       // how many items rendered for the current query
let lucideMatches = [];    // current filtered Lucide list
let moreBtn = null;

function rankLucide(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    const popularSet = new Set(POPULAR_LUCIDE);
    const popular = POPULAR_LUCIDE
      .map((name) => LUCIDE_ICONS.find((ic) => ic.name === name))
      .filter(Boolean);
    const rest = LUCIDE_ICONS.filter((ic) => !popularSet.has(ic.name));
    return popular.concat(rest);
  }
  const out = [];
  for (const ic of LUCIDE_ICONS) {
    const i = ic.name.indexOf(q);
    if (i === -1) continue;
    // exact match → 0, starts-with → 1, contains → 2 (then alpha)
    const rank = ic.name === q ? 0 : i === 0 ? 1 : 2;
    out.push({ ic, rank });
  }
  out.sort((a, b) => a.rank - b.rank || a.ic.name.localeCompare(b.ic.name));
  return out.map((o) => o.ic);
}

function renderLucidePage() {
  if (moreBtn) { moreBtn.remove(); moreBtn = null; }
  const end = Math.min(lucideShown + GALLERY_PAGE, lucideMatches.length);
  const frag = document.createDocumentFragment();
  for (let i = lucideShown; i < end; i++) {
    const ic = lucideMatches[i];
    const svgText = buildSvg(ic.node);
    const el = makeIconEl(svgDataUrl(svgText), async () => svgText, ic.name);
    frag.appendChild(el);
  }
  galleryEl.appendChild(frag);
  lucideShown = end;

  if (lucideShown < lucideMatches.length) {
    moreBtn = document.createElement('button');
    moreBtn.id = 'galleryMore';
    moreBtn.type = 'button';
    moreBtn.textContent = `Show ${Math.min(GALLERY_PAGE, lucideMatches.length - lucideShown)} more (${lucideMatches.length - lucideShown} hidden)`;
    moreBtn.addEventListener('click', renderLucidePage);
    galleryEl.appendChild(moreBtn);
  }
  updateCount();
}

function updateCount() {
  const total = lucideMatches.length;
  if (total === 0) {
    countEl.textContent = 'No icons match.';
  } else {
    const visible = Math.min(lucideShown, total);
    countEl.textContent = searchEl.value.trim()
      ? `${total} match${total === 1 ? '' : 'es'}` + (visible < total ? ` · showing ${visible}` : '')
      : `${total} icons` + (visible < total ? ` · showing ${visible}` : '');
  }
}

function rebuildGallery() {
  galleryEl.innerHTML = '';
  lucideShown = 0;
  lucideMatches = rankLucide(searchEl.value);
  searchClearEl.style.display = searchEl.value ? 'block' : 'none';
  renderLucidePage();
}

let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(rebuildGallery, 80);
});
searchClearEl.addEventListener('click', () => {
  searchEl.value = '';
  rebuildGallery();
  searchEl.focus();
});

function defaultLucideIcon() {
  const first = LUCIDE_ICONS.find((ic) => ic.name === POPULAR_LUCIDE[0]) || LUCIDE_ICONS[0];
  if (!first) return null;
  const svgText = buildSvg(first.node);
  // Find rendered tile so we can mark it active.
  const idx = lucideMatches.indexOf(first);
  const el = idx >= 0 && idx < lucideShown ? galleryEl.children[idx] : null;
  return { el, getText: async () => svgText, name: first.name };
}

let uploadEmptyEl = null;
function refreshUploadEmptyState() {
  const empty = uploadGalleryEl.querySelectorAll('.icon').length === 0;
  if (empty && !uploadEmptyEl) {
    uploadEmptyEl = document.createElement('div');
    uploadEmptyEl.id = 'uploadGalleryEmpty';
    uploadEmptyEl.textContent = 'No SVGs yet. Drop files in public/icons/ or use the upload button.';
    uploadGalleryEl.appendChild(uploadEmptyEl);
  } else if (!empty && uploadEmptyEl) {
    uploadEmptyEl.remove();
    uploadEmptyEl = null;
  }
}

async function loadBundledSvgs() {
  const list = await fetch('icons-manifest.json').then((r) => r.json()).catch(() => []);
  for (const { name, file } of list) {
    const el = makeIconEl(file, () => fetch(file).then((r) => r.text()), name);
    uploadGalleryEl.appendChild(el);
  }
  refreshUploadEmptyState();
}

$('upload').addEventListener('change', async (e) => {
  let firstEl = null;
  for (const file of e.target.files) {
    const text = await file.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const el = makeIconEl(url, async () => text, file.name.replace(/\.svg$/i, ''));
    uploadGalleryEl.appendChild(el);
    if (!firstEl) firstEl = el;
  }
  refreshUploadEmptyState();
  if (firstEl) {
    setLegendMode('upload');
    firstEl.click();
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- export
// Assemble the 3MF body list (cap, legend, and stem) for one set of carved bodies.
// Shared by the single-cap export and the full-alphabet batch so colour/filament
// assignment stays identical. The stem rides on the legend filament in shine-through,
// otherwise the keycap filament.
function buildExportParts(bodies, capColor, logoColor, through) {
  const parts = [
    { name: 'Keycap', color: capColor, extruder: 1, geom: bodies.keycapGeometry },
  ];
  // Single-colour mode has no separate legend body (it's a recess in the cap).
  if (bodies.logoGeometry) {
    parts.push({ name: 'Legend', color: logoColor, extruder: 2, geom: bodies.logoGeometry });
  }
  if (stemGeometry) {
    parts.push({
      name: 'Stem',
      color: through ? logoColor : capColor,
      extruder: through ? 2 : 1,
      geom: stemGeometry,
    });
  }
  return parts;
}

$('export').addEventListener('click', () => {
  if (!lastBodies) return;
  const parts = buildExportParts(
    lastBodies, $('capColor').value, $('logoColor').value, $('through').checked
  );
  const blob = buildThreeMF(parts);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `keycap-${(currentLegend?.name || 'legend').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.3mf`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus($('single').checked
    ? 'Exported 3MF ✓  Single-colour cap with an engraved legend — one filament.'
    : 'Exported 3MF ✓  Open in your slicer and assign two filaments.');
});

// Export the bare cap (uncarved shell + stem) in a single colour — no legend.
// Works for any size; uses the loaded shell directly (already a clean indexed solid).
$('exportBlank').addEventListener('click', () => {
  if (!shellGeometry) return;
  const capColor = $('capColor').value;
  const parts = [{ name: 'Keycap', color: capColor, extruder: 1, geom: shellGeometry }];
  if (stemGeometry) parts.push({ name: 'Stem', color: capColor, extruder: 1, geom: stemGeometry });

  const blob = buildThreeMF(parts);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const sizeLabel = ($('unitSelect').value || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.download = `keycap-blank${sizeLabel ? '-' + sizeLabel : ''}.3mf`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Exported blank keycap ✓  Single-colour cap with no legend.');
});

// -------------------------------------------------------- full alphabet set
// Batch-generate A–Z keycaps in the current font + placement/colour settings and
// download them as a single ZIP of 3MFs. 1u-only for now (button is disabled on
// other sizes). Each letter is carved with the same buildBodies path as the live
// preview, so what you set up for one letter is what every cap in the pack gets.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const alphabetBtn = $('alphabetSet');
const alphabetHelp = $('alphabetHelp');

// The set only makes sense for a 1u cap right now; reflect that on the button.
function updateAlphabetAvailability() {
  const ok = currentUnit === 1;
  alphabetBtn.disabled = !ok || running;
  alphabetHelp.textContent = ok
    ? 'Generates 26 keycaps (A–Z) in the current font & settings, zipped as 3MF files.'
    : 'Full alphabet set is available for the 1u keycap only — switch size to 1u to enable.';
}

async function generateAlphabetSet() {
  if (currentUnit !== 1 || !meta || !shellGeometry || running) return;

  const fontId = $('fontSelect').value;
  const fontName = FONT_OPTIONS.find((f) => f.id === fontId)?.name || 'font';
  const opts = currentOpts();
  const capColor = $('capColor').value;
  const logoColor = $('logoColor').value;
  const through = $('through').checked;

  // Hold the regen lock so live preview rebuilds don't run Manifold concurrently.
  clearTimeout(regenTimer);
  running = true;
  alphabetBtn.disabled = true;
  busyEl.style.display = 'block';
  const files = {};

  try {
    for (let i = 0; i < ALPHABET.length; i++) {
      const ch = ALPHABET[i];
      setStatus(`Generating alphabet set… ${ch} (${i + 1}/26)`);
      busyEl.textContent = `generating ${ch} (${i + 1}/26)…`;
      await new Promise((r) => setTimeout(r, 0)); // let the spinner/status paint

      const legend = parseLetter(ch, fontId, 1);
      const bodies = await buildBodies(shellGeometry, meta, legend, opts);
      const parts = buildExportParts(bodies, capColor, logoColor, through);
      files[`keycap-${ch}.3mf`] = new Uint8Array(await buildThreeMF(parts).arrayBuffer());
      bodies.keycapGeometry.dispose();
      bodies.logoGeometry?.dispose();
    }

    // 3MFs are already deflated zips — store (level 0) rather than re-compress.
    const zipped = zipSync(files, { level: 0 });
    const fontSlug = fontName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
    a.download = `keycap-alphabet-${fontSlug}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('Exported full alphabet set ✓  26 keycaps (A–Z) zipped — open each 3MF in your slicer.');
  } catch (e) {
    console.error(e);
    setStatus('Could not generate the alphabet set (try a simpler font or smaller size).', 'err');
  } finally {
    busyEl.textContent = 'generating…';
    busyEl.style.display = 'none';
    running = false;
    updateAlphabetAvailability();
    scheduleRegen(); // refresh the live preview to the current inputs after the batch
  }
}

alphabetBtn.addEventListener('click', generateAlphabetSet);

// ---------------------------------------------------------------- keycap swap
// Install a freshly loaded keycap: dispose the old geometry, clean the new stem,
// re-frame the camera, and reset the size to a sensible default for this cap.
// Called at boot and whenever the size dropdown changes. (Manifold must be ready.)
// Max legend size: a single icon (≈square) is capped by the cap's short side, but a wide
// legend (multi-letter text) can stretch along the cap's long side. Scale the ceiling by the
// legend's aspect ratio so long words on wide caps/spacebars can use the room available.
function updateSizeMax() {
  if (!meta) return;
  const capLong = Math.max(meta.topExtent[0], meta.topExtent[1]);
  const capShort = Math.min(meta.topExtent[0], meta.topExtent[1]);
  let maxW = capShort; // square / no legend yet
  const b = currentLegend?.box;
  if (b) {
    const lng = Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
    const sht = Math.min(b.max.x - b.min.x, b.max.y - b.min.y);
    const aspect = sht > 1e-6 ? lng / sht : 1;
    maxW = Math.min(capLong, capShort * aspect);
  }
  C.size.setMax((maxW * 0.95).toFixed(1));
}

// Symmetric ± range for a nudge slider + its number box.
function setNudgeRange(rangeId, numId, m) {
  $(rangeId).min = -m; $(rangeId).max = m;
  $(numId).min = -m; $(numId).max = m;
}

function setKeycap(kc) {
  // Free everything tied to the previous cap before swapping references.
  shellGeometry?.dispose();
  stemGeometry?.dispose();
  capMesh.geometry?.dispose();
  stemMesh.geometry?.dispose();

  shellGeometry = kc.shellGeometry;
  meta = kc.meta;
  capMesh.geometry = shellGeometry.clone(); // shown until the first regen carves it

  // Run the stem(s) through Manifold once so they're a watertight, welded, manifold solid
  // (the raw STEP tessellation has split vertices) — clean for both preview and 3MF.
  if (kc.stemGeometry) {
    const m = geomToManifold(kc.stemGeometry);
    stemGeometry = manifoldToGeom(m); // clean indexed solid kept for export
    m.delete();
    kc.stemGeometry.dispose();
    stemMesh.geometry = creaseNormals(stemGeometry); // creased copy for preview
  } else {
    stemGeometry = null;
    stemMesh.geometry = undefined;
  }
  updateStemMaterial();

  // Centre every cap on the world origin so it sits on the grid regardless of its native
  // STEP coordinates (the larger caps are modelled off-origin). The group holds cap + legend
  // + stem, so they all shift together. Group is Z-up rotated; position is world space.
  group.position.set(-meta.center[0], 0, meta.center[1]);

  // Frame the camera on the (now origin-centred) cap; pull the distance back proportionally
  // so wide caps (spacebars) still fit the viewport.
  const spanX = meta.bbox.max[0] - meta.bbox.min[0];
  const spanY = meta.bbox.max[1] - meta.bbox.min[1];
  const dist = Math.max(Math.max(spanX, spanY) * 1.4, 34);
  const target = new THREE.Vector3(0, meta.topZ / 2, 0);
  controls.target.copy(target);
  camera.position.copy(target).add(new THREE.Vector3(0.5, 0.45, 0.75).multiplyScalar(dist));
  resize();

  // sensible default size for this cap (also the value the placement reset restores)
  const room = Math.min(meta.topExtent[0], meta.topExtent[1]);
  DEFAULTS.size = Math.round(room * 0.5 * 10) / 10;
  C.size.set(DEFAULTS.size);
  updateSizeMax(); // legend-aspect-aware ceiling (wide text can use the cap's length)

  // Nudge range follows the cap so the legend can reach the edges of wide caps/spacebars.
  setNudgeRange('offx', 'offxNum', Math.max(5, Math.ceil((meta.bbox.max[0] - meta.bbox.min[0]) / 2)));
  setNudgeRange('offy', 'offyNum', Math.max(5, Math.ceil((meta.bbox.max[1] - meta.bbox.min[1]) / 2)));

  applyLetterLimit(); // longer legends on bigger caps
  $('exportBlank').disabled = false; // blank export needs only the shell, ready now

  $('meta').textContent = `Cap ${(meta.bbox.max[0] - meta.bbox.min[0]).toFixed(1)}×${(meta.bbox.max[1] - meta.bbox.min[1]).toFixed(1)}×${meta.topZ.toFixed(1)} mm · ${meta.triangles} tris · from ${meta.generatedFrom}`;
}

const unitSelect = $('unitSelect');
let keycapManifest = [];

// Load a different keycap size and rebuild the current legend on it.
async function switchKeycap(file, label) {
  busyEl.style.display = 'block';
  unitSelect.disabled = true;
  try {
    const kc = await loadKeycap(file);
    setKeycap(kc);
    if (currentLegend) scheduleRegen(); else busyEl.style.display = 'none';
  } catch (e) {
    console.error(e);
    busyEl.style.display = 'none';
    setStatus(`Could not load ${label || 'this size'}.`, 'err');
  } finally {
    unitSelect.disabled = false;
  }
}

unitSelect.addEventListener('change', () => {
  const entry = keycapManifest.find((k) => k.id === unitSelect.value);
  if (entry) {
    currentUnit = entry.unit || 1;
    updateAlphabetAvailability();
    switchKeycap(entry.file, entry.label);
  }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    await initManifold(); // engine needed up-front to clean the stem body

    // Pull the size manifest; fall back to the single-cap file if it isn't there.
    const index = await fetch('keycaps/index.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    let defaultFile = 'keycap.json';
    if (index?.keycaps?.length) {
      keycapManifest = index.keycaps;
      for (const k of keycapManifest) {
        const opt = document.createElement('option');
        opt.value = k.id;
        opt.textContent = k.label;
        unitSelect.appendChild(opt);
      }
      const def = keycapManifest.find((k) => k.id === index.default) || keycapManifest[0];
      unitSelect.value = def.id;
      defaultFile = def.file;
      currentUnit = def.unit || 1;
    } else {
      unitSelect.closest('.section').style.display = 'none'; // no sizes — hide the picker
    }

    setKeycap(await loadKeycap(defaultFile));
    updateAlphabetAvailability();

    rebuildGallery();
    loadBundledSvgs();
    const first = defaultLucideIcon();
    if (first && currentMode === 'icon') {
      selectIcon(first.el || galleryEl.firstElementChild, first.getText, first.name);
    } else if (currentMode === 'letter') {
      selectLetter();
    }
  } catch (e) {
    console.error(e);
    setStatus(e.message || 'Failed to load.', 'err');
  }
})();
