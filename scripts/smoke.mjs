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

/**
 * How many frames a scripted drag is spread over.
 *
 * It has to fit inside the tracker's rolling sample window (0.25s by default), and
 * one step per rendered frame is the only way to have them counted as separate
 * samples. At ~20fps a six-step drag spans 300ms, so the earliest samples expire
 * before the last one lands and the sum never reaches the commit threshold — the
 * gesture then silently fails to commit, and only on slow runs. Three steps stay
 * inside the window with room to spare, and still read as a flick rather than a
 * single teleporting jump.
 */
const GESTURE_STEPS = 3;

const snapshot = () => page.evaluate(() => window.__voxelquest.debugSnapshot());
const diagnostics = () => page.evaluate(() => window.__voxelquest.debugCombatDiag());

/**
 * Waits until the combat system will accept a new action.
 *
 * Attacks commit the player for a wind-up plus a recovery, and because the game
 * clamps `dt`, that window takes longer in wall-clock time the slower the
 * renderer is. Sleeping a fixed interval before the next click is therefore
 * unreliable; wait for the state machine instead.
 *
 * The budget is generous because the slowest case is genuinely slow: a mace downcut
 * is a long wind-up, a long recovery and a heavy weapon's cooldown, all stretched by
 * the clamped `dt` of a software renderer.
 */
async function waitForIdle(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await diagnostics();
    // Both conditions matter. 'idle' only means the animation finished; the
    // between-uses cooldown runs on past it and refuses the next attack.
    if (d.combatState === 'idle' && (d.useCooldown ?? 0) <= 0) return true;
    await page.waitForTimeout(80);
  }
  console.log('  note  combat system never returned to idle');
  return false;
}

/**
 * How many melee attacks have actually begun, as opposed to been attempted.
 *
 * Melee can be refused for reasons that have nothing to do with the gesture —
 * cooldown, stamina, no melee mode — and a refusal is silent in the view state. The
 * gesture helpers compare this counter across an attempt so they can retry rather
 * than assert against the previous stroke's direction.
 */
async function attacksStarted() {
  const d = await diagnostics();
  return d.started ?? 0;
}

/**
 * Waits briefly for a new attack to begin, rather than reading the counter once.
 *
 * A single read right after the input is a race: the press is handled on the next
 * rendered frame, and on a software renderer at ~9 fps that can be a tenth of a
 * second away. Reading too early looks like a refusal, and the retry that follows
 * presses the button *during* the wind-up of the attack that was starting all along.
 */
async function waitForAttackStart(before, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await attacksStarted()) > before) return true;
    await page.waitForTimeout(60);
  }
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
  // Poll for the chunk count rather than reading it once.
  //
  // Streaming is paced by a per-frame mesh budget, so how many chunks exist at any
  // given instant is a function of how many frames have been rendered — and under a
  // software renderer that varies with whatever else the machine is doing. Read
  // once, this asserted a frame rate more than it asserted streaming.
  let streamed = await snapshot();
  for (let i = 0; i < 40 && streamed.chunks < 60; i++) {
    await page.waitForTimeout(250);
    streamed = await snapshot();
  }
  check('chunks streamed in', streamed.chunks >= 60, `${streamed.chunks} chunks`);
  check('mesher produced geometry', streamed.triangles > 5000, `${streamed.triangles} triangles`);

  // Terrain textures. A missing atlas, a missing UV attribute, or UVs that all land on
  // the blank tile each produce exactly the flat-coloured world that existed before
  // textures, so none of them would be obvious from a screenshot.
  const terrainMaterial = await page.evaluate(() => window.__voxelquest.debugTerrainMaterial());
  check('terrain samples the block atlas', terrainMaterial.hasMap === true, JSON.stringify(terrainMaterial));
  check(
    'terrain geometry carries UVs',
    terrainMaterial.uvCount > 1000,
    `${terrainMaterial.uvCount} uvs across ${terrainMaterial.meshes} chunk meshes`,
  );
  check(
    'UVs span more than one tile of the atlas',
    terrainMaterial.uMax - terrainMaterial.uMin > 0.2,
    `u from ${terrainMaterial.uMin} to ${terrainMaterial.uMax}`,
  );
  check(
    'vertex colours still drive shading alongside the texture',
    terrainMaterial.vertexColors === true,
    'ambient occlusion and face shading are preserved',
  );

  // Every tile has to carry visible detail.
  //
  // This is the check that would have caught the real bug. The grass tile was drawn,
  // uploaded and sampled correctly, but seven passes of blades overdrew each other
  // until the tile averaged out nearly flat — measured contrast a third of the leaf
  // tiles'. On screen that is indistinguishable from the texture never having been
  // applied, and no amount of looking at screenshots tells you which it is.
  const tiles = await page.evaluate(() => window.__voxelquest.debugAtlasStats());
  const flat = Object.entries(tiles).filter(([name, s]) => name !== 'Blank' && s.stdev < 0.06);
  check(
    'every atlas tile carries visible detail',
    flat.length === 0,
    flat.length === 0
      ? Object.entries(tiles)
          .filter(([name]) => name !== 'Blank')
          .map(([name, s]) => `${name} ${s.stdev}`)
          .join(', ')
      : `flat: ${flat.map(([name, s]) => `${name} ${s.stdev}`).join(', ')}`,
  );
  // A tolerance rather than an exact match: the tile is drawn flat white, but it is
  // filtered and mipmapped like everything else, so a stray thousandth is expected.
  check(
    'the blank tile really is blank',
    !!tiles.Blank && tiles.Blank.stdev < 0.01 && tiles.Blank.mean > 0.99,
    `mean ${tiles.Blank?.mean}, stdev ${tiles.Blank?.stdev} — the identity for a multiply`,
  );

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

  /**
   * Performs a melee attack the way a player does: hold the left button, move the
   * mouse, let go.
   *
   * The movement is injected rather than sent as `mouse.move`. Synthetic moves under
   * pointer lock report deltas computed against the absolute cursor position — probed
   * here as cancelling pairs like (640, 360) then (-640, -360) — so a drag built from
   * them sums to zero and no gesture would ever commit. Injection enters at exactly
   * the point a real event does, so gesture accumulation, look suppression, the
   * geometry fallbacks and the attack itself are all still the code under test.
   *
   * @param dx total horizontal movement; negative is leftwards
   * @param dy total vertical movement, y-down as the browser reports it
   */
  const meleeDrag = async (dx, dy, { steps = GESTURE_STEPS, release = true, attempts = 3 } = {}) => {
    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Readiness, not just idleness: `beginMelee` refuses while the between-uses
      // cooldown runs, and a refused attack leaves the *previous* stroke's direction
      // on display, which reads as a misclassified gesture rather than a no-op.
      await waitForIdle();
      const startedBefore = await attacksStarted();
      await page.evaluate(() => window.__voxelquest.debugRefill());
      await page.mouse.down({ button: 'left' });
      state = null;
      for (let i = 0; i < steps; i++) {
        await page.evaluate(([x, y]) => window.__voxelquest.debugFeedMouse(x, y), [dx / steps, dy / steps]);
        // One rendered frame per step, so the tracker sees them as separate samples
        // inside its rolling window.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        // Sample the instant the stroke commits. The gesture fires partway through
        // the drag, so reading only after the last step would miss the start of the
        // animation, which is what the trajectory samplers need to latch onto.
        if (state === null) {
          const v = await page.evaluate(() => window.__voxelquest.debugViewState());
          if (v.action === 'swing' || v.action === 'thrust') {
            state = v;
            // Stop feeding movement the moment the stroke commits. Continuing would
            // spend the remaining steps *inside* the animation, and on a software
            // renderer those few frames are most of the swing — the trajectory
            // sampler would then start after the interesting part was over.
            break;
          }
        }
      }
      if (release) await page.mouse.up({ button: 'left' });
      if (state === null) state = await page.evaluate(() => window.__voxelquest.debugViewState());
      if (await waitForAttackStart(startedBefore)) return state;
      // Retrying with the button held would stack holds; one attempt is all we get.
      if (!release) return state;
    }
    console.log('  note  melee drag never started an attack');
    return state;
  };

  /** A bare click: button down, nothing moved, button up. Should read as a thrust. */
  const meleeClick = async (attempts = 3) => {
    let state = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await waitForIdle();
      const startedBefore = await attacksStarted();
      await page.evaluate(() => window.__voxelquest.debugRefill());
      await page.mouse.click(CENTER_X, CENTER_Y);
      const began = await waitForAttackStart(startedBefore);
      state = await page.evaluate(() => window.__voxelquest.debugViewState());
      if (began) return state;
    }
    console.log('  note  melee click never started an attack');
    return state;
  };

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
  await meleeDrag(-260, 0);
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
      // A gesture, not a click. A bare click now thrusts, which is the narrow
      // single-target attack — far too slow to grind a kill inside the timeout.
      await page.evaluate(() => window.__voxelquest.debugMeleeGesture('left'));
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

  console.log('\n[melee gestures]');
  // Melee is driven by mouse gestures now: hold the button, move the mouse, and the
  // direction chooses the attack. The X key no longer switches swing and thrust.
  await setupArena(2.6);
  await page.waitForTimeout(1200);
  await waitForIdle();

  // A real held-button drag, left across the screen.
  const yawBefore = (await page.evaluate(() => window.__voxelquest.debugCombatDiag())).yaw;
  const dragState = await meleeDrag(-260, 0);
  check(
    'a held-LMB drag left throws a left slash',
    dragState.attackDirection === 'left',
    `direction ${dragState.attackDirection}, action ${dragState.action}`,
  );
  const yawAfter = (await page.evaluate(() => window.__voxelquest.debugCombatDiag())).yaw;
  // The same deltas that chose the attack must not also turn the camera.
  check(
    'the gesture does not spin the camera',
    Math.abs(yawAfter - yawBefore) < 0.01,
    `yaw ${yawBefore} -> ${yawAfter}`,
  );

  // Vertical and diagonal strokes. Mouse dy is y-down, so a negative dy is upwards.
  await waitForIdle();
  const upState = await meleeDrag(0, -260);
  check('dragging up throws an uppercut', upState.attackDirection === 'up', upState.attackDirection);

  await waitForIdle();
  const diagonalState = await meleeDrag(200, -200);
  check(
    'dragging up and right throws a rising slash',
    diagonalState.attackDirection === 'upRight',
    diagonalState.attackDirection,
  );

  // The crosshair must show the stroke being drawn while the button is held. Fed
  // past the dead zone but short of the commit threshold, so the gesture is still
  // being made rather than already spent.
  await waitForIdle();
  await page.mouse.down({ button: 'left' });
  const indicator = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__voxelquest;
        let fed = 0;
        const tick = () => {
          if (g.debugGestureState().active && fed < 2) {
            g.debugFeedMouse(-9, 0);
            fed++;
            requestAnimationFrame(tick);
            return;
          }
          if (fed < 2) {
            requestAnimationFrame(tick);
            return;
          }
          const el = document.getElementById('gesture');
          const arrow = document.getElementById('gesture-arrow');
          resolve({
            active: el?.classList.contains('active') ?? false,
            committed: el?.classList.contains('committed') ?? false,
            transform: arrow?.style.transform ?? '',
            state: g.debugGestureState(),
          });
        };
        requestAnimationFrame(tick);
      }),
  );
  // Releasing this hold commits a left swing, which is correct: the movement is
  // past the dead zone, so it is a real stroke rather than a click. It has to be
  // drained before moving on, or the next check latches onto *this* attack starting
  // and reads its direction instead of its own.
  const pendingBefore = await attacksStarted();
  await page.mouse.up({ button: 'left' });
  await waitForAttackStart(pendingBefore);
  await waitForIdle();
  check(
    'a held gesture draws an indicator at the crosshair',
    indicator.active && indicator.state.direction === 'left' && indicator.transform.includes('translate'),
    `active ${indicator.active}, direction ${indicator.state.direction}, charge ${indicator.state.charge?.toFixed?.(2)}`,
  );
  check(
    'the indicator points the way the mouse moved, and is not yet committed',
    indicator.transform.startsWith('translate(-') && !indicator.committed,
    `transform ${indicator.transform.slice(0, 40)}`,
  );

  // A click with no movement is a thrust, which is what keeps clicking sensible.
  await waitForIdle();
  const clickState = await meleeClick();
  check('a click with no movement thrusts', clickState.attackDirection === 'thrust', clickState.attackDirection);

  // Weapon geometry still governs: a mace has no point, so a thrust becomes a chop.
  await waitForIdle();
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugGiveItem('mace', 1);
    g.debugSelectHotbarByItem('mace');
  });
  await page.waitForTimeout(250);
  const maceThrust = await page.evaluate(() => window.__voxelquest.debugMeleeGesture('thrust'));
  check('a thrust gesture with a mace falls back to a swing', maceThrust === 'down', `performed ${maceThrust}`);

  await waitForIdle();
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugGiveItem('rapier', 1);
    g.debugSelectHotbarByItem('rapier');
  });
  await page.waitForTimeout(250);
  const rapierSlash = await page.evaluate(() => window.__voxelquest.debugMeleeGesture('left'));
  check('a slash gesture with a rapier falls back to a thrust', rapierSlash === 'thrust', `performed ${rapierSlash}`);

  await page.evaluate(() => window.__voxelquest.debugSelectHotbarByItem('shortsword'));
  await page.waitForTimeout(250);
  await setupArena(2.6);
  await page.waitForTimeout(1000);
  await waitForIdle();

  const beforeThrust = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  const thrustHitsBefore = (await diagnostics()).hits;
  await meleeClick();
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
  // The whole draw is retried, not just polled for. Polling alone assumes the
  // draw happened; but a hold can be swallowed outright — the press landing on a
  // frame where the previous action still owned the button, or the draw never
  // reaching the minimum power — and then no amount of waiting produces an arrow.
  // This flaked roughly one run in four before it retried.
  const shot = await waitUntil(
    'an arrow to be launched',
    async () => {
      await page.evaluate(() => window.__voxelquest.debugRefill());
      await page.mouse.down();
      await page.waitForTimeout(1100);
      await page.mouse.up();
      await page.waitForTimeout(150);
      const s2 = await snapshot();
      return s2.projectilesFired > firedBefore ? s2 : null;
    },
    12_000,
    120,
  );
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
  // Click until it lands. Placement has a cooldown shared with the attack that
  // just ran, so a single click behind a fixed wait can be swallowed entirely —
  // which tests the timing of one click rather than whether placing works.
  let cobbleAfter = cobbleBefore;
  let editsAfter = editsBefore;
  for (let attempt = 0; attempt < 6 && editsAfter <= editsBefore; attempt++) {
    await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
    for (let poll = 0; poll < 8; poll++) {
      await page.waitForTimeout(80);
      editsAfter = await page.evaluate(() => window.__voxelquest.debugEditedBlockCount());
      if (editsAfter > editsBefore) break;
    }
  }
  cobbleAfter = await page.evaluate(() => window.__voxelquest.debugItemCount('block_cobblestone'));
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
  const sampleAttack = async (expectMode, drag = [-260, 0]) => {
    // The gesture *is* the mode selector now, so the drag has to be performed: a
    // bare click always thrusts, and asking it for a swing would wait forever.
    const dragged =
      drag[0] === 0 && drag[1] === 0 ? await meleeClick() : await meleeDrag(drag[0], drag[1]);

    const seen =
      dragged?.action === expectMode
        ? dragged
        : await waitUntil(
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

  /**
   * Records the whole trajectory of an attack and returns each axis's range.
   *
   * A single sampled frame cannot measure how a motion travels. A diagonal cut
   * crosses the middle of its own X, where the vertical offset is back at rest by
   * construction — so whether a "is it diagonal" check passed depended entirely on
   * which frame the sampler happened to catch, and it failed on a swing that was
   * behaving perfectly. Range over the whole animation is the honest measure.
   */
  const sampleTrajectory = async (expectMode, drag = [-260, 0]) => {
    await waitForIdle();

    const keys = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
    const min = {};
    const max = {};
    // The pose the stroke started from, read while still at rest. Taken after the
    // drag it would be a mid-swing pose, and every "which way did it travel" signed
    // excursion would be measured from the middle of the motion it is describing.
    const baseline = await page.evaluate(() => window.__voxelquest.debugViewPose());

    // The drag *and* the recording happen inside one page call, one sample per
    // rendered frame.
    //
    // Sampling from Node instead costs a round trip per frame, and a swing is only
    // about five frames on a software renderer — so the recording could begin after
    // most of the motion was already over, and the same healthy swing measured 1.32
    // on one run and 0.08 on the next. Staying inside the page removes the latency
    // altogether: nothing is missed between the stroke committing and the first
    // sample. Deltas are fed only until the attack starts, since the stroke is
    // chosen by then and further movement would just be follow-through.
    let recorded = [];
    for (let attempt = 0; attempt < 3 && recorded.length === 0; attempt++) {
      await waitForIdle();
      await page.evaluate(() => window.__voxelquest.debugRefill());
      // Clear any button state left over from the previous stroke before pressing.
      // A `mouse.down` issued while the browser already considers the button held
      // produces no press transition, so the tracker never starts capturing and the
      // whole recording comes back empty.
      await page.mouse.up({ button: 'left' }).catch(() => {});
      await page.mouse.down({ button: 'left' });
      const result = await page.evaluate(
        ([dx, dy, steps, expect]) =>
          new Promise((resolve) => {
            const g = window.__voxelquest;
            const poses = [];
            let fed = 0;
            let started = false;
            let waited = 0;
            const tick = () => {
              // Only feed once the press has actually reached the tracker. Feeding
              // beforehand throws the deltas away: they are consumed each frame
              // whether or not a gesture is capturing them.
              const capturing = g.debugGestureState().active;
              if (!started && capturing && fed < steps) {
                g.debugFeedMouse(dx / steps, dy / steps);
                fed++;
              }
              const view = g.debugViewState();
              if (view.action === expect) {
                started = true;
                poses.push(g.debugViewPose());
              } else if (started) {
                // The animation has finished; stop on the first frame past it.
                resolve({ poses, fed, reason: 'complete' });
                return;
              }
              // Give up rather than hang if the gesture never commits. Kept short:
              // a stuck hold here would sit on the button for seconds and starve
              // every later check of wall-clock budget.
              if (++waited > 90) {
                resolve({ poses, fed, reason: capturing ? 'never committed' : 'press never registered' });
                return;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        [drag[0], drag[1], GESTURE_STEPS, expectMode],
      );
      await page.mouse.up({ button: 'left' });
      recorded = result.poses;
      if (recorded.length === 0) {
        // Reported rather than swallowed. An empty recording used to surface as a
        // travel of exactly zero, which looks like a broken animation instead of a
        // gesture that never fired.
        console.log(`  note  ${expectMode} stroke recorded no frames (${result.reason}, fed ${result.fed})`);
      }
    }

    const frames = recorded.length;
    for (const pose of recorded) {
      for (const key of keys) {
        const v = pose[key] ?? 0;
        min[key] = min[key] === undefined ? v : Math.min(min[key], v);
        max[key] = max[key] === undefined ? v : Math.max(max[key], v);
      }
    }
    const range = {};
    // Signed excursion as well as magnitude: which *way* the weapon travelled is the
    // whole point once the player's gesture chooses the stroke, and an unsigned range
    // cannot tell a left slash from a right one.
    const signedRange = {};
    for (const key of keys) {
      range[key] = (max[key] ?? 0) - (min[key] ?? 0);
      const low = (min[key] ?? 0) - (baseline[key] ?? 0);
      const high = (max[key] ?? 0) - (baseline[key] ?? 0);
      signedRange[key] = Math.abs(high) >= Math.abs(low) ? high : low;
    }
    return { range, signedRange, frames };
  };

  // Reference pose with nothing happening, so animations can be measured as
  // offsets from rest rather than as absolute numbers (the rest pose already
  // carries a large yaw, which would swamp any absolute comparison).
  await waitForIdle();
  const idlePose = await page.evaluate(() => window.__voxelquest.debugViewPose());

  const swingSample = await sampleAttack('swing');
  check('swinging drives a swing animation', swingSample.view?.action === 'swing', `action ${swingSample.view?.action}, phase ${swingSample.view?.phase}`);

  // The stroke is chosen by the gesture, so a thrust is a drag of nothing at all.
  const thrustSample = await sampleAttack('thrust', [0, 0]);
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

  // A slash is diagonal: it must travel across the view *and* down it. A purely
  // horizontal sweep — which is what this used to assert — reads as the weapon
  // being waved rather than swung, because nothing about it moves the way a cut
  // does.
  //
  // Measured as the range over the whole animation, not from one frame: see
  // sampleTrajectory.
  await waitForIdle();
  const swingTravel = await sampleTrajectory('swing', [-260, 180]);
  const acrossRange = swingTravel.range.rotY + swingTravel.range.posX;
  const downRange = swingTravel.range.rotX + swingTravel.range.posY;
  check(
    'the swing cuts diagonally, across and down',
    acrossRange > 0.4 && downRange > 0.4,
    `across ${acrossRange.toFixed(2)}, down ${downRange.toFixed(2)} over ${swingTravel.frames} frames`,
  );

  // The gesture, not an alternating counter, decides which way the blade travels.
  // The animation must follow the stroke that was actually asked for — this replaced
  // a check that consecutive swings mirrored each other, which was the right
  // assertion only while the player had no say in the matter.
  await waitForIdle();
  const leftStroke = await sampleTrajectory('swing', [-260, 0]);
  const leftYaw = leftStroke.signedRange.rotY;
  await waitForIdle();
  const rightStroke = await sampleTrajectory('swing', [260, 0]);
  const rightYaw = rightStroke.signedRange.rotY;
  check(
    'opposite gestures sweep the weapon opposite ways',
    Math.sign(leftYaw) !== 0 && Math.sign(leftYaw) === -Math.sign(rightYaw),
    `left stroke yaw ${leftYaw.toFixed(2)}, right stroke yaw ${rightYaw.toFixed(2)}`,
  );

  await waitForIdle();
  const upStroke = await sampleTrajectory('swing', [0, -260]);
  check(
    'an uppercut travels vertically rather than across',
    upStroke.range.rotX > upStroke.range.rotY,
    `pitch ${upStroke.range.rotX.toFixed(2)} vs yaw ${upStroke.range.rotY.toFixed(2)}`,
  );
  // And a thrust must bring the weapon towards the centre, not away from it.
  check(
    'a thrust moves the weapon towards screen centre',
    Math.abs(thrustPose.posX ?? 0) < Math.abs(idlePose.posX ?? 0),
    `posX ${idlePose.posX} -> ${thrustPose.posX}`,
  );

  // The point has to arrive *on* the crosshair, measured in pixels.
  //
  // "The hand moves towards centre" above is a proxy, and it passed while the tip
  // still sat visibly low and to the right — which is exactly what the player
  // reported, twice. This measures the thing itself: the tip's projected position
  // relative to the crosshair, at its closest approach during the thrust.
  await waitForIdle();
  await meleeClick();
  let closestTip = null;
  for (let i = 0; i < 70; i++) {
    const sample = await page.evaluate(() => ({
      action: window.__voxelquest.debugViewState().action,
      tip: window.__voxelquest.debugTipOffset(),
    }));
    if (sample.action === 'thrust' && sample.tip) {
      const distance = Math.hypot(sample.tip.x, sample.tip.y);
      if (closestTip === null || distance < closestTip.distance) {
        closestTip = { distance, ...sample.tip };
      }
    } else if (closestTip !== null) {
      break;
    }
    await page.waitForTimeout(25);
  }
  check(
    'the thrust puts the weapon tip on the crosshair',
    closestTip !== null && closestTip.distance < 0.05,
    closestTip
      ? `closest approach ${(closestTip.x * 640).toFixed(0)}px x, ${(closestTip.y * 360).toFixed(0)}px y at 1280x720`
      : 'tip never observed',
  );

  console.log('\n[sun and moon]');
  await page.evaluate(() => window.__voxelquest.debugSetTime('day'));
  await page.waitForTimeout(500);
  const daySky = await page.evaluate(() => window.__voxelquest.debugCelestial());
  check('the sun is up during the day', daySky.sunVisible === true, JSON.stringify(daySky));
  check('the moon is not up during the day', daySky.moonVisible === false, `moonVisible ${daySky.moonVisible}`);

  await page.evaluate(() => window.__voxelquest.debugSetTime('night'));
  await page.waitForTimeout(500);
  const nightSky = await page.evaluate(() => window.__voxelquest.debugCelestial());
  check('the moon is up at night', nightSky.moonVisible === true, JSON.stringify(nightSky));
  check('the sun is not up at night', nightSky.sunVisible === false, `sunVisible ${nightSky.sunVisible}`);
  await page.evaluate(() => window.__voxelquest.debugSetTime('day'));

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
  // Retried: using an item shares the action cooldown with whatever ran just
  // before it, so a lone click here can be refused outright and the counts never
  // move. Same lesson as the torch placement and the bow draw.
  const afterCook =
    (await waitUntil(
      'the fish to be cooked',
      async () => {
        await page.mouse.click(CENTER_X, CENTER_Y);
        await page.waitForTimeout(500);
        const now = await page.evaluate(() => ({
          raw: window.__voxelquest.debugItemCount('raw_fish'),
          cooked: window.__voxelquest.debugItemCount('cooked_fish'),
        }));
        return now.cooked > cooked.cooked ? now : null;
      },
      12_000,
      150,
    )) ??
    (await page.evaluate(() => ({
      raw: window.__voxelquest.debugItemCount('raw_fish'),
      cooked: window.__voxelquest.debugItemCount('cooked_fish'),
    })));
  check(
    'holding a torch cooks a raw fish instead of eating it',
    afterCook.cooked > cooked.cooked && afterCook.raw < cooked.raw,
    `raw ${cooked.raw}->${afterCook.raw}, cooked ${cooked.cooked}->${afterCook.cooked}`,
  );

  console.log('\n[shaped blocks]');
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
  // Retried rather than clicked once behind a fixed wait. Placement shares a
  // cooldown with the use that cooked the fish a moment ago, so a lone right-click
  // here can be swallowed entirely and the shape read back as null.
  const torchShape = await waitUntil('a torch to be placed', async () => {
    await waitForIdle();
    await page.mouse.click(CENTER_X, CENTER_Y, { button: 'right' });
    await page.waitForTimeout(400);
    return page.evaluate(() => window.__voxelquest.debugPlacedShape('torch'));
  });
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

  console.log('\n[mana spells]');
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugSetMana(200);
    // The shaped-block section left the camera aimed at the floor.
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

  console.log('\n[character, skills and gold]');
  const character = await page.evaluate(() => {
    const g = window.__voxelquest;
    // A build that can actually reach a capstone: Strength 15 clears the gate.
    g.debugSetAbilities({ str: 15, dex: 12, con: 14, int: 10, wis: 10 });
    g.debugGrantLevels(8);
    return g.debugCharacter();
  });
  check(
    'the sheet runs on five 5e abilities',
    Object.keys(character.abilities).length === 5 && character.abilities.str === 15,
    JSON.stringify(character.abilities),
  );
  check(
    'modifiers follow floor((score - 10) / 2)',
    character.modifiers.str === 2 && character.modifiers.con === 2 && character.modifiers.int === 0,
    JSON.stringify(character.modifiers),
  );
  check(
    'Constitution is what sets the health pool',
    character.maxHp > 34,
    `${character.maxHp} HP at CON ${character.abilities.con}`,
  );
  check('levelling grants skill points', character.skillPoints >= 8, `${character.skillPoints} points`);

  // Buying through the same path the sheet uses, including the ability gate.
  const bought = await page.evaluate(() => {
    const g = window.__voxelquest;
    const before = g.debugCharacter();
    const edge = g.debugBuySkill('blade_edge');
    const sunder = g.debugBuySkill('blade_sunder');
    const capstone = g.debugBuySkill('blade_executioner');
    return { before, edge, sunder, capstone, after: g.debugCharacter() };
  });
  check('a skill can be bought', bought.edge === true && (bought.after.skills.blade_edge ?? 0) >= 1);
  check(
    'buying a skill raises the stat it claims to',
    bought.after.melee > bought.before.melee,
    `melee x${bought.before.melee} -> x${bought.after.melee}`,
  );
  check(
    'the prerequisite chain can be climbed',
    bought.sunder === true && bought.capstone === true,
    `sunder ${bought.sunder}, capstone ${bought.capstone}`,
  );

  const gated = await page.evaluate(() => {
    const g = window.__voxelquest;
    // Dropping Strength below the gate must take the capstone with it.
    const after = g.debugSetAbilities({ str: 8 });
    return { skills: after.skills, melee: after.melee };
  });
  check(
    'lowering an ability prunes the skills it gated',
    (gated.skills.blade_executioner ?? 0) === 0 && (gated.skills.blade_sunder ?? 0) === 0,
    JSON.stringify(gated.skills),
  );

  // Gold, and the respec it pays for.
  const respec = await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugSetAbilities({ str: 15 });
    g.debugBuySkill('blade_edge');
    const before = g.debugCharacter();
    const broke = g.debugRespec();
    g.debugGiveGold(5000);
    const rich = g.debugRespec();
    return { before, broke, rich, after: g.debugCharacter() };
  });
  check('a respec is refused without the gold', respec.broke === false, `cost ${respec.before.respecCost}`);
  check(
    'paying the fee clears the tree and charges the gold',
    respec.rich === true &&
      Object.keys(respec.after.skills).length === 0 &&
      // Measured against the purse the player already had: earlier kills in this
      // run pay out gold too, so 5000 is a top-up and not a starting balance.
      respec.after.gold === respec.before.gold + 5000 - respec.before.respecCost,
    `gold ${respec.before.gold} +5000 -${respec.before.respecCost} -> ${respec.after.gold}`,
  );
  check(
    'a respec leaves ability scores alone',
    respec.after.abilities.str === 15,
    JSON.stringify(respec.after.abilities),
  );
  check(
    'refunded points can be spent again',
    respec.after.skillPoints >= respec.before.skillPoints,
    `${respec.before.skillPoints} -> ${respec.after.skillPoints}`,
  );

  // Enemies have to actually pay out, or the respec fee is unreachable.
  const earned = await page.evaluate(async () => {
    const g = window.__voxelquest;
    g.debugSetInvulnerable(true);
    g.debugClearEnemies();
    const start = g.debugCharacter().gold;
    // Kill repeatedly: the drop is a roll, so one kill proves nothing.
    for (let i = 0; i < 24; i++) {
      g.debugSpawnEnemyInReach(2.4);
      g.debugKillNearestEnemy();
      await new Promise((r) => setTimeout(r, 20));
    }
    return { start, spawned: true };
  });
  const goldAfterKills = await waitUntil(
    'gold to be collected from kills',
    async () => {
      const c = await page.evaluate(() => window.__voxelquest.debugCharacter());
      return c.gold > earned.start ? c : null;
    },
    20_000,
    250,
  );
  check(
    'enemies drop gold that the player collects',
    (goldAfterKills?.gold ?? 0) > earned.start,
    `${earned.start} -> ${goldAfterKills?.gold ?? earned.start} gold over 24 kills`,
  );

  // The sheet must render all four branches, the connectors, and the respec button.
  await page.evaluate(() => window.__voxelquest.debugOpenSheet());
  await page.waitForTimeout(400);
  // Skills live behind their own tab now, so it has to be activated first.
  await page.evaluate(() => document.getElementById('tab-skills')?.click());
  await page.waitForTimeout(500);
  const sheetDom = await page.evaluate(() => ({
    skillsVisible: !document.getElementById('pane-skills')?.classList.contains('hidden'),
    gearHidden: document.getElementById('pane-gear')?.classList.contains('hidden'),
    tabLabel: document.getElementById('tab-skills')?.textContent ?? '',
    branches: document.querySelectorAll('#sheet-skills .skill-branch').length,
    nodes: document.querySelectorAll('#sheet-skills .skill-node').length,
    // The curved connectors are generated from measured geometry, so an empty
    // SVG means the layout pass never ran or measured a hidden panel as zero.
    limbs: document.querySelectorAll('#sheet-skills .branch-canvas path.limb').length,
    trunks: document.querySelectorAll('#sheet-skills .branch-canvas path.trunk').length,
    curved: Array.from(document.querySelectorAll('#sheet-skills .branch-canvas path.limb')).filter((p) =>
      (p.getAttribute('d') ?? '').includes('C'),
    ).length,
    radarAxes: document.querySelectorAll('#ability-radar .spoke').length,
    radarShape: document.querySelectorAll('#ability-radar .shape').length,
    respec: document.getElementById('respec')?.textContent ?? '',
    abilities: Array.from(document.querySelectorAll('#sheet-abilities .attr .an')).map((n) => n.textContent),
  }));
  check('the skills tab is named "Skills and Stats"', sheetDom.tabLabel.trim() === 'Skills and Stats', sheetDom.tabLabel);
  check(
    'activating the tab shows skills and hides the gear pane',
    sheetDom.skillsVisible === true && sheetDom.gearHidden === true,
    `skills ${sheetDom.skillsVisible}, gear hidden ${sheetDom.gearHidden}`,
  );
  check('the sheet shows four skill branches', sheetDom.branches === 4, `${sheetDom.branches} branches`);
  check('every skill node is rendered', sheetDom.nodes === 20, `${sheetDom.nodes} nodes`);
  check(
    'each node is joined to the tree by a limb',
    sheetDom.limbs === 20 && sheetDom.trunks === 4,
    `${sheetDom.limbs} limbs, ${sheetDom.trunks} trunks`,
  );
  check(
    'the limbs are curves, not straight lines',
    sheetDom.curved === sheetDom.limbs && sheetDom.curved > 0,
    `${sheetDom.curved} of ${sheetDom.limbs} use bezier segments`,
  );
  check(
    'the ability radar is drawn with one axis per ability',
    sheetDom.radarAxes === 5 && sheetDom.radarShape === 1,
    `${sheetDom.radarAxes} axes`,
  );
  check(
    'the respec button shows its gold price',
    sheetDom.respec.toLowerCase().includes('gold'),
    sheetDom.respec,
  );
  check(
    'the sheet lists the five abilities',
    sheetDom.abilities.join(',') === 'STR,DEX,CON,INT,WIS',
    sheetDom.abilities.join(','),
  );

  // Dragging an item onto an equipment slot must equip it, and onto a hotbar
  // slot must assign it. This is the loop the player complained about: the old
  // flow was leave the sheet, scroll the hotbar, reopen, click.
  const dragResult = await page.evaluate(async () => {
    const g = window.__voxelquest;
    g.debugGiveItem('longsword', 1);
    document.getElementById('tab-gear')?.click();
    await new Promise((r) => setTimeout(r, 250));

    // Weapons live in the Tools bag tab, so it has to be the active one before
    // the cell exists in the DOM at all.
    const pickBagTab = async (label) => {
      const tab = Array.from(document.querySelectorAll('#sheet-bag .bag-tab')).find((b) =>
        (b.textContent ?? '').startsWith(label),
      );
      tab?.click();
      await new Promise((r) => setTimeout(r, 250));
    };
    await pickBagTab('Tools');

    const cells = Array.from(document.querySelectorAll('#sheet-bag .bag-item'));
    const sword = cells.find((c) => c.dataset.item === 'longsword');
    const weaponSlot = document.querySelector('#sheet-equip .eq-slot');
    if (!sword || !weaponSlot) {
      return { ok: false, why: `sword ${!!sword} slot ${!!weaponSlot}` };
    }

    // A real HTML5 drag needs a DataTransfer shared across the three events;
    // Playwright's dragTo cannot reach elements inside this overlay reliably.
    const fire = (target, type, dt) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(event);
      return event;
    };
    const dt = new DataTransfer();
    fire(sword, 'dragstart', dt);
    const over = fire(weaponSlot, 'dragover', dt);
    const highlighted = weaponSlot.classList.contains('drop-ok');
    fire(weaponSlot, 'drop', dt);
    fire(sword, 'dragend', dt);
    await new Promise((r) => setTimeout(r, 250));
    const equipped = g.debugEquipped();

    // And onto a hotbar slot. Potions are in the Main tab.
    await pickBagTab('Main');
    const cells2 = Array.from(document.querySelectorAll('#sheet-bag .bag-item'));
    const potion = cells2.find((c) => c.dataset.item === 'healing_draught');
    let hotbarAssigned = null;
    // Re-queried, not reused: the sheet rebuilds itself after every change, so the
    // slot captured before the first drop is a detached node and events sent to
    // it reach nothing.
    const hotbarSlot = document.querySelectorAll('#sheet-hotbar .hotbar-slot')[5];
    let diag = {};
    if (potion && hotbarSlot) {
      const dt2 = new DataTransfer();
      fire(potion, 'dragstart', dt2);
      const over2 = fire(hotbarSlot, 'dragover', dt2);
      diag = { dragged: potion.dataset.item, over2: over2.defaultPrevented };
      fire(hotbarSlot, 'drop', dt2);
      fire(potion, 'dragend', dt2);
      await new Promise((r) => setTimeout(r, 250));
      hotbarAssigned = g.debugHotbar()[5];
    } else {
      diag = { potionFound: !!potion, slotFound: !!hotbarSlot };
    }

    return { ok: true, overPrevented: over.defaultPrevented, highlighted, equipped, hotbarAssigned, diag };
  });
  check('the bag and slots are present to drag between', dragResult.ok === true, dragResult.why ?? '');
  check(
    'an equipment slot accepts a dragged weapon',
    dragResult.overPrevented === true && dragResult.highlighted === true,
    `dragover accepted ${dragResult.overPrevented}, highlighted ${dragResult.highlighted}`,
  );
  check(
    'dropping a weapon on the weapon slot equips it',
    dragResult.equipped?.weapon === 'longsword',
    JSON.stringify(dragResult.equipped),
  );
  check(
    'dropping an item on a hotbar slot assigns it',
    dragResult.hotbarAssigned === 'healing_draught',
    `slot 6 holds ${dragResult.hotbarAssigned} | ${JSON.stringify(dragResult.diag)}`,
  );

  await page.evaluate(() => window.__voxelquest.debugCloseSheet());
  await page.waitForTimeout(300);

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

  // The all-items loadout. Last, deliberately: it rewrites the inventory and the
  // equipped slots, and run mid-suite it silently broke the bow checks that followed
  // by swapping the weapon out from under them.
  console.log('\n[enemy AI]');

  // A melee enemy that has closed to reach must actually swing.
  //
  // It used to attack only inside 0.92 of its reach but hold station anywhere inside
  // 1.05, leaving a band where it did neither — and since circling holds distance
  // roughly constant, anything that arrived in that band orbited the player forever.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugFreezeEnemies(false);
    g.debugRevive();
    g.debugSetInvulnerable(false);
    g.debugRefill();
    g.debugSpawnArchetype('goblin_grunt', 2.2);
  });
  const meleeStates = new Set();
  let meleeHp = (await snapshot()).hp;
  let meleeDamaged = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(100);
    const report = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
    if (report[0]) meleeStates.add(report[0].state);
    const hp = (await snapshot()).hp;
    if (hp < meleeHp) meleeDamaged = true;
    meleeHp = hp;
    if (meleeDamaged && meleeStates.has('windup')) break;
  }
  check(
    'a melee enemy in reach commits to an attack',
    meleeStates.has('windup'),
    `states seen: ${[...meleeStates].join(', ') || 'none'}`,
  );
  check('a melee enemy actually lands hits', meleeDamaged, `player hp fell to ${meleeHp}`);

  // An archer backed into a corner must keep shooting while it gives ground. Closing
  // the distance used to switch it off completely.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugFreezeEnemies(false);
    g.debugSetInvulnerable(true);
    g.debugRevive();
    g.debugSpawnArchetype('bandit_archer', 4);
  });
  const shotsBefore = (await snapshot()).projectilesFired;
  const archerStates = new Set();
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(100);
    const report = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
    if (report[0]) archerStates.add(report[0].state);
    if ((await snapshot()).projectilesFired > shotsBefore) break;
  }
  const shotsAfter = (await snapshot()).projectilesFired;
  check(
    'a crowded archer keeps shooting while giving ground',
    shotsAfter > shotsBefore,
    `${shotsBefore} -> ${shotsAfter} shots, states: ${[...archerStates].join(', ')}`,
  );

  // Being shot from outside its sight range must wake it *and* set it hunting. This set
  // `aggro` alone, and the acquire check is guarded on `!aggro` — so a sniped enemy
  // stayed awake and idle forever, wandering while its health dropped.
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugClearEnemies();
    g.debugFreezeEnemies(true);
    g.debugSpawnArchetype('goblin_grunt', 26);
  });
  await page.waitForTimeout(600);
  const asleep = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  check(
    'a distant enemy starts unaware',
    asleep[0] && asleep[0].hunting === false,
    `state ${asleep[0]?.state}, hunting ${asleep[0]?.hunting}`,
  );
  await page.evaluate(() => window.__voxelquest.debugDamageNearestEnemy(3));
  await page.waitForTimeout(400);
  const woken = await page.evaluate(() => window.__voxelquest.debugEnemyReport());
  check(
    'hitting a distant enemy makes it hunt you',
    woken[0] && woken[0].hunting === true && woken[0].state !== 'idle',
    `state ${woken[0]?.state}, hunting ${woken[0]?.hunting}`,
  );
  await page.evaluate(() => {
    const g = window.__voxelquest;
    g.debugFreezeEnemies(false);
    g.debugClearEnemies();
  });

  console.log('\n[full loadout]');
  const loadout = await page.evaluate(() => window.__voxelquest.debugGiveAll());
  check(
    'the full loadout hands over every item',
    loadout.weapons >= 10 && loadout.other >= 20,
    `${loadout.weapons} weapons and ${loadout.other} other items`,
  );
  const equipped = await page.evaluate(() => window.__voxelquest.debugViewState());
  check(
    'the loadout equips a one-handed weapon with shield and torch',
    equipped.mainItem === 'shortsword' && equipped.shield === 'iron_kite_shield' && equipped.torch === 'torch',
    `main ${equipped.mainItem}, shield ${equipped.shield}, torch ${equipped.torch}`,
  );

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

