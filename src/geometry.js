import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { initManifold, geomToManifold, manifoldToGeom, extrudePrism, extrudeStrokeGeom } from './manifold.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Centre the SVG, scale the longer side to widthMM, flip SVG-Y, rotate, then position.
function transformContours(contours, box, { widthMM, centerX, centerY, rotationDeg, mirror }) {
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) || 1;
  const s = widthMM / span;
  const sx = s * (mirror ? -1 : 1);
  const a = (rotationDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return contours.map((c) =>
    c.map(([x, y]) => {
      const X = (x - cx) * sx;
      const Y = (y - cy) * -s; // flip SVG Y so the logo reads upright from the top
      return [X * ca - Y * sa + centerX, X * sa + Y * ca + centerY];
    })
  );
}

/**
 * Apply the same center/scale/flip/rotate/translate as transformContours but to a
 * THREE.BufferGeometry (used for stroke-ribbon geometries from SVGLoader.pointsToStroke).
 * Returns a cloned geometry with transformed XY positions; Z is left at 0.
 */
function transformStrokeGeom(geom, box, { widthMM, centerX, centerY, rotationDeg, mirror }) {
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) || 1;
  const s = widthMM / span;
  const sx = s * (mirror ? -1 : 1);
  const a = (rotationDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);

  const clone = geom.clone();
  const pos = clone.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const X = (x - cx) * sx;
    const Y = (y - cy) * -s;
    pos.setXY(i, X * ca - Y * sa + centerX, X * sa + Y * ca + centerY);
  }
  pos.needsUpdate = true;
  return clone;
}

// Lowest/highest cap-surface height under the legend footprint (rays straight down).
// Accepts both contour arrays and transformed stroke BufferGeometries to build the AABB.
function sampleSurface(capGeom, contours, strokeGeoms, topZ) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const c of contours) for (const [x, y] of c) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  for (const sg of strokeGeoms) {
    const pos = sg.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }

  if (!capGeom.boundsTree) capGeom.computeBoundsTree();
  const mesh = new THREE.Mesh(capGeom);
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  const down = new THREE.Vector3(0, 0, -1);
  const o = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  const N = 8;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    rc.set(o.set(minX + ((maxX - minX) * i) / N, minY + ((maxY - minY) * j) / N, topZ + 5), down);
    const h = rc.intersectObject(mesh, false)[0];
    if (h) { lo = Math.min(lo, h.point.z); hi = Math.max(hi, h.point.z); }
  }
  if (lo === Infinity) { lo = hi = topZ; }
  return { lo, hi, box: { minX, minY, maxX, maxY } };
}

/**
 * Split the keycap into two watertight, mating bodies with the Manifold engine.
 *
 *   prism      = logo silhouette extruded from (lowestSurface - depth) up past the top.
 *                May be a union of a fill prism + one or more stroke solids.
 *   logoBody   = cap ∩ prism  -> top IS the real cap surface (follows any curvature),
 *                               >= depth thick, smooth.
 *   keycapBody = cap − prism  -> the exact matching pocket.
 *
 * Manifold guarantees both outputs are 2-manifold (no non-manifold edges), so the 3MF
 * imports clean.
 */
export async function buildBodies(capGeom, meta, icon, opts) {
  await initManifold();

  const contours    = icon.contours.length
    ? transformContours(icon.contours, icon.box, opts)
    : [];
  const strokeGeoms = (icon.strokeGeoms || []).map(g => transformStrokeGeom(g, icon.box, opts));

  const { lo, hi } = sampleSurface(capGeom, contours, strokeGeoms, meta.topZ);

  // Shine-through mode: extrude the prism the full height of the (now hollow, stem-removed)
  // shell so the legend punches clean through the top wall into the cavity — a light pipe in
  // transparent filament. With the stem gone there's no central material to leave ribbons on.
  const capBottomZ = meta.bbox.min[2];
  const bottomZ = opts.through ? capBottomZ - 1 : lo - opts.depth;
  const height  = meta.topZ + 3 - bottomZ;

  const cap = geomToManifold(capGeom);

  // Build the prism: start with fill contours (if any), then union in each stroke solid.
  let prism = contours.length ? extrudePrism(contours, bottomZ, height) : null;

  for (const sg of strokeGeoms) {
    const strokeSolid = extrudeStrokeGeom(sg, bottomZ, height);
    if (prism) {
      const united = prism.add(strokeSolid);
      prism.delete();
      strokeSolid.delete();
      prism = united;
    } else {
      prism = strokeSolid;
    }
  }

  if (!prism) throw new Error('No geometry to extrude for this icon.');

  const logoM  = cap.intersect(prism);
  const bodyM  = cap.subtract(prism);

  const logoGeometry    = manifoldToGeom(logoM);
  const keycapGeometry  = manifoldToGeom(bodyM);

  cap.delete(); prism.delete(); logoM.delete(); bodyM.delete();
  return { keycapGeometry, logoGeometry, surfaceVariation: hi - lo };
}
