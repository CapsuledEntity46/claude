/**
 * Visual capture pass. Automated checks confirm the game *runs*; only looking at
 * it confirms it looks right. Grabs a few vantage points to inspect terrain
 * shape, ambient occlusion, combat feedback, and the UI.
 *
 * Usage: npm run build && node scripts/shots.mjs
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const relative = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^[/\\]+/, '');
    const body = await readFile(join(DIST, relative));
    res.writeHead(200, { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e)));

const g = (fn, ...args) => page.evaluate(fn, ...args);
const shot = async (name) => {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`  captured ${name}.png`);
};

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 20_000 });
await page.click('#play');
await page.mouse.move(640, 360);
await g(() => window.__voxelquest.debugSetLookEnabled(false));
await g(() => window.__voxelquest.debugSetInvulnerable(true));

// Let terrain stream in and the mesher drain.
await page.waitForTimeout(9000);
console.log('emoji support:', await g(() => document.querySelector('#hotbar .hs span:nth-child(2)')?.className || '(none)'));

// 1. Natural terrain at eye level, looking slightly down.
await g(() => {
  window.__voxelquest.debugClearEnemies();
  window.__voxelquest.debugLook(0.6, -0.12);
});
await page.waitForTimeout(2500);
await shot('view-terrain');

// 2. High vantage point to judge overall terrain shape and biomes.
await g(() => {
  const game = window.__voxelquest;
  game.debugTeleportUp(34);
  game.debugLook(0.6, -0.62);
});
await page.waitForTimeout(3500);
await shot('view-from-above');

// 3. Ambient occlusion: stand in a built corner and look into it.
await g(() => window.__voxelquest.debugBuildAoProbe());
await page.waitForTimeout(3000);
await shot('view-ambient-occlusion');

// 4. Combat: a few enemies, mid-fight, with the HUD populated.
await g(() => {
  const game = window.__voxelquest;
  game.debugFlattenArena(10);
  game.debugLook(0, -0.05);
  game.debugSpawnEnemyInReach(3.0);
  game.debugSpawnEnemyInReach(5.0);
  game.debugSpawnEnemyInReach(7.5);
});
await page.waitForTimeout(3000);
await page.mouse.click(640, 360);
await page.waitForTimeout(400);
await shot('view-combat');

// 5. Character sheet, showing attack modes and the bag.
await page.keyboard.press('Tab');
await page.waitForTimeout(700);
await shot('view-character-sheet');

await browser.close();
server.close();
console.log(`\nscreenshots in ${SHOTS}`);
