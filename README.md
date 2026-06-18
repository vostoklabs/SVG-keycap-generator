# Keycap Legend Generator

Local web app to drop an SVG icon or typed letter onto a keycap and export a
**two-color 3MF** (keycap body + legend body) for printing the cap face-down in
two filaments.

## Run

```bash
npm install
npm run convert   # STEP -> public/keycap.json  (only needed once, or when you swap the .stp)
npm run dev       # opens the app
```

## Use

1. Pick an icon from the gallery (or **Upload SVG**) or switch to **Letter** and choose a font.
2. Set **Size**, **Depth** (default 0.5 mm), rotation and nudge. The legend is centered on the dish.
3. Choose the two colors (used in the preview and written into the 3MF).
4. **Export 3MF** → open in PrusaSlicer / OrcaSlicer / Bambu Studio.

In the slicer the file loads as one object with two parts (*Keycap* + *Legend*),
already colored. Assign a filament to each, then orient the cap **top-face-down**
to print the legend color as the first layers.

## How it works

- `scripts/convert-keycap.mjs` tessellates the STEP solid (via `occt-import-js`) into
  `public/keycap.json` plus metadata (bounding box, top Z, dish bottom).
- The chosen SVG icon or generated letter outline is extruded into a tall prism over
  the legend footprint. Two booleans (`three-bvh-csg`) split the cap:
  `cap ∩ prism` → the legend body (its top **is** the real
  dished surface, ≥ depth thick), `cap − prism` → a perfectly matching pocket.
- `src/export3mf.js` zips both meshes into a 3MF with two base materials.

## Add more icons

Drop `*.svg` files into `public/icons/` — they appear in the gallery on refresh.
Single-color outline icons (e.g. [Simple Icons](https://simpleicons.org)) work best.

## Add more fonts

Use **Import font** in Letter mode to load a local `.ttf`, `.otf`, or Three.js
`.typeface.json` font. Imported fonts are available for the current browser session.

## Swap the keycap

Replace the `.stp` in the project root and re-run `npm run convert`.
