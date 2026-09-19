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
    game.debugRevive();
    game.debugClearEnemies();
    game.debugFlattenArena(12);
    game.debugLook(0, -0.06);
    game.debugRefill();
  });
  await page.waitForTimeout(2500);
};

// ---------------------------------------------------------------- ground texture
//
// First, before anything flattens the arena. `stage()` replaces the ground with
// cobblestone to get a level surface for the combat shots, so taking these later
// photographs bare stone and looks exactly like the textures having failed.

// Close and steep, so the turf fills the frame, then level for the grass-over-soil
// fringe on the block sides. Both are needed: the top and side tiles are different
// textures and either can be wrong on its own.
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugEquip('fists');
  game.debugSelectHotbarByItem('fists');
  game.debugLook(0.6, -0.75);
});
await page.waitForTimeout(1800);
await shot('texture-ground-close');

await g(() => window.__voxelquest.debugLook(0.6, -0.12));
await page.waitForTimeout(1400);
await shot('texture-ground-level');
console.log(`  terrain material ${JSON.stringify(await g(() => window.__voxelquest.debugTerrainMaterial()))}`);

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
// Sample several points through the swing, so the arc can be judged as a motion.
await waitForIdle();
await page.mouse.click(CENTER_X, CENTER_Y);
for (const [i, delay] of [140, 90, 90, 110].entries()) {
  await page.waitForTimeout(delay);
  await shot(`attack-swing-${i + 1}`);
}

await waitForIdle();
await g(() => window.__voxelquest.debugSetAttackMode('thrust'));
await page.mouse.click(CENTER_X, CENTER_Y);
for (const [i, delay] of [150, 110, 120].entries()) {
  await page.waitForTimeout(delay);
  await shot(`attack-thrust-${i + 1}`);
}

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

// Natural night terrain, away from the flattened arena: this is the view that
// looked flat before per-face shading was baked in.
await g(() => {
  const game = window.__voxelquest;
  game.debugTeleportUp(12);
  game.debugLook(0.7, -0.22);
});
await page.waitForTimeout(3000);
await shot('night-terrain-shading');

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

// ---------------------------------------------------------------- building

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugSetWeather('clear');
  game.debugGiveItem('block_stone_stairs', 60);
  game.debugGiveItem('block_door', 8);
  game.debugGiveItem('block_window', 20);
  game.debugGiveItem('block_fence', 30);
  game.debugGiveItem('block_shingles', 40);
  game.debugGiveItem('block_plank_slab', 40);
  game.debugBuildShowcase();
});
await page.waitForTimeout(3500);
await shot('building-materials');

// The build tool in hand, with its readout.
await g(() => {
  const game = window.__voxelquest;
  game.debugSelectHotbarByItem('build_tool');
  game.debugSetToolMode('wall');
});
await page.waitForTimeout(1200);
await shot('build-tool');

// ---------------------------------------------------------------- sky

// The sun low and reddened at dusk. At noon it sits almost straight overhead, so a
// level shot would miss it entirely; dusk puts it on the horizon where the warm
// corona is doing its work.
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('dusk');
  game.debugEquip('fists');
  game.debugSelectHotbarByItem('fists');
  // Azimuth of the setting sun, worked out from TimeOfDay's tilted arc.
  game.debugLook(0.6, 0.12);
});
await page.waitForTimeout(1600);
await shot('sky-sunset');

// The moon, near the zenith at midnight.
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('night');
  game.debugLook(0.6, 1.15);
});
await page.waitForTimeout(1600);
await shot('sky-moon');

await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugLook(0, 0);
});

// ---------------------------------------------------------------- dungeon

const wentUnderground = await g(() => window.__voxelquest.debugGoToDungeon());
if (wentUnderground) {
  await g(() => {
    const game = window.__voxelquest;
    game.debugRevive();
    game.debugSetTime('day');
    game.debugEquip('longsword');
    game.debugSelectHotbarByItem('longsword');
    game.debugEquip('torch');
  });
  // The mouth is a hole in the ground a few blocks ahead, so a near-level gaze
  // looks straight over it at the horizon — which is what the first version of
  // this shot did. Tip the camera down far enough to put the opening in frame.
  await g(() => window.__voxelquest.debugPitch(-0.42));
  await page.waitForTimeout(5000);
  await shot('dungeon-entrance');

  // Drop into the first room.
  await g(() => {
    window.__voxelquest.debugDescendDungeon();
    window.__voxelquest.debugRevive();
  });
  await page.waitForTimeout(4500);
  await shot('dungeon-interior');

  // And a wide view across the largest room, where the prop kit reads: columns,
  // braziers, banners, sarcophagi. Standing in the middle of the room puts your face
  // against the nearest piece of furniture instead.
  await g(() => {
    window.__voxelquest.debugSurveyDungeonRoom();
    window.__voxelquest.debugRevive();
  });
  await page.waitForTimeout(4000);
  await shot('dungeon-props');
  console.log(`  props ${JSON.stringify(await g(() => window.__voxelquest.debugProps()))}`);
}

// ---------------------------------------------------------------- death burst

await stage();
await g(() => {
  const game = window.__voxelquest;
  game.debugSetTime('day');
  game.debugEquip('longsword');
  game.debugSelectHotbarByItem('longsword');
  game.debugSetAttackMode('swing');
  game.debugFreezeEnemies(true);
  game.debugSpawnEnemyInReach(2.4);
});
await page.waitForTimeout(1200);
// Shoot the burst at its peak, not after it has settled.
//
// The particles only live about a second, and a fixed wait after the killing blow
// landed well past that — the first version of this shot caught bare ground with
// the debris already gone. So poll the particle count and fire the moment it
// jumps, which is the frame the enemy shatters.
{
  const baseline = await g(() => window.__voxelquest.debugParticleCount());
  let captured = false;
  for (let i = 0; i < 25 && !captured; i++) {
    await g(() => window.__voxelquest.debugRefill());
    await page.mouse.click(CENTER_X, CENTER_Y);
    for (let poll = 0; poll < 12; poll++) {
      await page.waitForTimeout(40);
      const count = await g(() => window.__voxelquest.debugParticleCount());
      if (count > baseline + 20) {
        await shot('death-break-particles');
        captured = true;
        break;
      }
    }
    const report = await g(() => window.__voxelquest.debugEnemyReport());
    if (report.length === 0) break;
  }
  if (!captured) {
    await shot('death-break-particles');
    console.log('  note  death burst peak not observed; captured anyway');
  }
}

// ---------------------------------------------------------------- sheet

await g(() => window.__voxelquest.debugSetTime('day'));
await page.keyboard.press('Tab');
await page.waitForTimeout(900);
await shot('character-sheet');

// The materials tab, which is where building actually happens from.
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.bag-tab')];
  const materials = tabs.find((t) => t.textContent.startsWith('Materials'));
  materials?.click();
});
await page.waitForTimeout(600);
await shot('character-sheet-materials');

console.log('\nenvironment:', JSON.stringify(await g(() => window.__voxelquest.debugEnvironment())));
await browser.close();
server.close();
console.log(`screenshots in ${SHOTS}`);
