// Convert the keycap STEP file to indexed meshes + metadata the web app loads.
// Run with: npm run convert   (re-run if you swap in a different keycap .stp)
//
// The STEP is expected to hold two solids: the cap SHELL (walls + dished top, hollow
// underneath) and the switch STEM. They're emitted as separate bodies so the app can
// recolour the stem on its own (shine-through mode). The shell goes in the top-level
// positions/indices (back-compat with the dev test scripts); the stem in `stem`.
// A single-solid STEP still works — everything just becomes the shell with no stem.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import occtimportjs from 'occt-import-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- locate the .stp file (first one in the project root) ---
const stepName =
  process.argv[2] ||
  readdirSync(root).find((f) => /\.(stp|step)$/i.test(f));
if (!stepName) {
  console.error('No .stp/.step file found in project root.');
  process.exit(1);
}
const stepPath = join(root, stepName);
console.log(`Reading ${stepName} ...`);

const occt = await occtimportjs();
const buf = new Uint8Array(readFileSync(stepPath));

// Fine tessellation so the dished top reads as smooth (chordal error 0.04 mm).
const result = occt.ReadStepFile(buf, {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.04,
  angularDeflection: 0.2,
});

if (!result || !result.success || !result.meshes?.length) {
  console.error('STEP import failed.');
  process.exit(1);
}

// --- per-mesh body + XY footprint, so we can tell stem from shell ---
const bboxOf = (positions) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
};

const mergeBodies = (bodies) => {
  const positions = [];
  const indices = [];
  let offset = 0;
  for (const b of bodies) {
    for (const v of b.positions) positions.push(v);
    for (const i of b.indices) indices.push(i + offset);
    offset += b.positions.length / 3;
  }
  return { positions, indices };
};

const bodies = result.meshes.map((mesh) => ({
  positions: Array.from(mesh.attributes.position.array),
  indices: Array.from(mesh.index.array),
}));

// Stem = the body with the smallest XY footprint; everything else merges into the shell.
const ranked = bodies
  .map((b) => {
    const bb = bboxOf(b.positions);
    return { b, bb, fp: (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) };
  })
  .sort((p, q) => p.fp - q.fp);

const hasStem = ranked.length > 1;
const stem = hasStem ? ranked[0].b : null;
const shell = mergeBodies((hasStem ? ranked.slice(1) : ranked).map((e) => e.b));
console.log(
  `Bodies: ${bodies.length}.` +
    (hasStem
      ? ` stem footprint ${ranked[0].fp.toFixed(1)} mm², shell ${ranked.slice(1).map((e) => e.fp.toFixed(0)).join('+')} mm².`
      : ' single solid — no separate stem.')
);

// --- bounding box + top-surface metadata from the SHELL (units = mm, Z up) ---
const { min, max } = bboxOf(shell.positions);
const centerX = (min[0] + max[0]) / 2;
const centerY = (min[1] + max[1]) / 2;
const topZ = max[2];

// Top-rim opening: lateral extent of vertices within 1.2 mm of the very top.
// Lowest point of the dish (near the lateral centre): the seat for preview.
let rimMinX = Infinity, rimMaxX = -Infinity, rimMinY = Infinity, rimMaxY = -Infinity;
let dishBottomZ = topZ;
const halfX = (max[0] - min[0]) / 2;
const halfY = (max[1] - min[1]) / 2;
const P = shell.positions;
for (let i = 0; i < P.length; i += 3) {
  const x = P[i], y = P[i + 1], z = P[i + 2];
  if (z >= topZ - 1.2) {
    if (x < rimMinX) rimMinX = x; if (x > rimMaxX) rimMaxX = x;
    if (y < rimMinY) rimMinY = y; if (y > rimMaxY) rimMaxY = y;
  }
  // central 40% of the cap, upper half in Z -> find the dish's lowest point
  if (Math.abs(x - centerX) < halfX * 0.4 && Math.abs(y - centerY) < halfY * 0.4 && z > (min[2] + max[2]) / 2) {
    if (z < dishBottomZ) dishBottomZ = z;
  }
}

const totalTris = (shell.indices.length + (stem?.indices.length || 0)) / 3;
const totalVerts = (shell.positions.length + (stem?.positions.length || 0)) / 3;

const meta = {
  generatedFrom: stepName,
  generatedAt: new Date().toISOString(),
  triangles: totalTris,
  vertices: totalVerts,
  bbox: { min, max },          // shell bounds
  center: [centerX, centerY],
  topZ,                 // highest point of the cap (rim of the dish)
  dishBottomZ,          // lowest point of the dished top (seat for the logo preview)
  topExtent: [rimMaxX - rimMinX, rimMaxY - rimMinY], // usable opening of the top dish
  hasStem,
  stemBbox: stem ? bboxOf(stem.positions) : null,
};

const round = (n) => Math.round(n * 1e4) / 1e4;
const out = {
  meta,
  positions: shell.positions.map(round),  // shell (top-level = back-compat with dev scripts)
  indices: shell.indices,
};
if (stem) {
  out.stem = { positions: stem.positions.map(round), indices: stem.indices };
}

const outPath = join(root, 'public', 'keycap.json');
writeFileSync(outPath, JSON.stringify(out));
console.log('Wrote public/keycap.json');
console.log(JSON.stringify(meta, null, 2));
