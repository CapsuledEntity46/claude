/**
 * Bakes the authored block GLBs down into atlas tiles.
 *
 * The GLBs in `assets/blocks/` are Blender cubes with Ucupaint-baked 1024px
 * colour, normal and roughness maps — about 2.5 MB each, 7.3 MB for the three.
 * Shipping that to a browser to texture three block types would be absurd, and
 * the mesh itself is a cube we already have. So this script runs offline and
 * writes the only thing the game actually needs: small colour tiles, committed
 * to `public/textures/`.
 *
 *     npm run tiles
 *
 * Three things it does that are not obvious:
 *
 * - **It reads the UV layout rather than assuming one.** A Blender default cube
 *   unwrap is a cross on a 4x4 grid of 0.25 cells, so each face is a 256px
 *   region and most of the image is unused background. Slicing the image naively
 *   would texture blocks with that flat grey filler.
 *
 * - **It bakes relief from the normal map into the colour.** The terrain material
 *   is `MeshLambertMaterial` with a single `map` and no normal map, so surface
 *   relief has nowhere to come from at runtime. Sand is the proof: its colour map
 *   has a luma stdev of 0.017, which is flat enough that the smoke suite's
 *   "every tile carries visible detail" check rejects it. Its *normal* map is
 *   full of ripples. Lighting the normal map from a fixed direction and
 *   multiplying it in puts that relief where the renderer can see it, which is
 *   the same trick the mesher already plays with CUBE_FACE_SHADE.
 *
 * - **It tone-maps to a target mean *and* a target contrast.** Rock bakes at a
 *   mean luma of 0.34 and has to land near the 0.49 the flat-coloured block used
 *   to render at. Multiplying by 1.6 clips every highlight; `pow(x, g)` with g
 *   solved from the means hits the target exactly, keeps the top end intact, and
 *   opens up the shadows. Contrast then gets its own pass, because brightness and
 *   contrast fight each other here: relief is multiplied in linear light, which
 *   is correct, but sRGB encoding then compresses that variation by roughly the
 *   2.4 exponent — a normal map with an N·L spread of 0.21 came out as a tile
 *   with a luma stdev of 0.043, which the smoke suite's detail check rejects.
 *   Solving a stretch factor from the measured stdev makes the outcome a
 *   guarantee rather than a hope.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'assets', 'blocks');
const OUT_DIR = join(ROOT, 'public', 'textures');

/** Edge of one output tile, matching TILE_PIXELS in src/world/textures.ts. */
const TILE = 128;
/** Variants per block type. Two is what breaks up the per-block repeat. */
const VARIANTS = 2;

/**
 * What to bake, and what each one has to look like when it gets there.
 *
 * `targetMean` is a luma the tile should average once everything is applied. It
 * is pitched at roughly what the block's old flat colour rendered at, so turning
 * a texture on does not visibly darken the world: Stone was 0.49, Sand 0.85,
 * Terracotta about 0.42. Slightly above those, because a texture's mean sits
 * under its own highlights.
 */
const JOBS = [
  { source: 'rock.glb', out: 'rock.png', targetMean: 0.56, targetStdev: 0.11, relief: 1.3, saturation: 1.0 },
  // Less relief than grey rock, despite near-identical source maps. Its normal map
  // is strongly directional, and the badlands are the one biome built out of long
  // open slopes — at 1.3 the lighting streaks lined up across hundreds of blocks
  // and the whole hillside read as corduroy. Backing it off lets the contrast
  // stretch pull detail out of the albedo, which has no direction to it.
  { source: 'red-rock.glb', out: 'red-rock.png', targetMean: 0.52, targetStdev: 0.1, relief: 0.85, saturation: 1.1 },
  // Sand gets the most relief and the lowest contrast target of the three: its
  // colour map is genuinely almost featureless (stdev 0.017), so what detail it
  // has on screen is very nearly all coming from its normal map's ripples.
  { source: 'sand.glb', out: 'sand.png', targetMean: 0.8, targetStdev: 0.09, relief: 1.9, saturation: 1.1 },
];

/**
 * The six face regions of a Blender default cube unwrap, as (u, v) origins of
 * 0.25-wide cells. Verified against the mesh's own TEXCOORD_0 accessor, whose 24
 * UVs collapse to exactly these fourteen corners.
 */
const FACE_CELLS = [
  [0.375, 0.0],
  [0.125, 0.25],
  [0.375, 0.25],
  [0.625, 0.25],
  [0.375, 0.5],
  [0.375, 0.75],
];
const CELL = 0.25;

// --------------------------------------------------------------- glTF reading

/** Parses a binary glTF container into its JSON chunk and a view of its BIN chunk. */
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: not a GLB`);

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', start, start + length));
    else if (type === 'BIN\0') bin = buf.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error(`${path}: no JSON chunk`);
  if (!bin) throw new Error(`${path}: no BIN chunk`);
  return { json, bin };
}

/**
 * Decodes one of the material's embedded images, chosen by glTF role.
 *
 * Selected through `materials[0]` rather than by image name: the names here come
 * from whichever texturing addon authored the file, and keying on them would
 * break the moment someone exports from a different tool.
 */
function decodeImage(glb, role) {
  const material = glb.json.materials?.[0];
  if (!material) throw new Error('no material');

  const textureIndex =
    role === 'color'
      ? material.pbrMetallicRoughness?.baseColorTexture?.index
      : material.normalTexture?.index;
  if (textureIndex === undefined) throw new Error(`no ${role} texture`);

  const image = glb.json.images[glb.json.textures[textureIndex].source ?? textureIndex];
  const view = glb.json.bufferViews[image.bufferView];
  const start = view.byteOffset ?? 0;
  return PNG.sync.read(glb.bin.subarray(start, start + view.byteLength));
}

// ------------------------------------------------------------------ transfer

/**
 * sRGB transfer functions.
 *
 * Averaging four sRGB bytes is not the average of the light they represent, and
 * a 2x box filter done in sRGB comes out measurably dark. Every resample below
 * goes through linear light.
 */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

const LINEAR_FROM_BYTE = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR_FROM_BYTE[i] = toLinear(i / 255);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

// -------------------------------------------------------------------- baking

/**
 * Lifts a face region out of an image into a linear-light RGB float buffer,
 * box-filtered down to `TILE` on the way.
 */
function sampleFace(png, cell, size) {
  const x0 = Math.round(cell[0] * png.width);
  const y0 = Math.round(cell[1] * png.height);
  const span = Math.round(CELL * png.width);
  const step = span / size;
  const out = new Float32Array(size * size * 3);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Average every source pixel falling under this output pixel, so the
      // filter stays correct if the source is not an exact power-of-two multiple.
      const sx0 = Math.floor(x * step);
      const sy0 = Math.floor(y * step);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * step));
      const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * step));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = ((y0 + sy) * png.width + (x0 + sx)) * 4;
          r += LINEAR_FROM_BYTE[png.data[o]];
          g += LINEAR_FROM_BYTE[png.data[o + 1]];
          b += LINEAR_FROM_BYTE[png.data[o + 2]];
          n++;
        }
      }
      const i = (y * size + x) * 3;
      out[i] = r / n;
      out[i + 1] = g / n;
      out[i + 2] = b / n;
    }
  }
  return out;
}

/**
 * Directional shading from a tangent-space normal map, as a multiplier per pixel.
 *
 * glTF normal maps are OpenGL-convention (+Y up), encoded with 0.5 as zero, so
 * the vector is `2c - 1`. The light comes from the upper left and slightly
 * towards the viewer, which is the direction the rest of the game's baked
 * shading already implies.
 *
 * Normals are read as *raw bytes*, not through the sRGB curve: a normal map is
 * vector data that happens to live in an image, and linearising it would bend
 * every vector towards the surface.
 */
function reliefFromNormal(png, cell, size, strength) {
  const x0 = Math.round(cell[0] * png.width);
  const y0 = Math.round(cell[1] * png.height);
  const span = Math.round(CELL * png.width);
  const step = span / size;

  const lx = -0.45;
  const ly = 0.5;
  const lz = 0.74;
  const llen = Math.hypot(lx, ly, lz);

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor(x * step);
      const sy0 = Math.floor(y * step);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * step));
      const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * step));
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = ((y0 + sy) * png.width + (x0 + sx)) * 4;
          nx += (png.data[o] / 255) * 2 - 1;
          ny += (png.data[o + 1] / 255) * 2 - 1;
          nz += (png.data[o + 2] / 255) * 2 - 1;
          n++;
        }
      }
      nx /= n;
      ny /= n;
      nz /= n;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      const ndotl = (nx * lx + ny * ly + nz * lz) / (nlen * llen);

      // Centred on 1.0 so the relief darkens and brightens around the albedo
      // instead of only ever darkening it, which would just dim the tile.
      out[y * size + x] = 1 + strength * (ndotl - 0.62);
    }
  }
  return out;
}

/** Multiplies baked relief into a linear albedo buffer, in place. */
function applyRelief(rgb, relief) {
  for (let p = 0; p < relief.length; p++) {
    const m = relief[p] < 0 ? 0 : relief[p];
    const i = p * 3;
    rgb[i] *= m;
    rgb[i + 1] *= m;
    rgb[i + 2] *= m;
  }
  return rgb;
}

/**
 * Pushes a tile to a target mean luma and a target contrast, and optionally
 * pushes chroma away from grey.
 *
 * Both controls are *solved* from what the tile measures rather than tuned by
 * hand, so re-authoring a GLB cannot silently change how bright the world is:
 *
 * - Mean, via a gamma curve. `pow(mean, g) = target` gives
 *   `g = ln(target) / ln(mean)`. Applied in sRGB space on purpose — this is a
 *   look control, not a physical operation, and a perceptual curve is what makes
 *   "brighten the midtones without blowing the highlights" behave as the eye
 *   expects. A multiply would clip instead.
 *
 * - Contrast, via a stretch about the mean: `out = mean + (in - mean) * k` with
 *   `k = targetStdev / measured`. Capped, because an uncapped factor on a nearly
 *   flat source amplifies 8-bit quantisation into visible banding rather than
 *   inventing detail that was never there.
 *
 * Clamping during the stretch drags the mean a little, so the gamma is solved a
 * second time afterwards to put it back.
 */
const MAX_CONTRAST_STRETCH = 4;

function lumaStats(values, pixels) {
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    const l = luma(values[i], values[i + 1], values[i + 2]);
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / pixels;
  return { mean, stdev: Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)) };
}

/** Solves the gamma that moves `mean` onto `target`, or 1 where that is undefined. */
function gammaFor(mean, target) {
  return mean > 0.001 && mean < 0.999 ? Math.log(target) / Math.log(mean) : 1;
}

function tone(rgb, size, targetMean, targetStdev, saturation) {
  const pixels = size * size;

  // Into perceptual space, where every control below is defined.
  const work = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels * 3; i++) work[i] = toSrgb(clamp01(rgb[i]));

  const before = lumaStats(work, pixels);

  const gamma = gammaFor(before.mean, targetMean);
  for (let i = 0; i < pixels * 3; i++) work[i] = Math.pow(work[i], gamma);

  const lifted = lumaStats(work, pixels);
  const stretch = Math.min(MAX_CONTRAST_STRETCH, Math.max(1, targetStdev / Math.max(1e-6, lifted.stdev)));
  if (stretch > 1) {
    for (let i = 0; i < pixels * 3; i++) {
      work[i] = clamp01(lifted.mean + (work[i] - lifted.mean) * stretch);
    }
  }

  // The stretch clamps at both ends, which shifts the mean off target; put it back.
  const stretched = lumaStats(work, pixels);
  const correction = gammaFor(stretched.mean, targetMean);

  const out = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    let r = Math.pow(work[i], correction);
    let g = Math.pow(work[i + 1], correction);
    let b = Math.pow(work[i + 2], correction);

    if (saturation !== 1) {
      const l = luma(r, g, b);
      r = clamp01(l + (r - l) * saturation);
      g = clamp01(l + (g - l) * saturation);
      b = clamp01(l + (b - l) * saturation);
    }

    out[i] = Math.round(clamp01(r) * 255);
    out[i + 1] = Math.round(clamp01(g) * 255);
    out[i + 2] = Math.round(clamp01(b) * 255);
  }
  return { pixels: out, gamma, stretch, meanBefore: before.mean };
}

/** Mean and standard deviation of a tile's luma, in the units the smoke test uses. */
function stats(pixels, size) {
  let sum = 0;
  let sumSq = 0;
  const n = size * size;
  for (let p = 0; p < n; p++) {
    const i = p * 3;
    // Rec.601, to match atlasTileStats in src/world/textures.ts.
    const l = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) / 255;
    sum += l;
    sumSq += l * l;
  }
  const mean = sum / n;
  return { mean, stdev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/**
 * Chooses which cube faces to ship as the variants.
 *
 * All six faces are baked from the same material, so any of them reads as the
 * right rock — but two *similar* ones would waste the variant slot that exists
 * to break up the per-block repeat. This picks the pair that differs most.
 */
function pickVariantFaces(faces, size) {
  let best = [0, 1];
  let bestDistance = -1;
  for (let a = 0; a < faces.length; a++) {
    for (let b = a + 1; b < faces.length; b++) {
      let sum = 0;
      for (let i = 0; i < size * size * 3; i += 3) sum += Math.abs(faces[a][i] - faces[b][i]);
      if (sum > bestDistance) {
        bestDistance = sum;
        best = [a, b];
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------- main

if (!existsSync(SOURCE_DIR)) {
  console.error(`no ${SOURCE_DIR} — put the block GLBs there`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

for (const job of JOBS) {
  const path = join(SOURCE_DIR, job.source);
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }

  const glb = readGlb(path);
  const color = decodeImage(glb, 'color');
  const normal = decodeImage(glb, 'normal');

  const baked = FACE_CELLS.map((cell) => {
    const albedo = sampleFace(color, cell, TILE);
    return applyRelief(albedo, reliefFromNormal(normal, cell, TILE, job.relief));
  });

  const chosen = pickVariantFaces(baked, TILE);

  // Variants sit side by side in one sheet, so the runtime fetches one file per
  // block type and slices it.
  const sheet = new PNG({ width: TILE * VARIANTS, height: TILE });
  const report = [];
  chosen.forEach((faceIndex, slot) => {
    const { pixels, gamma, stretch, meanBefore } = tone(
      baked[faceIndex],
      TILE,
      job.targetMean,
      job.targetStdev,
      job.saturation,
    );
    const measured = stats(pixels, TILE);
    report.push(
      `face${faceIndex} mean ${meanBefore.toFixed(3)}->${measured.mean.toFixed(3)} ` +
        `stdev ${measured.stdev.toFixed(3)} gamma ${gamma.toFixed(3)} stretch ${stretch.toFixed(2)}`,
    );
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const src = (y * TILE + x) * 3;
        const dst = (y * sheet.width + slot * TILE + x) << 2;
        sheet.data[dst] = pixels[src];
        sheet.data[dst + 1] = pixels[src + 1];
        sheet.data[dst + 2] = pixels[src + 2];
        sheet.data[dst + 3] = 255;
      }
    }
  });

  const outPath = join(OUT_DIR, job.out);
  writeFileSync(outPath, PNG.sync.write(sheet, { deflateLevel: 9 }));
  const kb = (readFileSync(outPath).length / 1024).toFixed(1);
  console.log(`${job.out.padEnd(13)} ${sheet.width}x${sheet.height}  ${kb.padStart(6)} KB  ${report.join('  |  ')}`);
}
