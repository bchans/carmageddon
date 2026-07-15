import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { RoadAssets } from "./assets";
import {
  TileNetwork,
  TILE_SIZE,
  DIRS,
  type Cell,
  buildKenneyMesh,
  buildKenneyShapeMesh,
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
  Boost: "boost",
  Mud: "mud",
} as const;
export type RoadKind = (typeof RoadKind)[keyof typeof RoadKind];

export const SPEED_MULTIPLIER: Record<RoadKind, number> = {
  [RoadKind.Standard]: 1,
  [RoadKind.Crossroad]: 1,
  [RoadKind.Ramp]: 1,
  [RoadKind.Boost]: 1.7,
  [RoadKind.Mud]: 0.45,
};

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
  [RoadKind.Boost]: 0xffa53d,
  [RoadKind.Mud]: 0x6b5636,
};

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

  protected speedMultiplier(kind: RoadKind): number {
    return SPEED_MULTIPLIER[kind];
  }

  protected canSlope(kind: RoadKind): boolean {
    return kind !== RoadKind.Ramp && kind !== RoadKind.Crossroad;
  }

  protected isAlwaysOpen(kind: RoadKind): boolean {
    return kind === RoadKind.Crossroad;
  }

  protected curbSkipExtra(kind: RoadKind, dir: number, facing: number): boolean {
    if (kind !== RoadKind.Ramp) return false;
    return dir === facing || dir === (facing + 2) % 4; // launch end and entry end stay open
  }

  protected buildMesh(kind: RoadKind, facing: number, mask: boolean[], cell: Cell, pitch: number): THREE.Object3D {
    if (kind === RoadKind.Ramp) return buildRampMesh(facing, this.roadAssets);
    // Every third plain "Road" tile (deterministic by position, so it doesn't
    // flicker between rebuilds) gets Kenney's lightpost variant for a bit of
    // streetscape variety instead of only ever using the bare straight piece.
    const useVariant = (c: Cell) => kind === RoadKind.Standard && (c.col + c.row * 3) % 3 === 0;
    const swatch = CITYBUILDER_SWATCH_LINEAR;
    return buildKenneyShapeMesh(mask, cell, pitch, this.roadAssets, TILE_TARGET_COLOR[kind], swatch, useVariant);
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
