import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import { TileNetwork, TILE_SIZE, DIRS, type Cell } from "./network";

export const TrackKind = {
  Standard: "standard",
} as const;
export type TrackKind = (typeof TrackKind)[keyof typeof TrackKind];

export const TRACK_SPEED_MULTIPLIER: Record<TrackKind, number> = {
  [TrackKind.Standard]: 1,
};

// Procedural rail geometry — no Kenney kit reachable from this sandbox
// (kenney.nl is blocked by the environment's network policy), so tracks are
// built directly from primitives instead of a loaded GLB, at the same
// unit-tile scale the road pieces use (the group gets scaled by TILE_SIZE
// like everything else placed on the grid).
const RAIL_GAUGE = 0.16;
const RAIL_WIDTH = 0.035;
const RAIL_HEIGHT = 0.05;
const BED_HEIGHT = 0.03;
const TIE_COUNT = 3;
const TIE_WIDTH = 0.42;
const TIE_DEPTH = 0.075;
const TIE_HEIGHT = 0.03;

const railMaterial = new THREE.MeshStandardMaterial({ color: 0x8b909b, roughness: 0.35, metalness: 0.75 });
const tieMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95 });
const bedMaterial = new THREE.MeshStandardMaterial({ color: 0x6b6459, roughness: 1 });

/** One rail arm (two rails + ties) running from the tile center to the edge in the given direction. */
function buildRailArm(dir: number): THREE.Group {
  const { dc, dr } = DIRS[dir];
  const isNS = dc === 0;
  const arm = new THREE.Group();

  for (let i = 1; i <= TIE_COUNT; i++) {
    const t = (i / (TIE_COUNT + 0.5)) * 0.5;
    const tieGeo = isNS
      ? new THREE.BoxGeometry(TIE_WIDTH, TIE_HEIGHT, TIE_DEPTH)
      : new THREE.BoxGeometry(TIE_DEPTH, TIE_HEIGHT, TIE_WIDTH);
    const tie = new THREE.Mesh(tieGeo, tieMaterial);
    tie.position.set(dc * t, TIE_HEIGHT / 2 + BED_HEIGHT, dr * t);
    tie.castShadow = true;
    tie.receiveShadow = true;
    arm.add(tie);
  }

  for (const side of [-1, 1]) {
    const railGeo = isNS
      ? new THREE.BoxGeometry(RAIL_WIDTH, RAIL_HEIGHT, 0.5)
      : new THREE.BoxGeometry(0.5, RAIL_HEIGHT, RAIL_WIDTH);
    const rail = new THREE.Mesh(railGeo, railMaterial);
    const x = isNS ? side * RAIL_GAUGE : dc * 0.25;
    const z = isNS ? dr * 0.25 : side * RAIL_GAUGE;
    rail.position.set(x, RAIL_HEIGHT / 2 + BED_HEIGHT, z);
    rail.castShadow = true;
    arm.add(rail);
  }
  return arm;
}

function buildTrackTile(mask: boolean[], pitch: number): THREE.Object3D {
  const group = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.BoxGeometry(0.92, BED_HEIGHT, 0.92), bedMaterial);
  bed.position.y = BED_HEIGHT / 2;
  bed.receiveShadow = true;
  group.add(bed);

  let dirs = [0, 1, 2, 3].filter((d) => mask[d]);
  if (dirs.length === 0) dirs = [0, 2]; // isolated tile: default N/S stub so it isn't blank
  for (const d of dirs) group.add(buildRailArm(d));

  // Only a straight run (1 or 2-opposite connections) ever carries a nonzero
  // pitch — junction shapes always grade flat — so deriving the travel axis
  // from the first connected direction is safe here the same way
  // RoadSystem's straight-mesh builder does.
  if (pitch !== 0) {
    const axisIsZ = dirs[0] % 2 === 0;
    group.rotation.x = axisIsZ ? pitch : 0;
    group.rotation.z = axisIsZ ? 0 : -pitch;
  }
  group.scale.setScalar(TILE_SIZE);
  return group;
}

export class TrackSystem extends TileNetwork<TrackKind> {
  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
  }

  protected speedMultiplier(kind: TrackKind): number {
    return TRACK_SPEED_MULTIPLIER[kind];
  }

  protected buildMesh(_kind: TrackKind, _facing: number, mask: boolean[], _cell: Cell, pitch: number): THREE.Object3D {
    return buildTrackTile(mask, pitch);
  }

  protected curbColor(): number {
    return 0x35302a; // dark ballast-shoulder tint, distinct from a road's grey curb
  }
}
