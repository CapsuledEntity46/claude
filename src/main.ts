import { Game } from './core/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Missing #game canvas');

try {
  const game = new Game(canvas);
  game.start();
  // Exposed on purpose: `__voxelquest.debugSnapshot()` in the console is the
  // fastest way to tell whether a problem is meshing, streaming, or spawning.
  (window as unknown as { __voxelquest: Game }).__voxelquest = game;
} catch (error) {
  // WebGL can fail outright on some machines; say so instead of showing a blank page.
  const message = error instanceof Error ? error.message : String(error);
  const menu = document.querySelector('.menu-inner');
  if (menu) {
    menu.innerHTML = `<h1 style="font-size:26px">Could not start</h1><p class="tag">${message}</p>
      <p class="tag">This game needs a browser with WebGL 2 enabled.</p>`;
  }
  throw error;
}
