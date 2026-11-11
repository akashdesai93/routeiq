// Bundles src/main.js (and @capacitor/core) into www/app.js for the WebView.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src/main.js')],
  outfile: path.join(root, 'www/app.js'),
  bundle: true,
  format: 'iife',
  target: 'safari15',
  logLevel: 'info',
});
