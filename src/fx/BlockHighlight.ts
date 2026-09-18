import * as THREE from 'three';

const STAGES = 10;
const TEXTURE_SIZE = 64;

/**
 * Minecraft-style mining feedback: a black outline on the targeted block, plus a
 * crack overlay that advances through ten stages as the block breaks.
 *
 * Crack textures are generated on a canvas at load time so the project stays
 * asset-free. Each stage redraws every earlier stage's cracks, so damage visibly
 * accumulates instead of flickering between unrelated patterns.
 */
function buildCrackTextures(): THREE.Texture[] {
  const textures: THREE.Texture[] = [];

  // A fixed set of crack seeds, so stage N always contains stage N-1's cracks.
  const seeds = Array.from({ length: STAGES }, (_, i) => (i * 2654435761) % 4294967296);

  for (let stage = 0; stage < STAGES; stage++) {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    for (let s = 0; s <= stage; s++) {
      let seed = seeds[s];
      const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      // Each stage adds one crack radiating from near the centre.
      const cracksThisStage = 2;
      for (let c = 0; c < cracksThisStage; c++) {
        let x = TEXTURE_SIZE / 2 + (random() - 0.5) * 14;
        let y = TEXTURE_SIZE / 2 + (random() - 0.5) * 14;
        let angle = random() * Math.PI * 2;

        // Cracks widen and lengthen with the stage. Kept thin: heavy strokes
        // read as scribble rather than fracture.
        ctx.strokeStyle = `rgba(12, 10, 10, ${0.42 + stage * 0.045})`;
        ctx.lineWidth = 0.7 + stage * 0.13;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y);

        const segments = 3 + Math.floor(stage * 0.7);
        for (let i = 0; i < segments; i++) {
          // Small angle changes keep cracks looking brittle and straight-ish.
          angle += (random() - 0.5) * 0.7;
          const length = 2.5 + random() * (2.5 + stage * 0.5);
          x += Math.cos(angle) * length;
          y += Math.sin(angle) * length;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    // Nearest filtering keeps the cracks crisp and blocky, matching the art.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    textures.push(texture);
  }

  return textures;
}

export class BlockHighlight {
  readonly group = new THREE.Group();

  private outline: THREE.LineSegments;
  private crack: THREE.Mesh;
  private crackTextures: THREE.Texture[];
  private crackMaterial: THREE.MeshBasicMaterial;
  private currentStage = -1;

  constructor() {
    this.group.name = 'block-highlight';
    this.group.visible = false;

    const box = new THREE.BoxGeometry(1, 1, 1);

    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    // Slightly inflated so the outline does not z-fight with the block's faces.
    this.outline.scale.setScalar(1.004);

    this.crackTextures = buildCrackTextures();
    this.crackMaterial = new THREE.MeshBasicMaterial({
      map: this.crackTextures[0],
      transparent: true,
      depthWrite: false,
      // Pull the overlay towards the viewer so it wins the depth test cleanly.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.crack = new THREE.Mesh(box, this.crackMaterial);
    this.crack.scale.setScalar(1.002);
    this.crack.visible = false;

    this.group.add(this.outline, this.crack);
  }

  /**
   * Shows the highlight on a block.
   * @param progress 0..1 mining progress, or a negative value for "not mining"
   */
  show(x: number, y: number, z: number, progress: number): void {
    this.group.visible = true;
    this.group.position.set(x + 0.5, y + 0.5, z + 0.5);

    if (progress < 0) {
      this.crack.visible = false;
      this.outline.scale.setScalar(1.004);
      return;
    }

    const stage = Math.min(STAGES - 1, Math.max(0, Math.floor(progress * STAGES)));
    if (stage !== this.currentStage) {
      this.currentStage = stage;
      this.crackMaterial.map = this.crackTextures[stage];
      this.crackMaterial.needsUpdate = true;
    }
    this.crack.visible = true;

    // A subtle swell as the block nears breaking, so it feels under strain.
    const swell = 1.004 + progress * 0.03;
    this.outline.scale.setScalar(swell);
    this.crack.scale.setScalar(swell - 0.002);
  }

  hide(): void {
    this.group.visible = false;
    this.crack.visible = false;
    this.currentStage = -1;
  }
}
