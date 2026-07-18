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

// Sampled directly off a rendered Kenney straight piece (not guessed): the
// old values (0x8b909b rail, 0x4a3524 tie) were never actually cross-checked
// against the asset they're supposed to match, so a curve or junction never
// really blended into a straight even once the geometry lined up.
const railMaterial = new THREE.MeshStandardMaterial({ color: 0x8089ad, roughness: 0.35, metalness: 0.6 });
const tieMaterial = new THREE.MeshStandardMaterial({ color: 0xa5694e, roughness: 0.85 });
const bedMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 1 });

// How far each arm's rails/ties stop short of the tile center, in world
// units — matters for two reasons. First, letting rails run all the way to
// the center meant an N/S arm's rails (fixed at x=+-RAIL_GAUGE) sliced
// straight through an E/W arm's rails (fixed at z=+-RAIL_GAUGE) right
// around the middle, on any junction with arms on both axes — visible as a
// crosshatched box instead of tracks converging on a point. Insetting
// leaves a small gap that a flat hub pad (see buildJunctionTile) fills
// instead, so arms visually meet at the center without their actual
// geometry crossing. Second — and this is what actually made a junction
// look broken rather than just busy — buildRailArm's positions/dimensions
// are real world units exactly like buildCurveTrack's (RAIL_GAUGE, tie
// sizes, etc. were all measured directly off the rendered Kenney straight,
// see the constants above), but buildJunctionTile used to additionally
// scale its whole group by TILE_SIZE (4x) on top of that, inherited from
// when these were small pre-scale fractions — quadrupling every dimension
// and turning what should read as a rail crossing into an oversized brown
// slab. Both functions now build in the same real-world-unit space with no
// extra group scale, matching how the curve already worked correctly.
const ARM_INSET = 0.6;

function buildRailArm(dir: number): THREE.Group {
  const { dc, dr } = DIRS[dir];
  const isNS = dc === 0;
  const arm = new THREE.Group();
  const half = TILE_SIZE / 2;
  const armLength = half - ARM_INSET;
  const armMid = ARM_INSET + armLength / 2;

  for (let i = 1; i <= TIE_COUNT; i++) {
    const t = ARM_INSET + (i / (TIE_COUNT + 0.5)) * armLength;
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
      ? new THREE.BoxGeometry(RAIL_WIDTH, RAIL_HEIGHT, armLength)
      : new THREE.BoxGeometry(armLength, RAIL_HEIGHT, RAIL_WIDTH);
    const rail = new THREE.Mesh(railGeo, railMaterial);
    const x = isNS ? side * RAIL_GAUGE : dc * armMid;
    const z = isNS ? dr * armMid : side * RAIL_GAUGE;
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

// A modest pad under the crossing — a bit wider than a tie (TIE_WIDTH) so
// it peeks out from underneath, not a near-full-tile slab.
const JUNCTION_BED_SIZE = 1.3;

function buildJunctionTile(dirs: number[]): THREE.Object3D {
  const group = new THREE.Group();
  const bed = new THREE.Mesh(new THREE.BoxGeometry(JUNCTION_BED_SIZE, BED_HEIGHT, JUNCTION_BED_SIZE), bedMaterial);
  bed.position.y = BED_HEIGHT / 2;
  bed.receiveShadow = true;
  group.add(bed);
  // Fills the small gap each arm's rails/ties now stop short of (see
  // ARM_INSET) so the junction still reads as one continuous convergence
  // point instead of a visible hole at the center.
  const hub = new THREE.Mesh(new THREE.BoxGeometry(ARM_INSET * 1.5, TIE_HEIGHT, ARM_INSET * 1.5), tieMaterial);
  hub.position.y = TIE_HEIGHT / 2 + BED_HEIGHT;
  hub.castShadow = true;
  hub.receiveShadow = true;
  group.add(hub);
  for (const d of dirs) group.add(buildRailArm(d));
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
    if (kind === TrackKind.Bridge) return this.buildBridgeMesh(cell, mask, pitch);
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

  private buildBridgeMesh(cell: Cell, mask: boolean[], pitch: number): THREE.Object3D {
    const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
    const axisIsZ = dirs.length > 0 ? dirs[0] % 2 === 0 : true;
    const center = cellCenter(cell);
    const deckY = this.tileHeight(cell) ?? this.terrain.getHeightAt(center.x, center.z);
    const bedY = this.terrain.getHeightAt(center.x, center.z);
    const group = new THREE.Group();
    group.add(
      buildArchBridgeMesh(
        axisIsZ,
        deckY,
        bedY,
        { deckColor: TRACK_BRIDGE_DECK_COLOR, pierColor: TRACK_BRIDGE_PIER_COLOR, deckWidth: TRACK_BRIDGE_DECK_WIDTH, railing: false },
        pitch,
      ),
    );
    // Same idea as the road bridge: the arch is just the structural
    // slab/support — lay actual rails on top so a train bridge doesn't read
    // as a bare platform with nothing to ride on.
    group.add(buildStraightTrack(axisIsZ, pitch, this.trackAssets));
    return group;
  }

  protected buildsCurbs(): boolean {
    // Trains run on rails, not free-roaming physics — there's no gameplay
    // reason for a car-style solid retaining wall around a track tile's
    // unconnected edges (most visible/ugly at dead-ends, where 3 of the 4
    // sides would get walled in).
    return false;
  }

  /** A bridge ramps to match whatever it's connected to at each end (possibly a different height on each side) instead of sampling the ground/water it's spanning over. */
  protected slopeSourceHeight(cell: Cell, kind: TrackKind, dir: number): number {
    if (kind !== TrackKind.Bridge) return super.slopeSourceHeight(cell, kind, dir);
    const { dc, dr } = DIRS[dir];
    const neighborEdge = this.edgeHeightTowards({ col: cell.col + dc, row: cell.row + dr }, (dir + 2) % 4);
    return neighborEdge ?? super.slopeSourceHeight(cell, kind, dir);
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
