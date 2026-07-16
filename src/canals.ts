import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { WATER_LEVEL } from "./terrain";
import type { CanalAssets } from "./assets";
import type { WaterField } from "./waterField";
import { TileNetwork, cellCenter, type Cell } from "./network";

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
// A ship can ride a waterfall down but never climb one — this caps how much
// a single tile-to-tile bed climb is still considered "a connected pool"
// for pathfinding, vs. a one-way drop. Purely a ship-navigation rule; the
// actual water surface (WaterField) needs no equivalent special case at
// all — it's just diffusion, and a climb like this naturally reads as a
// cascade there already.
const WATERFALL_BED_THRESHOLD = 0.3;
const BUOY_SCALE = 0.55;
const BUOY_REST_HEIGHT = 1.0;

/** A canal has no pavement of its own — its dug bed is what makes it read as
 * a waterway (the water surface itself belongs entirely to WaterField, the
 * one shared height-field simulation covering the whole map — a canal tile
 * is just a grid region whose bed got dug below sea level, nothing more). A
 * pair of real Kenney channel buoys at opposite corners marks the dug
 * channel so a player can see where they've dug before/without a boat
 * sitting on it. */
function buildCanalMarker(buoyTemplate: THREE.Object3D): THREE.Object3D {
  const group = new THREE.Group();
  for (const [x, z] of [
    [-1.4, -1.4],
    [1.4, 1.4],
  ]) {
    const buoy = buoyTemplate.clone(true);
    buoy.scale.setScalar(BUOY_SCALE);
    buoy.position.set(x, BUOY_REST_HEIGHT, z);
    buoy.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
    group.add(buoy);
  }
  return group;
}

export class CanalSystem extends TileNetwork<CanalKind> {
  private readonly canalAssets: CanalAssets;
  private readonly waterField: WaterField;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    canalAssets: CanalAssets,
    waterField: WaterField,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
    this.canalAssets = canalAssets;
    this.waterField = waterField;
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

  /** A cell WaterField already considers navigable (a lake, a river, open
   * ocean) is already a waterway on its own — it needs no digging, and
   * counts as part of the canal network without ever being placed. This is
   * what lets a player just connect a dug canal to a lake's edge and treat
   * the whole lake as traversable, instead of having to pave over it tile
   * by tile with redundant, doubly-rendered canal digs. */
  protected isExtraNetworkCell(cell: Cell): boolean {
    const center = cellCenter(cell);
    return this.waterField.isNavigable(center.x, center.z);
  }

  /** A ship can ride a waterfall down but never climb one — blocks exactly
   * the direction that would mean going from a lower bed to a much higher
   * one. Purely a pathfinding rule; the water itself doesn't need this
   * distinction; see WATERFALL_BED_THRESHOLD above. */
  protected canTraverseEdge(from: Cell, to: Cell): boolean {
    const bedFrom = this.tileHeight(from);
    const bedTo = this.tileHeight(to);
    if (bedFrom === null || bedTo === null) return true;
    return bedTo - bedFrom <= WATERFALL_BED_THRESHOLD;
  }

  /** Every time a canal tile's bed is graded (placed, or re-graded as a
   * neighbor changes), tell WaterField this exact footprint was actually
   * dug — the only way a cell becomes eligible to hold water at all. Roads
   * and tracks share the same underlying grading call but never override
   * this, so paving them can't spawn a puddle. */
  protected onGraded(center: THREE.Vector3, halfSize: number): void {
    this.waterField.markExcavated(center.x, center.z, halfSize);
  }
}
