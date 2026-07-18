import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { TrackAssets } from "./assets";
import { TileNetwork, TILE_SIZE, DIRS, cellCenter, type Cell, buildKenneyMesh, buildArchBridgeMesh } from "./network";

export const TrackKind = {
  Standard: "standard",
  Bridge: "bridge",
} as const;
export type TrackKind = (typeof TrackKind)[keyof typeof TrackKind];

export const TRACK_SPEED_MULTIPLIER: Record<TrackKind, number> = {
  [TrackKind.Standard]: 1,
  [TrackKind.Bridge]: 1,
};

// A brick arch bridge for trains — same span mechanic as the road bridge
// (see roads.ts), narrower deck and a warmer brick-red support color
// instead of concrete grey.
const TRACK_BRIDGE_DECK_WIDTH = 1.6;
const TRACK_BRIDGE_DECK_COLOR = 0x8a8478; // ballast/stone deck edge
const TRACK_BRIDGE_PIER_COLOR = 0x8a3a2e; // brick red

// Kenney's train kit (real assets — kenney.nl itself is blocked from this
// sandbox, but the user supplied the kit directly) is already authored at
// tile scale (railroad-straight.glb spans exactly 4 units, matching
// TILE_SIZE) and with its origin at one corner rather than centered, unlike
// the city-builder road kit — assets.ts recenters it once at load time so it
// drops into the same buildKenneyMesh pipeline roads use. No color retint is
// wanted (the kit's own silver rail / brown tie colors are already right),
// so it passes an identity tint.
const IDENTITY_TINT_TARGET = 0xffffff;
const IDENTITY_SWATCH: number[] = [1, 1, 1];

function buildStraightTrack(axisIsZ: boolean, pitch: number, trackAssets: TrackAssets): THREE.Object3D {
  return buildKenneyMesh(trackAssets.straight, axisIsZ ? 0 : Math.PI / 2, IDENTITY_TINT_TARGET, IDENTITY_SWATCH, pitch, 1);
}

// --- Procedural rail geometry (curves and 3-/4-way junctions) ------------
//
// The train kit's only curve piece (railroad-corner-large.glb) turned out to
// be a wide, multi-tile-radius curve — its two rail tangent points sit at
// diagonally opposite corners of a ~4.49-unit footprint, not at the
// midpoints of two adjacent tile edges, so no rotation or recenter pivot
// could make it connect flush to a neighboring straight piece within one
// TILE_SIZE=4 cell (see assets.ts for how that was actually measured, not
// guessed). Curves are built procedurally instead, the same way junctions
// already were — an arc of rail/tie segments running from one connected
// edge's midpoint to the other's, exactly, by construction.
// Matches the Kenney straight piece's own rail spacing exactly — measured
// directly off its rendered rail vertices at a tile seam (centerlines at
// +-0.3, each rail 0.1 wide) — rather than an earlier, narrower guess that
// only the procedural junction pieces used and nothing cross-checked against
// the actual asset, so a junction never actually lined up with a straight
// either.
const RAIL_GAUGE = 0.3;
const RAIL_WIDTH = 0.1;
const RAIL_HEIGHT = 0.05;
const BED_HEIGHT = 0.03;
const TIE_COUNT = 3;
// Wide enough to reach a bit past both rails' outer edges (rail centerlines
// at +-RAIL_GAUGE, +-RAIL_WIDTH/2 wide each) rather than stopping short of
// them — matters more now that RAIL_GAUGE matches the actual (wider) Kenney
// straight piece instead of the old, narrower procedural-only guess.
const TIE_WIDTH = 0.9;
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

// How many straight sub-segments approximate the arc — enough for a smooth
// curve at this tile scale without needing a real curved-geometry pipeline
// (ExtrudeGeometry/TubeGeometry) just for two thin rail lines.
const CURVE_ARC_SEGMENTS = 10;
const CURVE_TIE_COUNT = 7;

/**
 * A curve connecting two perpendicular directions `dirs`, built as an arc of
 * straight rail/tie segments from one connected edge's midpoint to the
 * other's — exactly, by construction, rather than relying on a pre-modeled
 * asset's own (possibly mismatched) geometry.
 *
 * The arc's center is the tile corner diagonally between the two connected
 * edges, at radius TILE_SIZE/2: for perpendicular directions A and B, that
 * corner is always exactly TILE_SIZE/2 from both edge midpoints (Pythagoras
 * isn't even needed — it falls straight out of DIRS being unit vectors
 * along the axes), so a circle of that radius centered there passes through
 * both tangent points and sweeps through the tile's interior between them,
 * the same shape a real quarter-circle curve piece should have.
 */
function buildCurveTrack(dirs: [number, number]): THREE.Object3D {
  const half = TILE_SIZE / 2;
  const [dA, dB] = [DIRS[dirs[0]], DIRS[dirs[1]]];
  const centerX = (dA.dc + dB.dc) * half;
  const centerZ = (dA.dr + dB.dr) * half;
  const angleA = Math.atan2(dA.dr * half - centerZ, dA.dc * half - centerX);
  const angleB = Math.atan2(dB.dr * half - centerZ, dB.dc * half - centerX);
  let delta = angleB - angleA;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const group = new THREE.Group();

  for (const offset of [-RAIL_GAUGE, RAIL_GAUGE]) {
    const r = half + offset;
    for (let i = 0; i < CURVE_ARC_SEGMENTS; i++) {
      const ang0 = angleA + (delta * i) / CURVE_ARC_SEGMENTS;
      const ang1 = angleA + (delta * (i + 1)) / CURVE_ARC_SEGMENTS;
      const x0 = centerX + Math.cos(ang0) * r;
      const z0 = centerZ + Math.sin(ang0) * r;
      const x1 = centerX + Math.cos(ang1) * r;
      const z1 = centerZ + Math.sin(ang1) * r;
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      const segAngle = Math.atan2(z1 - z0, x1 - x0);
      // Slight overlap between consecutive segments so the polyline
      // approximation of the arc doesn't show hairline gaps at the joins.
      const rail = new THREE.Mesh(new THREE.BoxGeometry(segLen * 1.15, RAIL_HEIGHT, RAIL_WIDTH), railMaterial);
      rail.position.set((x0 + x1) / 2, RAIL_HEIGHT / 2 + BED_HEIGHT, (z0 + z1) / 2);
      rail.rotation.y = -segAngle;
      rail.castShadow = true;
      group.add(rail);
    }
  }

  for (let i = 0; i <= CURVE_TIE_COUNT; i++) {
    const ang = angleA + (delta * i) / CURVE_TIE_COUNT;
    const tx = centerX + Math.cos(ang) * half;
    const tz = centerZ + Math.sin(ang) * half;
    const tie = new THREE.Mesh(new THREE.BoxGeometry(TIE_WIDTH, TIE_HEIGHT, TIE_DEPTH), tieMaterial);
    tie.position.set(tx, TIE_HEIGHT / 2 + BED_HEIGHT, tz);
    tie.rotation.y = -ang; // radial direction — perpendicular to the rails at this point, same as a straight tie
    tie.castShadow = true;
    tie.receiveShadow = true;
    group.add(tie);
  }

  return group;
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

  protected buildMesh(kind: TrackKind, _facing: number, mask: boolean[], cell: Cell, pitch: number): THREE.Object3D {
    if (kind === TrackKind.Bridge) return this.buildBridgeMesh(cell, mask);
    const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
    if (dirs.length >= 3) return buildJunctionTile(dirs);
    if (dirs.length === 2) {
      const [a, b] = dirs;
      const opposite = (a + 2) % 4 === b;
      if (opposite) return buildStraightTrack(a % 2 === 0, pitch, this.trackAssets);
      return buildCurveTrack([a, b] as [number, number]);
    }
    if (dirs.length === 1) return buildStraightTrack(dirs[0] % 2 === 0, pitch, this.trackAssets);
    return buildStraightTrack(true, pitch, this.trackAssets); // isolated tile: default N/S stub
  }

  private buildBridgeMesh(cell: Cell, mask: boolean[]): THREE.Object3D {
    const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
    const axisIsZ = dirs.length > 0 ? dirs[0] % 2 === 0 : true;
    const center = cellCenter(cell);
    const deckY = this.tileHeight(cell) ?? this.terrain.getHeightAt(center.x, center.z);
    const bedY = this.terrain.getHeightAt(center.x, center.z);
    return buildArchBridgeMesh(axisIsZ, deckY, bedY, {
      deckColor: TRACK_BRIDGE_DECK_COLOR,
      pierColor: TRACK_BRIDGE_PIER_COLOR,
      deckWidth: TRACK_BRIDGE_DECK_WIDTH,
      railing: false,
    });
  }

  protected buildsCurbs(): boolean {
    // Trains run on rails, not free-roaming physics — there's no gameplay
    // reason for a car-style solid retaining wall around a track tile's
    // unconnected edges (most visible/ugly at dead-ends, where 3 of the 4
    // sides would get walled in).
    return false;
  }

  protected canSlope(kind: TrackKind): boolean {
    return kind !== TrackKind.Bridge;
  }

  protected requiresDryLand(kind: TrackKind): boolean {
    return kind !== TrackKind.Bridge;
  }

  protected gradesTerrain(kind: TrackKind): boolean {
    return kind !== TrackKind.Bridge;
  }

  protected targetFlatHeight(cell: Cell, kind: TrackKind, mask: boolean[]): number {
    if (kind !== TrackKind.Bridge) return super.targetFlatHeight(cell, kind, mask);
    const neighborHeights: number[] = [];
    for (let dir = 0; dir < 4; dir++) {
      if (!mask[dir]) continue;
      const { dc, dr } = DIRS[dir];
      const neighborHeight = this.tileHeight({ col: cell.col + dc, row: cell.row + dr });
      if (neighborHeight !== null) neighborHeights.push(neighborHeight);
    }
    if (neighborHeights.length === 0) return super.targetFlatHeight(cell, kind, mask);
    return neighborHeights.reduce((a, b) => a + b, 0) / neighborHeights.length;
  }
}
