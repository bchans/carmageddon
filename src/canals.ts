import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { WATER_LEVEL } from "./terrain";
import { TileNetwork, TILE_SIZE, type Cell } from "./network";

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
const CANAL_DEPTH = 1.4;

const postMaterial = new THREE.MeshStandardMaterial({ color: 0xd7c48a, roughness: 0.85 });

/** A canal has no pavement of its own — carving the bed below water level is
 * what makes it visually read as a waterway, since the map already has one
 * continuous water plane. Four low corner posts just mark the channel so a
 * player can see where they've dug before/without a boat sitting on it. */
function buildCanalMarker(): THREE.Object3D {
  const group = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6);
  for (const [x, z] of [
    [-0.44, -0.44],
    [0.44, -0.44],
    [-0.44, 0.44],
    [0.44, 0.44],
  ]) {
    const post = new THREE.Mesh(postGeo, postMaterial);
    post.position.set(x, 0.25, z);
    post.castShadow = true;
    group.add(post);
  }
  group.scale.setScalar(TILE_SIZE);
  return group;
}

export class CanalSystem extends TileNetwork<CanalKind> {
  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
  }

  protected speedMultiplier(kind: CanalKind): number {
    return CANAL_SPEED_MULTIPLIER[kind];
  }

  protected buildMesh(): THREE.Object3D {
    return buildCanalMarker();
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
