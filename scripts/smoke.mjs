/**
 * Headless smoke test.
 *
 * A clean `tsc` says nothing about whether the game actually runs, so this boots
 * the real build in Chromium, plays it for a few seconds, and asserts that the
 * engine reached a sane state: chunks meshed, triangles drawn, player resting on
 * ground, enemies spawning, and no uncaught errors along the way.
 *
 * Usage: node scripts/smoke.mjs [--headed] [--keep]
 * Requires: npm run build, plus playwright available (see README).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SHOTS = join(ROOT, '.kiro', 'artifacts', 'screenshots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

let playwright;
try {
  playwright = await import('playwright');
} catch {
  // Fall back to a globally installed copy, which is how the sandbox has it.
  const globalRoot = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!globalRoot) {
    console.error('playwright is not installed. `npm i -D playwright && npx playwright install chromium`');
    process.exit(1);
  }
  playwright = await import(globalRoot);
}

// ---------------------------------------------------------------- static server

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const relative = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^([/\\])+/, '');
    const filePath = join(DIST, relative);
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const url = `http://127.0.0.1:${port}/`;
console.log(`serving dist at ${url}`);

// ---------------------------------------------------------------- browser

const headed = process.argv.includes('--headed');
const browser = await playwright.chromium.launch({
  headless: !headed,
  args: [
    '--no-sandbox',
    // Force a software GL stack; the sandbox has no GPU.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Every mouse action uses this one point, so the pointer never generates a
// mouse-look delta that would rotate the camera mid-test.
const CENTER_X = 640;
const CENTER_Y = 360;

const errors = [];
const consoleErrors = [];
page.on('pageerror', (error) => errors.push(String(error?.stack ?? error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const failures = [];
const check = (name, condition, detail) => {
  if (condition) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

const snapshot = () => page.evaluate(() => window.__voxelquest.debugSnapshot());
const diagnostics = () => page.evaluate(() => window.__voxelquest.debugCombatDiag());

/**
 * Polls until a predicate holds. Necessary because the game clamps `dt`, so on a
 * software renderer running at ~9 fps, game-time advances several times slower
 * than wall-clock and fixed sleeps become unreliable.
 */
async function waitUntil(label, predicate, timeoutMs = 15_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await page.waitForTimeout(intervalMs);
  }
  console.log(`  note  timed out waiting for ${label}`);
  return last;
}

try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 20_000 });
  console.log('\n[boot]');
  check('game constructed', true);

  const initial = await snapshot();
  check('world generated at spawn', initial.chunks > 0, `${initial.chunks} chunks`);
  check('player spawned above bedrock', initial.playerY > 4, `y=${initial.playerY}`);

  await page.click('#play');
  // Park the cursor at the canvas centre up front. Pointer lock is active, so any
  // later mouse.move would be consumed as a mouse-look delta and swing the camera;
  // clicking repeatedly at this same coordinate produces zero movement.
  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.waitForTimeout(2500);
  const lockState = await page.evaluate(() => document.pointerLockElement !== null);
  console.log(`  info  pointer lock ${lockState ? 'acquired' : 'not acquired'}`);

  // Synthetic mouse events report meaningless movement deltas under pointer lock
  // (observed: -1280,-720 for a same-position click), which whips the camera
  // around. Suspend mouse-look and drive the aim explicitly instead.
  await page.evaluate(() => window.__voxelquest.debugSetLookEnabled(false));

  console.log('\n[streaming + rendering]');
  const streamed = await snapshot();
  check('chunks streamed in', streamed.chunks >= 60, `${streamed.chunks} chunks`);
  check('mesher produced geometry', streamed.triangles > 5000, `${streamed.triangles} triangles`);
  check('draw calls issued', streamed.drawCalls > 0, `${streamed.drawCalls} calls`);
  check('frame loop is running', streamed.fps > 0, `${streamed.fps} fps`);

  console.log('\n[physics]');
  // Let gravity settle, then confirm the player is resting rather than falling.
  const y1 = (await snapshot()).playerY;
  await page.waitForTimeout(1200);
  const y2 = (await snapshot()).playerY;
  check('player rests on terrain (not falling)', Math.abs(y2 - y1) < 0.6, `y ${y1} -> ${y2}`);
  check('player is above sea level', y2 > 20, `y=${y2}`);

  // Walk forward across a flat platform, so this measures the movement code
  // rather than whatever hillside the player happened to spawn against.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugFlattenArena(14);
    g.debugLook(0, 0);
  });
  await page.waitForTimeout(1500);
  const beforeWalk = await snapshot();
  await page.keyboard.down('KeyW');
  const walked = await waitUntil(
    'player to walk 4 blocks',
    async () => {
      const s = await snapshot();
      return Math.hypot(s.playerX - beforeWalk.playerX, s.playerZ - beforeWalk.playerZ) > 4 ? s : null;
    },
    12_000,
  );
  await page.keyboard.up('KeyW');
  const moved = walked ? Math.hypot(walked.playerX - beforeWalk.playerX, walked.playerZ - beforeWalk.playerZ) : 0;
  check('player can walk', moved > 4, `moved ${moved.toFixed(1)} blocks`);
  check('still on solid ground after walking', (walked ?? beforeWalk).playerY > 4, `y=${(walked ?? beforeWalk).playerY}`);

  console.log('\n[melee]');
  // A controlled arena: level ground, no incoming damage, full stamina. This
  // measures the hit pipeline rather than staging a survival fight.
  const setupArena = async (distance = 2.2) =>
    page.evaluate((d) => {
      const g = window.__voxelquest;
      g.debugSetInvulnerable(true);
      g.debugClearEnemies();
      g.debugRefill();
      g.debugLook(0, 0);
      // Flat ground, so the target cannot slide down a hillside out of reach.
      g.debugFlattenArena(7);
      return g.debugSpawnEnemyInReach(d);
    }, distance);

  const spawnDistance = await setupArena(2.2);
  // Flattening dirties chunks; let the mesher drain before timing anything.
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  check('test enemy is within melee reach', spawnDistance > 0 && spawnDistance < 3, `distance ${spawnDistance?.toFixed?.(2)}`);

  // Guard against the camera having drifted: an aim check failing here explains
  // every downstream miss, rather than leaving them a mystery.
  const aim = await page.evaluate(() => window.__voxelquest.debugCombatDiag());
  check('camera is aimed level at the target', Math.abs(aim.pitch) < 0.2, `pitch ${aim.pitch}, yaw ${aim.yaw}`);

  // A single swing must resolve and reduce that enemy's HP.
  const hitsBefore = (await diagnostics()).hits;
  await page.mouse.click(CENTER_X, CENTER_Y);
  const swung = await waitUntil('swing to resolve', async () => {
    const d = await diagnostics();
    return d.resolved > 0 ? d : null;
  });
  const afterOne = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  check(
    'one swing damages the target',
    afterOne.length === 0 || (before[0] && afterOne[0] && afterOne[0].hp < before[0].hp),
    `hp ${before[0]?.hp} -> ${afterOne[0]?.hp ?? 'dead'}, hits ${hitsBefore} -> ${swung?.hits}`,
  );
  check('the swing connected with a target', (swung?.hits ?? 0) > hitsBefore, `hits ${swung?.hits}`);

  // A damaged enemy must show a health bar, and that bar must squarely face the
  // camera. It is parented to the entity, so a stray parent rotation would skew
  // it or turn it edge-on and invisible.
  const bars = await waitUntil('a health bar to appear', async () => {
    const b = await page.evaluate(() => window.__voxelquest.debugHealthBars());
    return b.some((x) => x.visible) ? b : null;
  }, 8000);
  const shown = (bars ?? []).filter((b) => b.visible);
  check('a damaged enemy shows a health bar', shown.length > 0, `${shown.length} visible`);
  check(
    'the health bar is billboarded towards the camera',
    shown.length > 0 && shown.every((b) => b.facing > 0.99),
    `facing ${shown.map((b) => b.facing).join(', ')}`,
  );

  // Keep swinging until it dies, refilling stamina so the loop is not gated by it.
  const killed = await waitUntil(
    'enemy to die and drop orbs',
    async () => {
      await page.evaluate(() => window.__voxelquest.debugRefill());
      await page.mouse.click(CENTER_X, CENTER_Y);
      const s = await snapshot();
      return s.orbs > 0 || s.xp > 0 ? s : null;
    },
    25_000,
    400,
  );
  check('kill yields XP orbs', (killed?.orbs ?? 0) > 0 || (killed?.xp ?? 0) > 0, `orbs ${killed?.orbs}, xp ${killed?.xp}`);

  const collected = await waitUntil('orbs to be collected', async () => {
    const s = await snapshot();
    return s.xp > 0 ? s : null;
  });
  check('orbs are collected into XP', (collected?.xp ?? 0) > 0, `xp ${collected?.xp}`);

  console.log('\n[attack modes]');
  // X must switch swing -> thrust, and the thrust must also land.
  await setupArena(2.6);
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(400);
  const modeLabel = await page.evaluate(() => document.getElementById('active-mode').textContent);
  check('mode label reports Thrust after pressing X', /thrust/i.test(modeLabel ?? ''), modeLabel?.slice(0, 70));

  const beforeThrust = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  const thrustHitsBefore = (await diagnostics()).hits;
  await page.mouse.click(CENTER_X, CENTER_Y);
  const thrust = await waitUntil('thrust to land', async () => {
    const d = await diagnostics();
    return d.hits > thrustHitsBefore ? d : null;
  });
  const afterThrust = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  check(
    'thrust also lands hits',
    (thrust?.hits ?? 0) > thrustHitsBefore,
    `hits ${thrustHitsBefore} -> ${thrust?.hits} | before ${JSON.stringify(beforeThrust)} | after ${JSON.stringify(afterThrust)}`,
  );

  console.log('\n[ranged and spells]');
  await page.evaluate(() => window.__voxelquest.debugRefill());
  await page.keyboard.press('Digit2'); // shortbow
  const staminaBeforeDraw = await page.evaluate(() => window.__voxelquest.debugStamina());
  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const shot = await snapshot();
  check('bow fires a projectile', shot.projectiles > 0, `${shot.projectiles} in flight, stamina was ${staminaBeforeDraw}`);

  const arrowsBefore = await page.evaluate(() => window.__voxelquest.debugItemCount('arrow'));
  check('firing consumed an arrow', arrowsBefore < 24, `${arrowsBefore} arrows left of 24`);

  await page.keyboard.press('Digit3'); // firebolt
  const slotsBefore = await page.evaluate(() => window.__voxelquest.debugSpellSlots());
  await page.mouse.click(CENTER_X, CENTER_Y);
  await page.waitForTimeout(600);
  const slotsAfter = await page.evaluate(() => window.__voxelquest.debugSpellSlots());
  check('casting consumes a spell slot', slotsAfter[0] < slotsBefore[0], `tier1 ${slotsBefore[0]} -> ${slotsAfter[0]}`);

  await page.evaluate(() => {
    window.__voxelquest.debugSetInvulnerable(false);
    window.__voxelquest.debugClearEnemies();
  });

  console.log('\n[mining and building]');
  // Stable arena and no attackers: mining progress resets whenever the targeted
  // block changes, so a jostled player would never finish a block.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFlattenArena(7);
    g.debugLook(0, 0);
    g.debugLookDown();
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Digit6'); // cobblestone

  const blockBefore = await page.evaluate(() => window.__voxelquest.debugTargetBlock());
  check('a block is targeted under the crosshair', blockBefore !== null, JSON.stringify(blockBefore));

  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.mouse.down();
  const broke = await waitUntil(
    'a block to break',
    async () => {
      const d = await diagnostics();
      return d.breaks > 0 ? d : null;
    },
    25_000,
  );
  await page.mouse.up();
  await page.waitForTimeout(300);

  const mined = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
  check(
    'mining removed at least one block',
    mined > 0 && (broke?.breaks ?? 0) > 0,
    `${mined} edited voxels, ${broke?.breaks} breaks after ${broke?.mineCalls} mine ticks`,
  );

  // The arena floor is cobblestone, so breaking it should add to that stack.
  const cobbleStock = await page.evaluate(() => window.__voxelquest.debugItemCount('block_cobblestone'));
  check('broken block dropped into the bag', cobbleStock > 48, `cobble ${cobbleStock} (started at 48)`);

  // Place a block back into the hole.
  const cobbleBefore = await page.evaluate(() => window.__voxelquest.debugItemCount('block_cobblestone'));
  const editsBefore = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(400);
  const cobbleAfter = await page.evaluate(() => window.__voxelquest.debugItemCount('block_cobblestone'));
  const editsAfter = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
  check(
    'placing a block consumes it and edits the world',
    cobbleAfter < cobbleBefore && editsAfter >= editsBefore,
    `cobble ${cobbleBefore} -> ${cobbleAfter}, edits ${editsBefore} -> ${editsAfter}`,
  );

  await page.evaluate(() => window.__voxelquest.debugSetInvulnerable(false));

  console.log('\n[save/load]');
  await page.keyboard.press('F5');
  await page.waitForTimeout(900);
  await page.keyboard.press('F9');
  await page.waitForTimeout(1500);
  const loaded = await snapshot();
  check('world still alive after save/load', loaded.chunks > 0 && loaded.triangles > 1000, `${loaded.chunks} chunks, ${loaded.triangles} tris`);

  console.log('\n[character sheet]');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const sheetVisible = await page.evaluate(() => !document.getElementById('sheet').classList.contains('hidden'));
  check('character sheet opens', sheetVisible);
  const sheetHasContent = await page.evaluate(
    () => document.getElementById('sheet-equip').textContent.includes('Attack Modes'),
  );
  check('sheet lists attack modes', sheetHasContent);
  await page.screenshot({ path: join(SHOTS, 'smoke-character-sheet.png') });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);

  console.log('\n[stability]');
  await page.waitForTimeout(3000);
  const final = await snapshot();
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');
  check('still rendering at the end', final.triangles > 1000 && final.fps > 0, `${final.triangles} tris, ${final.fps} fps`);

  await page.screenshot({ path: join(SHOTS, 'smoke-gameplay.png') });
  console.log('\nfinal snapshot:', JSON.stringify(final, null, 2));
  console.log(`screenshots written to ${SHOTS}`);
} finally {
  if (!process.argv.includes('--keep')) {
    await browser.close();
    server.close();
  }
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
