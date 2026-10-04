/**
 * Screenshots the character sheet, both tabs, with a part-built skill tree.
 *
 * Separate from shots.mjs because it needs a wider viewport and a character that
 * has actually spent points — an empty tree shows none of the connector states.
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
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 60_000 });
// The start overlay has to be dismissed first, or the sheet cannot open: it only
// opens from the 'playing' mode, so a screenshot taken before this is of the menu.
await page.click('#play');
await page.waitForTimeout(6000);

await page.evaluate(() => {
  const g = window.__voxelquest;
  if (g.debugGiveAll) g.debugGiveAll();
  g.debugSetAbilities({ str: 15, dex: 12, con: 14, int: 10, wis: 11 });
  g.debugGrantLevels(9);
});
await page.waitForTimeout(800);

await page.evaluate(() => {
  const g = window.__voxelquest;
  // A partly-grown tree, so owned, available and locked discs all appear.
  for (const id of [
    'blade_edge',
    'blade_edge',
    'blade_sweep',
    'blade_sunder',
    'blade_executioner',
    'hunt_aim',
    'end_vitality',
    'end_hide',
    'arcana_power',
  ]) {
    g.debugBuySkill(id);
  }
  g.debugOpenSheet();
});
await page.waitForTimeout(900);
await page.screenshot({ path: '.kiro/artifacts/screenshots/sheet-gear.png' });
console.log('  captured sheet-gear.png');

await page.evaluate(() => document.getElementById('tab-skills').click());
await page.waitForTimeout(900);
await page.screenshot({ path: '.kiro/artifacts/screenshots/sheet-skills.png' });
console.log('  captured sheet-skills.png');

await browser.close();
server.close();
