/**
 * The draw pipeline.
 *
 * Order matters a great deal here:
 *   terrain (cached per chunk) -> decals -> flat structures -> sorted entities
 *   -> building roofs -> particles -> lighting -> weather -> minimap
 *
 * Roofs are drawn *after* entities so that anything inside a building you're not
 * standing in stays hidden, which is what makes looting houses feel like
 * entering them.
 */

import { clamp, clamp01, lerp, TAU } from '../core/math';
import { smoothNoise, valueNoise2 } from '../core/rng';
import { TILES, TILE_SIZE, Tile, mix, type Biome } from '../world/tiles';
import { PROPS } from '../world/props';
import type { Building } from '../world/buildings';
import { itemDef } from '../items/itemdefs';
import {
  drawAnimalSprite, drawBanditSprite, drawCorpseSprite, drawDeployable, drawGroundItemSprite,
  drawHorseSprite, drawPlayerSprite, drawProp, drawStructure, drawZombieSprite,
} from './sprites';
import type { Game } from '../game';

const CHUNK_TILES = 16;
const CHUNK_PX = CHUNK_TILES * TILE_SIZE;
const CHUNK_CACHE_MAX = 64;

interface Drawable {
  /** Sort key — larger draws later (further "down" the screen). */
  y: number;
  draw(): void;
}

interface Light {
  x: number;
  y: number;
  radius: number;
  /** Warm additive tint colour. */
  color: string;
  intensity: number;
  /** Cone direction for flashlights; undefined = omnidirectional. */
  angle?: number;
  spread?: number;
}

export class Renderer {
  private game: Game;
  dpr = 1;
  viewSize = { w: 1, h: 1 };

  private chunks = new Map<number, HTMLCanvasElement>();
  private chunkOrder: number[] = [];

  /** 1px-per-tile image of the whole world, for the minimap and map screen. */
  private worldMap: HTMLCanvasElement | null = null;

  private lightCanvas: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D;

  private drawables: Drawable[] = [];
  private lights: Light[] = [];
  private time = 0;

  constructor(game: Game) {
    this.game = game;
    this.lightCanvas = document.createElement('canvas');
    this.lightCtx = this.lightCanvas.getContext('2d')!;
  }

  onResize(dpr: number): void {
    this.dpr = dpr;
    this.viewSize.w = this.game.canvas.width;
    this.viewSize.h = this.game.canvas.height;
    // Lighting runs at half resolution; it's a soft effect, nobody notices.
    this.lightCanvas.width = Math.max(1, Math.floor(this.viewSize.w / 2));
    this.lightCanvas.height = Math.max(1, Math.floor(this.viewSize.h / 2));
  }

  invalidateTerrain(): void {
    this.chunks.clear();
    this.chunkOrder.length = 0;
    this.worldMap = null;
  }

  // =========================================================================
  // Main draw
  // =========================================================================

  draw(_alpha: number): void {
    const g = this.game.ctx;
    const game = this.game;
    this.time = performance.now() / 1000;

    const cw = game.canvas.width;
    const ch = game.canvas.height;
    const zoom = game.camera.zoom * this.dpr;

    // Camera shake.
    const shake = game.effects.shake;
    const shakeX = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    const shakeY = shake > 0 ? (Math.random() - 0.5) * shake : 0;

    const camX = game.camera.x + shakeX;
    const camY = game.camera.y + shakeY;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0a0c0e';
    g.fillRect(0, 0, cw, ch);

    g.setTransform(zoom, 0, 0, zoom, cw / 2 - camX * zoom, ch / 2 - camY * zoom);

    // Visible world rect (padded so tall props don't pop in at the edge).
    const halfW = cw / (2 * zoom);
    const halfH = ch / (2 * zoom);
    const view = {
      x: camX - halfW - 120,
      y: camY - halfH - 220,
      w: halfW * 2 + 240,
      h: halfH * 2 + 380,
    };

    this.drawTerrain(g, view);
    game.effects.drawDecals(g);
    this.drawFlatStructures(g, view);
    this.collectAndDrawEntities(g, view);
    this.drawRoofs(g, view);
    this.drawBuildGhost(g);
    game.effects.draw(g);
    game.effects.drawNumbers(g);
    this.drawInteractionHighlight(g);

    // Screen-space passes.
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.drawLighting(g, camX, camY, zoom, cw, ch);
    this.drawWeather(g, cw, ch, camX, camY, zoom);
    this.drawBlind(g, cw, ch);
    this.drawMinimap();
  }

  // =========================================================================
  // Terrain
  // =========================================================================

  private chunkKey(cx: number, cy: number): number { return cy * 4096 + cx; }

  private getChunk(cx: number, cy: number): HTMLCanvasElement {
    const key = this.chunkKey(cx, cy);
    const hit = this.chunks.get(key);
    if (hit) return hit;

    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    this.paintChunk(canvas.getContext('2d')!, cx, cy);

    this.chunks.set(key, canvas);
    this.chunkOrder.push(key);
    if (this.chunkOrder.length > CHUNK_CACHE_MAX) {
      const evict = this.chunkOrder.shift()!;
      this.chunks.delete(evict);
    }
    return canvas;
  }

  /** Bake one terrain chunk. Called rarely, so it can afford detail. */
  private paintChunk(g: CanvasRenderingContext2D, cx: number, cy: number): void {
    const world = this.game.world;
    const seed = world.data.seed;
    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wtx = tx0 + tx;
        const wty = ty0 + ty;
        const tile = world.tileAtTile(wtx, wty);
        const info = TILES[tile];

        // Blend between the tile's two colours using low-frequency noise so
        // large areas of grass aren't flat.
        const n = smoothNoise(wtx / 3.5, wty / 3.5, seed + 17);
        const n2 = valueNoise2(wtx, wty, seed + 91);
        const col = mix(info.c0, info.c1, n * 0.85 + n2 * 0.15);
        g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        g.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);

        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;

        switch (tile) {
          case Tile.Grass:
          case Tile.DryGrass:
          case Tile.ForestFloor: {
            // Grass tufts.
            g.strokeStyle = `rgba(${col[0] + 18},${col[1] + 24},${col[2] + 10},0.5)`;
            g.lineWidth = 1;
            const count = 4;
            for (let i = 0; i < count; i++) {
              const r1 = valueNoise2(wtx * 7 + i, wty * 13 + i, seed + 5);
              const r2 = valueNoise2(wtx * 11 + i, wty * 3 + i, seed + 6);
              const gx = px + r1 * TILE_SIZE;
              const gy = py + r2 * TILE_SIZE;
              g.beginPath();
              g.moveTo(gx, gy);
              g.lineTo(gx + (r1 - 0.5) * 3, gy - 3 - r2 * 3);
              g.stroke();
            }
            break;
          }
          case Tile.Water:
          case Tile.DeepWater: {
            // Static wave crests.
            g.strokeStyle = 'rgba(190,220,240,0.12)';
            g.lineWidth = 1.4;
            for (let i = 0; i < 2; i++) {
              const r1 = valueNoise2(wtx * 5 + i, wty * 9 + i, seed + 8);
              const gy = py + r1 * TILE_SIZE;
              g.beginPath();
              g.moveTo(px, gy);
              g.quadraticCurveTo(px + TILE_SIZE / 2, gy - 2, px + TILE_SIZE, gy);
              g.stroke();
            }
            break;
          }
          case Tile.Sand:
          case Tile.Gravel: {
            for (let i = 0; i < 6; i++) {
              const r1 = valueNoise2(wtx * 3 + i, wty * 17 + i, seed + 12);
              const r2 = valueNoise2(wtx * 19 + i, wty * 5 + i, seed + 13);
              g.fillStyle = `rgba(${col[0] - 22},${col[1] - 20},${col[2] - 16},0.55)`;
              g.fillRect(px + r1 * TILE_SIZE, py + r2 * TILE_SIZE, 1.6, 1.6);
            }
            break;
          }
          case Tile.Road:
          case Tile.RoadLine: {
            // Asphalt speckle plus the centre line.
            for (let i = 0; i < 5; i++) {
              const r1 = valueNoise2(wtx * 23 + i, wty * 7 + i, seed + 14);
              const r2 = valueNoise2(wtx * 13 + i, wty * 29 + i, seed + 15);
              g.fillStyle = 'rgba(255,255,255,0.05)';
              g.fillRect(px + r1 * TILE_SIZE, py + r2 * TILE_SIZE, 2, 2);
            }
            if (tile === Tile.RoadLine) {
              g.fillStyle = 'rgba(190,178,110,0.55)';
              g.fillRect(px + TILE_SIZE * 0.42, py, TILE_SIZE * 0.16, TILE_SIZE);
            }
            break;
          }
          case Tile.FloorWood: {
            g.strokeStyle = 'rgba(0,0,0,0.22)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(px, py + TILE_SIZE / 2);
            g.lineTo(px + TILE_SIZE, py + TILE_SIZE / 2);
            g.stroke();
            g.beginPath();
            g.moveTo(px + (wtx % 2 === 0 ? TILE_SIZE * 0.3 : TILE_SIZE * 0.7), py);
            g.lineTo(px + (wtx % 2 === 0 ? TILE_SIZE * 0.3 : TILE_SIZE * 0.7), py + TILE_SIZE / 2);
            g.stroke();
            break;
          }
          case Tile.FloorTile: {
            g.strokeStyle = 'rgba(0,0,0,0.2)';
            g.lineWidth = 1;
            g.strokeRect(px + 0.5, py + 0.5, TILE_SIZE / 2, TILE_SIZE / 2);
            g.strokeRect(px + TILE_SIZE / 2 + 0.5, py + TILE_SIZE / 2 + 0.5, TILE_SIZE / 2, TILE_SIZE / 2);
            break;
          }
          case Tile.FloorConcrete: {
            g.strokeStyle = 'rgba(0,0,0,0.16)';
            g.lineWidth = 1;
            g.strokeRect(px + 0.5, py + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
            break;
          }
          case Tile.Farmland: {
            g.strokeStyle = 'rgba(0,0,0,0.18)';
            g.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
              g.beginPath();
              g.moveTo(px, py + 6 + i * 10);
              g.lineTo(px + TILE_SIZE, py + 6 + i * 10);
              g.stroke();
            }
            break;
          }
          case Tile.Snow: {
            g.fillStyle = 'rgba(255,255,255,0.18)';
            for (let i = 0; i < 3; i++) {
              const r1 = valueNoise2(wtx * 31 + i, wty * 11 + i, seed + 21);
              const r2 = valueNoise2(wtx * 7 + i, wty * 23 + i, seed + 22);
              g.beginPath();
              g.arc(px + r1 * TILE_SIZE, py + r2 * TILE_SIZE, 2.4, 0, TAU);
              g.fill();
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  private drawTerrain(g: CanvasRenderingContext2D, view: { x: number; y: number; w: number; h: number }): void {
    const cx0 = Math.floor(view.x / CHUNK_PX);
    const cy0 = Math.floor(view.y / CHUNK_PX);
    const cx1 = Math.floor((view.x + view.w) / CHUNK_PX);
    const cy1 = Math.floor((view.y + view.h) / CHUNK_PX);
    const maxChunk = Math.ceil(this.game.world.tilesX / CHUNK_TILES);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 0 || cy < 0 || cx >= maxChunk || cy >= maxChunk) continue;
        const chunk = this.getChunk(cx, cy);
        g.drawImage(chunk, cx * CHUNK_PX, cy * CHUNK_PX);
      }
    }
  }

  // =========================================================================
  // Entities
  // =========================================================================

  private drawFlatStructures(g: CanvasRenderingContext2D, view: { x: number; y: number; w: number; h: number }): void {
    for (const s of this.game.world.structures) {
      if (s.kind !== 'foundation' && s.kind !== 'floor') continue;
      if (s.x + s.w < view.x || s.x > view.x + view.w || s.y + s.h < view.y || s.y > view.y + view.h) continue;
      drawStructure(g, s);
    }
  }

  private collectAndDrawEntities(
    g: CanvasRenderingContext2D, view: { x: number; y: number; w: number; h: number },
  ): void {
    const game = this.game;
    const list = this.drawables;
    list.length = 0;

    const inView = (x: number, y: number, pad = 90) =>
      x > view.x - pad && x < view.x + view.w + pad && y > view.y - pad && y < view.y + view.h + pad;

    const wind = game.dayNight.windStrength;
    const time = this.time;

    // --- walls of generated buildings ---
    for (const b of game.world.buildings) {
      if (b.x + b.w < view.x || b.x > view.x + view.w || b.y + b.h < view.y || b.y > view.y + view.h) continue;
      for (const w of b.walls) {
        list.push({
          y: w.y + w.h,
          draw: () => {
            if (w.window) {
              g.fillStyle = 'rgba(120,150,165,0.5)';
              g.fillRect(w.x, w.y - 4, w.w, w.h + 4);
              g.fillStyle = 'rgba(210,230,240,0.25)';
              g.fillRect(w.x, w.y - 4, w.w, 2);
            } else {
              // Extruded wall: dark body, lit cap, bright top edge. The edge is
              // what makes interior partitions readable once the roof is off.
              g.fillStyle = shadeHex(b.wallColor, -46);
              g.fillRect(w.x, w.y - 10, w.w, w.h + 10);
              g.fillStyle = b.wallColor;
              g.fillRect(w.x, w.y - 10, w.w, Math.min(w.h + 10, 7));
              g.fillStyle = shadeHex(b.wallColor, 30);
              g.fillRect(w.x, w.y - 10, w.w, 1.6);
            }
          },
        });
      }
    }

    // --- non-flat player structures ---
    for (const s of game.world.structures) {
      if (s.kind === 'foundation' || s.kind === 'floor') continue;
      if (!inView(s.x, s.y)) continue;
      list.push({ y: s.y + s.h, draw: () => drawStructure(g, s) });
    }

    // --- deployables ---
    for (const d of game.world.deployables) {
      if (!inView(d.x, d.y)) continue;
      list.push({ y: d.y, draw: () => drawDeployable(g, d, time) });
      if (d.lit) {
        this.lights.push({ x: d.x, y: d.y, radius: d.kind === 'furnace' ? 150 : 210, color: '#ffb347', intensity: 1 });
      }
    }

    // --- world props ---
    const props = game.world.propsNear(view.x, view.y, view.w, view.h);
    const playerBuilding = game.world.buildingAt(game.player.x, game.player.y);
    for (const p of props) {
      const def = PROPS[p.kind];
      // Indoor furniture is only drawn when its roof is off.
      if (def.indoor && p.buildingId >= 0 && playerBuilding?.id !== p.buildingId) continue;
      list.push({ y: p.y, draw: () => drawProp(g, p, time, wind) });
      if (def.light && game.dayNight.darkness > 0.2) {
        this.lights.push({ x: p.x, y: p.y - def.height * 0.3, radius: def.light, color: '#ffe0a0', intensity: 0.9 });
      }
    }

    // --- corpses (drawn low so bodies lie under things) ---
    for (const c of game.corpses) {
      if (!inView(c.x, c.y)) continue;
      list.push({ y: c.y - 6, draw: () => drawCorpseSprite(g, c) });
    }

    // --- ground items ---
    for (const gi of game.groundItems) {
      if (!inView(gi.x, gi.y)) continue;
      list.push({ y: gi.y, draw: () => drawGroundItemSprite(g, gi, time) });
    }

    // --- creatures ---
    for (const a of game.animals) {
      if (!a.alive || !inView(a.x, a.y)) continue;
      list.push({ y: a.y, draw: () => drawAnimalSprite(g, a) });
    }
    for (const h of game.horses) {
      if (!h.alive || !inView(h.x, h.y)) continue;
      const rider = game.player.mount === h ? game.player : null;
      list.push({ y: h.y, draw: () => drawHorseSprite(g, h, rider, game.aimAngle) });
    }
    for (const z of game.zombies) {
      if (!z.alive || !inView(z.x, z.y)) continue;
      list.push({ y: z.y, draw: () => { drawZombieSprite(g, z); this.drawHealthBar(g, z.x, z.y, z.healthFrac, z.stats.size, z.flash > 0 || z.healthFrac < 1); } });
      if (z.burning > 0) this.lights.push({ x: z.x, y: z.y, radius: 90, color: '#ff8c3a', intensity: 0.7 });
    }
    for (const b of game.bandits) {
      if (!b.alive || !inView(b.x, b.y)) continue;
      list.push({ y: b.y, draw: () => { drawBanditSprite(g, b); this.drawHealthBar(g, b.x, b.y, b.healthFrac, b.stats.size, b.healthFrac < 1); } });
      if (b.muzzleFlash > 0.1) this.lights.push({ x: b.x, y: b.y, radius: 170, color: '#ffd27a', intensity: b.muzzleFlash });
    }

    // --- player (not while mounted; the horse draws the rider) ---
    if (!game.player.mount && game.player.alive) {
      list.push({ y: game.player.y, draw: () => drawPlayerSprite(g, game.player, game.aimAngle) });
    }

    // --- thrown objects & fire pools ---
    for (const t of game.throwns) {
      list.push({
        y: t.y, draw: () => {
          const def = itemDef(t.itemId);
          g.save();
          g.translate(t.x, t.y - t.z);
          g.rotate(t.spin);
          g.fillStyle = def.icon.a ?? '#4a5240';
          if (t.kind === 'spear') g.fillRect(-14, -1.6, 28, 3.2);
          else { g.beginPath(); g.arc(0, 0, 4.2, 0, TAU); g.fill(); }
          g.restore();
          // Shadow on the ground shows where it will land.
          if (t.z > 2) {
            g.globalAlpha = 0.25;
            g.fillStyle = '#000';
            g.beginPath();
            g.ellipse(t.x, t.y, 4, 2.4, 0, 0, TAU);
            g.fill();
            g.globalAlpha = 1;
          }
        },
      });
    }

    // Sort back-to-front and draw.
    list.sort((a, b) => a.y - b.y);
    for (const d of list) d.draw();

    // Fire areas emit light.
    for (const a of game.areas) {
      if (a.kind === 'fire') {
        this.lights.push({ x: a.x, y: a.y, radius: a.radius * 2.2, color: '#ff8c3a', intensity: a.intensity });
      }
    }
  }

  private drawHealthBar(
    g: CanvasRenderingContext2D, x: number, y: number, frac: number, scale: number, show: boolean,
  ): void {
    if (!show || frac >= 1) return;
    const w = 24 * scale;
    const yy = y - 20 * scale;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x - w / 2, yy, w, 3.2);
    g.fillStyle = frac > 0.5 ? '#63a84b' : frac > 0.22 ? '#c9a227' : '#a3251f';
    g.fillRect(x - w / 2, yy, w * clamp01(frac), 3.2);
  }

  // =========================================================================
  // Roofs
  // =========================================================================

  private drawRoofs(g: CanvasRenderingContext2D, view: { x: number; y: number; w: number; h: number }): void {
    const game = this.game;
    const inside = game.world.buildingAt(game.player.x, game.player.y);

    for (const b of game.world.buildings) {
      if (b === inside) continue;
      if (b.x + b.w < view.x || b.x > view.x + view.w || b.y + b.h < view.y || b.y > view.y + view.h) continue;
      this.drawRoof(g, b);
    }
  }

  /**
   * A building's roof, drawn as a lifted slab.
   *
   * Big flat roofs are the largest thing on screen in a town, so they get
   * per-building tonal variance, pitched shading, dense shingle courses and a
   * little rooftop clutter — otherwise a warehouse is a grey rectangle.
   */
  private drawRoof(g: CanvasRenderingContext2D, b: Building): void {
    const lift = 12;
    const x = b.x - 3, y = b.y - 3 - lift, w = b.w + 6, h = b.h + 6;

    // Per-building tone so neighbouring roofs don't merge into one mass.
    const tone = ((b.id * 2654435761) % 19) - 9;
    const base = shadeHex(b.roofColor, tone - 10);

    // Eaves shadow cast down-right onto the ground.
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fillRect(x + 5, y + 10, w, h);

    g.fillStyle = base;
    g.fillRect(x, y, w, h);

    const horizontal = b.w >= b.h;

    // Two pitches meeting at a ridge: light on the near slope, dark on the far.
    const grad = horizontal
      ? g.createLinearGradient(0, y, 0, y + h)
      : g.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.30)');
    grad.addColorStop(0.48, 'rgba(255,255,255,0.13)');
    grad.addColorStop(0.52, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0.34)');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);

    // Shingle courses, run perpendicular to the ridge.
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 1;
    const step = 7;
    g.beginPath();
    if (horizontal) {
      for (let yy = y + step; yy < y + h; yy += step) {
        g.moveTo(x, yy);
        g.lineTo(x + w, yy);
      }
    } else {
      for (let xx = x + step; xx < x + w; xx += step) {
        g.moveTo(xx, y);
        g.lineTo(xx, y + h);
      }
    }
    g.stroke();

    // Ridge cap.
    g.strokeStyle = shadeHex(b.roofColor, 34);
    g.lineWidth = 2.6;
    g.beginPath();
    if (horizontal) {
      g.moveTo(x, y + h / 2);
      g.lineTo(x + w, y + h / 2);
    } else {
      g.moveTo(x + w / 2, y);
      g.lineTo(x + w / 2, y + h);
    }
    g.stroke();

    // Outline and a highlight along the top edge for a sense of height.
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1.6;
    g.strokeRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(x, y, w, 2);

    // --- rooftop clutter ---
    const rand = (n: number) => ((b.id * 9301 + n * 49297) % 233280) / 233280;

    if (b.kind === 'house_small' || b.kind === 'house_large' || b.kind === 'farmhouse') {
      // Chimney.
      const chx = x + w * (0.6 + rand(1) * 0.25);
      const chy = y + h * (0.2 + rand(2) * 0.3);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(chx + 2, chy - 6, 14, 18);
      g.fillStyle = shadeHex(b.roofColor, -34);
      g.fillRect(chx, chy - 8, 14, 18);
      g.fillStyle = shadeHex(b.roofColor, 22);
      g.fillRect(chx, chy - 10, 14, 4);
    }

    if (b.kind === 'warehouse' || b.kind === 'apartment' || b.kind === 'police'
      || b.kind === 'clinic' || b.kind === 'barracks' || b.kind === 'shop'
      || b.kind === 'hardware_store') {
      // Air handling units and skylights on flat commercial roofs.
      const units = 2 + Math.floor(rand(3) * 3);
      for (let i = 0; i < units; i++) {
        const ux = x + 18 + rand(10 + i) * Math.max(8, w - 60);
        const uy = y + 18 + rand(20 + i) * Math.max(8, h - 50);
        const uw = 22 + rand(30 + i) * 16;
        const uh = 14 + rand(40 + i) * 10;
        g.fillStyle = 'rgba(0,0,0,0.32)';
        g.fillRect(ux + 3, uy + 3, uw, uh);
        g.fillStyle = shadeHex(b.roofColor, 20);
        g.fillRect(ux, uy, uw, uh);
        g.fillStyle = shadeHex(b.roofColor, -26);
        g.fillRect(ux + 2, uy + 2, uw - 4, uh * 0.45);
      }
      // A skylight with a dull sheen.
      const sx = x + w * 0.5 - 16, sy = y + h * (0.62 + rand(5) * 0.2);
      g.fillStyle = 'rgba(150,180,195,0.28)';
      g.fillRect(sx, sy, 32, 18);
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 1;
      g.strokeRect(sx, sy, 32, 18);
    }

    if (b.kind === 'barn') {
      // Hay door in the gable end.
      g.fillStyle = shadeHex(b.roofColor, -38);
      g.fillRect(x + w * 0.42, y + h * 0.06, w * 0.16, h * 0.14);
    }

    // Label discovered buildings so towns read at a glance.
    if (b.discovered && b.tier >= 2) {
      g.font = '10px Rajdhani, sans-serif';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillText(b.name.toUpperCase(), b.x + b.w / 2 + 1, b.y + b.h / 2 + 1);
      g.fillStyle = 'rgba(220,214,196,0.75)';
      g.fillText(b.name.toUpperCase(), b.x + b.w / 2, b.y + b.h / 2);
    }
  }

  // =========================================================================
  // Build ghost & interaction highlight
  // =========================================================================

  private drawBuildGhost(g: CanvasRenderingContext2D): void {
    const ghost = this.game.building.ghost;
    if (!ghost) return;
    g.globalAlpha = 0.5;
    g.fillStyle = ghost.valid ? '#63a84b' : '#a3251f';
    g.fillRect(ghost.x, ghost.y, ghost.w, ghost.h);
    g.globalAlpha = 1;
    g.strokeStyle = ghost.valid ? '#8fd070' : '#d05a50';
    g.lineWidth = 1.6;
    g.strokeRect(ghost.x, ghost.y, ghost.w, ghost.h);

    // Grid hint around the target cell.
    const cell = 96;
    const gx = Math.floor(ghost.x / cell) * cell;
    const gy = Math.floor(ghost.y / cell) * cell;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        g.strokeRect(gx + i * cell, gy + j * cell, cell, cell);
      }
    }
  }

  private drawInteractionHighlight(g: CanvasRenderingContext2D): void {
    const i = this.game.interaction;
    if (!i) return;
    // A subtle ring under the player showing reach.
    const p = this.game.player;
    g.strokeStyle = 'rgba(201,162,39,0.22)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.ellipse(p.x, p.y + 6, 52, 30, 0, 0, TAU);
    g.stroke();
  }

  // =========================================================================
  // Lighting
  // =========================================================================

  private drawLighting(
    g: CanvasRenderingContext2D, camX: number, camY: number, zoom: number, cw: number, ch: number,
  ): void {
    const game = this.game;
    const dn = game.dayNight;
    const darkness = clamp01(dn.darkness * 0.94 + dn.cloudDarkness * 0.45);

    // Night vision changes the whole look rather than just brightening.
    const nvg = game.player.hasNightVision && dn.darkness > 0.3;

    if (darkness < 0.02 && !nvg) { this.lights.length = 0; return; }

    const lc = this.lightCtx;
    const lw = this.lightCanvas.width;
    const lh = this.lightCanvas.height;
    const scale = lw / cw;

    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, lw, lh);

    // Base darkness, tinted blue for moonlight.
    const moon = dn.moonBrightness;
    const alpha = nvg ? darkness * 0.35 : darkness * (0.93 - moon * 0.1);
    lc.fillStyle = nvg ? `rgba(6,26,12,${alpha})` : `rgba(6,10,22,${alpha})`;
    lc.fillRect(0, 0, lw, lh);

    // Lightning briefly erases the night entirely.
    if (dn.lightningFlash > 0.01) {
      lc.globalCompositeOperation = 'destination-out';
      lc.fillStyle = `rgba(0,0,0,${dn.lightningFlash * 0.9})`;
      lc.fillRect(0, 0, lw, lh);
      lc.globalCompositeOperation = 'source-over';
    }

    // Player-held lights.
    const p = game.player;
    const held = p.heldItem ? itemDef(p.heldItem.id) : null;
    const heldLight = held?.light ?? 0;
    const attachLight = p.heldItem?.attachments?.includes('weapon_light') ? 260 : 0;

    if (heldLight > 0) {
      this.lights.push({ x: p.x, y: p.y, radius: heldLight, color: '#ffce7a', intensity: 1 });
    }
    if (p.flashlightOn && (p.countItem('flashlight') > 0 || attachLight > 0)) {
      this.lights.push({
        x: p.x, y: p.y, radius: Math.max(340, attachLight), color: '#fff3d0',
        intensity: 1, angle: p.facing, spread: 0.55,
      });
    }
    if (p.muzzleFlash > 0.05) {
      this.lights.push({ x: p.x, y: p.y, radius: 260, color: '#ffe2a0', intensity: p.muzzleFlash });
    }
    // Ambient vision so you're never totally blind.
    this.lights.push({ x: p.x, y: p.y, radius: nvg ? 640 : 150, color: '#c8d8ff', intensity: 0.85 });

    // Punch holes in the darkness.
    lc.globalCompositeOperation = 'destination-out';
    const toScreenX = (wx: number) => (cw / 2 + (wx - camX) * zoom) * scale;
    const toScreenY = (wy: number) => (ch / 2 + (wy - camY) * zoom) * scale;

    for (const light of this.lights) {
      const sx = toScreenX(light.x);
      const sy = toScreenY(light.y);
      const r = light.radius * zoom * scale;
      if (sx < -r || sy < -r || sx > lw + r || sy > lh + r) continue;

      if (light.angle !== undefined && light.spread !== undefined) {
        // Cone: a wedge with a soft gradient.
        const grad = lc.createRadialGradient(sx, sy, 0, sx, sy, r);
        grad.addColorStop(0, `rgba(0,0,0,${0.95 * light.intensity})`);
        grad.addColorStop(0.55, `rgba(0,0,0,${0.6 * light.intensity})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        lc.fillStyle = grad;
        lc.beginPath();
        lc.moveTo(sx, sy);
        lc.arc(sx, sy, r, light.angle - light.spread, light.angle + light.spread);
        lc.closePath();
        lc.fill();
      } else {
        const grad = lc.createRadialGradient(sx, sy, 0, sx, sy, r);
        grad.addColorStop(0, `rgba(0,0,0,${0.98 * light.intensity})`);
        grad.addColorStop(0.5, `rgba(0,0,0,${0.55 * light.intensity})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        lc.fillStyle = grad;
        lc.beginPath();
        lc.arc(sx, sy, r, 0, TAU);
        lc.fill();
      }
    }
    lc.globalCompositeOperation = 'source-over';

    // Composite the darkness over the scene.
    g.imageSmoothingEnabled = true;
    g.drawImage(this.lightCanvas, 0, 0, cw, ch);

    // Warm additive glow for the strongest lights.
    g.globalCompositeOperation = 'lighter';
    for (const light of this.lights) {
      if (light.intensity < 0.3 || light.color === '#c8d8ff') continue;
      const sx = cw / 2 + (light.x - camX) * zoom;
      const sy = ch / 2 + (light.y - camY) * zoom;
      const r = light.radius * zoom * 0.62;
      const grad = g.createRadialGradient(sx, sy, 0, sx, sy, r);
      grad.addColorStop(0, hexToRgba(light.color, 0.2 * light.intensity * darkness));
      grad.addColorStop(1, hexToRgba(light.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sx, sy, r, 0, TAU);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    this.lights.length = 0;
  }

  // =========================================================================
  // Weather
  // =========================================================================

  private drawWeather(
    g: CanvasRenderingContext2D, cw: number, ch: number, camX: number, camY: number, zoom: number,
  ): void {
    const dn = this.game.dayNight;

    // Fog: a flat wash plus a soft vignette.
    if (dn.fogIntensity > 0.02) {
      const f = dn.fogIntensity;
      g.fillStyle = `rgba(170,176,182,${f * 0.3})`;
      g.fillRect(0, 0, cw, ch);
      const grad = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.18, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
      grad.addColorStop(0, 'rgba(170,176,182,0)');
      grad.addColorStop(1, `rgba(170,176,182,${f * 0.62})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, cw, ch);
    }

    // Rain: streaks whose angle follows the wind.
    const rain = dn.rainIntensity;
    if (rain > 0.02) {
      const count = Math.floor(rain * 420);
      const windAngle = dn.windAngle;
      const lean = Math.cos(windAngle) * 14 * dn.windStrength;
      g.strokeStyle = `rgba(178,200,216,${0.22 + rain * 0.2})`;
      g.lineWidth = 1;
      g.beginPath();
      const t = this.time;
      for (let i = 0; i < count; i++) {
        // Deterministic per-drop offsets keep the rain from jittering.
        const seedX = valueNoise2(i, 1, 7) * cw;
        const seedY = valueNoise2(i, 2, 13);
        const speed = 900 + seedY * 700;
        const y = ((seedY * ch + t * speed) % (ch + 40)) - 20;
        const x = (seedX + Math.cos(windAngle) * t * 120) % cw;
        g.moveTo(x, y);
        g.lineTo(x + lean, y + 16 + rain * 10);
      }
      g.stroke();

      // Splash sparkle on the ground.
      if (rain > 0.5) {
        g.fillStyle = 'rgba(200,220,235,0.18)';
        for (let i = 0; i < 40; i++) {
          const x = (valueNoise2(i, 3, 29) * cw + Math.sin(t * 2 + i) * 6) % cw;
          const y = (valueNoise2(i, 4, 31) * ch + Math.cos(t * 3 + i) * 6) % ch;
          g.fillRect(x, y, 2, 1);
        }
      }
    }

    // Snow in the tundra.
    const biome = this.game.world.biomeAt(this.game.player.x, this.game.player.y);
    if (biome === (6 as Biome)) {
      g.fillStyle = 'rgba(240,246,252,0.5)';
      const t = this.time;
      for (let i = 0; i < 150; i++) {
        const sx = valueNoise2(i, 5, 41);
        const sy = valueNoise2(i, 6, 43);
        const x = ((sx * cw) + Math.sin(t * 0.6 + i) * 24) % cw;
        const y = ((sy * ch + t * (60 + sy * 80)) % (ch + 20)) - 10;
        g.beginPath();
        g.arc(x, y, 1.2 + sx, 0, TAU);
        g.fill();
      }
    }

    void camX; void camY; void zoom;
  }

  private drawBlind(g: CanvasRenderingContext2D, cw: number, ch: number): void {
    const b = this.game.effects.blind;
    if (b <= 0.01) return;
    g.fillStyle = `rgba(255,255,255,${Math.min(0.95, b)})`;
    g.fillRect(0, 0, cw, ch);
  }

  // =========================================================================
  // Maps
  // =========================================================================

  /** Bake a 1px-per-tile image of the whole island. */
  private buildWorldMap(): HTMLCanvasElement {
    const world = this.game.world;
    const c = document.createElement('canvas');
    c.width = world.tilesX;
    c.height = world.tilesY;
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);

    for (let ty = 0; ty < world.tilesY; ty++) {
      for (let tx = 0; tx < world.tilesX; tx++) {
        const tile = world.tileAtTile(tx, ty);
        const info = TILES[tile];
        const n = smoothNoise(tx / 5, ty / 5, world.data.seed + 3);
        const col = mix(info.c0, info.c1, n);
        const i = (ty * c.width + tx) * 4;
        img.data[i] = col[0];
        img.data[i + 1] = col[1];
        img.data[i + 2] = col[2];
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // Overlay building footprints so towns are legible.
    for (const b of world.buildings) {
      g.fillStyle = 'rgba(30,26,24,0.85)';
      g.fillRect(b.x / TILE_SIZE, b.y / TILE_SIZE, Math.max(1, b.w / TILE_SIZE), Math.max(1, b.h / TILE_SIZE));
    }
    return c;
  }

  private ensureWorldMap(): HTMLCanvasElement {
    if (!this.worldMap) this.worldMap = this.buildWorldMap();
    return this.worldMap;
  }

  private drawMinimap(): void {
    const canvas = document.getElementById('minimap') as HTMLCanvasElement | null;
    if (!canvas) return;
    const g = canvas.getContext('2d')!;
    const game = this.game;
    const map = this.ensureWorldMap();

    const size = canvas.width;
    // Show a window of the world around the player.
    const spanTiles = 74;
    const ptx = game.player.x / TILE_SIZE;
    const pty = game.player.y / TILE_SIZE;

    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1, 0, TAU);
    g.clip();

    g.imageSmoothingEnabled = false;
    g.drawImage(
      map,
      ptx - spanTiles / 2, pty - spanTiles / 2, spanTiles, spanTiles,
      0, 0, size, size,
    );

    const scale = size / spanTiles;
    const toX = (wx: number) => (wx / TILE_SIZE - (ptx - spanTiles / 2)) * scale;
    const toY = (wy: number) => (wy / TILE_SIZE - (pty - spanTiles / 2)) * scale;

    // Night darkens the minimap too.
    const dark = game.dayNight.darkness;
    if (dark > 0.05) {
      g.fillStyle = `rgba(8,12,24,${dark * 0.55})`;
      g.fillRect(0, 0, size, size);
    }

    // Threats and points of interest.
    for (const z of game.zombies) {
      if (!z.alive) continue;
      g.fillStyle = '#a3251f';
      g.fillRect(toX(z.x) - 1, toY(z.y) - 1, 2.4, 2.4);
    }
    for (const b of game.bandits) {
      if (!b.alive) continue;
      g.fillStyle = '#e0a02c';
      g.fillRect(toX(b.x) - 1, toY(b.y) - 1, 2.6, 2.6);
    }
    for (const a of game.animals) {
      if (!a.alive) continue;
      g.fillStyle = '#8a6a44';
      g.fillRect(toX(a.x) - 1, toY(a.y) - 1, 2, 2);
    }
    for (const h of game.horses) {
      if (!h.alive) continue;
      g.fillStyle = h.tamed ? '#63a84b' : '#c4a06a';
      g.fillRect(toX(h.x) - 1, toY(h.y) - 1, 2.4, 2.4);
    }
    for (const d of game.world.deployables) {
      g.fillStyle = d.lit ? '#ff9a3c' : '#6f8ab5';
      g.fillRect(toX(d.x) - 1, toY(d.y) - 1, 2.4, 2.4);
    }
    for (const gi of game.groundItems) {
      g.fillStyle = 'rgba(201,162,39,0.8)';
      g.fillRect(toX(gi.x) - 0.5, toY(gi.y) - 0.5, 1.6, 1.6);
    }

    // Player arrow.
    g.save();
    g.translate(size / 2, size / 2);
    g.rotate(game.player.facing);
    g.fillStyle = '#e8eef2';
    g.beginPath();
    g.moveTo(5, 0);
    g.lineTo(-3.4, 3);
    g.lineTo(-3.4, -3);
    g.closePath();
    g.fill();
    g.restore();

    g.restore();

    // Compass ring.
    g.strokeStyle = 'rgba(52,57,62,0.9)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1, 0, TAU);
    g.stroke();
    g.fillStyle = 'rgba(232,238,242,0.7)';
    g.font = 'bold 9px Rajdhani, sans-serif';
    g.textAlign = 'center';
    g.fillText('N', size / 2, 11);
  }

  /** Full-screen map, redrawn when opened. */
  drawBigMap(): void {
    const canvas = document.getElementById('bigmap') as HTMLCanvasElement | null;
    if (!canvas) return;
    const g = canvas.getContext('2d')!;
    const game = this.game;
    const map = this.ensureWorldMap();
    const size = canvas.width;

    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, size, size);
    g.drawImage(map, 0, 0, size, size);
    g.imageSmoothingEnabled = true;

    const scale = size / game.world.tilesX / TILE_SIZE;
    const toX = (wx: number) => wx * scale;
    const toY = (wy: number) => wy * scale;

    // Undiscovered regions stay fogged.
    g.fillStyle = 'rgba(8,10,12,0.55)';
    g.fillRect(0, 0, size, size);
    for (const t of game.world.towns) {
      if (!t.discovered) continue;
      const grad = g.createRadialGradient(toX(t.x), toY(t.y), 0, toX(t.x), toY(t.y), t.radius * scale * 2.2);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = grad;
      g.beginPath();
      g.arc(toX(t.x), toY(t.y), t.radius * scale * 2.2, 0, TAU);
      g.fill();
      g.restore();
    }
    // Always reveal where you are.
    {
      const grad = g.createRadialGradient(toX(game.player.x), toY(game.player.y), 0, toX(game.player.x), toY(game.player.y), 120);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = grad;
      g.beginPath();
      g.arc(toX(game.player.x), toY(game.player.y), 120, 0, TAU);
      g.fill();
      g.restore();
    }

    // Roads.
    g.strokeStyle = 'rgba(210,200,170,0.28)';
    g.lineWidth = 1.6;
    for (const road of game.world.data.roads) {
      g.beginPath();
      road.forEach((pt, i) => (i === 0 ? g.moveTo(toX(pt.x), toY(pt.y)) : g.lineTo(toX(pt.x), toY(pt.y))));
      g.stroke();
    }

    // Town markers.
    g.textAlign = 'center';
    for (const t of game.world.towns) {
      if (!t.discovered) continue;
      const x = toX(t.x), y = toY(t.y);
      const color = t.kind === 'military' ? '#a3251f' : t.tier >= 2 ? '#e0a02c' : '#c4b896';
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, t.tier >= 2 ? 5 : 3.5, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 1;
      g.stroke();

      g.font = `${t.tier >= 2 ? 'bold ' : ''}11px Rajdhani, sans-serif`;
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillText(t.name, x + 1, y - 7);
      g.fillStyle = color;
      g.fillText(t.name, x, y - 8);
    }

    // Player's base markers.
    for (const d of game.world.deployables) {
      if (d.kind !== 'sleeping_bag' && d.kind !== 'tool_cupboard') continue;
      g.fillStyle = '#63a84b';
      g.fillRect(toX(d.x) - 2.5, toY(d.y) - 2.5, 5, 5);
    }

    // Player.
    const px = toX(game.player.x), py = toY(game.player.y);
    g.save();
    g.translate(px, py);
    g.rotate(game.player.facing);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(8, 0);
    g.lineTo(-5, 5);
    g.lineTo(-5, -5);
    g.closePath();
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.stroke();
    g.restore();

    // Grid + coordinates.
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      g.beginPath();
      g.moveTo((size / 10) * i, 0);
      g.lineTo((size / 10) * i, size);
      g.stroke();
      g.beginPath();
      g.moveTo(0, (size / 10) * i);
      g.lineTo(size, (size / 10) * i);
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------------------

function shadeHex(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = clamp(((v >> 16) & 255) + amt, 0, 255);
  const g = clamp(((v >> 8) & 255) + amt, 0, 255);
  const b = clamp((v & 255) + amt, 0, 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,220,150,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

export { lerp };
