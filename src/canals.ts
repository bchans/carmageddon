import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { WATER_LEVEL, WATER_MATERIAL_PARAMS } from "./terrain";
import type { CanalAssets } from "./assets";
import { TileNetwork, TILE_SIZE, cellCenter, type Cell } from "./network";
import { WATERFALL_BED_THRESHOLD, type WaterSim } from "./waterSim";

export const CanalKind = {
  Standard: "standard",
} as const;
export type CanalKind = (typeof CanalKind)[keyof typeof CanalKind];

export const CANAL_SPEED_MULTIPLIER: Record<CanalKind, number> = {
  [CanalKind.Standard]: 1,
};

// A canal bed is never allowed shallower than this below WATER_LEVEL — a
// floor, not a fixed depth: grading otherwise works exactly like a road (see
// canSlope/targetFlatHeight below), climbing/descending between connected
// neighbors, but an isolated or dry-land-adjacent tile still needs *some*
// forced minimum dig or it would just flatten to whatever bone-dry ground is
// already there instead of becoming a waterway at all.
export const CANAL_MIN_DEPTH = 1.4;
// How deep the water sim seeds a newly-placed cell above its own bed —
// separate from CANAL_MIN_DEPTH (the dig floor) because this is a starting
// condition for the flow simulation, not a grading constraint; connected
// cells then settle towards a shared level from there (see waterSim.ts).
export const CANAL_INITIAL_FILL = 1.0;
const BUOY_SCALE = 0.55;

/** A canal has no pavement of its own — its dug bed is what makes it read as
 * a waterway (the actual water surface is one continuous mesh across every
 * dug tile, built in updateWaterSurfaces, not per-tile). A pair of real
 * Kenney channel buoys at opposite corners marks the dug channel so a player
 * can see where they've dug before/without a boat sitting on it. */
function buildCanalMarker(buoyTemplate: THREE.Object3D): THREE.Object3D {
  const group = new THREE.Group();
  for (const [x, z] of [
    [-1.4, -1.4],
    [1.4, 1.4],
  ]) {
    const buoy = buoyTemplate.clone(true);
    buoy.scale.setScalar(BUOY_SCALE);
    buoy.position.set(x, CANAL_INITIAL_FILL, z);
    buoy.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
    group.add(buoy);
  }
  return group;
}

const HALF = TILE_SIZE / 2;
// Tile-local corner offsets in a consistent winding order (SW, SE, NE, NW).
const CORNER_OFFSETS: Array<[number, number]> = [
  [-HALF, -HALF],
  [HALF, -HALF],
  [HALF, HALF],
  [-HALF, HALF],
];

export class CanalSystem extends TileNetwork<CanalKind> {
  private readonly canalAssets: CanalAssets;
  private readonly terrainRef: Terrain;
  /** The single continuous water surface for every dug canal tile — replaces
   * what used to be one independent, disconnected flat quad per tile (the
   * "flying squares" bug: each tile's square popped to its own simulated
   * height with no relation to its neighbors). Corner heights are now
   * averaged across every tile sharing that corner, so adjacent tiles' water
   * meshes share the exact same edge and the whole thing reads as one sloped
   * surface — including an actual visible drop where the flow sim computes a
   * waterfall, instead of a vertical gap between two disconnected squares. */
  readonly waterMesh: THREE.Mesh;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    canalAssets: CanalAssets,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
    this.canalAssets = canalAssets;
    this.terrainRef = terrain;
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial(WATER_MATERIAL_PARAMS));
    this.waterMesh.receiveShadow = true;
    // this.root has no transform of its own (added directly to the scene at
    // the origin, same as roads.root/tracks.root), so this mesh can be built
    // straight in world-space coordinates rather than per-tile local space.
    this.root.add(this.waterMesh);
  }

  protected speedMultiplier(kind: CanalKind): number {
    return CANAL_SPEED_MULTIPLIER[kind];
  }

  protected buildMesh(_kind: CanalKind, _facing: number, _mask: boolean[], _cell: Cell): THREE.Object3D {
    return buildCanalMarker(this.canalAssets.buoy);
  }

  /** Grades exactly like a road (climbs/descends between connected
   * neighbors via the shared slope logic) — the only canal-specific rule is
   * the minimum-dig floor below, not a uniform flat depth everywhere. */
  protected canSlope(): boolean {
    return true;
  }

  protected targetFlatHeight(cell: Cell, mask: boolean[]): number {
    const natural = super.targetFlatHeight(cell, mask);
    return Math.min(natural, WATER_LEVEL - CANAL_MIN_DEPTH);
  }

  // No curb walls — a canal's "walls" are just its banks (the untouched
  // terrain around it), not a physical barrier tile.
  protected buildsCurbs(): boolean {
    return false;
  }

  /** A naturally underwater cell (lake/river) is already a waterway on its
   * own — it needs no digging and shares the same big sea-level water plane
   * every other natural water tile uses (terrain.ts's waterMesh), so it
   * counts as part of the canal network without ever being placed/dug.
   * This is what lets a player just connect a dug canal to a lake's edge
   * and treat the whole lake as traversable, instead of having to pave over
   * it tile by tile with redundant canal digs. */
  protected isExtraNetworkCell(cell: Cell): boolean {
    const center = cellCenter(cell);
    return this.terrainRef.isUnderwaterAt(center.x, center.z);
  }

  /** A ship can ride a waterfall down but never climb one — blocks exactly
   * the direction that would mean going from a lower bed to a much higher
   * one, mirroring how the water sim itself treats the same drop as a
   * one-way cascade instead of two pools equalizing into each other. */
  protected canTraverseEdge(from: Cell, to: Cell): boolean {
    const bedFrom = this.tileHeight(from);
    const bedTo = this.tileHeight(to);
    if (bedFrom === null || bedTo === null) return true;
    return bedTo - bedFrom <= WATERFALL_BED_THRESHOLD;
  }

  /**
   * Rebuilds the single continuous water surface from the flow sim's live
   * heights. Corner heights are averaged across every tile sharing that
   * corner first, so neighboring tiles' quads always meet at an identical
   * height — no seams, no independently-popping squares — and a genuine bed
   * drop between two tiles (a waterfall) renders as a sloped surface instead
   * of two disconnected flat pools. Tiles are only ever added, never
   * removed, so a full rebuild each call stays cheap (small tile counts,
   * no allocation-heavy diffing needed).
   */
  updateWaterSurfaces(sim: WaterSim): void {
    if (this.tiles.size === 0) {
      if (this.waterMesh.geometry.attributes.position) this.waterMesh.geometry = new THREE.BufferGeometry();
      return;
    }

    const cornerSum = new Map<string, { height: number; count: number }>();
    const waterHeightOf = (cell: Cell, centerHeight: number): number =>
      sim.getWaterHeight(cell) ?? centerHeight + CANAL_INITIAL_FILL;

    for (const tile of this.tiles.values()) {
      const center = cellCenter(tile.cell);
      const waterHeight = waterHeightOf(tile.cell, tile.centerHeight);
      for (const [dx, dz] of CORNER_OFFSETS) {
        const key = `${center.x + dx}:${center.z + dz}`;
        const entry = cornerSum.get(key);
        if (entry) {
          entry.height += waterHeight;
          entry.count += 1;
        } else {
          cornerSum.set(key, { height: waterHeight, count: 1 });
        }
      }
    }

    const positions: number[] = [];
    for (const tile of this.tiles.values()) {
      const center = cellCenter(tile.cell);
      const corners = CORNER_OFFSETS.map(([dx, dz]) => {
        const key = `${center.x + dx}:${center.z + dz}`;
        const entry = cornerSum.get(key)!;
        return { x: center.x + dx, y: entry.height / entry.count, z: center.z + dz };
      });
      const [sw, se, ne, nw] = corners;
      // Two triangles winding so their normal faces +Y (see the CCW-from-
      // above derivation this order was chosen for).
      pushTriangle(positions, sw, ne, se);
      pushTriangle(positions, sw, nw, ne);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    this.waterMesh.geometry.dispose();
    this.waterMesh.geometry = geometry;
  }
}

function pushTriangle(positions: number[], a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, c: { x: number; y: number; z: number }): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}
