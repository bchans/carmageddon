import * as THREE from "three";
import type { Terrain } from "./terrain";
import { TERRAIN_SIZE, TERRAIN_SEGMENTS, WATER_LEVEL } from "./terrain";
import { DIRS, cellCenter, cellKey, type Cell } from "./network";

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
// How much depth a pump moves from its source cell into its destination
// cell per second, ignoring the normal "only flows downhill" rule — the
// one deliberate exception in the whole simulation, representing an active
// mechanical lift rather than gravity-driven flow.
const PUMP_RATE = 1.5;
// A pump's destination never pools deeper than this, regardless of how
// long it's been running — without a cap, an isolated pumped-into pit with
// nowhere for the water to go on its own would just grow forever.
const PUMP_MAX_DEPTH = 3.0;

// Depth (in world units) at which water is considered "fully deep" for
// shading purposes — at or beyond this, color/opacity stop changing. Below
// it, both fade toward the shallow values so a thin film on a slope reads
// as a thin film instead of full-strength lake color.
const SHALLOW_REF_DEPTH = 0.45;
const SHALLOW_COLOR = new THREE.Color(0x6fb2c9);
const DEEP_COLOR = new THREE.Color(0x1f5a86);
const MIN_ALPHA = 0.05;
const MAX_ALPHA = 0.82;
// How fast the smoothed per-vertex flow display decays back towards zero
// once the underlying diffusion stops moving water through a vertex — a
// short tail rather than an instant cut so a just-stopped trickle doesn't
// visually snap to glassy-still.
const FLOW_VIS_DECAY = 4.0;

function createWaterMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    roughness: 0.28,
    metalness: 0.1,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.shallowColor = { value: SHALLOW_COLOR };
    shader.uniforms.deepColor = { value: DEEP_COLOR };
    shader.uniforms.shallowRefDepth = { value: SHALLOW_REF_DEPTH };
    shader.uniforms.minAlpha = { value: MIN_ALPHA };
    shader.uniforms.maxAlpha = { value: MAX_ALPHA };
    shader.uniforms.uTime = { value: 0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "attribute float waterDepth;",
          "attribute vec2 waterFlow;",
          "varying float vWaterDepth;",
          "varying vec2 vWaterFlow;",
          "varying vec2 vWaterWorldXZ;",
        ].join("\n"),
      )
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "vWaterDepth = waterDepth;",
          "vWaterFlow = waterFlow;",
          "vWaterWorldXZ = position.xz;",
        ].join("\n"),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying float vWaterDepth;",
          "varying vec2 vWaterFlow;",
          "varying vec2 vWaterWorldXZ;",
          "uniform vec3 shallowColor;",
          "uniform vec3 deepColor;",
          "uniform float shallowRefDepth;",
          "uniform float minAlpha;",
          "uniform float maxAlpha;",
          "uniform float uTime;",
        ].join("\n"),
      )
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "{",
          "  float depthT = clamp(vWaterDepth / shallowRefDepth, 0.0, 1.0);",
          "  diffuseColor.rgb = mix(shallowColor, deepColor, depthT);",
          // A steeper curve than the color blend for alpha specifically, so
          // a razor-thin film right at the shoreline reads as barely-there
          // rather than a flat, uniformly-visible wash over a wide gentle
          // slope (which is what made the whole bank look painted blue).
          "  float alphaT = pow(depthT, 1.6);",
          "  float grazing = 1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);",
          "  float fresnel = pow(grazing, 3.0);",
          // Fresnel brightening is scaled by depth too — otherwise a raking
          // view across a shallow shoreline slope gets the full grazing-angle
          // boost regardless of how thin the film is there, which visually
          // re-creates the "whole slope painted blue" look this shading was
          // built to fix in the first place.
          "  diffuseColor.a = clamp(mix(minAlpha, maxAlpha, alphaT) + fresnel * alphaT * 0.25, 0.0, 1.0);",
          // Streaks stretched along the local flow direction and scrolled
          // over time at a speed tied to flow strength, so moving water
          // visibly streams while still water stays glassy (flowMag ~ 0
          // gates the whole term out).
          "  float flowMag = length(vWaterFlow);",
          "  vec2 flowDir = flowMag > 0.0001 ? vWaterFlow / flowMag : vec2(0.0, 1.0);",
          "  float scroll = uTime * (0.8 + flowMag * 3.0);",
          "  vec2 rippleCoord = vWaterWorldXZ * 0.6 + flowDir * scroll;",
          "  float streak = sin(dot(rippleCoord, vec2(1.0, 0.3)) * 3.0) * 0.5",
          "               + sin(dot(rippleCoord, vec2(0.3, -1.0)) * 5.0 + uTime) * 0.5;",
          "  float ripple = smoothstep(0.4, 1.0, streak) * clamp(flowMag * 6.0, 0.0, 1.0);",
          "  diffuseColor.rgb += ripple * 0.18;",
          "}",
        ].join("\n"),
      );
    material.userData.shader = shader;
  };
  return material;
}

/**
 * The single water system in the game: one height-field flow simulation
 * covering the entire terrain grid. There is no separate notion of "lake
 * water" vs "canal water" — every grid cell has a bed height (read straight
 * from Terrain.heights, which digging a canal mutates exactly like any
 * other terrain edit) and a water depth above it, and the same two rules
 * govern all of it:
 *
 *  1. A cell that was *naturally* underwater at world generation (a lake,
 *     river, or the ocean — never a placed road/track/canal, see
 *     originalHeights below) gently relaxes towards being filled up to
 *     global sea level. This is the only self-sourcing rule in the whole
 *     simulation — the one legitimate "infinite reservoir" in the game.
 *  2. Neighbor-to-neighbor diffusion, driven purely by the surface-height
 *     difference between adjacent cells and capped by what the upstream
 *     side actually holds, connects everything together. This is the
 *     *only* way any other cell — including a freshly-dug canal, no
 *     matter how deep — ever gets water: it has to flow in from an
 *     already-wet neighbor, exactly like a real dug channel only fills
 *     once it's actually connected to a water source. A climbing stretch
 *     thins out and follows the bed contour (a real cascade) instead of
 *     pooling, and an isolated, not-yet-connected dig just stays dry —
 *     placing a canal tile carves a trench, nothing more; the water
 *     arriving there is purely a consequence of rule 2.
 *
 * Rendered as one continuous mesh built straight from the same grid — no
 * per-tile quads, no static "sea level" plane.
 *
 * Roads and train tracks grade their own pad flush with the ground through
 * the exact same Terrain.flattenForRoad mechanism a canal digs its bed
 * with (see TileNetwork.gradeCell), and that grading can genuinely dip a
 * hair below the original bumpy terrain too (e.g. a junction flattening to
 * the average of uneven neighbors). Gating rule 1 on the terrain's original
 * generated height rather than its current height is what keeps that from
 * spawning a puddle: a road/track tile only self-sources water if the
 * ground was already a lake/river there before anything was ever built.
 */
export class WaterField {
  private readonly terrain: Terrain;
  /** A one-time snapshot of the terrain's generated (pre-any-dig) heights,
   * taken here in the constructor before any road/track/canal exists to
   * grade anything. This is the sole thing that distinguishes "a real lake"
   * from "a hole someone dug" — see rule 1 above. */
  private readonly originalHeights: Float32Array;
  private depth: Float32Array;
  private scratch: Float32Array;
  /** Smoothed per-vertex flow display (world-space x/z), decayed and refed
   * each step from the instant diffusion amounts below — purely cosmetic,
   * drives the flow-direction ripple in the shader. */
  private readonly flowX: Float32Array;
  private readonly flowZ: Float32Array;
  /** Scratch accumulators for this step's raw diffusion flow, reset and
   * refilled every step() before being folded into flowX/flowZ. */
  private readonly instantFlowX: Float32Array;
  private readonly instantFlowZ: Float32Array;
  private time = 0;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly vertexDepths: Float32Array;
  private readonly vertexFlow: Float32Array;
  /** Active pumps as resolved grid-vertex index pairs (resolved once at
   * registration, since a pump's cell never moves) — see registerPump(). */
  private readonly pumps: Array<{ fromIdx: number; toIdx: number }> = [];
  readonly mesh: THREE.Mesh;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    this.originalHeights = terrain.heights.slice();
    this.depth = new Float32Array(GRID * GRID);
    this.scratch = new Float32Array(GRID * GRID);
    this.flowX = new Float32Array(GRID * GRID);
    this.flowZ = new Float32Array(GRID * GRID);
    this.instantFlowX = new Float32Array(GRID * GRID);
    this.instantFlowZ = new Float32Array(GRID * GRID);

    // Seed every naturally-submerged cell full at generation, so lakes,
    // rivers, and the ocean edge look right from the very first frame
    // instead of waiting for the relax pass to catch up. (Equivalent to
    // gating on originalHeights here, since nothing has been graded yet.)
    for (let i = 0; i < GRID * GRID; i++) {
      this.depth[i] = Math.max(0, WATER_LEVEL - terrain.heights[i]);
    }

    const maxQuads = (GRID - 1) * (GRID - 1);
    // 2 triangles * 3 vertices * 3 floats per quad.
    this.positions = new Float32Array(maxQuads * 18);
    this.normals = new Float32Array(maxQuads * 18);
    // 2 triangles * 3 vertices * 1 float per quad.
    this.vertexDepths = new Float32Array(maxQuads * 6);
    // 2 triangles * 3 vertices * 2 floats (x, z) per quad.
    this.vertexFlow = new Float32Array(maxQuads * 12);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(this.normals, 3));
    geometry.setAttribute("waterDepth", new THREE.BufferAttribute(this.vertexDepths, 1));
    geometry.setAttribute("waterFlow", new THREE.BufferAttribute(this.vertexFlow, 2));
    geometry.setDrawRange(0, 0);

    this.material = createWaterMaterial();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.rebuildMesh();
  }

  /** Advances the flow simulation by `dt` seconds and rebuilds the water mesh to match. */
  step(dt: number): void {
    const heights = this.terrain.heights;
    const depth = this.depth;
    const next = this.scratch;
    next.set(depth);

    // Pass 1: relax towards being filled — but only for a cell that was
    // *naturally* underwater at generation (see originalHeights). A dug
    // cell — road, track, or canal, doesn't matter, and regardless of how
    // far below sea level it was carved — gets nothing here; whatever
    // depth it holds came purely from Pass 2 flowing in from a neighbor,
    // and can flow back out again just as easily.
    for (let i = 0; i < heights.length; i++) {
      if (this.originalHeights[i] >= WATER_LEVEL) continue;
      const target = Math.max(0, WATER_LEVEL - heights[i]);
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
    const instantFlowX = this.instantFlowX;
    const instantFlowZ = this.instantFlowZ;
    instantFlowX.fill(0);
    instantFlowZ.fill(0);

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
          // Positive flow moves from i to j, i.e. in the +x direction — record
          // that at both endpoints as a (purely cosmetic) local flow vector.
          instantFlowX[i] += flow;
          instantFlowX[j] += flow;
        }
        if (iy + 1 < GRID) {
          const j = idx(iy + 1, ix);
          const diff = heights[i] + next[i] - (heights[j] + next[j]);
          let flow = Math.sign(diff) * Math.min(Math.abs(diff) * FLOW_RATE * dt, Math.abs(diff) / 2);
          flow = flow > 0 ? Math.min(flow, next[i]) : Math.max(flow, -next[j]);
          next[i] -= flow;
          next[j] += flow;
          instantFlowZ[i] += flow;
          instantFlowZ[j] += flow;
        }
      }
    }

    for (let i = 0; i < next.length; i++) depth[i] = Math.max(0, next[i]);

    // Fold this step's raw flow into the smoothed display vectors — decay
    // the old value towards zero, then add the fresh amount, so a vertex
    // that's stopped moving fades out over ~1/FLOW_VIS_DECAY seconds rather
    // than snapping instantly to "still".
    const flowDecay = Math.exp(-FLOW_VIS_DECAY * dt);
    for (let i = 0; i < this.flowX.length; i++) {
      this.flowX[i] = this.flowX[i] * flowDecay + instantFlowX[i];
      this.flowZ[i] = this.flowZ[i] * flowDecay + instantFlowZ[i];
    }
    this.time += dt;
    const shader = this.material.userData.shader;
    if (shader) shader.uniforms.uTime.value = this.time;

    // Pass 3: pumps. A direction-agnostic, explicit exception to "water
    // only flows downhill" — each registered pump pulls depth straight
    // from its fixed source vertex into its fixed destination vertex,
    // capped by what the source actually holds and by PUMP_MAX_DEPTH at
    // the destination so it can't tower indefinitely.
    for (const pump of this.pumps) {
      const available = depth[pump.fromIdx];
      const room = Math.max(0, PUMP_MAX_DEPTH - depth[pump.toIdx]);
      const amount = Math.min(available, room, PUMP_RATE * dt);
      if (amount <= 0) continue;
      depth[pump.fromIdx] -= amount;
      depth[pump.toIdx] += amount;
    }

    this.rebuildMesh();
  }

  /** Registers a pump that continuously moves water from `from` into `to`
   * every step, regardless of relative bed height — see PUMP_RATE/Pass 3
   * above. Resolves both cells to grid vertices once, since a placed
   * pump's cells never move. */
  registerPump(from: Cell, to: Cell): void {
    const fromCenter = cellCenter(from);
    const toCenter = cellCenter(to);
    this.pumps.push({
      fromIdx: this.nearestVertex(fromCenter.x, fromCenter.z),
      toIdx: this.nearestVertex(toCenter.x, toCenter.z),
    });
  }

  /**
   * Shortest path (BFS, uniform cost) from `spawn` to `target` through
   * currently-navigable water only — two cells are connected if both are
   * wet (see isNavigable) and orthogonally adjacent. This is the entire
   * routing rule for ships: there's no separate "canal network" to
   * consult, a route exists exactly when a connected chain of actual water
   * exists, whether that water is a natural lake or a player-dug and
   * since-filled trench. Returns null if no such chain currently connects
   * the two points (e.g. a fresh dig that hasn't filled in yet).
   */
  findPath(spawn: Cell, target: Cell): Cell[] | null {
    const startKey = cellKey(spawn);
    const goalKey = cellKey(target);
    if (startKey === goalKey) return [spawn];

    const visited = new Set<string>([startKey]);
    const prev = new Map<string, Cell>();
    const queue: Cell[] = [spawn];
    for (let qi = 0; qi < queue.length; qi++) {
      const current = queue[qi];
      if (cellKey(current) === goalKey) break;
      for (const { dc, dr } of DIRS) {
        const next: Cell = { col: current.col + dc, row: current.row + dr };
        const key = cellKey(next);
        if (visited.has(key)) continue;
        const c = cellCenter(next);
        if (!this.isNavigable(c.x, c.z)) continue;
        visited.add(key);
        prev.set(key, current);
        queue.push(next);
      }
    }
    if (!visited.has(goalKey)) return null;

    const path: Cell[] = [target];
    let curKey = goalKey;
    while (curKey !== startKey) {
      const p = prev.get(curKey);
      if (!p) return null;
      path.push(p);
      curKey = cellKey(p);
    }
    path.reverse();
    return path;
  }

  private nearestVertex(x: number, z: number): number {
    const ix = THREE.MathUtils.clamp(Math.round((x + TERRAIN_SIZE / 2) / SPACING), 0, GRID - 1);
    const iy = THREE.MathUtils.clamp(Math.round((z + TERRAIN_SIZE / 2) / SPACING), 0, GRID - 1);
    return idx(iy, ix);
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

  /**
   * Whether there's enough water at (x, z) for a ship to actually float.
   * Explicitly false outside the map's real extent — depthAt()'s bilinear
   * sample clamps to the nearest edge vertex for any point beyond the grid
   * (the same clamp-to-edge behavior Terrain.getHeightAt uses, intentional
   * there for sampling near a boundary spawn/target point), so without this
   * check every point off the edge of the map would silently inherit
   * whatever that edge vertex's wetness happens to be. findPath() relies on
   * this to decide connectivity — if it ever came back true unbounded, a
   * coastal map edge would make the search "discover" infinitely many
   * phantom navigable cells marching outward forever with nothing to stop
   * it.
   */
  isNavigable(x: number, z: number): boolean {
    if (Math.abs(x) > TERRAIN_SIZE / 2 || Math.abs(z) > TERRAIN_SIZE / 2) return false;
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
    const flowX = this.flowX;
    const flowZ = this.flowZ;
    const pos = this.positions;
    const vdepth = this.vertexDepths;
    const vflow = this.vertexFlow;
    let offset = 0;
    let depthOffset = 0;
    let flowOffset = 0;

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
        depthOffset = writeTriScalar(vdepth, depthOffset, d00, d11, d10);
        depthOffset = writeTriScalar(vdepth, depthOffset, d00, d01, d11);
        flowOffset = writeTriVec2(
          vflow, flowOffset,
          flowX[i00], flowZ[i00], flowX[i11], flowZ[i11], flowX[i10], flowZ[i10],
        );
        flowOffset = writeTriVec2(
          vflow, flowOffset,
          flowX[i00], flowZ[i00], flowX[i01], flowZ[i01], flowX[i11], flowZ[i11],
        );
      }
    }

    const geometry = this.mesh.geometry;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    geometry.setDrawRange(0, offset / 3);
    geometry.computeVertexNormals();
    (geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.waterDepth as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.waterFlow as THREE.BufferAttribute).needsUpdate = true;
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

function writeTriScalar(arr: Float32Array, offset: number, a: number, b: number, c: number): number {
  arr[offset] = a;
  arr[offset + 1] = b;
  arr[offset + 2] = c;
  return offset + 3;
}

function writeTriVec2(
  arr: Float32Array,
  offset: number,
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
): number {
  arr[offset] = ax; arr[offset + 1] = az;
  arr[offset + 2] = bx; arr[offset + 3] = bz;
  arr[offset + 4] = cx; arr[offset + 5] = cz;
  return offset + 6;
}
