// Builds a single self-contained HTML demo of the diner app (mock API, no server).
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const swapApi = {
  name: 'swap-api',
  setup(b) {
    b.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: path.join(root, 'public/js/api.demo.js') }));
    // In the browser /js/../shared maps to the served /shared folder.
    b.onResolve({ filter: /^\.\.\/shared\// }, (a) => ({ path: path.join(root, a.path.slice(3)) }));
  },
};
const out = await build({
  entryPoints: [path.join(root, 'public/js/app.js')],
  bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', plugins: [swapApi],
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile(path.join(root, 'public/css/app.css'), 'utf8');
const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Orderize — Demo</title><style>${css}</style></head>
<body><div id="app"></div><script>${js}</script></body></html>`;
await mkdir(path.join(root, 'demo/dist'), { recursive: true });
await writeFile(path.join(root, 'demo/dist/index.html'), html);
console.log(`demo/dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
