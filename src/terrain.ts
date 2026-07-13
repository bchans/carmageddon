import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";

/** Square terrain: world spans [-size/2, size/2] on both X and Z. */
export const TERRAIN_SIZE = 240;
export const TERRAIN_SEGMENTS = 120; // vertices per side = SEGMENTS + 1
const GRID = TERRAIN_SEGMENTS + 1;
const SPACING = TERRAIN_SIZE / TERRAIN_SEGMENTS;

const WATER_LEVEL = 0.4;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function idx(iy: number, ix: number): number {
  return iy * GRID + ix;
}

export class Terrain {
  readonly heights: Float32Array;
  readonly isRiver: Uint8Array;
  readonly mesh: THREE.Mesh;
  readonly waterMesh: THREE.Mesh;
  readonly collider: RAPIER.Collider;
  readonly rigidBody: RAPIER.RigidBody;

  private constructor(
    heights: Float32Array,
    isRiver: Uint8Array,
    mesh: THREE.Mesh,
    waterMesh: THREE.Mesh,
    rigidBody: RAPIER.RigidBody,
    collider: RAPIER.Collider,
  ) {
    this.heights = heights;
    this.isRiver = isRiver;
    this.mesh = mesh;
    this.waterMesh = waterMesh;
    this.rigidBody = rigidBody;
    this.collider = collider;
  }

  static generate(RAPIER: Rapier, world: RAPIER.World, seed: number): Terrain {
    const rng = mulberry32(seed);
    const noise2D = createNoise2D(rng);
    const heights = new Float32Array(GRID * GRID);

    // Base heightmap: fractal Brownian motion (layered noise).
    const baseFreq = 1 / 90;
    const octaves = 5;
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const x = -TERRAIN_SIZE / 2 + ix * SPACING;
        const z = -TERRAIN_SIZE / 2 + iy * SPACING;
        let amplitude = 1;
        let frequency = baseFreq;
        let sum = 0;
        let maxAmp = 0;
        for (let o = 0; o < octaves; o++) {
          sum += noise2D(x * frequency, z * frequency) * amplitude;
          maxAmp += amplitude;
          amplitude *= 0.5;
          frequency *= 2;
        }
        const n = sum / maxAmp; // roughly [-1, 1]
        // Push extremes apart a bit so we get flatter plains and clearer hills.
        const shaped = Math.sign(n) * Math.pow(Math.abs(n), 1.3);
        heights[idx(iy, ix)] = shaped * 9 + 3; // ~[-6, 12]-ish, biased above water
      }
    }

    const isRiver = new Uint8Array(GRID * GRID);
    const riverCount = 2;
    for (let r = 0; r < riverCount; r++) {
      carveRiver(heights, isRiver, rng);
    }

    smooth(heights, 1);

    const mesh = buildMesh(heights, isRiver);
    const waterMesh = buildWater();

    const rigidBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Rapier's heightfield buffer is indexed transposed relative to the row-major
    // (iy*GRID+ix) layout used for THREE's vertex positions above — verified
    // empirically: without transposing, world X/Z sampling comes out swapped.
    const colliderHeights = new Float32Array(GRID * GRID);
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        colliderHeights[ix * GRID + iy] = heights[idx(iy, ix)];
      }
    }
    const colliderDesc = RAPIER.ColliderDesc.heightfield(
      TERRAIN_SEGMENTS,
      TERRAIN_SEGMENTS,
      colliderHeights,
      { x: TERRAIN_SIZE, y: 1, z: TERRAIN_SIZE },
    ).setFriction(1.0);
    const collider = world.createCollider(colliderDesc, rigidBody);

    return new Terrain(heights, isRiver, mesh, waterMesh, rigidBody, collider);
  }

  /** Bilinear-interpolated terrain height at a world-space (x, z) coordinate. */
  getHeightAt(x: number, z: number): number {
    const fx = (x + TERRAIN_SIZE / 2) / SPACING;
    const fz = (z + TERRAIN_SIZE / 2) / SPACING;
    const ix = THREE.MathUtils.clamp(Math.floor(fx), 0, GRID - 2);
    const iy = THREE.MathUtils.clamp(Math.floor(fz), 0, GRID - 2);
    const tx = THREE.MathUtils.clamp(fx - ix, 0, 1);
    const tz = THREE.MathUtils.clamp(fz - iy, 0, 1);

    const h00 = this.heights[idx(iy, ix)];
    const h10 = this.heights[idx(iy, ix + 1)];
    const h01 = this.heights[idx(iy + 1, ix)];
    const h11 = this.heights[idx(iy + 1, ix + 1)];

    const top = h00 * (1 - tx) + h10 * tx;
    const bottom = h01 * (1 - tx) + h11 * tx;
    return top * (1 - tz) + bottom * tz;
  }

  /** Approximate local slope steepness (0 = flat) via finite differences. */
  getSlopeAt(x: number, z: number): number {
    const d = SPACING;
    const hL = this.getHeightAt(x - d, z);
    const hR = this.getHeightAt(x + d, z);
    const hD = this.getHeightAt(x, z - d);
    const hU = this.getHeightAt(x, z + d);
    const dx = (hR - hL) / (2 * d);
    const dz = (hU - hD) / (2 * d);
    return Math.sqrt(dx * dx + dz * dz);
  }

  isUnderwaterAt(x: number, z: number): boolean {
    return this.getHeightAt(x, z) < WATER_LEVEL + 0.15;
  }

  get worldSize(): number {
    return TERRAIN_SIZE;
  }
}

function carveRiver(heights: Float32Array, isRiver: Uint8Array, rng: () => number): void {
  // Start from a random high point away from the very edge, then follow
  // steepest descent to carve a naturally flowing valley down to the edge.
  let bestIx = Math.floor(GRID / 2);
  let bestIy = Math.floor(GRID / 2);
  let bestH = -Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const ix = 10 + Math.floor(rng() * (GRID - 20));
    const iy = 10 + Math.floor(rng() * (GRID - 20));
    const h = heights[idx(iy, ix)];
    if (h > bestH) {
      bestH = h;
      bestIx = ix;
      bestIy = iy;
    }
  }

  const path: Array<[number, number]> = [];
  let ix = bestIx;
  let iy = bestIy;
  const visited = new Set<number>();
  for (let step = 0; step < GRID * 2; step++) {
    path.push([ix, iy]);
    visited.add(idx(iy, ix));

    let nx = ix;
    let ny = iy;
    let lowest = heights[idx(iy, ix)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ax = ix + dx;
        const ay = iy + dy;
        if (ax < 0 || ax >= GRID || ay < 0 || ay >= GRID) continue;
        if (visited.has(idx(ay, ax))) continue;
        const h = heights[idx(ay, ax)];
        if (h < lowest) {
          lowest = h;
          nx = ax;
          ny = ay;
        }
      }
    }

    const reachedEdge = nx <= 1 || nx >= GRID - 2 || ny <= 1 || ny >= GRID - 2;
    if ((nx === ix && ny === iy) || reachedEdge) {
      if (reachedEdge) path.push([nx, ny]);
      break;
    }
    ix = nx;
    iy = ny;
  }

  const riverWidth = 3.2;
  for (const [px, py] of path) {
    const radius = Math.ceil(riverWidth);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const ax = px + dx;
        const ay = py + dy;
        if (ax < 0 || ax >= GRID || ay < 0 || ay >= GRID) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > riverWidth) continue;
        const falloff = 1 - dist / riverWidth;
        const target = WATER_LEVEL - 0.3;
        const i = idx(ay, ax);
        heights[i] = THREE.MathUtils.lerp(heights[i], target, falloff * falloff);
        if (dist < riverWidth * 0.6) isRiver[i] = 1;
      }
    }
  }
}

function smooth(heights: Float32Array, passes: number): void {
  for (let p = 0; p < passes; p++) {
    const copy = heights.slice();
    for (let iy = 1; iy < GRID - 1; iy++) {
      for (let ix = 1; ix < GRID - 1; ix++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += copy[idx(iy + dy, ix + dx)];
            count++;
          }
        }
        heights[idx(iy, ix)] = sum / count;
      }
    }
  }
}

function buildMesh(heights: Float32Array, isRiver: Uint8Array): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    TERRAIN_SEGMENTS,
    TERRAIN_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);

  const rock = new THREE.Color(0x7d7364);
  const grass = new THREE.Color(0x5a8f4a);
  const sand = new THREE.Color(0xcdb583);
  const riverbed = new THREE.Color(0x6b5a3e);

  for (let i = 0; i < position.count; i++) {
    const h = heights[i];
    position.setY(i, h);

    const c = new THREE.Color();
    if (isRiver[i]) {
      c.copy(riverbed);
    } else if (h < WATER_LEVEL + 0.6) {
      c.copy(sand);
    } else if (h < 6) {
      c.copy(grass);
    } else {
      const t = THREE.MathUtils.clamp((h - 6) / 8, 0, 1);
      c.copy(grass).lerp(rock, t);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

function buildWater(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE * 1.02, TERRAIN_SIZE * 1.02);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2f6fa3,
    transparent: true,
    opacity: 0.75,
    roughness: 0.3,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = WATER_LEVEL;
  return mesh;
}
