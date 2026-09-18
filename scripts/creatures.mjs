/**
 * Renders every enemy archetype's model, one screenshot each.
 *
 * Each creature has its own silhouette now, so each one has to be looked at — a
 * sampled couple of them tells you nothing about the rest.
 *
 * Usage: npm run build && node scripts/creatures.mjs
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
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugSetLookEnabled(false);
  g.debugSetInvulnerable(true);
  g.debugFreezeTime(true);
  g.debugSetTime('day');
  g.debugSetWeather('clear');
});
await page.waitForTimeout(8000);
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugFlattenArena(16);
  g.debugLook(0, 0.02);
  // Empty hands, so the view model does not cover the creature.
  g.debugEquip('fists');
  g.debugSelectHotbarByItem('fists');
});
await page.waitForTimeout(2500);

const archetypes = [
  'goblin_grunt',
  'goblin_skirmisher',
  'bandit_archer',
  'giant_spider',
  'orc_brute',
  'skeleton_knight',
  'cultist',
  'ogre',
  'river_fish',
];

for (const id of archetypes) {
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugHealthBars(false);
  });
  const spawned = await page.evaluate((a) => window.__voxelquest.debugSpawnArchetype(a, 4.5), id);
  // Frozen, so it stands still and faces the camera instead of charging past it.
  await page.evaluate(() => window.__voxelquest.debugFreezeEnemies(true));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(SHOTS, `creature-${id}.png`) });
  const report = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  console.log(`  creature-${id}.png  spawned=${spawned} ${JSON.stringify(report[0] ?? null)}`);
}

await browser.close();
server.close();
