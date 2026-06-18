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

  // Split vertex normals at sharp corners (>30°) while keeping curved surfaces smooth.
  const creasedGeom = toCreasedNormals(g, 30 * Math.PI / 180);
  g.dispose();
  return creasedGeom;
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
 * Algorithm:
 *  1. Duplicate vertices: first N at bottomZ, next N at bottomZ+height.
 *  2. Bottom cap  – reversed triangle winding → normals point down.
 *  3. Top    cap  – original winding → normals point up.
 *  4. Boundary edges (shared by exactly one triangle) → quad side walls.
 */
export function extrudeStrokeGeom(flatGeom, bottomZ, height) {
  const { Manifold, Mesh } = api;

  // Ensure we have an indexed geometry for correct boundary-edge detection
  const g = flatGeom.index ? flatGeom : weldPositions(flatGeom);
  const srcPos = g.getAttribute('position');
  const srcIdx = g.getIndex().array;

  const nVerts = srcPos.count;
  const nTris  = srcIdx.length / 3;

  // Build 2·N vertex buffer: lower half at bottomZ, upper half at bottomZ+height
  const verts = new Float32Array(nVerts * 2 * 3);
  for (let i = 0; i < nVerts; i++) {
    const x = srcPos.getX(i), y = srcPos.getY(i);
    // bottom
    verts[i * 3]     = x;  verts[i * 3 + 1] = y;  verts[i * 3 + 2] = bottomZ;
    // top
    verts[(nVerts + i) * 3]     = x;
    verts[(nVerts + i) * 3 + 1] = y;
    verts[(nVerts + i) * 3 + 2] = bottomZ + height;
  }

  // Count how many triangles share each undirected edge
  const edgeCnt = new Map();
  for (let t = 0; t < nTris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = srcIdx[t * 3 + e], b = srcIdx[t * 3 + (e + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edgeCnt.set(key, (edgeCnt.get(key) || 0) + 1);
    }
  }

  const tris = [];

  // Bottom cap (reversed winding → face normal –Z)
  for (let t = 0; t < nTris; t++) {
    tris.push(srcIdx[t * 3 + 2], srcIdx[t * 3 + 1], srcIdx[t * 3]);
  }

  // Top cap (original winding → face normal +Z)
  for (let t = 0; t < nTris; t++) {
    tris.push(nVerts + srcIdx[t * 3], nVerts + srcIdx[t * 3 + 1], nVerts + srcIdx[t * 3 + 2]);
  }

  // Side walls for every directed boundary edge a→b
  // Outward normal is to the right of (a→b) for CCW-wound faces → quad (a, b, b+N, a+N)
  for (let t = 0; t < nTris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = srcIdx[t * 3 + e], b = srcIdx[t * 3 + (e + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edgeCnt.get(key) === 1) {
        tris.push(a, b, nVerts + b);
        tris.push(a, nVerts + b, nVerts + a);
      }
    }
  }

  const mesh = new Mesh({
    numProp: 3,
    vertProperties: verts,
    triVerts: new Uint32Array(tris),
  });

  return Manifold.ofMesh(mesh);
}
