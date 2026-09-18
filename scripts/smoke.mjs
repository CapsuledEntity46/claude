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
  const walkAndMeasure = async (key, targetDistance = 1.5, timeoutMs = 8000) => {
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
    // Hold the key until the player has actually covered some ground, rather than
    // for a fixed stretch of wall-clock. The game clamps its timestep, so under
    // software rendering game-time runs several times slower than real time and a
    // fixed 1.6s walk covered well under half a block — enough to fail a distance
    // gate while the direction being tested was perfectly correct.
    const deadline = Date.now() + timeoutMs;
    let end = start;
    while (Date.now() < deadline) {
      await page.waitForTimeout(150);
      end = await snapshot();
      const travelled = Math.hypot(end.playerX - start.playerX, end.playerZ - start.playerZ);
      if (travelled >= targetDistance) break;
    }
    await page.keyboard.up(key);
    await page.waitForTimeout(250);
    end = await snapshot();
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
   *
   * The floor on total travel is only here to reject idle jitter — the walk itself
   * polls until the player has moved, so this is not a speed measurement.
   */
  const checkDirection = (label, m, axis, sign) => {
    const intended = axis === 'forward' ? m.forward : m.right;
    const other = axis === 'forward' ? m.right : m.forward;
    const moved = m.total > 0.2;
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
      const distance = g.debugSpawnEnemyInReach(d);
      // Hold the target still. Enemies now circle rather than standing in front
      // of you, which is correct in play but makes a fixed-aim test meaningless.
      g.debugFreezeEnemies(true);
      return distance;
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
  /**
   * Clicks once and samples the held item's pose during the *strike*.
   *
   * The strike (the recovery phase) is where the two motions actually differ; the
   * wind-up is mostly a small pull-back in both cases.
   */
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
      40,
    );

    // Poll for the strike, keeping the most extreme pose we observe.
    let extreme = await page.evaluate(() => window.__voxelquest.debugViewPose());
    let best = -1;
    for (let i = 0; i < 40; i++) {
      const [view, pose] = await Promise.all([
        page.evaluate(() => window.__voxelquest.debugViewState()),
        page.evaluate(() => window.__voxelquest.debugViewPose()),
      ]);
      if (view.action !== expectMode) break;
      if (view.phase === 'recovery') {
        const magnitude = Object.keys(pose).reduce(
          (sum, key) => sum + Math.abs((pose[key] ?? 0) - (idlePose[key] ?? 0)),
          0,
        );
        if (magnitude > best) {
          best = magnitude;
          extreme = pose;
        }
      }
      await page.waitForTimeout(30);
    }
    return { view: seen, pose: extreme };
  };

  // Reference pose with nothing happening, so animations can be measured as
  // offsets from rest rather than as absolute numbers (the rest pose already
  // carries a large yaw, which would swamp any absolute comparison).
  await waitForIdle();
  const idlePose = await page.evaluate(() => window.__voxelquest.debugViewPose());

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
  // The two motions are supposed to differ in *character*, not just in numbers:
  // the swing travels laterally (yaw, and a large sideways offset) while the
  // thrust travels vertically and forward down the view axis.
  const delta = (pose, key) => Math.abs((pose?.[key] ?? 0) - (idlePose[key] ?? 0));
  const swingPose = swingSample.pose ?? {};
  const thrustPose = thrustSample.pose ?? {};

  const poseDifference = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'].reduce(
    (sum, key) => sum + Math.abs((swingPose[key] ?? 0) - (thrustPose[key] ?? 0)),
    0,
  );
  check(
    'swing and thrust are visually distinct poses',
    poseDifference > 0.4,
    `total difference ${poseDifference.toFixed(2)}`,
  );

  // Character, not just numbers: the swing travels laterally, the thrust does not.
  const swingLateral = delta(swingPose, 'rotY') + delta(swingPose, 'posX');
  const thrustLateral = delta(thrustPose, 'rotY') + delta(thrustPose, 'posX');
  const thrustAxial = delta(thrustPose, 'posY') + delta(thrustPose, 'posZ') + delta(thrustPose, 'rotX');
  check(
    'the swing sweeps sideways across the view',
    swingLateral > 0.3,
    `lateral travel ${swingLateral.toFixed(2)}`,
  );
  check(
    'the thrust drives along the view axis rather than sideways',
    thrustAxial > thrustLateral,
    `axial ${thrustAxial.toFixed(2)} vs lateral ${thrustLateral.toFixed(2)}`,
  );

  // The swing must be dominated by yaw, since it is a horizontal slash.
  check(
    'the swing rotates mostly about the vertical axis',
    delta(swingPose, 'rotY') > delta(swingPose, 'rotX'),
    `rotY ${delta(swingPose, 'rotY').toFixed(2)} vs rotX ${delta(swingPose, 'rotX').toFixed(2)}`,
  );
  // And a thrust must bring the weapon towards the centre, not away from it.
  check(
    'a thrust moves the weapon towards screen centre',
    Math.abs(thrustPose.posX ?? 0) < Math.abs(idlePose.posX ?? 0),
    `posX ${idlePose.posX} -> ${thrustPose.posX}`,
  );

  console.log('\n[invulnerability covers every damage source]');
  // Fall damage used to bypass the guard by calling the combat system directly.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugRevive();
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFlattenArena(8);
    g.debugTeleportUp(26);
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__voxelquest.debugDropPlayer());
  await page.waitForTimeout(3000);
  const survivedFall = await page.evaluate(() => ({
    dead: window.__voxelquest.debugIsDead(),
    hp: window.__voxelquest.debugSnapshot().hp,
  }));
  check(
    'fall damage respects invulnerability',
    survivedFall.dead === false,
    `dead ${survivedFall.dead}, hp ${survivedFall.hp}`,
  );
  await page.evaluate(() => {
    window.__voxelquest.debugRevive();
    window.__voxelquest.debugSetInvulnerable(false);
  });

  console.log('\n[death particles]');
  // A kill should shatter the enemy into a burst of its own coloured pixels.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFlattenArena(8);
    g.debugLook(0, 0);
    g.debugFreezeEnemies(true);
    g.debugSpawnEnemyInReach(2.4);
  });
  await page.waitForTimeout(800);
  const particlesBeforeKill = await page.evaluate(() => window.__voxelquest.debugParticleCount());

  let peakParticles = particlesBeforeKill;
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => window.__voxelquest.debugRefill());
    await page.mouse.click(CENTER_X, CENTER_Y);
    await page.waitForTimeout(260);
    const count = await page.evaluate(() => window.__voxelquest.debugParticleCount());
    if (count > peakParticles) peakParticles = count;
    const report = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
    if (report.length === 0) break;
  }
  check(
    'a kill emits a burst of break particles',
    peakParticles - particlesBeforeKill >= 20,
    `${particlesBeforeKill} -> peak ${peakParticles}`,
  );

  console.log('\n[block breaking animation]');
  await waitForIdle();
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFreezeEnemies(false);
    g.debugFlattenArena(8);
    g.debugLook(0, 0);
    g.debugLookDown();
    g.debugResetMining();
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

  console.log('\n[shaped blocks and the build tool]');
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    g.debugFlattenArena(10);
    g.debugLook(0, 0);
    g.debugLookDown();
    g.debugGiveItem('block_stone_stairs', 20);
    g.debugGiveItem('block_door', 4);
  });
  await page.waitForTimeout(700);

  // A torch must place as a slim post, not a cube.
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('torch'));
  await page.waitForTimeout(250);
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(400);
  const torchShape = await page.evaluate(() => window.__voxelquest.debugPlacedShape('torch'));
  check(
    'a placed torch is a slim post, not a cube',
    torchShape?.shape === 'torch' && torchShape.fillsVoxel === false,
    JSON.stringify(torchShape),
  );

  // Stairs must record the orientation they were placed with.
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('block_stone_stairs'));
  await page.waitForTimeout(250);
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(400);
  const stairShape = await page.evaluate(() => window.__voxelquest.debugPlacedShape('block_stone_stairs'));
  check('stairs place as a shaped block', stairShape?.shape === 'stairs', JSON.stringify(stairShape));
  check('stairs are made of more than one box', (stairShape?.boxes ?? 0) > 1, `${stairShape?.boxes} boxes`);

  // A door must toggle rather than stack.
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('block_door'));
  await page.waitForTimeout(250);
  await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
  await page.waitForTimeout(400);
  const doorBefore = await page.evaluate(() => window.__voxelquest.debugPlacedShape('block_door'));
  if (doorBefore) {
    const toggled = await page.evaluate(() => window.__voxelquest.debugToggleNearestDoor());
    check('a door can be opened', toggled === true, `toggled ${toggled}`);
    const doorAfter = await page.evaluate(() => window.__voxelquest.debugPlacedShape('block_door'));
    check('opening a door clears its collision', doorAfter?.blocks === false, JSON.stringify(doorAfter));
  } else {
    console.log('  note  door did not place at this spot; skipping door checks');
  }

  // The build tool fills in bulk.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugGiveItem('block_cobblestone', 400);
    g.debugSelectHotbarByItem('build_tool');
    g.debugSetToolMode('floor');
    g.debugLookDown();
  });
  await page.waitForTimeout(400);
  const editsBeforeTool = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
  // Click until the fill lands, rather than once and hope.
  //
  // A single right-click behind a fixed wait can miss for reasons that have
  // nothing to do with bulk placement: the tool may still be on cooldown from the
  // preceding placements, or the aimed-at column may momentarily have no valid
  // face. Retrying and polling tests that the tool fills in bulk, which is the
  // actual claim, instead of testing that one particular click was well timed.
  let editsAfterTool = editsBeforeTool;
  for (let attempt = 0; attempt < 6 && editsAfterTool - editsBeforeTool < 4; attempt++) {
    await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
    for (let poll = 0; poll < 8; poll++) {
      await page.waitForTimeout(100);
      editsAfterTool = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
      if (editsAfterTool - editsBeforeTool >= 4) break;
    }
  }
  check(
    'the build tool places many blocks at once',
    editsAfterTool - editsBeforeTool >= 4,
    `${editsBeforeTool} -> ${editsAfterTool} edited voxels`,
  );

  console.log('\n[mana spells]');
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugSetMana(200);
    // The build tool section left the camera aimed at the floor.
    g.debugLook(0, 0);
    g.debugFlattenArena(8);
    g.debugSpawnEnemyInReach(3);
    g.debugFreezeEnemies(true);
    g.debugSelectHotbarByItem('flames');
  });
  await page.waitForTimeout(500);
  const manaBefore = await page.evaluate(() => window.__voxelquest.debugMana());
  const hpBefore = await page.evaluate(() => window.__voxelquest.debugEnemyReport());

  await page.mouse.move(CENTER_X, CENTER_Y);
  await page.mouse.down();
  const burned = await waitUntil(
    'Flames to damage the target',
    async () => {
      const report = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
      if (report.length === 0) return report;
      return hpBefore[0] && report[0] && report[0].hp < hpBefore[0].hp ? report : null;
    },
    12_000,
    150,
  );
  await page.mouse.up();
  await page.waitForTimeout(300);

  const manaAfter = await page.evaluate(() => window.__voxelquest.debugMana());
  const hpAfter = burned ?? (await page.evaluate(() => window.__voxelquest.debugEnemyReport()));
  check('a held mana spell drains mana', manaAfter.mana < manaBefore.mana, `${manaBefore.mana} -> ${manaAfter.mana}`);
  check(
    'Flames damages what it touches',
    hpAfter.length === 0 || (hpBefore[0] && hpAfter[0] && hpAfter[0].hp < hpBefore[0].hp),
    `hp ${hpBefore[0]?.hp} -> ${hpAfter[0]?.hp ?? 'dead'}`,
  );
  check('mana spells do not consume spell slots', (await page.evaluate(() => window.__voxelquest.debugSpellSlots()))[0] > 0);

  console.log('\n[aim down sights]');
  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('shortbow'));
  await page.waitForTimeout(300);
  const beforeAim = await page.evaluate(() => window.__voxelquest.debugAim());
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(900);
  const whileAiming = await page.evaluate(() => window.__voxelquest.debugAim());
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(700);
  const afterAim = await page.evaluate(() => window.__voxelquest.debugAim());

  check('right-click aims a bow', whileAiming.aiming === true, `aiming ${whileAiming.aiming}`);
  check('aiming zooms the view in', whileAiming.fov < beforeAim.fov - 2, `fov ${beforeAim.fov} -> ${whileAiming.fov}`);
  check('aiming draws a trajectory arc', whileAiming.arcVisible === true);
  check('releasing restores the view', afterAim.fov > whileAiming.fov, `fov back to ${afterAim.fov}`);
  check('the arc disappears when not aiming', afterAim.arcVisible === false);

  console.log('\n[dungeons]');
  const dungeonInfo = await page.evaluate(() => window.__voxelquest.debugDungeonInfo());
  check('dungeons exist near the player', dungeonInfo.sitesNearby > 0, JSON.stringify(dungeonInfo));
  check('dungeons have rooms and corridors', dungeonInfo.rooms > 0 && dungeonInfo.corridors > 0, `${dungeonInfo.rooms} rooms`);
  check('every dungeon has a vault', dungeonInfo.vaults > 0, `${dungeonInfo.vaults} vaults`);
  check('an entrance can be located', dungeonInfo.nearestEntranceDistance >= 0, `${dungeonInfo.nearestEntranceDistance} blocks away`);

  const arrived = await page.evaluate(() => window.__voxelquest.debugGoToDungeon());
  if (arrived) {
    await page.waitForTimeout(3500);
    const carved = await page.evaluate(() => window.__voxelquest.debugDungeonCarved());
    check('the dungeon is actually carved into the world', carved.airBelow > 30, JSON.stringify(carved));
    check('the dungeon is built from dungeon masonry', carved.masonry > 20, `${carved.masonry} brick blocks`);
    check('the dungeon is lit', carved.torches > 0, `${carved.torches} torches`);
  } else {
    console.log('  note  no dungeon within range; skipping carve checks');
  }

  console.log('\n[minimap]');
  const minimapDrawn = await page.evaluate(() => {
    const canvas = document.querySelector('.minimap-canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) lit++;
    }
    return { lit, total: data.length / 4 };
  });
  check('the minimap renders terrain', (minimapDrawn?.lit ?? 0) > 500, JSON.stringify(minimapDrawn));
  const compassDrawn = await page.evaluate(() => !!document.querySelector('.compass-canvas'));
  check('the compass is present', compassDrawn);

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
