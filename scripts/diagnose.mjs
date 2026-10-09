/** Reproduce the building showcase and isolate any unexplained visual layer. */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
  } catch { res.writeHead(404).end(); }
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 20000 });
await page.click('#play');
await page.mouse.move(640, 360);
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugSetLookEnabled(false); g.debugSetInvulnerable(true); g.debugFreezeTime(true);
  g.debugSetTime('day'); g.debugSetWeather('clear');
});
await page.waitForTimeout(9000);
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugClearEnemies(); g.debugFlattenArena(12); g.debugLook(0, -0.06); g.debugRefill();
  g.debugGiveItem('block_stone_stairs', 60);
  g.debugGiveItem('block_door', 8);
  g.debugGiveItem('block_window', 20);
  g.debugGiveItem('block_fence', 30);
  g.debugGiveItem('block_shingles', 40);
  g.debugGiveItem('block_plank_slab', 40);
  g.debugBuildShowcase();
  g.debugLook(0.45, -0.12);
});
await page.waitForTimeout(3500);
console.log('layers:', JSON.stringify(await page.evaluate(() => window.__voxelquest.debugLayers())));
await page.screenshot({ path: join(SHOTS, 'diag-build-all.png') });
for (const layer of ['particles', 'trails', 'viewmodel']) {
  await page.evaluate((l) => window.__voxelquest.debugHideLayer(l, true), layer);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `diag-build-no-${layer}.png`) });
  await page.evaluate((l) => window.__voxelquest.debugHideLayer(l, false), layer);
  console.log(`  captured diag-build-no-${layer}.png`);
}
await browser.close();
server.close();
