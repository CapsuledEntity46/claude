import './ui/styles.css';
import { Game } from './game';
import { audio } from './core/audio';

/**
 * Entry point: wire the canvas, unlock audio on the first gesture and hand
 * control to the game's main menu.
 */

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('missing #game canvas');

const game = new Game(canvas);

// Browsers require a user gesture before an AudioContext may start.
const unlock = () => {
  audio.resume();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// Save on the way out so a refresh doesn't cost progress.
window.addEventListener('beforeunload', () => {
  if (game.state === 'playing' || game.state === 'paused') {
    void import('./systems/save').then((m) => m.saveGame(game));
  }
});

// Handy for debugging from the console.
(window as unknown as { game: Game }).game = game;
