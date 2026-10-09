/**
 * Diagnostic: are the dark wedges on flat terrain stale geometry or real AO?
 *
 * Captures the same view twice — once as the streamer left it, once after
 * forcing every loaded chunk to re-mesh with all neighbours present — and
 * reports how many pixels changed. A large difference means chunks were meshed
 * against unloaded neighbours and never corrected.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, '.kiro', 'artifacts', 'screenshots');
await mkdir(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = p === '/' ? 'index.html' : normalize(p).replace(/^[/\\]+/, '');
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' }).end(await readFile(join(DIST, rel)));
  } catch {
    res.writeHead(404).end();
  }
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 20_000 });
await page.click('#play');
await page.mouse.move(640, 360);
await page.evaluate(() => {
  window.__voxelquest.debugSetLookEnabled(false);
  window.__voxelquest.debugSetInvulnerable(true);
});

// Stand on a clear platform above the trees so the ground fills the frame.
await page.waitForTimeout(10_000);
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugClearEnemies();
  g.debugLook(0.5, -0.35);
});
await page.waitForTimeout(4000);

const beforeBuf = await page.screenshot({ path: join(SHOTS, 'ao-before-remesh.png') });
const stats = await page.evaluate(() => ({
  dirty: window.__voxelquest.debugSnapshot().pendingChunks,
  rebuilt: window.__voxelquest.debugRemeshAll(),
}));
await page.waitForTimeout(1200);
const afterBuf = await page.screenshot({ path: join(SHOTS, 'ao-after-remesh.png') });

// Compare the two frames.
const a = PNG.sync.read(beforeBuf);
const b = PNG.sync.read(afterBuf);
let changed = 0;
let maxDelta = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  if (d > 12) changed++;
  if (d > maxDelta) maxDelta = d;
}
const total = a.width * a.height;
const pct = ((changed / total) * 100).toFixed(2);

console.log(`\nchunks rebuilt: ${stats.rebuilt} (pending before: ${stats.dirty})`);
console.log(`pixels changed: ${changed} / ${total} (${pct}%), max channel delta ${maxDelta}`);
console.log(
  Number(pct) > 1
    ? '\nVERDICT: geometry changed materially after a forced re-mesh.\n         Chunks were meshed against unloaded neighbours and not corrected.'
    : '\nVERDICT: re-meshing changed almost nothing.\n         The shading is genuine ambient occlusion, not stale geometry.',
);

await browser.close();
server.close();
