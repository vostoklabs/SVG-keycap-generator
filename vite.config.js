import { defineConfig } from 'vite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pretty-print a file name for the gallery: "googlecalendar.svg" -> "Googlecalendar"
function pretty(file) {
  const base = file.replace(/\.svg$/i, '').replace(/[-_]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Lists public/icons/*.svg so the gallery updates whenever you drop new icons in.
function iconsManifestPlugin() {
  const iconsDir = resolve(__dirname, 'public', 'icons');
  const list = () =>
    readdirSync(iconsDir)
      .filter((f) => /\.svg$/i.test(f))
      .sort()
      .map((f) => ({ name: pretty(f), file: `/icons/${f}` }));

  return {
    name: 'icons-manifest',
    configureServer(server) {
      // Live listing in dev: drop an SVG into public/icons and refresh.
      server.middlewares.use('/icons-manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(list()));
      });
    },
    generateBundle() {
      // Static manifest for `npm run build`.
      this.emitFile({
        type: 'asset',
        fileName: 'icons-manifest.json',
        source: JSON.stringify(list()),
      });
    },
  };
}

export default defineConfig({
  plugins: [iconsManifestPlugin()],
  server: { open: true },
  // manifold-3d ships its own WASM; let it load the asset directly instead of prebundling.
  optimizeDeps: { exclude: ['manifold-3d'] },
});
