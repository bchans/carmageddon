import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { WATER_LEVEL } from "./terrain";
import type { CanalAssets } from "./assets";
import { TileNetwork, type Cell } from "./network";

export const CanalKind = {
  Standard: "standard",
} as const;
export type CanalKind = (typeof CanalKind)[keyof typeof CanalKind];

export const CANAL_SPEED_MULTIPLIER: Record<CanalKind, number> = {
  [CanalKind.Standard]: 1,
};

// How far below the water surface a carved canal bed sits — deep enough that
// carving through a hill still reliably drops below WATER_LEVEL even after
// the neighbor-averaging a junction tile's flat height would otherwise do.
// Every canal tile grades to exactly this depth (see targetFlatHeight below,
// canals never slope), so a buoy's local y-offset needed to float it at the
// water surface is this same constant for every tile.
const CANAL_DEPTH = 1.4;
const BUOY_SCALE = 0.55;

/** A canal has no pavement of its own — carving the bed below water level is
 * what makes it visually read as a waterway, since the map already has one
 * continuous water plane. A pair of real Kenney channel buoys at opposite
 * corners marks the dug channel so a player can see where they've dug
 * before/without a boat sitting on it. */
function buildCanalMarker(buoyTemplate: THREE.Object3D): THREE.Object3D {
  const group = new THREE.Group();
  for (const [x, z] of [
    [-1.4, -1.4],
    [1.4, 1.4],
  ]) {
    const buoy = buoyTemplate.clone(true);
    buoy.scale.setScalar(BUOY_SCALE);
    buoy.position.set(x, CANAL_DEPTH, z);
    buoy.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = true;
    });
    group.add(buoy);
  }
  return group;
}

export class CanalSystem extends TileNetwork<CanalKind> {
  private readonly canalAssets: CanalAssets;

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

  protected buildMesh(): THREE.Object3D {
    return buildCanalMarker(this.canalAssets.buoy);
  }

  // Water has to stay level — a "sloped" canal bed would mean the water
  // surface tears away from its bed at one edge, so every canal tile grades
  // to the same fixed depth instead of climbing/descending like a road.
  protected canSlope(): boolean {
    return false;
  }

  protected targetFlatHeight(): number {
    return WATER_LEVEL - CANAL_DEPTH;
  }

  // No curb walls — a canal's "walls" are just its banks (the untouched
  // terrain around it), not a physical barrier tile.
  protected buildsCurbs(): boolean {
    return false;
  }
}
