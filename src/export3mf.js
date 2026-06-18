import { zipSync, strToU8 } from 'fflate';
import { weldPositions } from './meshUtils.js';

// Round to keep the XML compact without losing print precision (1e-4 mm).
const f = (n) => Math.round(n * 1e4) / 1e4;

function meshXml(geom) {
  // Manifold output is already a clean, indexed, watertight solid — use it as-is.
  // Only weld when handed a non-indexed mesh (don't re-weld and risk false merges).
  const g = geom.index ? geom : weldPositions(geom);
  const pos = g.getAttribute('position').array;
  const idx = g.getIndex().array;

  const verts = [];
  for (let i = 0; i < pos.length; i += 3) {
    verts.push(`<vertex x="${f(pos[i])}" y="${f(pos[i + 1])}" z="${f(pos[i + 2])}"/>`);
  }
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    tris.push(`<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

// "#rrggbb" -> "#RRGGBBFF" (3MF wants 8-digit sRGB with alpha).
const color3mf = (hex) => (hex.replace('#', '#').toUpperCase() + 'FF').replace('##', '#');

/**
 * Build a two-material 3MF: the keycap and the legend as separate colored parts,
 * assembled (via components) so they stay aligned and each maps to a filament
 * in PrusaSlicer / OrcaSlicer / Bambu Studio.
 */
export function buildThreeMF(keycapGeom, logoGeom, { keycapColor, logoColor }) {
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US"` +
    ` xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` +
    ` xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">` +
    `<resources>` +
    `<basematerials id="1">` +
    `<base name="Keycap" displaycolor="${color3mf(keycapColor)}"/>` +
    `<base name="Legend" displaycolor="${color3mf(logoColor)}"/>` +
    `</basematerials>` +
    `<object id="2" type="model" pid="1" pindex="0">${meshXml(keycapGeom)}</object>` +
    `<object id="3" type="model" pid="1" pindex="1">${meshXml(logoGeom)}</object>` +
    `<object id="4" type="model"><components>` +
    `<component objectid="2"/><component objectid="3"/>` +
    `</components></object>` +
    `</resources>` +
    `<build><item objectid="4"/></build>` +
    `</model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0"` +
    ` Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  const zipped = zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(model),
    },
    { level: 6 }
  );
  return new Blob([zipped], { type: 'model/3mf' });
}
