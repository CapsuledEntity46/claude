import * as THREE from 'three';
import { blockDef } from '../world/blocks';
import type { World } from '../world/World';

const SIZE = 148;
/** Blocks sampled per axis. Larger reveals more, at the cost of resolution. */
const SPAN = 74;
/** Rebuild interval. The terrain does not change fast enough to redraw every frame. */
const REFRESH_SECONDS = 0.35;

/**
 * Top-down minimap plus a compass ribbon.
 *
 * Drawn on a 2D canvas by sampling the loaded height map, shaded by elevation so
 * hills and valleys read at a glance. It samples the same chunk data the renderer
 * uses, so it only ever shows terrain that is actually loaded — which is honest,
 * and cheaper than maintaining a separate map cache.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  readonly compass: HTMLCanvasElement;

  private ctx: CanvasRenderingContext2D;
  private compassCtx: CanvasRenderingContext2D;
  private image: ImageData;
  private refreshTimer = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.canvas.className = 'minimap-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(SPAN, SPAN);

    this.compass = document.createElement('canvas');
    this.compass.width = SIZE;
    this.compass.height = 20;
    this.compass.className = 'compass-canvas';
    this.compassCtx = this.compass.getContext('2d')!;
  }

  update(
    dt: number,
    world: World,
    playerPosition: THREE.Vector3,
    yaw: number,
    markers: { x: number; z: number; kind: 'enemy' | 'dungeon' }[],
    daylight: number,
  ): void {
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) {
      this.refreshTimer = REFRESH_SECONDS;
      this.drawTerrain(world, playerPosition, daylight);
    }
    this.drawOverlay(playerPosition, yaw, markers);
    this.drawCompass(yaw, playerPosition, markers);
  }

  private drawTerrain(world: World, playerPosition: THREE.Vector3, daylight: number): void {
    const data = this.image.data;
    const half = SPAN >> 1;
    const originX = Math.floor(playerPosition.x) - half;
    const originZ = Math.floor(playerPosition.z) - half;
    // Night dims the map, so it matches what the player can actually see.
    const exposure = 0.45 + daylight * 0.55;

    for (let row = 0; row < SPAN; row++) {
      for (let col = 0; col < SPAN; col++) {
        const wx = originX + col;
        const wz = originZ + row;
        const i = (row * SPAN + col) * 4;

        const surfaceY = world.highestSolidY(wx, wz);
        if (surfaceY < 0) {
          // Unloaded: leave it dark so the frontier is visible.
          data[i] = 12;
          data[i + 1] = 14;
          data[i + 2] = 18;
          data[i + 3] = 200;
          continue;
        }

        const id = world.getBlock(wx, surfaceY, wz);
        const colour = blockDef(id).top;
        // Shade by height, which is what turns a flat colour field into terrain.
        const relief = 0.62 + Math.min(1, Math.max(0, (surfaceY - 24) / 40)) * 0.6;
        const shade = relief * exposure;

        data[i] = Math.min(255, colour[0] * 255 * shade);
        data[i + 1] = Math.min(255, colour[1] * 255 * shade);
        data[i + 2] = Math.min(255, colour[2] * 255 * shade);
        data[i + 3] = 235;
      }
    }

    // Blit the low-resolution sample up to the display size.
    this.ctx.putImageData(this.image, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.canvas, 0, 0, SPAN, SPAN, 0, 0, SIZE, SIZE);
  }

  private drawOverlay(
    playerPosition: THREE.Vector3,
    yaw: number,
    markers: { x: number; z: number; kind: 'enemy' | 'dungeon' }[],
  ): void {
    const ctx = this.ctx;
    const scale = SIZE / SPAN;
    const centre = SIZE / 2;

    for (const marker of markers) {
      const dx = (marker.x - playerPosition.x) * scale;
      const dz = (marker.z - playerPosition.z) * scale;
      if (Math.abs(dx) > centre - 4 || Math.abs(dz) > centre - 4) continue;
      ctx.fillStyle = marker.kind === 'enemy' ? '#ff5a4a' : '#ffd050';
      ctx.beginPath();
      ctx.arc(centre + dx, centre + dz, marker.kind === 'enemy' ? 2.6 : 3.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // The player: an arrow pointing where the camera looks.
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centre + forwardX * 7, centre + forwardZ * 7);
    ctx.lineTo(centre - forwardX * 4 + rightX * 4, centre - forwardZ * 4 + rightZ * 4);
    ctx.lineTo(centre - forwardX * 4 - rightX * 4, centre - forwardZ * 4 - rightZ * 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawCompass(
    yaw: number,
    playerPosition: THREE.Vector3,
    markers: { x: number; z: number; kind: 'enemy' | 'dungeon' }[],
  ): void {
    const ctx = this.compassCtx;
    const width = this.compass.width;
    ctx.clearRect(0, 0, width, 20);

    ctx.fillStyle = 'rgba(10, 9, 14, 0.55)';
    ctx.fillRect(0, 0, width, 20);

    // Heading, measured so that 0 is north (-Z) and increasing clockwise.
    const heading = ((-yaw * 180) / Math.PI + 360) % 360;
    const degreesPerPixel = 90 / width; // a 90-degree window across the ribbon

    const cardinals: [number, string][] = [
      [0, 'N'],
      [45, 'NE'],
      [90, 'E'],
      [135, 'SE'],
      [180, 'S'],
      [225, 'SW'],
      [270, 'W'],
      [315, 'NW'],
    ];

    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [angle, label] of cardinals) {
      // Shortest signed distance from the current heading to this bearing.
      let delta = ((angle - heading + 540) % 360) - 180;
      const x = width / 2 + delta / degreesPerPixel;
      if (x < 6 || x > width - 6) continue;
      const major = label.length === 1;
      ctx.fillStyle = major ? '#ffe0a0' : 'rgba(232, 226, 212, 0.6)';
      ctx.fillText(label, x, 11);
      ctx.fillRect(x - 0.5, 0, 1, major ? 4 : 2);
    }

    // A pip for the nearest dungeon, so the compass has a purpose beyond bearing.
    const dungeon = markers.find((m) => m.kind === 'dungeon');
    if (dungeon) {
      const bearing = ((Math.atan2(dungeon.x - playerPosition.x, -(dungeon.z - playerPosition.z)) * 180) / Math.PI + 360) % 360;
      let delta = ((bearing - heading + 540) % 360) - 180;
      const x = width / 2 + delta / degreesPerPixel;
      if (x > 3 && x < width - 3) {
        ctx.fillStyle = '#ffd050';
        ctx.beginPath();
        ctx.moveTo(x, 20);
        ctx.lineTo(x - 3.5, 15);
        ctx.lineTo(x + 3.5, 15);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Centre marker.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(width / 2 - 0.5, 14, 1, 6);
  }
}
