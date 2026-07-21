import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadKeycap } from './keycap.js';
import { parseSvg, logoFootprint } from './logo.js';
import { FONT_OPTIONS, importFontFile, parseLetter, loadBundledFonts } from './letter.js';
import { buildBodies } from './geometry.js';
import { initManifold, geomToManifold, manifoldToGeom, creaseNormals } from './manifold.js';
import { scaleStemComponentsXY } from './meshUtils.js';
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

// Ground grid + background — same look as the clicker & keychain apps, and
// theme-aware: brand-blue centre lines over grey grid on a dark/light backdrop.
// 10 mm cells, large enough to sit well past any cap size (1u … spacebar).
let grid = null;
function applyViewportTheme(theme) {
  const isLight = theme === 'light';
  renderer.setClearColor(isLight ? 0xf3f4f6 : 0x15171c);
  if (grid) { scene.remove(grid); grid.geometry.dispose(); }
  grid = new THREE.GridHelper(400, 40, isLight ? 0x2563eb : 0x5b9dff, isLight ? 0xd1d5db : 0x2f3440);
  grid.renderOrder = -1;
  // Draw the grid first and skip depth-writes so the opaque cap always wins.
  (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((m) => { m.depthWrite = false; });
  scene.add(grid);
}
applyViewportTheme(document.documentElement.getAttribute('data-theme') || 'dark');

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

// Rebuild the working stem from the authored one at the current fit tolerance, refreshing
// the preview. `stemGeometry` (used by both exports) is the scaled body; at 0 tolerance it
// IS the base solid (no copy). Safe to call before C exists (falls back to 0 tolerance).
function applyStemTolerance() {
  const prev = stemGeometry;
  if (!baseStemGeometry) {
    stemGeometry = null;
  } else {
    const tol = stemTolValue;
    stemGeometry = Math.abs(tol) > 1e-4
      ? scaleStemComponentsXY(baseStemGeometry, tol)
      : baseStemGeometry;
  }
  if (prev && prev !== baseStemGeometry && prev !== stemGeometry) prev.dispose();
  stemMesh.geometry?.dispose();
  stemMesh.geometry = stemGeometry ? creaseNormals(stemGeometry) : undefined;
  updateStemMaterial();
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
  renderer.render(scene, camera);
})();

// ---------------------------------------------------------------- state
let meta = null;            // keycap metadata from convert step
let shellGeometry = null;   // cap shell geometry, stem removed (native mm)
let baseStemGeometry = null;// switch stem as authored (clean solid); source for the tolerance scale
let stemGeometry = null;    // stem after fit-tolerance scaling — the body used for preview + export
let homingBumpGeometry = null; // homing bump geometry
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

// Stem fit stepper (− / +): a signed mm offset that rescales only the stem body (no cap CSG
// rebuild), so it lives outside `C` and drives applyStemTolerance directly.
let stemTolValue = 0;
const STEM_TOL_MIN = -0.4, STEM_TOL_MAX = 0.4, STEM_TOL_STEP = 0.02;
function renderStemTol() {
  const v = stemTolValue;
  $('stemTolVal').textContent = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} mm`;
}
function setStemTol(v) {
  stemTolValue = Math.round(Math.min(STEM_TOL_MAX, Math.max(STEM_TOL_MIN, v)) * 100) / 100;
  renderStemTol();
}
$('stemTolMinus').addEventListener('click', () => { setStemTol(stemTolValue - STEM_TOL_STEP); applyStemTolerance(); });
$('stemTolPlus').addEventListener('click', () => { setStemTol(stemTolValue + STEM_TOL_STEP); applyStemTolerance(); });
renderStemTol();
$('mirror').addEventListener('change', scheduleRegen);
$('homingBump').addEventListener('change', scheduleRegen);
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
  size: 8, depth: 0.5, rot: 0, offx: 0, offy: 0, stemTol: 0,
  mirror: false, through: false, single: false, homingBump: false,
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
  setStemTol(DEFAULTS.stemTol);
  applyStemTolerance();
  $('mirror').checked = DEFAULTS.mirror;
  $('through').checked = DEFAULTS.through;
  $('single').checked = DEFAULTS.single;
  $('homingBump').checked = DEFAULTS.homingBump;
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
    homingBump: $('homingBump').checked,
    homingBumpGeom: homingBumpGeometry,
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
  const legendSlug = (currentLegend?.name || 'legend').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.download = `keycap-${legendSlug}${profileSlug() ? '-' + profileSlug() : ''}.3mf`;
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
  const tags = [profileSlug(), sizeLabel].filter(Boolean).join('-');
  a.download = `keycap-blank${tags ? '-' + tags : ''}.3mf`;
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
    a.download = `keycap-alphabet-${fontSlug}${profileSlug() ? '-' + profileSlug() : ''}.zip`;
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
  if (stemGeometry && stemGeometry !== baseStemGeometry) stemGeometry.dispose();
  baseStemGeometry?.dispose();
  stemGeometry = null;
  baseStemGeometry = null;
  capMesh.geometry?.dispose();
  stemMesh.geometry?.dispose();

  shellGeometry = kc.shellGeometry;
  meta = kc.meta;
  capMesh.geometry = shellGeometry.clone(); // shown until the first regen carves it

  // Run the stem(s) through Manifold once so they're a watertight, welded, manifold solid
  // (the raw STEP tessellation has split vertices) — clean base for the fit-tolerance scale.
  if (kc.stemGeometry) {
    const m = geomToManifold(kc.stemGeometry);
    baseStemGeometry = manifoldToGeom(m); // clean indexed solid, as authored
    m.delete();
    kc.stemGeometry.dispose();
  }
  applyStemTolerance(); // derive stemGeometry + preview at the current fit tolerance

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

const profileSelect = $('profileSelect');
const unitSelect = $('unitSelect');
let keycapProfiles = [];     // [{ id, label, default, keycaps:[{ id, label, file, unit }] }]
let currentProfile = null;   // the active profile object
let keycapManifest = [];     // the active profile's size list (keycaps[])

// Load a different keycap (profile/size) and rebuild the current legend on it.
async function switchKeycap(file, label) {
  busyEl.style.display = 'block';
  unitSelect.disabled = true;
  profileSelect.disabled = true;
  try {
    const kc = await loadKeycap(file);
    setKeycap(kc);
    if (currentLegend) scheduleRegen(); else busyEl.style.display = 'none';
  } catch (e) {
    console.error(e);
    busyEl.style.display = 'none';
    setStatus(`Could not load ${label || 'this keycap'}.`, 'err');
  } finally {
    unitSelect.disabled = false;
    profileSelect.disabled = false;
  }
}

// Fill the size dropdown from a profile, keeping the same size id when it exists (so flipping
// profile preserves the chosen size — both profiles carry the same set). Returns the entry.
function populateSizes(profile, preferredId) {
  keycapManifest = profile.keycaps;
  unitSelect.textContent = '';
  for (const k of keycapManifest) {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.label;
    unitSelect.appendChild(opt);
  }
  const entry =
    keycapManifest.find((k) => k.id === preferredId) ||
    keycapManifest.find((k) => k.id === profile.default) ||
    keycapManifest[0];
  unitSelect.value = entry.id;
  return entry;
}

// Slug for the active profile, used to keep exported filenames distinct between profiles.
// Empty when there's only one profile, so single-profile filenames stay unchanged.
function profileSlug() {
  if (!currentProfile || keycapProfiles.length < 2) return '';
  return currentProfile.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

profileSelect.addEventListener('change', () => {
  const profile = keycapProfiles.find((p) => p.id === profileSelect.value);
  if (!profile) return;
  currentProfile = profile;
  const entry = populateSizes(profile, unitSelect.value); // keep the current size if it exists
  currentUnit = entry.unit || 1;
  updateAlphabetAvailability();
  switchKeycap(entry.file, `${profile.label} ${entry.label}`);
});

unitSelect.addEventListener('change', () => {
  const entry = keycapManifest.find((k) => k.id === unitSelect.value);
  if (entry) {
    currentUnit = entry.unit || 1;
    updateAlphabetAvailability();
    switchKeycap(entry.file, entry.label);
  }
});

// ------------------------------------------------------- quality callout (dismissable)
(function initQualityCallout() {
  const callout = $('qualityCallout');
  if (!callout) return;
  const KEY = 'keycap_quality_callout';
  try { if (localStorage.getItem(KEY) === 'dismissed') { callout.hidden = true; return; } } catch {}
  $('qualityCalloutDismiss')?.addEventListener('click', () => {
    callout.hidden = true;
    try { localStorage.setItem(KEY, 'dismissed'); } catch {}
  });
})();

// ------------------------------------------------------- theme toggle
const themeToggle = $('themeToggle');
const themeLabel = $('themeLabel');
function syncThemeLabel() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  themeLabel.textContent = isLight ? 'Dark mode' : 'Light mode';
}
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('keycap_theme', next);
    applyViewportTheme(next);
    syncThemeLabel();
  });
  syncThemeLabel();
}

// ------------------------------------------------------- save/load project
$('saveProj')?.addEventListener('click', () => {
  const projectState = {
    size: parseFloat($('size').value),
    depth: parseFloat($('depth').value),
    rot: parseFloat($('rot').value),
    offx: parseFloat($('offx').value),
    offy: parseFloat($('offy').value),
    capColor: $('capColor').value,
    logoColor: $('logoColor').value,
    mirror: $('mirror').checked,
    homingBump: $('homingBump').checked,
    through: $('through').checked,
    single: $('single').checked,
    profile: $('profileSelect').value,
    unit: $('unitSelect').value,
  };
  if (currentLegend) projectState.legend = currentLegend;
  const blob = new Blob([JSON.stringify(projectState, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'keycap-project.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Project saved ✓');
});

$('loadProj')?.addEventListener('click', () => $('projFile').click());
$('projFile')?.addEventListener('change', () => {
  const f = $('projFile').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const loaded = JSON.parse(reader.result);
      if (loaded.size != null) { $('size').value = loaded.size; $('sizeNum').value = loaded.size; }
      if (loaded.depth != null) { $('depth').value = loaded.depth; $('depthNum').value = loaded.depth; }
      if (loaded.rot != null) { $('rot').value = loaded.rot; $('rotNum').value = loaded.rot; }
      if (loaded.offx != null) { $('offx').value = loaded.offx; $('offxNum').value = loaded.offx; }
      if (loaded.offy != null) { $('offy').value = loaded.offy; $('offyNum').value = loaded.offy; }
      if (loaded.capColor) { $('capColor').value = loaded.capColor; capMat.color.set(loaded.capColor); }
      if (loaded.logoColor) { $('logoColor').value = loaded.logoColor; logoMat.color.set(loaded.logoColor); }
      if (loaded.mirror != null) $('mirror').checked = loaded.mirror;
      if (loaded.homingBump != null) $('homingBump').checked = loaded.homingBump;
      if (loaded.through != null) $('through').checked = loaded.through;
      if (loaded.single != null) $('single').checked = loaded.single;
      if (loaded.profile) $('profileSelect').value = loaded.profile;
      if (loaded.unit) $('unitSelect').value = loaded.unit;
      // Trigger UI sync
      $('size').dispatchEvent(new Event('input'));
      $('profileSelect').dispatchEvent(new Event('change'));
      applyModeFlags();
      setStatus('Project loaded ✓');
    } catch {
      setStatus('Failed to load project file', 'err');
    }
  };
  reader.readAsText(f);
  $('projFile').value = '';
});

// ------------------------------------------------------- help dialog
$('helpToggle')?.addEventListener('click', () => {
  const overlay = $('whatsNew');
  if (overlay) overlay.hidden = false;
});

// ------------------------------------------------------- "what's new" modal
// Shows on every visit until the user ticks "Don't show this again". Bump
// WHATS_NEW_VERSION whenever the notes change so the popup resurfaces for everyone.
(function whatsNew() {
  const WHATS_NEW_VERSION = '2026-07-thocky-stem';
  const KEY = 'keycap_whatsnew_dismissed';
  const overlay = $('whatsNew');
  if (!overlay) return;

  let dismissed = null;
  try { dismissed = localStorage.getItem(KEY); } catch {}
  if (dismissed === WHATS_NEW_VERSION) return; // user opted out of this version

  const close = () => {
    overlay.hidden = true;
    document.removeEventListener('keydown', onKey);
    if ($('whatsNewHide').checked) {
      try { localStorage.setItem(KEY, WHATS_NEW_VERSION); } catch {}
    }
  };
  function onKey(e) { if (e.key === 'Escape') close(); }

  $('whatsNewClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }); // backdrop
  document.addEventListener('keydown', onKey);
  overlay.hidden = false;
})();

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    await initManifold(); // engine needed up-front to clean the stem body

    // Pull the manifest; fall back to the single-cap file if it isn't there.
    const index = await fetch('keycaps/index.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    // Accept the profile-aware manifest, or the older flat { default, keycaps } as one profile.
    const profiles = index?.profiles?.length
      ? index.profiles
      : index?.keycaps?.length
        ? [{ id: 'default', label: 'Default', default: index.default, keycaps: index.keycaps }]
        : null;

    let defaultFile = 'keycap.json';
    if (profiles) {
      keycapProfiles = profiles;
      for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        profileSelect.appendChild(opt);
      }
      const defProfile = profiles.find((p) => p.id === index.defaultProfile) || profiles[0];
      currentProfile = defProfile;
      profileSelect.value = defProfile.id;
      const entry = populateSizes(defProfile, defProfile.default);
      defaultFile = entry.file;
      currentUnit = entry.unit || 1;
      // A single profile needs no picker — keep the size dropdown, hide the profile one.
      if (profiles.length < 2) profileSelect.closest('.field').style.display = 'none';
    } else {
      unitSelect.closest('.section').style.display = 'none'; // no manifest — hide the picker
    }

    try {
      const hb = await loadKeycap('keycaps/homing-bump.json');
      homingBumpGeometry = hb.shellGeometry;
    } catch (e) {
      console.error('Failed to load homing bump geometry:', e);
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

// ---------------------------------------------------------------- help tooltips
// A single bubble reused by every ".help-badge". Appended to <body> so the right
// sidebar's overflow:hidden never clips it. Shown on hover/focus of a badge.
(function initHelpTips() {
  const bubble = document.createElement('div');
  bubble.className = 'help-tip-bubble';
  bubble.hidden = true;
  document.body.appendChild(bubble);

  function show(badge) {
    const tip = badge.getAttribute('data-tip');
    if (!tip) return;
    bubble.textContent = tip;
    bubble.hidden = false;
    const r = badge.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
    let top = r.top - b.height - 8;
    if (top < 8) top = r.bottom + 8; // flip below if there's no room above
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }
  const hide = () => { bubble.hidden = true; };

  document.querySelectorAll('.help-badge').forEach((badge) => {
    badge.addEventListener('mouseenter', () => show(badge));
    badge.addEventListener('mouseleave', hide);
    badge.addEventListener('focus', () => show(badge));
    badge.addEventListener('blur', hide);
    badge.addEventListener('click', (e) => e.preventDefault());
  });
})();
