/**
 * Visual capture pass. Automated checks confirm the game *runs*; only looking at
 * it confirms it looks right. Captures the held weapon, both attack motions,
 * mining cracks, day and night, weather, and the character sheet.
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
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
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
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e)));

const CENTER_X = 640;
const CENTER_Y = 360;
const g = (fn, ...args) => page.evaluate(fn, ...args);
const shot = async (name) => {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`  captured ${name}.png`);
};
const waitForIdle = async () => {
  for (let i = 0; i < 60; i++) {
    if ((await g(() => window.__voxelquest.debugCombatDiag())).combatState === 'idle') return;
    await page.waitForTimeout(100);
  }
};

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 20_000 });
await page.click('#play');
await page.mouse.move(CENTER_X, CENTER_Y);
await g(() => {
  const game = window.__voxelquest;
  game.debugSetLookEnabled(false);
  game.debugSetInvulnerable(true);
  game.debugFreezeTime(true);
});
await page.waitForTimeout(9000);

// A flat stage with a couple of foes, so every shot is composed the same way.
const stage = async () => {
  await g(() => {
    const game = window.__voxelquest;
    game.debugClearEnemies();
    game.debugFlattenArena(12);
    game.debugLook(0, -0.06);
    game.debugRefill();
  });
  await page.waitForTimeout(2500);
};

// ---------------------------------------------------------------- daylight

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugSetWeather('clear');
  game.debugSelectHotbarByItem('longsword');
  game.debugEquip('longsword');
});
await page.waitForTimeout(1200);
await shot('day-weapon-held');

// Mid-swing and mid-thrust, to show the two motions differ.
await g(() => {
  window.__voxelquest.debugSpawnEnemyInReach(2.6);
  window.__voxelquest.debugSetAttackMode('swing');
});
await waitForIdle();
await page.mouse.click(CENTER_X, CENTER_Y);
await page.waitForTimeout(180);
await shot('attack-swing');

await waitForIdle();
await g(() => window.__voxelquest.debugSetAttackMode('thrust'));
await page.mouse.click(CENTER_X, CENTER_Y);
await page.waitForTimeout(230);
await shot('attack-thrust');

// ---------------------------------------------------------------- mining

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugSelectHotbarByItem('block_cobblestone');
  game.debugLookDown();
});
await page.waitForTimeout(600);
await page.mouse.move(CENTER_X, CENTER_Y);
await page.mouse.down();
// Hold until the cracks are well advanced but the block has not broken.
for (let i = 0; i < 120; i++) {
  const h = await g(() => window.__voxelquest.debugHighlight());
  if (h && h.progress > 0.62) break;
  await page.waitForTimeout(100);
}
await shot('mining-cracks');
await page.mouse.up();

// ---------------------------------------------------------------- night

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('night');
  game.debugSetWeather('clear');
  game.debugEquip('longsword');
  game.debugEquip('torch');
  game.debugSelectHotbarByItem('longsword');
  game.debugSpawnEnemyInReach(4.5);
});
await page.waitForTimeout(2000);
await shot('night-torchlight');

// Plant a few torches and stand back, to show world lighting.
await g(() => {
  const game = window.__voxelquest;
  game.debugSelectHotbarByItem('torch');
  game.debugLookDown();
});
await page.waitForTimeout(400);
for (let i = 0; i < 3; i++) {
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(300);
  await g(() => window.__voxelquest.debugLook(Math.random() * 2 - 1, -0.5));
  await page.waitForTimeout(200);
}
await g(() => window.__voxelquest.debugLook(0, -0.25));
await page.waitForTimeout(1200);
await shot('night-planted-torches');

// ---------------------------------------------------------------- weather

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugSetWeather('storm', 1);
  game.debugEquip('longsword');
});
await page.waitForTimeout(4000);
await shot('weather-storm');

await g(() => window.__voxelquest.debugSetWeather('fog', 1));
await page.waitForTimeout(5000);
await shot('weather-fog');

// ---------------------------------------------------------------- dusk vista

await g(() => {
  const game = window.__voxelquest;
  game.debugSetWeather('clear');
  game.debugSetTime('dusk');
  game.debugTeleportUp(30);
  game.debugLook(0.6, -0.5);
});
await page.waitForTimeout(4000);
await shot('dusk-vista');

// ---------------------------------------------------------------- sheet

await g(() => window.__voxelquest.debugSetTime('day'));
await page.keyboard.press('Tab');
await page.waitForTimeout(900);
await shot('character-sheet');

console.log('\nenvironment:', JSON.stringify(await g(() => window.__voxelquest.debugEnvironment())));
await browser.close();
server.close();
console.log(`screenshots in ${SHOTS}`);
