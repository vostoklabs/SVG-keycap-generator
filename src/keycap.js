import * as THREE from 'three';

// Load the pre-converted keycap meshes + metadata (see scripts/convert-keycap.mjs).
// The shell (walls + dished top) lives in the top-level positions/indices; the switch
// stem, when present, is a separate body so the app can recolour it on its own.
export async function loadKeycap() {
  const res = await fetch('keycap.json');
  if (!res.ok) {
    throw new Error('keycap.json not found — run `npm run convert` first.');
  }
  const data = await res.json();

  const makeGeom = (body) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(body.positions, 3));
    geometry.setIndex(body.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  };

  const shellGeometry = makeGeom({ positions: data.positions, indices: data.indices });
  const stemGeometry = data.stem ? makeGeom(data.stem) : null;

  return { shellGeometry, stemGeometry, meta: data.meta };
}
