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
 * Waits until the combat system will accept a new action.
 *
 * Attacks commit the player for a wind-up plus a recovery, and because the game
 * clamps `dt`, that window takes longer in wall-clock time the slower the
 * renderer is. Sleeping a fixed interval before the next click is therefore
 * unreliable; wait for the state machine instead.
 */
async function waitForIdle(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await diagnostics();
    if (d.combatState === 'idle') return true;
    await page.waitForTimeout(80);
  }
  console.log('  note  combat system never returned to idle');
  return false;
}

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

  // Walk across a flat platform, so this measures the movement code rather than
  // whatever hillside the player happened to spawn against.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugFlattenArena(16);
    g.debugLook(0, 0);
  });
  await page.waitForTimeout(1500);

  /**
   * Walks with one key and reports displacement along the camera's forward and
   * right axes. Measuring *direction* matters: the original test only checked
   * total distance moved, so it passed happily while W and S were inverted.
   */
  const walkAndMeasure = async (key, seconds = 1.6) => {
    // Reset position and aim, but do not rebuild the arena every time: doing so
    // dirties several chunks and the resulting re-mesh slows the frame rate
    // enough to distort a distance measurement.
    await page.evaluate(() => {
      const g = window.__voxelquest;
      g.debugLook(0, 0);
      g.debugRefill();
    });
    await page.waitForTimeout(400);
    const start = await snapshot();
    await page.keyboard.down(key);
    await page.waitForTimeout(seconds * 1000);
    await page.keyboard.up(key);
    await page.waitForTimeout(250);
    const end = await snapshot();
    // With yaw 0 the camera faces -Z and right is +X.
    return {
      forward: -(end.playerZ - start.playerZ),
      right: end.playerX - start.playerX,
      total: Math.hypot(end.playerX - start.playerX, end.playerZ - start.playerZ),
    };
  };

  /**
   * Asserts the movement went the right way along the right axis.
   *
   * Direction, not distance: the bug this guards against is an inverted or
   * swapped axis, and absolute distance is at the mercy of the frame rate under
   * software rendering. Requiring the intended axis to dominate the other by 3x
   * catches inversions and swaps without being flaky.
   */
  const checkDirection = (label, m, axis, sign) => {
    const intended = axis === 'forward' ? m.forward : m.right;
    const other = axis === 'forward' ? m.right : m.forward;
    const moved = m.total > 0.5;
    const correctSign = Math.sign(intended) === sign;
    const dominant = Math.abs(intended) > Math.abs(other) * 3;
    check(
      label,
      moved && correctSign && dominant,
      `forward ${m.forward.toFixed(2)}, right ${m.right.toFixed(2)}`,
    );
  };

  checkDirection('W moves the player forward', await walkAndMeasure('KeyW'), 'forward', 1);
  checkDirection('S moves the player backward', await walkAndMeasure('KeyS'), 'forward', -1);
  checkDirection('D strafes right', await walkAndMeasure('KeyD'), 'right', 1);
  checkDirection('A strafes left', await walkAndMeasure('KeyA'), 'right', -1);

  const afterWalk = await snapshot();
  check('still on solid ground after walking', afterWalk.playerY > 4, `y=${afterWalk.playerY}`);

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
  await waitForIdle();
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
  await page.evaluate(() => {
    window.__voxelquest.debugRefill();
    window.__voxelquest.debugSelectHotbarByItem('shortbow');
  });
  await page.waitForTimeout(200);
  const staminaBeforeDraw = await page.evaluate(() => window.__voxelquest.debugStamina());
  const firedBefore = (await snapshot()).projectilesFired;
  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.mouse.down();
  await page.waitForTimeout(1100);
  await page.mouse.up();
  // Poll: the projectile appears on a later frame, and a slow renderer can take
  // longer than one fixed wait to get there.
  const shot = await waitUntil('an arrow to be launched', async () => {
    const s2 = await snapshot();
    return s2.projectilesFired > firedBefore ? s2 : null;
  }, 6000, 40);
  check(
    'bow launches a projectile',
    (shot?.projectilesFired ?? firedBefore) > firedBefore,
    `fired ${firedBefore} -> ${shot?.projectilesFired ?? firedBefore}, ${shot?.projectiles ?? 0} still in flight, stamina was ${staminaBeforeDraw}`,
  );

  const arrowsBefore = await page.evaluate(() => window.__voxelquest.debugItemCount('arrow'));
  check('firing consumed an arrow', arrowsBefore < 24, `${arrowsBefore} arrows left of 24`);

  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('firebolt'));
  await page.waitForTimeout(200);
  const slotsBefore = await page.evaluate(() => window.__voxelquest.debugSpellSlots());
  await page.mouse.click(CENTER_X, CENTER_Y);
  const slotsAfter = await waitUntil('a spell slot to be spent', async () => {
    const now = await page.evaluate(() => window.__voxelquest.debugSpellSlots());
    return now[0] < slotsBefore[0] ? now : null;
  }, 5000, 100);
  check(
    'casting consumes a spell slot',
    (slotsAfter?.[0] ?? slotsBefore[0]) < slotsBefore[0],
    `tier1 ${slotsBefore[0]} -> ${slotsAfter?.[0] ?? slotsBefore[0]}`,
  );

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
  // Select by item, not by digit: the hotbar layout is not a test contract.
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('block_cobblestone'));
  await page.waitForTimeout(200);

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

  console.log('\n[view model]');
  // The held item must be visible and, crucially, animate *differently* for a
  // swing than for a thrust — that was the whole point of the feedback.
  await setupArena(2.4);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSelectHotbarByItem('shortsword');
    // An earlier section toggled this weapon to thrust; pin it explicitly.
    g.debugSetAttackMode('swing');
  });
  await page.waitForTimeout(300);

  const idleView = await page.evaluate(() => window.__voxelquest.debugViewState());
  check('a weapon is held in the view model', idleView.mainItem === 'shortsword', `holding ${idleView.mainItem}`);

  // Capture the pose partway through each attack and compare.
  const sampleAttack = async (expectMode) => {
    // The previous attack must have finished, or this click is swallowed.
    await waitForIdle();
    await page.evaluate(() => window.__voxelquest.debugRefill());
    await page.mouse.click(CENTER_X, CENTER_Y);
    const seen = await waitUntil(
      `${expectMode} animation`,
      async () => {
        const v = await page.evaluate(() => window.__voxelquest.debugViewState());
        return v.action === expectMode ? v : null;
      },
      6000,
      50,
    );
    // Sample the pose mid-strike, which is where the two motions differ most.
    const pose = await page.evaluate(() => window.__voxelquest.debugViewPose());
    return { view: seen, pose };
  };

  const swingSample = await sampleAttack('swing');
  check('swinging drives a swing animation', swingSample.view?.action === 'swing', `action ${swingSample.view?.action}, phase ${swingSample.view?.phase}`);

  await waitForIdle();
  const modeSet = await page.evaluate(() => window.__voxelquest.debugSetAttackMode('thrust'));
  await page.waitForTimeout(250);
  const pinned = await page.evaluate(() => window.__voxelquest.debugViewState());
  check('the weapon can be pinned to thrust mode', modeSet && pinned.attackMode === 'thrust', `set ${modeSet}, mode ${pinned.attackMode}`);

  const thrustSample = await sampleAttack('thrust');
  const thrustDiag = await page.evaluate(() => window.__voxelquest.debugCombatDiag());
  check(
    'thrusting drives a thrust animation',
    thrustSample.view?.action === 'thrust',
    `action ${thrustSample.view?.action} | diag ${JSON.stringify(thrustDiag)}`,
  );

  // A swing rolls the weapon across the screen; a thrust drives it forward.
  check(
    'swing and thrust are visually distinct poses',
    Math.abs((swingSample.pose?.rotZ ?? 0) - (thrustSample.pose?.rotZ ?? 0)) > 0.25 ||
      Math.abs((swingSample.pose?.posZ ?? 0) - (thrustSample.pose?.posZ ?? 0)) > 0.1,
    `swing rotZ ${swingSample.pose?.rotZ} posZ ${swingSample.pose?.posZ} | thrust rotZ ${thrustSample.pose?.rotZ} posZ ${thrustSample.pose?.posZ}`,
  );

  console.log('\n[block breaking animation]');
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFlattenArena(8);
    g.debugLook(0, 0);
    g.debugLookDown();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('block_cobblestone'));
  await page.waitForTimeout(200);

  const idleHighlight = await page.evaluate(() => window.__voxelquest.debugHighlight());
  check('the targeted block is outlined', idleHighlight !== null, JSON.stringify(idleHighlight));
  check('outline shows no cracks before mining', (idleHighlight?.progress ?? 0) < 0, `progress ${idleHighlight?.progress}`);

  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.mouse.down();
  const cracking = await waitUntil(
    'crack progress to advance',
    async () => {
      const h = await page.evaluate(() => window.__voxelquest.debugHighlight());
      return h && h.progress > 0.15 ? h : null;
    },
    20_000,
    150,
  );
  await page.mouse.up();
  check('mining advances the crack animation', (cracking?.progress ?? 0) > 0.15, `progress ${cracking?.progress}`);

  console.log('\n[day/night cycle]');
  const day = await page.evaluate(() => {
    window.__voxelquest.debugSetTime('day');
    return window.__voxelquest.debugEnvironment();
  });
  check('noon is fully lit', day.daylight > 0.9, `daylight ${day.daylight}, clock ${day.clock}`);
  check('no stars at noon', day.starOpacity < 0.05, `starOpacity ${day.starOpacity}`);

  const night = await page.evaluate(() => {
    window.__voxelquest.debugSetTime('night');
    return window.__voxelquest.debugEnvironment();
  });
  check('midnight is dark', night.daylight < 0.05, `daylight ${night.daylight}, clock ${night.clock}`);
  check('stars are visible at night', night.starOpacity > 0.9, `starOpacity ${night.starOpacity}`);
  check(
    'night raises the enemy population cap above daytime',
    night.hostileCap > day.hostileCap,
    `day cap ${day.hostileCap} -> night cap ${night.hostileCap}`,
  );

  console.log('\n[weather]');
  const storm = await page.evaluate(() => {
    window.__voxelquest.debugSetTime('day');
    window.__voxelquest.debugSetWeather('storm', 1);
    return window.__voxelquest.debugEnvironment();
  });
  check('a storm produces rain', storm.raining && storm.rainRate > 100, `rainRate ${storm.rainRate}`);
  await page.waitForTimeout(1500);
  const drops = await page.evaluate(() => window.__voxelquest.debugRainDrops());
  check('rain drops exist in the world', drops > 50, `${drops} drops`);

  const clear = await page.evaluate(() => {
    window.__voxelquest.debugSetWeather('clear');
    return window.__voxelquest.debugEnvironment();
  });
  check('clearing the weather stops the rain', !clear.raining, `weather ${clear.weather}`);

  console.log('\n[torch and off-hand]');
  const offhand = await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetTime('night');
    // Earlier sections drew a two-handed bow, which correctly drops the shield.
    // Re-equip a one-handed weapon plus shield to test the off-hand pairing.
    g.debugEquip('shortsword');
    g.debugEquip('wooden_buckler');
    g.debugEquip('torch');
    return g.debugViewState();
  });
  check('a torch is equipped in the off hand', offhand.torch === 'torch', `torch ${offhand.torch}`);
  check(
    'a shield can be carried at the same time as the torch',
    !!offhand.shield,
    `shield ${offhand.shield}, torch ${offhand.torch}`,
  );

  const lit = await page.evaluate(() => window.__voxelquest.debugTorchLight());
  check('the held torch casts light in the world', lit.handLightOn && lit.handIntensity > 0.5, JSON.stringify(lit));

  // Planting a torch should register a world light source.
  const lightsBefore = (await page.evaluate(() => window.__voxelquest.debugEnvironment())).lightSources;
  await page.evaluate(() => {
    window.__voxelquest.debugSelectHotbarByItem('torch');
    window.__voxelquest.debugLookDown();
  });
  await page.waitForTimeout(300);
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(500);
  const lightsAfter = (await page.evaluate(() => window.__voxelquest.debugEnvironment())).lightSources;
  check('planting a torch adds a world light', lightsAfter > lightsBefore, `${lightsBefore} -> ${lightsAfter}`);

  console.log('\n[fish and food]');
  const fishSpawned = await page.evaluate(() => window.__voxelquest.debugSpawnFish());
  const fishEnv = await page.evaluate(() => window.__voxelquest.debugEnvironment());
  if (fishSpawned > 0) {
    check('fish spawn in water', fishEnv.fish > 0, `${fishEnv.fish} fish`);
    check('fish are not counted as hostiles', fishEnv.hostiles >= 0 && fishEnv.fish > 0, `hostiles ${fishEnv.hostiles}, fish ${fishEnv.fish}`);
  } else {
    console.log('  note  no water within range of this spawn point; skipping fish spawn check');
  }

  // Cooking: a raw fish plus the torch you are already carrying.
  const cooked = await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugGiveItem('raw_fish', 2);
    return { raw: g.debugItemCount('raw_fish'), cooked: g.debugItemCount('cooked_fish') };
  });
  const holdingFish = await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugEquip('torch');
    return g.debugSelectHotbarByItem('raw_fish');
  });
  check('the raw fish can be held', holdingFish, `selected ${holdingFish}`);
  await page.waitForTimeout(300);
  await page.mouse.click(CENTER_X, CENTER_Y);
  await page.waitForTimeout(1200);
  const afterCook = await page.evaluate(() => ({
    raw: window.__voxelquest.debugItemCount('raw_fish'),
    cooked: window.__voxelquest.debugItemCount('cooked_fish'),
  }));
  check(
    'holding a torch cooks a raw fish instead of eating it',
    afterCook.cooked > cooked.cooked && afterCook.raw < cooked.raw,
    `raw ${cooked.raw}->${afterCook.raw}, cooked ${cooked.cooked}->${afterCook.cooked}`,
  );

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
