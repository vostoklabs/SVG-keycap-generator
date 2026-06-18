// Inspect SVG paths manually (no DOM required)
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node debug-svg.mjs <file.svg>'); process.exit(1); }

const svgText = readFileSync(file, 'utf-8');

// Quick regex to find all path elements and their fill/stroke attributes
const pathRe = /<[^>]*>/g;
let match;
let idx = 0;
while ((match = pathRe.exec(svgText)) !== null) {
  const tag = match[0];
  if (!tag.startsWith('<path') && !tag.startsWith('<rect') && !tag.startsWith('<circle') && !tag.startsWith('<polygon')) continue;
  
  const fill = (tag.match(/\bfill=["']([^"']*)["']/) || [])[1] || '(unset)';
  const stroke = (tag.match(/\bstroke=["']([^"']*)["']/) || [])[1] || '(unset)';
  const strokeW = (tag.match(/\bstroke-width=["']([^"']*)["']/) || [])[1] || '(unset)';
  const opacity = (tag.match(/\bopacity=["']([^"']*)["']/) || [])[1] || '(unset)';
  
  const tagType = tag.match(/^<(\w+)/)[1];
  console.log(`\n[${idx++}] <${tagType}>`);
  console.log('  fill:', fill);
  console.log('  stroke:', stroke);
  console.log('  stroke-width:', strokeW);
  console.log('  opacity:', opacity);
}
