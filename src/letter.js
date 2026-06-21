import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js';
import helvetikerRegular from 'three/examples/fonts/helvetiker_regular.typeface.json';
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json';
import optimerBold from 'three/examples/fonts/optimer_bold.typeface.json';
import optimerRegular from 'three/examples/fonts/optimer_regular.typeface.json';
import gentilisRegular from 'three/examples/fonts/gentilis_regular.typeface.json';
import gentilisBold from 'three/examples/fonts/gentilis_bold.typeface.json';
import droidSansRegular from 'three/examples/fonts/droid/droid_sans_regular.typeface.json';
import droidSansBold from 'three/examples/fonts/droid/droid_sans_bold.typeface.json';
import droidSansMonoRegular from 'three/examples/fonts/droid/droid_sans_mono_regular.typeface.json';
import droidSerifRegular from 'three/examples/fonts/droid/droid_serif_regular.typeface.json';
import droidSerifBold from 'three/examples/fonts/droid/droid_serif_bold.typeface.json';

const fontLoader = new FontLoader();
const ttfLoader = new TTFLoader();

export const FONT_OPTIONS = [];

const BUILT_IN_FONTS = [
  ['helvetiker-regular', 'Helvetiker', helvetikerRegular],
  ['helvetiker-bold', 'Helvetiker Bold', helvetikerBold],
  ['optimer-regular', 'Optimer', optimerRegular],
  ['optimer-bold', 'Optimer Bold', optimerBold],
  ['gentilis-regular', 'Gentilis', gentilisRegular],
  ['gentilis-bold', 'Gentilis Bold', gentilisBold],
  ['droid-sans-regular', 'Droid Sans', droidSansRegular],
  ['droid-sans-bold', 'Droid Sans Bold', droidSansBold],
  ['droid-sans-mono-regular', 'Droid Sans Mono', droidSansMonoRegular],
  ['droid-serif-regular', 'Droid Serif', droidSerifRegular],
  ['droid-serif-bold', 'Droid Serif Bold', droidSerifBold],
];

for (const [id, name, data] of BUILT_IN_FONTS) {
  FONT_OPTIONS.push({ id, name, font: fontLoader.parse(data) });
}

// Open-source TTFs bundled in public/fonts/ (SIL OFL 1.1 — see public/fonts/CREDITS.md).
// Loaded lazily at startup via loadBundledFonts() so the dropdown grows as each parses;
// a font that fails is skipped rather than blocking the rest. Ordered keycap-friendly first.
const BUNDLED_TTF = [
  ['bebas-neue', 'Bebas Neue'],
  ['anton', 'Anton'],
  ['oswald', 'Oswald'],
  ['titillium-web', 'Titillium Web'],
  ['rajdhani', 'Rajdhani'],
  ['chakra-petch', 'Chakra Petch'],
  ['orbitron', 'Orbitron'],
  ['audiowide', 'Audiowide'],
  ['michroma', 'Michroma'],
  ['russo-one', 'Russo One'],
  ['righteous', 'Righteous'],
  ['bungee', 'Bungee'],
  ['share-tech-mono', 'Share Tech Mono'],
  ['vt323', 'VT323'],
  ['press-start-2p', 'Press Start 2P'],
  ['arvo', 'Arvo'],
  ['lobster', 'Lobster'],
  ['pacifico', 'Pacifico'],
];

let bundledLoaded = false;
export async function loadBundledFonts(onLoaded) {
  if (bundledLoaded) return;
  bundledLoaded = true;
  for (const [slug, name] of BUNDLED_TTF) {
    try {
      const buf = await fetch(`fonts/${slug}.ttf`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      const option = { id: `bundled-${slug}`, name, font: fontLoader.parse(ttfLoader.parse(buf)) };
      FONT_OPTIONS.push(option);
      onLoaded?.(option);
    } catch (e) {
      console.warn(`Could not load font "${name}":`, e.message);
    }
  }
}

function uniqueFontId(base) {
  const slug = base
    .replace(/\.[^.]+$/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'imported-font';
  let id = `imported-${slug}`;
  let suffix = 2;
  while (FONT_OPTIONS.some((font) => font.id === id)) {
    id = `imported-${slug}-${suffix}`;
    suffix++;
  }
  return id;
}

function fontNameFromData(data, fallback) {
  return data.familyName || data.original_font_information?.fullName?.en || fallback;
}

function pointsToContour(points, box) {
  const contour = [];
  for (const point of points) {
    const x = point.x;
    const y = -point.y;
    box.expandByPoint(new THREE.Vector2(x, y));
    contour.push([x, y]);
  }
  return contour;
}

export async function importFontFile(file) {
  const isJson = /\.json$/i.test(file.name);
  const data = isJson ? JSON.parse(await file.text()) : ttfLoader.parse(await file.arrayBuffer());
  const option = {
    id: uniqueFontId(file.name),
    name: fontNameFromData(data, file.name.replace(/\.[^.]+$/g, '')),
    font: fontLoader.parse(data),
    imported: true,
  };
  FONT_OPTIONS.push(option);
  return option;
}

export function parseLetter(text, fontId, maxLen = 4) {
  const value = Array.from((text || '').trim()).slice(0, maxLen).join('');
  if (!value) throw new Error('Type a letter first.');

  const option = FONT_OPTIONS.find((font) => font.id === fontId) || FONT_OPTIONS[0];
  const shapes = option.font.generateShapes(value, 100);
  const contours = [];
  const box = new THREE.Box2(
    new THREE.Vector2(Infinity, Infinity),
    new THREE.Vector2(-Infinity, -Infinity)
  );

  for (const shape of shapes) {
    const extracted = shape.extractPoints(16);
    if (extracted.shape.length >= 3) contours.push(pointsToContour(extracted.shape, box));
    for (const hole of extracted.holes) {
      if (hole.length >= 3) contours.push(pointsToContour(hole, box));
    }
  }

  if (!contours.length) throw new Error('No drawable outlines found in this font.');
  return {
    contours,
    strokeGeoms: [], // letters are always fill-based
    box,
    name: `${value}-${option.name}`,
    label: value,
    fontName: option.name,
  };
}
