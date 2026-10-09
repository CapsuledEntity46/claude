/**
 * Screenshots each terrain feature the generator claims to make.
 *
 * Flies to a matching column for each one and photographs it. Terrain is the one
 * part of this project where test numbers are genuinely insufficient: "p99 height
 * is 120" does not tell you whether a mountain range looks like a mountain range
 * or like a pile of noise.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    const file = join(DIST, url === '/' ? 'index.html' : url);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 60_000 });
await page.click('#play');
await page.waitForTimeout(5000);

await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugSetInvulnerable(true);
  g.debugSetTime('day');
  g.debugSetWeather('clear');
});

/**
 * @param name   file stem
 * @param want   terrain predicate for debugFindTerrain
 * @param rise   blocks to lift the camera, for a wider view
 * @param pitch  camera pitch; negative looks down
 */
async function shot(name, want, distance, rise) {
  const found = await page.evaluate(
    ([w, d, r]) => {
      const g = window.__voxelquest;
      g.debugSetInvulnerable(true);
      return g.debugViewFeature(w, d, r);
    },
    [want, distance, rise],
  );
  if (!found) {
    console.log(`  MISS  no ${want} found within 5000 blocks`);
    return;
  }
  // Terrain has to stream in around the new position before it can be shot.
  await page.waitForTimeout(9000);
  // Re-position immediately before the shutter. The camera is a falling player:
  // lifting it above the canopy and then waiting nine seconds for chunks just
  // means it lands again, which is how the first attempt photographed the
  // underside of a forest instead of the mountain range behind it.
  await page.evaluate(
    ([w, d, r]) => {
      const g = window.__voxelquest;
      g.debugRevive();
      g.debugViewFeature(w, d, r);
    },
    [want, distance, rise],
  );
  await page.waitForTimeout(120);
  await page.screenshot({ path: `.kiro/artifacts/screenshots/terrain-${name}.png` });
  console.log(
    `  captured terrain-${name}.png — ${want} at ${found.x},${found.z} height ${found.height}, ` +
      `viewed from ${found.fromX},${found.fromZ} (${found.drop} below)`,
  );
}

await shot('mountains', 'mountain', 130, 52);
await shot('canyon', 'canyon', 64, 26);
await shot('plateau', 'plateau', 95, 26);
await shot('island', 'island', 72, 24);
await shot('deep-ocean', 'deep-ocean', 55, 14);
await shot('jungle', 'jungle', 76, 30);
await shot('desert', 'desert', 90, 22);
// Woodland. Shot from further back and higher than the landforms above, because a
// tree is only legible against sky or against the stand behind it — from inside a
// canopy every one of these is just green filling the frame.
await shot('forest', 'forest', 78, 26);
await shot('tundra', 'tundra', 78, 24);

await browser.close();
server.close();
