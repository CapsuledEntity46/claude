import * as THREE from 'three';
import type { GameContext, ProjectileRequest } from '../core/Context';
import { isSolid } from '../world/blocks';
import type { Enemy } from './Enemy';

const WORLD_GRAVITY = 26;
const MAX_LIFETIME = 8;
/** Substep length in blocks, chosen so fast bullets cannot tunnel through walls. */
const SUBSTEP = 0.45;

const GEO = {
  arrow: new THREE.BoxGeometry(0.05, 0.05, 0.9),
  bolt: new THREE.BoxGeometry(0.06, 0.06, 0.55),
  bullet: new THREE.SphereGeometry(0.055, 6, 5),
  grenade: new THREE.SphereGeometry(0.16, 8, 6),
  magic: new THREE.OctahedronGeometry(0.19, 0),
};

class Projectile {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly req: ProjectileRequest;
  readonly mesh: THREE.Mesh;

  life = MAX_LIFETIME;
  fuse: number;
  dead = false;

  private trailTimer = 0;
  private readonly bouncy: boolean;

  constructor(req: ProjectileRequest, material: THREE.Material, geometry: THREE.BufferGeometry) {
    this.req = req;
    this.position = req.origin.clone();
    this.velocity = req.direction.clone().normalize().multiplyScalar(req.speed);
    this.fuse = req.fuse ?? 0;
    this.bouncy = this.fuse > 0;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(this.position);
  }

  update(dt: number, ctx: GameContext): void {
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }

    if (this.fuse > 0) {
      this.fuse -= dt;
      if (this.fuse <= 0) {
        this.detonate(ctx);
        return;
      }
    }

    const gravityScale = this.req.gravity ?? 1;
    this.velocity.y -= WORLD_GRAVITY * gravityScale * dt;

    const travel = this.velocity.length() * dt;
    const steps = Math.max(1, Math.ceil(travel / SUBSTEP));
    const stepDt = dt / steps;

    for (let i = 0; i < steps && !this.dead; i++) {
      this.step(stepDt, ctx);
    }

    if (this.dead) return;

    this.mesh.position.copy(this.position);
    // Point physical projectiles along their flight path; spin the magical ones.
    if (this.req.look === 'magic' || this.req.look === 'grenade') {
      this.mesh.rotation.x += dt * 7;
      this.mesh.rotation.y += dt * 9;
    } else if (this.velocity.lengthSq() > 0.01) {
      this.mesh.lookAt(this.position.clone().add(this.velocity));
    }

    this.emitTrail(dt, ctx);
  }

  private step(dt: number, ctx: GameContext): void {
    const delta = this.velocity.clone().multiplyScalar(dt);
    const distance = delta.length();
    if (distance <= 0) return;
    const direction = delta.clone().divideScalar(distance);

    // --- world geometry -----------------------------------------------------
    const hit = ctx.world.raycast(this.position, direction, distance, isSolid);

    // --- actors -------------------------------------------------------------
    const nextPosition = this.position.clone().add(delta);
    if (this.req.hostile) {
      if (ctx.player.overlapsSphere(nextPosition, 0.35) && !ctx.player.dead) {
        this.hitPlayer(ctx, nextPosition);
        return;
      }
    } else {
      const target = this.findEnemyHit(ctx, nextPosition);
      if (target) {
        this.hitEnemy(ctx, target, nextPosition);
        return;
      }
    }

    if (hit) {
      const contact = hit.point.clone().addScaledVector(direction, -0.02);
      if (this.bouncy) {
        this.bounce(hit.nx, hit.ny, hit.nz, contact, ctx);
        return;
      }
      this.position.copy(contact);
      this.impactWorld(ctx);
      return;
    }

    this.position.copy(nextPosition);
  }

  private findEnemyHit(ctx: GameContext, at: THREE.Vector3): Enemy | null {
    for (const enemy of ctx.enemies.enemies) {
      if (enemy.dead) continue;
      const c = enemy.center;
      const dx = at.x - c.x;
      const dz = at.z - c.z;
      const dy = at.y - c.y;
      const r = enemy.radius + 0.25;
      // Capsule-ish test: generous horizontally, bounded by body height.
      if (dx * dx + dz * dz <= r * r && Math.abs(dy) <= enemy.height * 0.55) return enemy;
    }
    return null;
  }

  private bounce(nx: number, ny: number, nz: number, contact: THREE.Vector3, ctx: GameContext): void {
    this.position.copy(contact);
    const normal = new THREE.Vector3(nx, ny, nz);
    const dot = this.velocity.dot(normal);
    this.velocity.addScaledVector(normal, -2 * dot).multiplyScalar(0.36);
    ctx.particles.burst(contact, 3, 1.6, { color: 0x998877, size: 0.05, life: 0.25, gravity: 12 });
  }

  private hitPlayer(ctx: GameContext, at: THREE.Vector3): void {
    if ((this.req.aoeRadius ?? 0) > 0) {
      this.position.copy(at);
      this.detonate(ctx);
      return;
    }
    ctx.damagePlayer(
      {
        amount: this.req.damage,
        type: this.req.type,
        armorPierce: this.req.armorPierce,
        critChance: 0.05,
      },
      at,
      this.req.sourceName,
    );
    if (this.req.slow) ctx.player.stats.slowTimer = Math.max(ctx.player.stats.slowTimer, this.req.slow);
    ctx.particles.burst(at, 6, 3, { color: 0xaa2222, size: 0.07, life: 0.4, gravity: 14 });
    this.dead = true;
  }

  private hitEnemy(ctx: GameContext, enemy: Enemy, at: THREE.Vector3): void {
    if ((this.req.aoeRadius ?? 0) > 0) {
      this.position.copy(at);
      this.detonate(ctx);
      return;
    }
    ctx.enemies.damageEnemy(
      enemy,
      {
        amount: this.req.damage,
        type: this.req.type,
        armorPierce: this.req.armorPierce,
        critChance: 0.1,
      },
      at,
      this.req.knockback,
    );
    if (this.req.slow) enemy.applySlow(this.req.slow);
    this.dead = true;
  }

  private impactWorld(ctx: GameContext): void {
    if ((this.req.aoeRadius ?? 0) > 0) {
      this.detonate(ctx);
      return;
    }
    const color = this.req.look === 'magic' ? this.req.color ?? 0xaa66ff : 0x998877;
    ctx.particles.burst(this.position, 5, 2.2, { color, size: 0.06, life: 0.3, gravity: 14 });
    this.dead = true;
  }

  private detonate(ctx: GameContext): void {
    this.dead = true;
    ctx.explode(
      this.position,
      this.req.aoeRadius ?? 3,
      this.req.damage,
      this.req.type,
      this.req.armorPierce,
      this.req.blockDamage ?? 0,
      this.req.hostile,
      this.req.sourceName,
    );
  }

  private emitTrail(dt: number, ctx: GameContext): void {
    if (this.req.look !== 'magic' && this.req.look !== 'grenade') return;
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return;
    this.trailTimer = 0.02;
    const color = this.req.look === 'grenade' ? 0x776655 : this.req.color ?? 0xaa66ff;
    ctx.particles.spawn(
      this.position,
      new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.4, (Math.random() - 0.5) * 0.6),
      { color, size: this.req.look === 'grenade' ? 0.07 : 0.12, life: 0.35, gravity: -2, drag: 2 },
    );
  }
}

/**
 * Owns every in-flight projectile: arrows, bolts, lead shot, grenades, and
 * spell bolts all share the same integrator and collision path.
 */
export class ProjectileManager {
  readonly group = new THREE.Group();
  private live: Projectile[] = [];
  private materialCache = new Map<string, THREE.Material>();

  constructor() {
    this.group.name = 'projectiles';
  }

  get count(): number {
    return this.live.length;
  }

  spawn(req: ProjectileRequest): void {
    const look = req.look ?? 'arrow';
    const geometry = GEO[look];
    const material = this.material(look, req.color ?? defaultColor(look));
    const p = new Projectile(req, material, geometry);
    this.live.push(p);
    this.group.add(p.mesh);
  }

  private material(look: string, color: number): THREE.Material {
    const key = `${look}:${color}`;
    let m = this.materialCache.get(key);
    if (!m) {
      // Magic bolts read better unlit so they glow against dark terrain.
      m = look === 'magic'
        ? new THREE.MeshBasicMaterial({ color })
        : new THREE.MeshLambertMaterial({ color });
      this.materialCache.set(key, m);
    }
    return m;
  }

  update(dt: number, ctx: GameContext): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.update(dt, ctx);
      if (p.dead) {
        this.group.remove(p.mesh);
        this.live.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const p of this.live) this.group.remove(p.mesh);
    this.live.length = 0;
  }
}

function defaultColor(look: string): number {
  switch (look) {
    case 'arrow':
      return 0xc8b48a;
    case 'bolt':
      return 0x8a8a94;
    case 'bullet':
      return 0x2a2a2e;
    case 'grenade':
      return 0x3a3a34;
    default:
      return 0xaa66ff;
  }
}
