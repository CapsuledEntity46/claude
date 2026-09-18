import * as THREE from 'three';
import type { DungeonGenerator } from '../world/Dungeon';
import { propsForSite, type DungeonProp } from '../world/DungeonProps';
import { buildMergedProp, PROP_KINDS, type PropKind } from './props';

/**
 * Draws dungeon props around the player.
 *
 * One `InstancedMesh` per prop kind, so a corridor lined with twenty arches costs a
 * single draw call rather than twenty. Props are pure decoration — collision and
 * light come from voxels the generator writes underneath them — so this can be
 * rebuilt freely without touching the simulation.
 *
 * Rebuilds are driven by *which sites are nearby*, not by the player's position, so
 * walking around inside one dungeon never re-uploads a single matrix. Crossing into
 * range of a new site does.
 */

/** Per-kind instance ceiling. Columns are the most numerous by a wide margin. */
const MAX_INSTANCES = 700;
/** How far out props are drawn, in blocks. Beyond this they are not worth the cost. */
const PROP_RADIUS = 110;

interface KindMeshes {
  solid: THREE.InstancedMesh;
  glow: THREE.InstancedMesh | null;
}

export class PropManager {
  readonly group = new THREE.Group();

  private readonly meshes = new Map<PropKind, KindMeshes>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  /** Which sites the current instance data was built from. */
  private builtKey = '';
  private visibleCount = 0;
  private overflowed = false;
  /**
   * Props within 24 blocks of the player.
   *
   * The total across every nearby site says nothing about whether the room you are
   * standing in has any furniture — which is exactly the failure this was written to
   * catch: hundreds of props placed across a site, none of them in the room.
   */
  private nearCount = 0;

  constructor() {
    this.group.name = 'dungeon-props';

    const solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    // Fire and embers: unlit, so they stay bright in a pitch-dark room.
    const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });

    for (const kind of PROP_KINDS) {
      const merged = buildMergedProp(kind);
      const solid = new THREE.InstancedMesh(merged.solid, solidMaterial, MAX_INSTANCES);
      solid.count = 0;
      solid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instanced bounds are computed from one instance's geometry, so the built-in
      // frustum test would cull the whole batch as soon as the origin instance left
      // the view. There are few enough props that always drawing them is cheaper
      // than getting this right.
      solid.frustumCulled = false;
      solid.name = `prop-${kind}`;

      let glow: THREE.InstancedMesh | null = null;
      if (merged.glow) {
        glow = new THREE.InstancedMesh(merged.glow, glowMaterial, MAX_INSTANCES);
        glow.count = 0;
        glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        glow.frustumCulled = false;
        glow.name = `prop-${kind}-glow`;
      }

      this.meshes.set(kind, { solid, glow });
      this.group.add(solid);
      if (glow) this.group.add(glow);
    }
  }

  /** Rebuilds instance data if the set of nearby dungeon sites has changed. */
  update(playerPosition: THREE.Vector3, dungeons: DungeonGenerator): void {
    const sites = dungeons.sitesNear(
      playerPosition.x - PROP_RADIUS,
      playerPosition.z - PROP_RADIUS,
      playerPosition.x + PROP_RADIUS,
      playerPosition.z + PROP_RADIUS,
    );

    const key = sites
      .map((site) => `${site.gx},${site.gz}`)
      .sort()
      .join('|');
    if (key === this.builtKey) return;
    this.builtKey = key;

    const byKind = new Map<PropKind, DungeonProp[]>();
    for (const site of sites) {
      for (const prop of propsForSite(site, dungeons.seed)) {
        let list = byKind.get(prop.kind);
        if (!list) byKind.set(prop.kind, (list = []));
        list.push(prop);
      }
    }

    this.visibleCount = 0;
    this.overflowed = false;
    for (const [kind, entry] of this.meshes) {
      const props = byKind.get(kind) ?? [];
      const count = Math.min(props.length, MAX_INSTANCES);
      if (props.length > MAX_INSTANCES) this.overflowed = true;

      for (let i = 0; i < count; i++) {
        const prop = props[i];
        this.position.set(prop.x, prop.y, prop.z);
        this.quaternion.setFromAxisAngle(this.up, prop.rotationY);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        entry.solid.setMatrixAt(i, this.matrix);
        entry.glow?.setMatrixAt(i, this.matrix);
      }

      entry.solid.count = count;
      entry.solid.instanceMatrix.needsUpdate = true;
      if (entry.glow) {
        entry.glow.count = count;
        entry.glow.instanceMatrix.needsUpdate = true;
      }
      this.visibleCount += count;
    }

    this.nearCount = 0;
    for (const props of byKind.values()) {
      for (const prop of props) {
        if (Math.hypot(prop.x - playerPosition.x, prop.z - playerPosition.z) <= 24) this.nearCount++;
      }
    }
  }

  /** Prop counts by kind, for tests and diagnosis. */
  debugState(): Record<string, unknown> {
    const perKind: Record<string, number> = {};
    for (const [kind, entry] of this.meshes) {
      if (entry.solid.count > 0) perKind[kind] = entry.solid.count;
    }
    return {
      total: this.visibleCount,
      kinds: Object.keys(perKind).length,
      perKind,
      /** Props within sight of the player, which is what actually reads on screen. */
      nearPlayer: this.nearCount,
      // True if any kind hit the ceiling, which would mean props silently missing.
      overflowed: this.overflowed,
      drawCalls: this.group.children.filter((c) => (c as THREE.InstancedMesh).count > 0).length,
    };
  }
}
