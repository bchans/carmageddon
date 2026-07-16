import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { WATER_LEVEL } from "./terrain";
import type { CanalAssets } from "./assets";
import { TileNetwork, type Cell } from "./network";
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

const waterMaterial = new THREE.MeshStandardMaterial({
  color: 0x2f6fa3,
  transparent: true,
  opacity: 0.8,
  roughness: 0.25,
  metalness: 0.1,
});
const waterQuadGeometry = new THREE.PlaneGeometry(4.05, 4.05);
waterQuadGeometry.rotateX(-Math.PI / 2);

/** A canal has no pavement of its own — its dug bed plus a locally-simulated
 * water quad (see updateWaterSurfaces) are what make it read as a waterway.
 * A pair of real Kenney channel buoys at opposite corners marks the dug
 * channel so a player can see where they've dug before/without a boat
 * sitting on it. */
function buildCanalMarker(buoyTemplate: THREE.Object3D): { group: THREE.Object3D; waterQuad: THREE.Mesh } {
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

  const waterQuad = new THREE.Mesh(waterQuadGeometry, waterMaterial);
  waterQuad.position.y = CANAL_INITIAL_FILL; // corrected every tick by updateWaterSurfaces once the flow sim is running
  waterQuad.receiveShadow = true;
  group.add(waterQuad);

  return { group, waterQuad };
}

export class CanalSystem extends TileNetwork<CanalKind> {
  private readonly canalAssets: CanalAssets;
  private readonly waterQuads = new Map<string, THREE.Mesh>();

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
  }

  protected speedMultiplier(kind: CanalKind): number {
    return CANAL_SPEED_MULTIPLIER[kind];
  }

  protected buildMesh(_kind: CanalKind, _facing: number, _mask: boolean[], cell: Cell): THREE.Object3D {
    const { group, waterQuad } = buildCanalMarker(this.canalAssets.buoy);
    this.waterQuads.set(`${cell.col}:${cell.row}`, waterQuad);
    return group;
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

  /** Repositions each tile's water quad to the flow sim's live simulated
   * surface height for that cell, falling back to the tile's own seed fill
   * if the sim hasn't got a reading yet (e.g. the very first tick after
   * placement, before Game has synced it in). */
  updateWaterSurfaces(sim: WaterSim): void {
    for (const [key, quad] of this.waterQuads) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      const [col, row] = key.split(":").map(Number);
      const waterHeight = sim.getWaterHeight({ col, row });
      quad.position.y = (waterHeight ?? tile.centerHeight + CANAL_INITIAL_FILL) - tile.centerHeight;
    }
  }
}
