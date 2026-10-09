/**
 * Screenshots the crafting tab.
 *
 * Its own script because the crafting list is the one panel whose failure mode is
 * purely visual: every recipe can resolve, every button can work, and the thing
 * can still be unreadable because an icon has overflowed its box across the text
 * beside it. That is exactly what happened — `applyIcon` takes (node, glyph, name)
 * and was handed the item id as the glyph, so each row rendered its raw id at
 * 21px across the recipe name.
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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 60_000 });
await page.click('#play');
await page.waitForTimeout(3500);

// A part-stocked bag, so the shot shows affordable and blocked rows side by side —
// a list where everything is one state does not prove the other renders.
await page.evaluate(() => {
  const g = window.__voxelquest;
  g.debugSetInvulnerable(true);
  g.debugOpenSheet();
});
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('tab-crafting')?.click());
await page.waitForTimeout(700);

// Measure the overlap rather than only photographing it: an icon wider than its
// cell is a number, and a number can be asserted.
const overflow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#sheet-crafting .recipe'));
  let worst = 0;
  let culprit = '';
  for (const row of rows) {
    const icon = row.querySelector('.ricon');
    const text = row.children[1];
    if (!icon || !text) continue;
    const a = icon.getBoundingClientRect();
    const b = text.getBoundingClientRect();
    const spill = a.right - b.left;
    if (spill > worst) {
      worst = spill;
      culprit = row.textContent?.slice(0, 40) ?? '';
    }
  }
  return { rows: rows.length, worst: Math.round(worst), culprit };
});
console.log(`rows ${overflow.rows}, worst icon/text overlap ${overflow.worst}px ${overflow.culprit}`);

await page.screenshot({ path: '.kiro/artifacts/screenshots/crafting.png' });
console.log('wrote .kiro/artifacts/screenshots/crafting.png');

await browser.close();
server.close();
