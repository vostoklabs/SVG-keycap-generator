import * as THREE from 'three';
import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { weldPositions } from './meshUtils.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let api = null;

// Load the Manifold WASM once. `locateFile` points Emscripten at the asset Vite serves.
export async function initManifold() {
  if (api) return api;
  const wasm = await ManifoldModule({ locateFile: () => wasmUrl });
  wasm.setup();
  api = wasm;
  return api;
}

// three geometry -> Manifold solid (must be welded/watertight first).
export function geomToManifold(geom) {
  const g = weldPositions(geom);
  const { Manifold, Mesh } = api;
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(g.getAttribute('position').array),
    triVerts: new Uint32Array(g.getIndex().array),
  });
  return Manifold.ofMesh(mesh);
}

// Manifold solid -> three geometry. Copies out of WASM memory so it survives delete().
// Returns the clean, indexed, 2-manifold mesh exactly as Manifold produced it — this is
// what the 3MF export must use. (For preview shading, run it through creaseNormals.)
export function manifoldToGeom(man) {
  const m = man.getMesh();
  const np = m.numProp;
  const vp = m.vertProperties;
  const pos = new Float32Array(m.numVert * 3);
  for (let i = 0; i < m.numVert; i++) {
    pos[i * 3]     = vp[i * np];
    pos[i * 3 + 1] = vp[i * np + 1];
    pos[i * 3 + 2] = vp[i * np + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

// Split vertex normals at sharp corners (>creaseAngle) while keeping curved surfaces
// smooth — for nicer PREVIEW shading only. Produces a non-indexed clone; never feed it to
// the 3MF export, since re-welding thin features (e.g. the stem cross) can fuse vertices
// and introduce non-manifold edges. Export manifoldToGeom()'s indexed output instead.
export function creaseNormals(geom, creaseAngleDeg = 30) {
  return toCreasedNormals(geom, (creaseAngleDeg * Math.PI) / 180);
}

// 2D contours -> vertical prism spanning bottomZ .. bottomZ + height.
// NonZero fill matches SVG and cleanly unions any self-overlapping paths.
export function extrudePrism(contours, bottomZ, height) {
  const { CrossSection } = api;
  const cs = new CrossSection(contours, 'NonZero');
  const solid = cs.extrude(height).translate([0, 0, bottomZ]);
  cs.delete();
  return solid;
}

/**
 * Extrude a flat 2-D BufferGeometry (z ≈ 0, as produced by SVGLoader.pointsToStroke)
 * into a watertight solid Manifold spanning bottomZ .. bottomZ + height.
 *
 * Each triangle of the ribbon mesh becomes a tiny 2-D polygon contour, forced to CCW
 * winding. Feeding the whole set to CrossSection with the NonZero fill rule lets
 * Manifold union all overlapping triangles into one clean filled region — robust to
 * the miter-join self-overlaps that pointsToStroke produces (which broke the previous
 * boundary-edge wall builder, where shared edges got count ≥ 2 and walls never closed).
 */
export function extrudeStrokeGeom(flatGeom, bottomZ, height) {
  const { CrossSection } = api;

  const pos = flatGeom.getAttribute('position');
  const idx = flatGeom.getIndex();

  const contours = [];
  const getTri = idx
    ? (t) => [idx.array[t * 3], idx.array[t * 3 + 1], idx.array[t * 3 + 2]]
    : (t) => [t * 3, t * 3 + 1, t * 3 + 2];
  const nTris = (idx ? idx.array.length : pos.count) / 3;

  for (let t = 0; t < nTris; t++) {
    const [ia, ib, ic] = getTri(t);
    const ax = pos.getX(ia), ay = pos.getY(ia);
    const bx = pos.getX(ib), by = pos.getY(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic);
    // Signed area: positive = CCW, negative = CW. Skip degenerate triangles.
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    contours.push(area > 0
      ? [[ax, ay], [bx, by], [cx, cy]]
      : [[ax, ay], [cx, cy], [bx, by]]);
  }

  if (!contours.length) {
    throw new Error('Stroke geometry produced no usable triangles.');
  }

  const cs = new CrossSection(contours, 'NonZero');
  const solid = cs.extrude(height).translate([0, 0, bottomZ]);
  cs.delete();
  return solid;
}
