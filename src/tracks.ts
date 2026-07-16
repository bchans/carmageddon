import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { TrackAssets } from "./assets";
import { TileNetwork, TILE_SIZE, DIRS, type Cell, buildKenneyMesh, curveRotationSteps } from "./network";

export const TrackKind = {
  Standard: "standard",
} as const;
export type TrackKind = (typeof TrackKind)[keyof typeof TrackKind];

export const TRACK_SPEED_MULTIPLIER: Record<TrackKind, number> = {
  [TrackKind.Standard]: 1,
};

// Kenney's train kit (real assets — kenney.nl itself is blocked from this
// sandbox, but the user supplied the kit directly) is already authored at
// tile scale (railroad-straight.glb spans exactly 4 units, matching
// TILE_SIZE) and with its origin at one corner rather than centered, unlike
// the city-builder road kit — assets.ts recenters the straight/curve
// templates once at load time so they drop into the same buildKenneyMesh
// pipeline roads use. No color retint is wanted (the kit's own silver
// rail / brown tie colors are already right), so straight/curve pass an
// identity tint.
const IDENTITY_TINT_TARGET = 0xffffff;
const IDENTITY_SWATCH: number[] = [1, 1, 1];

// The corner-large template natively (rotationY = 0) connects dirs {3, 0}
// (W, N) — same pivot as the road kit's corner piece. (An earlier {0, 1}
// assumption here was wrong: sampling the raw GLB's own bounding box before
// recentering showed its geometry actually extends toward -X/+Z, i.e. hugs
// the west/north edges exactly like the road corner, not north/east — that
// mismatch rotated every placed curve tile by a fixed wrong offset, which is
// why curves visually faced the wrong way.)
const TRACK_CORNER_NATIVE_DIRS: [number, number] = [3, 0];

function buildStraightTrack(axisIsZ: boolean, pitch: number, trackAssets: TrackAssets): THREE.Object3D {
  return buildKenneyMesh(trackAssets.straight, axisIsZ ? 0 : Math.PI / 2, IDENTITY_TINT_TARGET, IDENTITY_SWATCH, pitch, 1);
}

function buildCurveTrack(dirs: [number, number], trackAssets: TrackAssets): THREE.Object3D {
  const steps = curveRotationSteps(dirs, TRACK_CORNER_NATIVE_DIRS);
  return buildKenneyMesh(trackAssets.curve, steps * (Math.PI / 2), IDENTITY_TINT_TARGET, IDENTITY_SWATCH, 0, 1);
}

// --- Procedural fallback for 3-/4-way junctions --------------------------
//
// The train kit has no T-junction/crossing piece (real rail networks rarely
// have a literal 4-way rail crossing either), so a junction tile — otherwise
// rare — falls back to simple procedural rail arms instead of a missing
// asset.
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

function buildJunctionTile(dirs: number[]): THREE.Object3D {
  const group = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.BoxGeometry(0.92, BED_HEIGHT, 0.92), bedMaterial);
  bed.position.y = BED_HEIGHT / 2;
  bed.receiveShadow = true;
  group.add(bed);
  for (const d of dirs) group.add(buildRailArm(d));
  group.scale.setScalar(TILE_SIZE);
  return group;
}

export class TrackSystem extends TileNetwork<TrackKind> {
  private readonly trackAssets: TrackAssets;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    trackAssets: TrackAssets,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
    this.trackAssets = trackAssets;
  }

  protected speedMultiplier(kind: TrackKind): number {
    return TRACK_SPEED_MULTIPLIER[kind];
  }

  protected buildMesh(_kind: TrackKind, _facing: number, mask: boolean[], _cell: Cell, pitch: number): THREE.Object3D {
    const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
    if (dirs.length >= 3) return buildJunctionTile(dirs);
    if (dirs.length === 2) {
      const [a, b] = dirs;
      const opposite = (a + 2) % 4 === b;
      if (opposite) return buildStraightTrack(a % 2 === 0, pitch, this.trackAssets);
      return buildCurveTrack([a, b] as [number, number], this.trackAssets);
    }
    if (dirs.length === 1) return buildStraightTrack(dirs[0] % 2 === 0, pitch, this.trackAssets);
    return buildStraightTrack(true, pitch, this.trackAssets); // isolated tile: default N/S stub
  }

  protected curbColor(): number {
    return 0x35302a; // dark ballast-shoulder tint, distinct from a road's grey curb
  }
}
