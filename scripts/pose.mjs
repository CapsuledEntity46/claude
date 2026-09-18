/**
 * Fast viewmodel iteration: renders the held item for several weapons and poses
 * in one pass, so the composition can be judged without replaying a whole
 * gameplay capture.
 *
 * Usage: npm run build && node scripts/pose.mjs
 */
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
  const g = window.__voxelquest;
  g.debugSetLookEnabled(false);
  g.debugSetInvulnerable(true);
  g.debugFreezeTime(true);
  g.debugSetTime('day');
  g.debugSetWeather('clear');
});
await page.waitForTimeout(8000);

// Flat ground and a level horizon, so only the held item varies between shots.
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugClearEnemies();
  g.debugFlattenArena(14);
  g.debugLook(0, 0.05);
});
await page.waitForTimeout(2500);

const weapons = ['longsword', 'mace', 'spear', 'halberd', 'shortbow', 'musket', 'torch'];
for (const id of weapons) {
  await page.evaluate((weapon) => {
    const g = window.__voxelquest;
    g.debugGiveItem(weapon, 1);
    g.debugEquip(weapon);
    g.debugSelectHotbarByItem(weapon);
    g.debugEquip('torch');
    g.debugEquip('wooden_buckler');
  }, id);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, `pose-${id}.png`) });
  const pose = await page.evaluate(() => window.__voxelquest.debugViewPose());
  console.log(`  pose-${id}.png  ${JSON.stringify(pose)}`);
}

await browser.close();
server.close();
