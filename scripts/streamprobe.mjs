/**
 * Watches the chunk queue drain, to confirm the world finishes streaming.
 *
 * A time-sliced budget trades fill speed for smoothness, so the question "does
 * it still finish?" has to be answered with a measurement rather than assumed.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__voxelquest, null, { timeout: 60_000 });
await page.click('#play');

console.log('\n  t(s)  queued  chunks  worstFrameMs  fps');
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  const [cost, snap] = await Promise.all([
    page.evaluate(() => window.__voxelquest.debugChunkCost()),
    page.evaluate(() => window.__voxelquest.debugSnapshot()),
  ]);
  console.log(
    `  ${String((i + 1) * 2).padStart(4)}  ${String(cost.queued).padStart(6)}  ` +
      `${String(snap.chunks).padStart(6)}  ${String(cost.maxFrameMs).padStart(12)}  ${snap.fps}`,
  );
  if (cost.queued === 0) {
    console.log('\n  queue fully drained.');
    break;
  }
}

await browser.close();
server.close();
