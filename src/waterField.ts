import * as THREE from "three";
import type { Terrain } from "./terrain";
import { TERRAIN_SIZE, TERRAIN_SEGMENTS, WATER_LEVEL } from "./terrain";

const GRID = TERRAIN_SEGMENTS + 1;
const SPACING = TERRAIN_SIZE / TERRAIN_SEGMENTS;

function idx(iy: number, ix: number): number {
  return iy * GRID + ix;
}

// How fast a submerged cell's depth relaxes toward "full to sea level" per
// second — gentle rather than instant, so a freshly-dug canal visibly
// floods in over roughly half a second instead of popping full, while
// still converging fast enough that a stable pool reads as "full" almost
// immediately.
const SEA_RELAX_RATE = 2.2;
// Caps how deep a dug-into-a-hillside pool can read as, regardless of how
// much taller the original undisturbed ground there was — a canal cut
// through a mountain shouldn't pool as a multi-unit-deep slab just because
// the hill was tall.
const MAX_DUG_POOL_DEPTH = 2.5;
// Fraction of the surface-height (bed + depth) difference between two
// neighboring cells exchanged per second — this alone is what produces a
// visible waterfall: a cell whose bed pokes up above WATER_LEVEL gets no
// relax-to-full term (see step()), so it only ever holds however much
// water flows in from a lower/wetter neighbor. A climbing stretch of canal
// thins out and follows the bed contour instead of pooling — a real
// cascade — while a flat or sunken stretch settles into a calm connected
// pool.
const FLOW_RATE = 3.0;
// Below this: dry — not rendered, not navigable. Above zero so a barely-wet
// vertex right at the shoreline doesn't flicker in and out from float
// noise.
const MIN_DEPTH = 0.015;
// Minimum depth for a ship to actually be considered afloat there.
export const NAVIGABLE_DEPTH = 0.08;

const WATER_MATERIAL_PARAMS = {
  color: 0x2f6fa3,
  transparent: true,
  opacity: 0.78,
  roughness: 0.28,
  metalness: 0.1,
} as const;

/**
 * The single water system in the game: one height-field flow simulation
 * covering the entire terrain grid. There is no separate notion of "lake
 * water" vs "canal water" — every grid cell has a bed height (read straight
 * from Terrain.heights, which digging a canal mutates exactly like any
 * other terrain edit) and a water depth above it, and the same two rules
 * govern all of it:
 *
 *  1. A cell gently relaxes towards being filled up to whichever is higher:
 *     global sea level, or its own original undisturbed ground height. This
 *     alone is what makes the ocean, a lake, and a freshly-dug canal all
 *     read as "full" the same way, with no special-casing between them —
 *     natural low terrain fills via the sea-level rule, and anywhere a
 *     player has actually dug below its own original grade fills too,
 *     regardless of that hillside's absolute elevation.
 *  2. Neighbor-to-neighbor diffusion, driven purely by the surface-height
 *     difference between adjacent cells, connects everything together and
 *     produces real waterfalls wherever the bed climbs faster than it was
 *     actually dug (see FLOW_RATE above).
 *
 * Rendered as one continuous mesh built straight from the same grid — no
 * per-tile quads, no static "sea level" plane.
 */
export class WaterField {
  private readonly terrain: Terrain;
  /** A one-time snapshot of the terrain's generated (pre-any-dig) heights,
   * taken here in the constructor before any road/track/canal exists to
   * grade anything. This is what lets a canal dug into a hillside — bed
   * still above global sea level — hold water too: relax() below fills a
   * cell towards whichever is higher, sea level or its own original
   * undisturbed ground height, so digging anywhere exposes water relative
   * to what was actually excavated, the same way a real dug pit fills with
   * groundwater regardless of the hill's absolute elevation. */
  private readonly originalHeights: Float32Array;
  private depth: Float32Array;
  private scratch: Float32Array;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  readonly mesh: THREE.Mesh;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    this.originalHeights = terrain.heights.slice();
    this.depth = new Float32Array(GRID * GRID);
    this.scratch = new Float32Array(GRID * GRID);

    // Seed every naturally-submerged cell full at generation, so lakes,
    // rivers, and the ocean edge look right from the very first frame
    // instead of waiting for the relax pass to catch up.
    for (let i = 0; i < GRID * GRID; i++) {
      this.depth[i] = Math.max(0, WATER_LEVEL - terrain.heights[i]);
    }

    const maxQuads = (GRID - 1) * (GRID - 1);
    // 2 triangles * 3 vertices * 3 floats per quad.
    this.positions = new Float32Array(maxQuads * 18);
    this.normals = new Float32Array(maxQuads * 18);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(this.normals, 3));
    geometry.setDrawRange(0, 0);

    this.mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(WATER_MATERIAL_PARAMS));
    this.mesh.receiveShadow = true;
    this.rebuildMesh();
  }

  /** Advances the flow simulation by `dt` seconds and rebuilds the water mesh to match. */
  step(dt: number): void {
    const heights = this.terrain.heights;
    const depth = this.depth;
    const next = this.scratch;
    next.set(depth);

    // Pass 1: relax towards being filled. A cell's fill target is whichever
    // is higher: global sea level (the natural-lake/ocean/river rule), or
    // its own original undisturbed ground height (the "digging exposes
    // groundwater" rule — capped at MAX_DUG_POOL_DEPTH so an isolated canal
    // tile carved into a tall hillside doesn't pool absurdly deep). A cell
    // whose *current* bed is already at or above both never gets this term
    // at all, so whatever depth it holds (if any) came purely from flowing
    // in from a neighbor and can flow back out again — that's what makes a
    // climbing, ungraded stretch of canal read as a real cascade instead of
    // a pool.
    for (let i = 0; i < heights.length; i++) {
      const bed = heights[i];
      const seaTarget = Math.max(0, WATER_LEVEL - bed);
      const dugTarget = Math.min(MAX_DUG_POOL_DEPTH, Math.max(0, this.originalHeights[i] - bed));
      const target = Math.max(seaTarget, dugTarget);
      if (target <= 0) continue;
      next[i] += (target - next[i]) * Math.min(1, SEA_RELAX_RATE * dt);
    }

    // Pass 2: neighbor diffusion (4-connected), continuing from the
    // relaxed state above so both effects compose in one step. Mutates
    // `next` in place as it sweeps (a cell already touched this pass feeds
    // its updated value into the next edge) rather than double-buffering —
    // equivalent to a Gauss-Seidel update, which stays stable here and
    // self-corrects a cell touched by multiple edges within the same pass.
    //
    // Flow is driven by the surface-height (bed + depth) difference, but
    // capped to whatever depth the upstream side actually holds — two
    // bone-dry cells always have *some* bed-height difference (that's just
    // bare terrain slope), and without this cap that alone would compute a
    // nonzero "flow" and slowly leak phantom water across dry ground with
    // no real source anywhere nearby.
    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const i = idx(iy, ix);
        if (ix + 1 < GRID) {
          const j = idx(iy, ix + 1);
          const diff = heights[i] + next[i] - (heights[j] + next[j]);
          let flow = Math.sign(diff) * Math.min(Math.abs(diff) * FLOW_RATE * dt, Math.abs(diff) / 2);
          flow = flow > 0 ? Math.min(flow, next[i]) : Math.max(flow, -next[j]);
          next[i] -= flow;
          next[j] += flow;
        }
        if (iy + 1 < GRID) {
          const j = idx(iy + 1, ix);
          const diff = heights[i] + next[i] - (heights[j] + next[j]);
          let flow = Math.sign(diff) * Math.min(Math.abs(diff) * FLOW_RATE * dt, Math.abs(diff) / 2);
          flow = flow > 0 ? Math.min(flow, next[i]) : Math.max(flow, -next[j]);
          next[i] -= flow;
          next[j] += flow;
        }
      }
    }

    for (let i = 0; i < next.length; i++) depth[i] = Math.max(0, next[i]);

    this.rebuildMesh();
  }

  /** Bilinear-interpolated water depth at a world-space (x, z) coordinate. */
  depthAt(x: number, z: number): number {
    const { ix, iy, tx, tz } = this.sampleCoords(x, z);
    const d00 = this.depth[idx(iy, ix)];
    const d10 = this.depth[idx(iy, ix + 1)];
    const d01 = this.depth[idx(iy + 1, ix)];
    const d11 = this.depth[idx(iy + 1, ix + 1)];
    const top = d00 * (1 - tx) + d10 * tx;
    const bottom = d01 * (1 - tx) + d11 * tx;
    return top * (1 - tz) + bottom * tz;
  }

  /** Water surface height (bed + depth) at a world-space (x, z) coordinate — what a floating ship should rest on. */
  surfaceHeightAt(x: number, z: number): number {
    return this.terrain.getHeightAt(x, z) + this.depthAt(x, z);
  }

  /** Whether there's enough water at (x, z) for a ship to actually float. */
  isNavigable(x: number, z: number): boolean {
    return this.depthAt(x, z) >= NAVIGABLE_DEPTH;
  }

  private sampleCoords(x: number, z: number): { ix: number; iy: number; tx: number; tz: number } {
    const fx = (x + TERRAIN_SIZE / 2) / SPACING;
    const fz = (z + TERRAIN_SIZE / 2) / SPACING;
    const ix = THREE.MathUtils.clamp(Math.floor(fx), 0, GRID - 2);
    const iy = THREE.MathUtils.clamp(Math.floor(fz), 0, GRID - 2);
    const tx = THREE.MathUtils.clamp(fx - ix, 0, 1);
    const tz = THREE.MathUtils.clamp(fz - iy, 0, 1);
    return { ix, iy, tx, tz };
  }

  /**
   * Rebuilds the water surface mesh from the current depth field — a quad
   * per grid cell is included only if at least one of its 4 corners is
   * wet, so dry land renders no water geometry at all (no separate mask or
   * second material needed: a bone-dry vertex has depth 0, so its height
   * exactly matches the ground there, tapering the mesh smoothly down to
   * nothing right at the actual shoreline).
   */
  private rebuildMesh(): void {
    const heights = this.terrain.heights;
    const depth = this.depth;
    const pos = this.positions;
    let offset = 0;

    for (let iy = 0; iy < GRID - 1; iy++) {
      for (let ix = 0; ix < GRID - 1; ix++) {
        const i00 = idx(iy, ix);
        const i10 = idx(iy, ix + 1);
        const i01 = idx(iy + 1, ix);
        const i11 = idx(iy + 1, ix + 1);
        const d00 = depth[i00];
        const d10 = depth[i10];
        const d01 = depth[i01];
        const d11 = depth[i11];
        if (d00 < MIN_DEPTH && d10 < MIN_DEPTH && d01 < MIN_DEPTH && d11 < MIN_DEPTH) continue;

        const x0 = -TERRAIN_SIZE / 2 + ix * SPACING;
        const x1 = x0 + SPACING;
        const z0 = -TERRAIN_SIZE / 2 + iy * SPACING;
        const z1 = z0 + SPACING;
        const y00 = heights[i00] + d00;
        const y10 = heights[i10] + d10;
        const y01 = heights[i01] + d01;
        const y11 = heights[i11] + d11;

        // Two triangles wound so their normal faces +Y: SW,NE,SE then SW,NW,NE.
        offset = writeTri(pos, offset, x0, y00, z0, x1, y11, z1, x1, y10, z0);
        offset = writeTri(pos, offset, x0, y00, z0, x0, y01, z1, x1, y11, z1);
      }
    }

    const geometry = this.mesh.geometry;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    geometry.setDrawRange(0, offset / 3);
    geometry.computeVertexNormals();
    (geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    geometry.computeBoundingSphere();
  }
}

function writeTri(
  pos: Float32Array,
  offset: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  pos[offset] = ax; pos[offset + 1] = ay; pos[offset + 2] = az;
  pos[offset + 3] = bx; pos[offset + 4] = by; pos[offset + 5] = bz;
  pos[offset + 6] = cx; pos[offset + 7] = cy; pos[offset + 8] = cz;
  return offset + 9;
}
