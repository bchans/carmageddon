import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { RoadAssets } from "./assets";
import {
  TileNetwork,
  TILE_SIZE,
  DIRS,
  cellKey,
  cellCenter,
  type Cell,
  buildKenneyMesh,
  buildKenneyShapeMesh,
  buildArchBridgeMesh,
  srgbToLinear,
} from "./network";

export { TILE_SIZE };
export type { Cell, Waypoint } from "./network";

// Ramp launch surface: tilt angle, the total span it covers from its entry
// edge, and its physical (invisible) thickness.
const RAMP_LAUNCH_ANGLE = 0.49;
const RAMP_LENGTH = TILE_SIZE * 1.5;
const RAMP_THICKNESS = 0.5;

export const RoadKind = {
  Standard: "standard",
  Crossroad: "crossroad",
  Ramp: "ramp",
  Bridge: "bridge",
} as const;
export type RoadKind = (typeof RoadKind)[keyof typeof RoadKind];

// A concrete arch bridge — the deck holds a fixed elevation matching
// whatever it connects to on each end rather than grading down to the
// ground/water below (see RoadSystem.targetFlatHeight), on visible arch
// supports that actually reach down to the real bed height underneath.
const BRIDGE_DECK_WIDTH = 3.2;
const BRIDGE_DECK_COLOR = 0xb9b6ad; // concrete
const BRIDGE_PIER_COLOR = 0x8f8c83; // slightly darker concrete for the support mass

// A highway sign is a modifier placed on an already-built road tile (see
// RoadSystem.placeSign), not a RoadKind of its own, so this is the only
// speed multiplier left in the road system.
export const HIGHWAY_SIGN_SPEED_MULTIPLIER = 1.6;

// --- Road surfaces ---------------------------------------------------------
//
// All road shapes — straight, curve, T-junction, and 4-way crossroad — reuse
// Kenney's actual GLB meshes (real geometry: curb bevels, corner accents,
// lane dashes) from github.com/KenneyNL/Starter-Kit-City-Builder, the one
// Kenney kit set that includes a proper curve/corner and T/split piece (the
// older city-kit-roads pack bundled alongside it for the ramp does not).
//
// Kenney's shared atlas swatch that these pieces sample reads as a dark
// slate-navy under neutral lighting (measured directly off the rendered
// mesh, not a color-space bug), not the light grey/white asphalt the game
// wants. The tint multiplier recolors it: material.color multiplies the
// mapped texture in the renderer's linear working space, so it's derived by
// converting both the measured swatch and the desired target through the
// sRGB transfer function rather than guessing a flat replacement color
// (which would just crush the lane-line contrast).
const CITYBUILDER_SWATCH_LINEAR = [79 / 255, 82 / 255, 96 / 255].map(srgbToLinear);
const CITYKIT_SWATCH_LINEAR = [84 / 255, 88 / 255, 105 / 255].map(srgbToLinear);

const TILE_TARGET_COLOR: Record<RoadKind, number> = {
  [RoadKind.Standard]: 0xacaeb4,
  [RoadKind.Crossroad]: 0xacaeb4,
  [RoadKind.Ramp]: 0xacaeb4,
  [RoadKind.Bridge]: BRIDGE_DECK_COLOR,
};

// --- Highway sign -----------------------------------------------------------
//
// A modifier placed on an already-built road tile rather than a tile kind of
// its own — the player picks a spot on their existing road, not a fresh cell.
// No Kenney sign asset exists in this repo (kenney.nl itself is unreachable
// from this sandbox — see the note on the train kit above), so this is a
// small procedural placeholder (post + green placard) rather than a real
// Kenney model; swap it for one if a suitable GLB gets added later.
const SIGN_POST_HEIGHT = 1.6;
const signPostMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.6, metalness: 0.4 });
const signBoardMaterial = new THREE.MeshStandardMaterial({ color: 0x1f7a3d, roughness: 0.5, metalness: 0.1 });
const signChevronMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });

function buildHighwaySignMesh(facing: number): THREE.Object3D {
  const group = new THREE.Group();

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, SIGN_POST_HEIGHT, 8), signPostMaterial);
  post.position.y = SIGN_POST_HEIGHT / 2;
  post.castShadow = true;
  group.add(post);

  const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 1.1), signBoardMaterial);
  board.position.y = SIGN_POST_HEIGHT - 0.5;
  board.castShadow = true;
  group.add(board);

  // A simple upward chevron on the placard reads as "speed up ahead" without
  // needing any text/texture.
  for (const dz of [-0.22, 0, 0.22]) {
    const chevron = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.32), signChevronMaterial);
    chevron.position.set(0.035, SIGN_POST_HEIGHT - 0.5, dz);
    chevron.rotation.x = dz === 0 ? 0 : (dz > 0 ? -1 : 1) * 0.5;
    group.add(chevron);
  }

  // Planted at the tile's edge facing oncoming traffic, not the center, like
  // a real roadside sign — offset towards the incoming direction and turned
  // to face it.
  const { dc, dr } = DIRS[facing];
  group.position.set(dc * (TILE_SIZE / 2 - 0.3), 0, dr * (TILE_SIZE / 2 - 0.3));
  group.rotation.y = Math.atan2(dc, dr) + Math.PI / 2;
  return group;
}

// The road-slant-high.glb template's own slope rises along its local +X axis at
// rotationY=0 (verified empirically: sampling its vertices found a height
// gradient across X, none across Z) — unlike the citybuilder pack's straight/curve
// pieces, which run along local Z. So facing=E (which maps to local +X, i.e. no
// rotation needed) is the rotational "zero", not facing=N; every other facing is
// 90° steps from there.
function buildRampMesh(facing: number, roadAssets: RoadAssets): THREE.Object3D {
  const rotationY = ((facing + 3) % 4) * (Math.PI / 2);
  return buildKenneyMesh(roadAssets.ramp, rotationY, TILE_TARGET_COLOR[RoadKind.Ramp], CITYKIT_SWATCH_LINEAR);
}

export class RoadSystem extends TileNetwork<RoadKind> {
  private readonly roadAssets: RoadAssets;
  private readonly signedCells = new Set<string>();

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    roadAssets: RoadAssets,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    super(RAPIER, world, terrain, isCellFree, claimCell);
    this.roadAssets = roadAssets;
  }

  protected speedMultiplier(): number {
    return 1; // all remaining road kinds are equal-speed for pathfinding purposes
  }

  /** Whether a highway sign can be planted at `cell` — needs an already-built
   * road tile (any kind but Ramp, which has its own launch mechanic) that
   * doesn't already have one. */
  canPlaceSign(cell: Cell): boolean {
    const tile = this.tiles.get(cellKey(cell));
    if (!tile || tile.kind === RoadKind.Ramp) return false;
    return !this.signedCells.has(cellKey(cell));
  }

  placeSign(cell: Cell): boolean {
    if (!this.canPlaceSign(cell)) return false;
    const tile = this.tiles.get(cellKey(cell))!;
    this.signedCells.add(cellKey(cell));
    const mesh = buildHighwaySignMesh(tile.facing);
    mesh.position.add(this.cellWorldCenter(cell));
    this.root.add(mesh);
    return true;
  }

  /** Whether the road tile at this world position has a highway sign — see placeSign(). */
  hasSignAt(x: number, z: number): boolean {
    const cell = this.worldToCell(x, z);
    if (Math.abs(x - cell.col * TILE_SIZE) > TILE_SIZE / 2) return false;
    if (Math.abs(z - cell.row * TILE_SIZE) > TILE_SIZE / 2) return false;
    return this.signedCells.has(cellKey(cell));
  }

  protected canSlope(kind: RoadKind): boolean {
    return kind !== RoadKind.Ramp && kind !== RoadKind.Crossroad && kind !== RoadKind.Bridge;
  }

  protected isAlwaysOpen(kind: RoadKind): boolean {
    return kind === RoadKind.Crossroad;
  }

  protected curbSkipExtra(kind: RoadKind, dir: number, facing: number): boolean {
    if (kind !== RoadKind.Ramp) return false;
    return dir === facing || dir === (facing + 2) % 4; // launch end and entry end stay open
  }

  protected buildsCurbs(kind: RoadKind): boolean {
    // A bridge has its own railings (see buildArchBridgeMesh) instead of the
    // usual solid box curb wall — a plain curb would also nonsensically wall
    // off the two unconnected sides of a span that's supposed to be open air
    // over water.
    return kind !== RoadKind.Bridge;
  }

  protected requiresDryLand(kind: RoadKind): boolean {
    return kind !== RoadKind.Bridge;
  }

  protected gradesTerrain(kind: RoadKind): boolean {
    return kind !== RoadKind.Bridge;
  }

  /** A bridge holds the elevation of whatever it's connected to on each end (averaged if both, matched exactly if only one) instead of matching the ground/water beneath it. */
  protected targetFlatHeight(cell: Cell, kind: RoadKind, mask: boolean[]): number {
    if (kind !== RoadKind.Bridge) return super.targetFlatHeight(cell, kind, mask);
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

  protected buildMesh(kind: RoadKind, facing: number, mask: boolean[], cell: Cell, pitch: number): THREE.Object3D {
    if (kind === RoadKind.Ramp) return buildRampMesh(facing, this.roadAssets);
    if (kind === RoadKind.Bridge) return this.buildBridgeMesh(cell, mask);
    // Every third plain "Road" tile (deterministic by position, so it doesn't
    // flicker between rebuilds) gets Kenney's lightpost variant for a bit of
    // streetscape variety instead of only ever using the bare straight piece.
    const useVariant = (c: Cell) => kind === RoadKind.Standard && (c.col + c.row * 3) % 3 === 0;
    const swatch = CITYBUILDER_SWATCH_LINEAR;
    return buildKenneyShapeMesh(mask, cell, pitch, this.roadAssets, TILE_TARGET_COLOR[kind], swatch, useVariant);
  }

  private buildBridgeMesh(cell: Cell, mask: boolean[]): THREE.Object3D {
    const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
    // A bridge only ever renders as a straight span, oriented along whichever
    // axis its connection(s) lie on — N/S (dir 0 or 2) or E/W (dir 1 or 3).
    // Opposite dirs always share parity, so this works whether it's
    // connected on both ends already or still just one (e.g. right after
    // placement, before its far neighbor exists); an isolated tile with no
    // connections yet has no orientation to go on, so it defaults to N/S.
    const axisIsZ = dirs.length > 0 ? dirs[0] % 2 === 0 : true;
    const center = cellCenter(cell);
    const deckY = this.tileHeight(cell) ?? this.terrain.getHeightAt(center.x, center.z);
    const bedY = this.terrain.getHeightAt(center.x, center.z);
    return buildArchBridgeMesh(axisIsZ, deckY, bedY, {
      deckColor: BRIDGE_DECK_COLOR,
      pierColor: BRIDGE_PIER_COLOR,
      deckWidth: BRIDGE_DECK_WIDTH,
      railing: true,
    });
  }

  protected onTilePlaced(
    tile: { group: THREE.Group; cell: Cell; facing: number; setExtraBody: (b: RAPIER.RigidBody) => void },
    kind: RoadKind,
  ): void {
    if (kind !== RoadKind.Ramp) return;
    // Pivot the tilt at the ground-level entry edge (where this tile meets its
    // incoming neighbor), not the tile center. Pivoting at the center buried the
    // collider's entry half below the (flat) terrain and left its launch half
    // floating unreachably high, so a car driving onto the tile just kept
    // rolling across the terrain heightfield underneath — never actually
    // touching the tilted ramp surface — instead of climbing and launching.
    const center = tile.group.position;
    const travelDir = new THREE.Vector3(DIRS[tile.facing].dc, 0, DIRS[tile.facing].dr);
    const entryEdge = center.clone().addScaledVector(travelDir, -TILE_SIZE / 2);
    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(
      entryEdge.x,
      entryEdge.y + RAMP_THICKNESS / 2,
      entryEdge.z,
    );
    // Rotating by +RAMP_LAUNCH_ANGLE around the horizontal axis perpendicular to
    // travelDir always lifts a point offset along +travelDir upward, regardless
    // of facing — verified for both axis-aligned cases (N/S rotates around X,
    // E/W around Z) rather than needing per-facing sign flips.
    const rotAxis = new THREE.Vector3(-travelDir.z, 0, travelDir.x);
    const tilt = new THREE.Quaternion().setFromAxisAngle(rotAxis, RAMP_LAUNCH_ANGLE);
    bodyDesc.setRotation({ x: tilt.x, y: tilt.y, z: tilt.z, w: tilt.w });
    const body = this.world.createRigidBody(bodyDesc);

    // Ramp surface spans 1.5 tiles (RAMP_LENGTH) from the entry edge towards the
    // launch end — matches the 2-tile jump distance used for its pathfinding
    // shortcut edge in extraEdges(). The long half-extent runs along Z for a N/S
    // ramp (rotated around X) or X for an E/W ramp (rotated around Z).
    const halfLen = RAMP_LENGTH / 2;
    const halfWidth = TILE_SIZE / 2;
    const [hx, hz] = tile.facing % 2 === 0 ? [halfWidth, halfLen] : [halfLen, halfWidth];
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(hx, RAMP_THICKNESS / 2, hz)
      // Local offset (pre-rotation) so the box's near face sits at the pivot
      // (entry edge) and it extends towards the launch end, rather than being
      // centered on the pivot.
      .setTranslation(travelDir.x * halfLen, 0, travelDir.z * halfLen)
      .setFriction(1.1);
    this.world.createCollider(colliderDesc, body);
    tile.setExtraBody(body);
  }

  protected extraEdges(cell: Cell, kind: RoadKind, facing: number): Array<{ cell: Cell; weight: number }> {
    if (kind !== RoadKind.Ramp) return [];
    const { dc, dr } = DIRS[facing];
    const landing = { col: cell.col + dc * 2, row: cell.row + dr * 2 };
    return [{ cell: landing, weight: TILE_SIZE * 1.5 }];
  }
}
