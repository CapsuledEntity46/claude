/**
 * Builds the functional harness page.
 *
 * The harness reuses the game's real markup (so the HUD and inventory DOM the
 * game expects actually exists), with the module entry swapped for the bundled
 * harness script and a results <pre> appended.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'test/dist');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'test/harness.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: resolve(outDir, 'harness.js'),
  logLevel: 'warning',
  loader: { '.css': 'empty' },
});

const page = readFileSync(resolve(root, 'index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.ts"></script>', '<script src="./harness.js"></script>')
  .replace('</body>', `  <pre id="out" style="position:fixed;inset:0;z-index:999;margin:0;padding:16px;overflow:auto;background:#0d0f10;color:#d9dde1;font:12px/1.55 monospace;white-space:pre-wrap">running…</pre>
</body>`);

writeFileSync(resolve(outDir, 'harness.html'), page);

// The harness needs the stylesheet only so layout-dependent code (inventory cell
// metrics) reads sane values.
writeFileSync(
  resolve(outDir, 'styles.css'),
  readFileSync(resolve(root, 'src/ui/styles.css'), 'utf8'),
);
writeFileSync(
  resolve(outDir, 'harness.html'),
  page.replace('</head>', '  <link rel="stylesheet" href="./styles.css" />\n</head>'),
);

console.log('harness built -> test/dist/harness.html');
