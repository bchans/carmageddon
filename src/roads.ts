import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { RoadAssets } from "./assets";

export const TILE_SIZE = 4;
const CURB_HEIGHT = 0.6;
const CURB_THICKNESS = 0.25;
// Height the pavement decal sits above the (now flattened-flush) terrain, purely
// to avoid z-fighting with the ground mesh underneath it.
const DECAL_HEIGHT = 0.08;
// Max grade a single straight tile will climb (~13°); a bigger gap between two
// connected points gets climbed gradually over consecutive tiles instead. Kept
// gentler than terrain's own natural slope cap so a fast-moving car reliably
// keeps traction through a climb instead of catching air off a steep grade change.
const MAX_GRADE_PITCH = 0.22;
// Ramp launch surface: tilt angle (~28°, tuned steeper than the old 24° for a
// more satisfying launch — see the ramp collider setup in place()), the total
// span it covers from its entry edge, and its physical (invisible) thickness.
const RAMP_LAUNCH_ANGLE = 0.49;
const RAMP_LENGTH = TILE_SIZE * 1.5;
const RAMP_THICKNESS = 0.5;

/** Grading info for a straight tile climbing/descending a slope; junctions stay flat (null). */
interface SlopeInfo {
  axisIsZ: boolean;
  pitch: number; // radians, matches THREE's rotation.x convention for the road mesh
  loHeight: number; // height at the tile's "low" edge (S for a N/S run, W for an E/W run)
  hiHeight: number; // height at the tile's "high" edge (N for a N/S run, E for an E/W run)
}

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

export interface Cell {
  col: number;
  row: number;
}

export interface Waypoint {
  position: THREE.Vector3;
  /** True for points on/approaching a bend's curve, so the autopilot slows and drops boost ahead of the turn instead of only reacting once already inside it. */
  slow: boolean;
}

const DIRS: Array<{ dc: number; dr: number }> = [
  { dc: 0, dr: 1 }, // N
  { dc: 1, dr: 0 }, // E
  { dc: 0, dr: -1 }, // S
  { dc: -1, dr: 0 }, // W
];

function cellKey(c: Cell): string {
  return `${c.col}:${c.row}`;
}

/** Direction index pointing from `from` to `to`, or null if they aren't orthogonal neighbors. */
function directionBetween(from: Cell, to: Cell): number | null {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  for (let d = 0; d < 4; d++) {
    if (DIRS[d].dc === dc && DIRS[d].dr === dr) return d;
  }
  return null;
}

function slopesEqual(a: SlopeInfo | null, b: SlopeInfo | null): boolean {
  if (a === null || b === null) return a === b;
  const eps = 1e-4;
  return (
    a.axisIsZ === b.axisIsZ &&
    Math.abs(a.pitch - b.pitch) < eps &&
    Math.abs(a.loHeight - b.loHeight) < eps &&
    Math.abs(a.hiHeight - b.hiHeight) < eps
  );
}

class RoadTile {
  readonly cell: Cell;
  readonly kind: RoadKind;
  readonly group = new THREE.Group();
  private curbBodies: RAPIER.RigidBody[] = [];
  private curbMeshes: THREE.Object3D[] = [];
  private roadMesh: THREE.Object3D | null = null;
  private readonly world: RAPIER.World;
  private readonly RAPIER: Rapier;
  private centerHeight: number;
  private readonly roadAssets: RoadAssets;
  private slope: SlopeInfo | null;
  /** For ramps: the direction (index into DIRS) the ramp launches towards. */
  readonly facing: number;
  /** For ramps: the fixed launch-surface collider body, kept flush with the tile's
   * pad height across later re-grades (see applyGrade) instead of only ever being
   * positioned once at initial placement. */
  rampBody: RAPIER.RigidBody | null = null;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    cell: Cell,
    kind: RoadKind,
    centerHeight: number,
    facing: number,
    roadAssets: RoadAssets,
    slope: SlopeInfo | null,
  ) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.cell = cell;
    this.kind = kind;
    this.centerHeight = centerHeight;
    this.facing = facing;
    this.roadAssets = roadAssets;
    this.slope = slope;
  }

  /**
   * Re-grades this tile to a newly computed pad height/slope (see
   * `RoadSystem.gradeCell`) and repositions its group accordingly. Needed
   * because a tile's rendered shape can change after it's placed — e.g. a
   * graded straight run turns into a flat T-junction/crossroad plate once a
   * new neighbor connects on a third or fourth side — and the terrain under
   * it has to be re-flattened to match, not left however it was graded for
   * the tile's shape at the time it was first placed.
   *
   * Returns whether the height/slope actually changed, so callers can decide
   * whether this tile's own neighbors need re-grading in turn — a tile's edge
   * height is sampled from the live terrain, which a neighbor's own re-grade
   * can just have overwritten at their shared boundary.
   */
  applyGrade(centerHeight: number, slope: SlopeInfo | null): boolean {
    const changed = Math.abs(this.centerHeight - centerHeight) > 1e-4 || !slopesEqual(this.slope, slope);
    const heightDelta = centerHeight - this.centerHeight;
    this.centerHeight = centerHeight;
    this.slope = slope;
    this.group.position.y = centerHeight;
    if (this.rampBody) {
      // The tile is always flat under a ramp, so a height re-grade shifts the
      // whole (already-pivoted-at-entry-edge) collider straight up/down by the
      // same delta rather than needing to recompute the pivot.
      const t = this.rampBody.translation();
      this.rampBody.setTranslation({ x: t.x, y: t.y + heightDelta, z: t.z }, true);
    }
    return changed;
  }

  /**
   * Rebuild the road surface shape and the perpendicular curb walls. `shapeMask`
   * (real placed tiles only) drives which piece is used, so a tile's shape
   * only ever reflects actual pavement it connects to; `curbMask` (also aware
   * of the spawn/target network endpoints) drives which sides get walled off,
   * so the first/last tile leading to the (unpaved) spawn/target point still
   * stays open there. Using curbMask for the shape too would make a tile's
   * rendered shape flicker between straight/curve/junction depending on
   * where the target marker (which moves every round) happens to wander.
   */
  updateConnections(curbMask: boolean[], shapeMask: boolean[]): void {
    if (this.roadMesh) {
      this.group.remove(this.roadMesh);
      disposeObject3D(this.roadMesh);
    }
    this.roadMesh = buildTileMesh(this.kind, this.facing, shapeMask, this.roadAssets, this.cell, this.slope?.pitch ?? 0);
    this.group.add(this.roadMesh);

    for (const body of this.curbBodies) this.world.removeRigidBody(body);
    this.curbBodies = [];
    for (const mesh of this.curbMeshes) this.group.remove(mesh);
    this.curbMeshes = [];

    if (this.kind === RoadKind.Crossroad) return; // always open in all directions

    const center = cellCenter(this.cell);
    for (let dir = 0; dir < 4; dir++) {
      if (curbMask[dir]) continue;
      if (this.kind === RoadKind.Ramp && dir === this.facing) continue; // launch end stays open
      if (this.kind === RoadKind.Ramp && dir === (this.facing + 2) % 4) continue; // entry end stays open
      this.addCurb(dir, center);
    }
  }

  private addCurb(dir: number, center: THREE.Vector3): void {
    const { dc, dr } = DIRS[dir];
    const isNS = dc === 0; // curb blocks the N or S end (wide in X); false = blocks E/W side (wide in Z)
    const hx = isNS ? TILE_SIZE / 2 : CURB_THICKNESS / 2;
    const hz = isNS ? CURB_THICKNESS / 2 : TILE_SIZE / 2;
    const x = center.x + (dc * TILE_SIZE) / 2;
    const z = center.z + (dr * TILE_SIZE) / 2;

    // On a sloped straight tile, the two curbs running parallel to the travel
    // axis (its sides) are tilted to match the road surface instead of
    // floating above the low end or burying into the high end; the two
    // perpendicular end-cap curbs (when unconnected) sit flat at their own
    // edge's actual height instead of the tile's mid-slope average.
    let y = this.centerHeight + DECAL_HEIGHT + CURB_HEIGHT / 2;
    let tiltX = 0;
    let tiltZ = 0;
    if (this.slope) {
      const isParallelSide = this.slope.axisIsZ ? !isNS : isNS;
      if (isParallelSide) {
        tiltX = this.slope.axisIsZ ? this.slope.pitch : 0;
        tiltZ = this.slope.axisIsZ ? 0 : -this.slope.pitch;
      } else {
        const loDir = this.slope.axisIsZ ? 2 : 3;
        y = (dir === loDir ? this.slope.loHeight : this.slope.hiHeight) + DECAL_HEIGHT + CURB_HEIGHT / 2;
      }
    }

    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    if (tiltX !== 0 || tiltZ !== 0) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, 0, tiltZ));
      bodyDesc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(hx, CURB_HEIGHT / 2, hz).setFriction(0.9);
    this.world.createCollider(colliderDesc, body);
    this.curbBodies.push(body);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, CURB_HEIGHT, hz * 2),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.8 }),
    );
    mesh.position.set(x - center.x, y - this.centerHeight, z - center.z);
    mesh.rotation.set(tiltX, 0, tiltZ);
    mesh.castShadow = true;
    this.group.add(mesh);
    this.curbMeshes.push(mesh);
  }
}

function cellCenter(cell: Cell): THREE.Vector3 {
  return new THREE.Vector3(cell.col * TILE_SIZE, 0, cell.row * TILE_SIZE);
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}

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
// wants. tintMultiplierFor recolors it: material.color multiplies the mapped
// texture in the renderer's linear working space, so the multiplier is
// derived by converting both the measured swatch and the desired target
// through the sRGB transfer function rather than guessing a flat replacement
// color (which would just crush the lane-line contrast).
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// Measured swatch for the city-builder atlas (straight/curve/T/crossroad).
const CITYBUILDER_SWATCH_LINEAR = [79 / 255, 82 / 255, 96 / 255].map(srgbToLinear);
// Measured swatch for the older city-kit-roads atlas (ramp only).
const CITYKIT_SWATCH_LINEAR = [84 / 255, 88 / 255, 105 / 255].map(srgbToLinear);
function tintMultiplierFor(targetHex: number, swatchLinear: number[]): THREE.Color {
  const target = new THREE.Color(targetHex); // hex ctor converts sRGB -> linear working space
  return new THREE.Color(target.r / swatchLinear[0], target.g / swatchLinear[1], target.b / swatchLinear[2]);
}

const TILE_TARGET_COLOR: Record<RoadKind, number> = {
  [RoadKind.Standard]: 0xacaeb4,
  [RoadKind.Crossroad]: 0xacaeb4,
  [RoadKind.Ramp]: 0xacaeb4,
  [RoadKind.Boost]: 0xffa53d,
  [RoadKind.Mud]: 0x6b5636,
};

/** Clones a Kenney road template and recolors it via the gamma-correct tint multiplier. */
function buildKenneyMesh(
  template: THREE.Object3D,
  rotationY: number,
  kind: RoadKind,
  swatchLinear: number[],
  pitch = 0,
): THREE.Object3D {
  const mesh = template.clone(true);
  mesh.scale.setScalar(TILE_SIZE);
  // THREE's default 'XYZ' Euler order composes as Rx * Ry * Rz, which — read as a
  // transform applied to a vector — rotates around Y (yaw) *first* and X (pitch)
  // *last*, using the fixed world X axis. For an E/W run (rotationY = 90°) that
  // pitches the already-yawed mesh around world X, which no longer lines up with
  // its travel axis, tilting it based on tile *width* instead of length (only
  // invisible for N/S runs, where rotationY is 0 and yaw is a no-op). 'YXZ' order
  // composes as Ry * Rx * Rz, applying pitch to the untouched template first (always
  // tilting its native local-Z travel axis) and yaw second, so it works for both.
  mesh.rotation.set(pitch, rotationY, 0, "YXZ");
  // The template's own bottom face sits at local y=0, exactly the flattened terrain's
  // height — without this clearance the two surfaces z-fight, showing as a fine
  // flickering/checkered moire pattern where the terrain and road interleave.
  mesh.position.y = DECAL_HEIGHT;
  const tint = tintMultiplierFor(TILE_TARGET_COLOR[kind], swatchLinear);
  mesh.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const base = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const cloned = (base as THREE.MeshStandardMaterial).clone();
    cloned.color = tint;
    obj.material = cloned;
  });
  return mesh;
}

function buildStraightMesh(
  kind: RoadKind,
  axisIsZ: boolean,
  roadAssets: RoadAssets,
  cell: Cell,
  pitch: number,
): THREE.Object3D {
  // Every third plain "Road" tile (deterministic by position, so it doesn't
  // flicker between rebuilds) gets Kenney's lightpost variant for a bit of
  // streetscape variety instead of only ever using the bare straight piece.
  const useLightposts = kind === RoadKind.Standard && ((cell.col + cell.row * 3) % 3 === 0);
  const template = useLightposts ? roadAssets.straightLightposts : roadAssets.straight;
  // Straight template runs along local Z (native N/S); rotate 90° for an E/W run.
  // `pitch` tilts it to match the graded slope underneath (see RoadSystem.computeSlope) —
  // the real Kenney model rotated to the exact grade, not a separate plain-grey piece.
  return buildKenneyMesh(template, axisIsZ ? 0 : Math.PI / 2, kind, CITYBUILDER_SWATCH_LINEAR, pitch);
}

function buildPlateMesh(kind: RoadKind, roadAssets: RoadAssets): THREE.Object3D {
  return buildKenneyMesh(roadAssets.crossroad, 0, kind, CITYBUILDER_SWATCH_LINEAR);
}

// The road-slant-high.glb template's own slope rises along its local +X axis at
// rotationY=0 (verified empirically: sampling its vertices found a height
// gradient across X, none across Z) — unlike the citybuilder pack's straight/curve
// pieces, which run along local Z. So facing=E (which maps to local +X, i.e. no
// rotation needed) is the rotational "zero", not facing=N; every other facing is
// 90° steps from there.
function buildRampMesh(facing: number, roadAssets: RoadAssets): THREE.Object3D {
  const rotationY = ((facing + 3) % 4) * (Math.PI / 2);
  return buildKenneyMesh(roadAssets.ramp, rotationY, RoadKind.Ramp, CITYKIT_SWATCH_LINEAR);
}

// The corner template natively (rotationY = 0) connects dirs {3, 0} (W, N); the
// T/split template natively connects {3, 0, 1} (W, N, E), i.e. every side but
// S (dir 2). A rotation of k*90° shifts every connected direction index by k
// (mod 4) — verified empirically by rendering the piece at each of the 4
// rotations and sampling which tile edge was pavement vs. grass.
const CORNER_NATIVE_DIRS: [number, number] = [3, 0];
const T_JUNCTION_NATIVE_MISSING_DIR = 2;

function buildCurveMesh(kind: RoadKind, dirs: [number, number], roadAssets: RoadAssets): THREE.Object3D {
  const [a, b] = dirs; // sorted ascending; adjacent pair, either {n, n+1} or the wraparound {0, 3}
  const nativeStart = a === 0 && b === 3 ? 3 : a;
  const steps = ((nativeStart - CORNER_NATIVE_DIRS[0]) % 4 + 4) % 4;
  return buildKenneyMesh(roadAssets.curve, steps * (Math.PI / 2), kind, CITYBUILDER_SWATCH_LINEAR);
}

function buildTJunctionMesh(kind: RoadKind, missingDir: number, roadAssets: RoadAssets): THREE.Object3D {
  const steps = ((missingDir - T_JUNCTION_NATIVE_MISSING_DIR) % 4 + 4) % 4;
  return buildKenneyMesh(roadAssets.tJunction, steps * (Math.PI / 2), kind, CITYBUILDER_SWATCH_LINEAR);
}

/** Picks straight / curve / T-junction / crossroad shape from the tile's actual live connectivity. */
function buildTileMesh(
  kind: RoadKind,
  facing: number,
  mask: boolean[],
  roadAssets: RoadAssets,
  cell: Cell,
  pitch: number,
): THREE.Object3D {
  if (kind === RoadKind.Ramp) return buildRampMesh(facing, roadAssets);
  if (kind === RoadKind.Crossroad) return buildPlateMesh(kind, roadAssets);

  const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
  if (dirs.length === 2) {
    const [a, b] = dirs;
    const opposite = (a + 2) % 4 === b;
    if (opposite) return buildStraightMesh(kind, a % 2 === 0, roadAssets, cell, pitch);
    return buildCurveMesh(kind, [a, b], roadAssets);
  }
  if (dirs.length === 3) {
    const missingDir = [0, 1, 2, 3].find((d) => !dirs.includes(d))!;
    return buildTJunctionMesh(kind, missingDir, roadAssets);
  }
  if (dirs.length === 1) return buildStraightMesh(kind, dirs[0] % 2 === 0, roadAssets, cell, pitch);
  if (dirs.length === 0) return buildStraightMesh(kind, true, roadAssets, cell, pitch);
  return buildPlateMesh(kind, roadAssets); // 4-way
}

export class RoadSystem {
  readonly root = new THREE.Group();
  private readonly tiles = new Map<string, RoadTile>();
  private readonly RAPIER: Rapier;
  private readonly world: RAPIER.World;
  private readonly terrain: Terrain;
  private readonly roadAssets: RoadAssets;
  private spawnCell: Cell = { col: 0, row: 0 };
  private targetCell: Cell = { col: 0, row: 0 };

  constructor(RAPIER: Rapier, world: RAPIER.World, terrain: Terrain, roadAssets: RoadAssets) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.terrain = terrain;
    this.roadAssets = roadAssets;
  }

  /**
   * Roads are permanent and persist across levels — only the spawn/target
   * network endpoints move each time a new toll run starts.
   */
  setEndpoints(spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): void {
    this.spawnCell = this.worldToCell(spawnWorld.x, spawnWorld.z);
    this.targetCell = this.worldToCell(targetWorld.x, targetWorld.z);
    for (const cell of [...this.tiles.keys()]) {
      const [col, row] = cell.split(":").map(Number);
      this.refreshCurbs({ col, row });
    }
  }

  worldToCell(x: number, z: number): Cell {
    return { col: Math.round(x / TILE_SIZE), row: Math.round(z / TILE_SIZE) };
  }

  cellWorldCenter(cell: Cell): THREE.Vector3 {
    const c = cellCenter(cell);
    c.y = this.terrain.getHeightAt(c.x, c.z);
    return c;
  }

  private isNetworkCell(cell: Cell): boolean {
    if (cell.col === this.spawnCell.col && cell.row === this.spawnCell.row) return true;
    if (cell.col === this.targetCell.col && cell.row === this.targetCell.row) return true;
    return this.tiles.has(cellKey(cell));
  }

  private connectionMask(cell: Cell): boolean[] {
    return DIRS.map(({ dc, dr }) => this.isNetworkCell({ col: cell.col + dc, row: cell.row + dr }));
  }

  /** Like connectionMask, but only counts actual placed tiles — never the spawn/target
   * points, which move every round and shouldn't make an unrelated tile's shape flicker. */
  private tileConnectionMask(cell: Cell): boolean[] {
    return DIRS.map(({ dc, dr }) => this.tiles.has(cellKey({ col: cell.col + dc, row: cell.row + dr })));
  }

  /** Which direction (if any) an adjacent network cell lies, for auto-orienting new tiles. */
  private incomingDirection(cell: Cell): number | null {
    for (let dir = 0; dir < 4; dir++) {
      const { dc, dr } = DIRS[dir];
      if (this.isNetworkCell({ col: cell.col + dc, row: cell.row + dr })) return dir;
    }
    return null;
  }

  canPlace(cell: Cell): boolean {
    if (this.tiles.has(cellKey(cell))) return false; // already a tile there
    if (Math.abs(cell.col * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE) return false;
    if (Math.abs(cell.row * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE) return false;
    // The spawn/target cells are always valid to pave — they're already part of
    // the network, they just don't have a tile object (and mesh/curbs/flattened
    // ground) until the player builds one there.
    const isEndpoint =
      (cell.col === this.spawnCell.col && cell.row === this.spawnCell.row) ||
      (cell.col === this.targetCell.col && cell.row === this.targetCell.row);
    if (isEndpoint) return true;
    return this.incomingDirection(cell) !== null;
  }

  /** Flat target height for a new junction tile: the average terrain height at each already-connected edge. */
  private computeFlatHeight(cell: Cell, mask: boolean[]): number {
    const center = cellCenter(cell);
    const heights: number[] = [];
    for (let dir = 0; dir < 4; dir++) {
      if (!mask[dir]) continue;
      const { dc, dr } = DIRS[dir];
      heights.push(this.terrain.getHeightAt(center.x + (dc * TILE_SIZE) / 2, center.z + (dr * TILE_SIZE) / 2));
    }
    if (heights.length === 0) return this.terrain.getHeightAt(center.x, center.z);
    return heights.reduce((a, b) => a + b, 0) / heights.length;
  }

  /**
   * For a tile that will render as a straight piece (one real-tile connection,
   * or two opposite), grades it as a ramp from its low edge's actual terrain
   * height to its high edge's, capped to MAX_GRADE_PITCH — a bigger gap gets
   * climbed gradually by consecutive tiles instead of a single steep one, and
   * a cliff-like connection just steps once at the tile boundary rather than
   * clipping. Junction shapes (bends/T/4-way) return null and stay flat —
   * tilting a multi-directional piece convincingly isn't worth the complexity.
   */
  private computeSlope(cell: Cell, shapeMask: boolean[]): SlopeInfo | null {
    const dirs = [0, 1, 2, 3].filter((d) => shapeMask[d]);
    let axisIsZ: boolean;
    if (dirs.length === 1) {
      axisIsZ = dirs[0] % 2 === 0;
    } else if (dirs.length === 2 && (dirs[0] + 2) % 4 === dirs[1]) {
      axisIsZ = dirs[0] % 2 === 0;
    } else {
      return null;
    }

    const center = cellCenter(cell);
    const loDir = axisIsZ ? 2 : 3;
    const hiDir = axisIsZ ? 0 : 1;
    const lo = this.terrain.getHeightAt(
      center.x + (DIRS[loDir].dc * TILE_SIZE) / 2,
      center.z + (DIRS[loDir].dr * TILE_SIZE) / 2,
    );
    const rawHi = this.terrain.getHeightAt(
      center.x + (DIRS[hiDir].dc * TILE_SIZE) / 2,
      center.z + (DIRS[hiDir].dr * TILE_SIZE) / 2,
    );
    const maxDelta = TILE_SIZE * Math.tan(MAX_GRADE_PITCH);
    const hi = lo + THREE.MathUtils.clamp(rawHi - lo, -maxDelta, maxDelta);
    const pitch = Math.atan2(lo - hi, TILE_SIZE);
    return { axisIsZ, pitch, loHeight: lo, hiHeight: hi };
  }

  /**
   * Grades the ground under a cell so the pavement and its physics both sit
   * flush with the (now-levelled or ramped) terrain underneath, and returns
   * the resulting pad height/slope. Ramp/Crossroad kinds always render as
   * their own fixed (unpitched) mesh regardless of shape, so grading them to
   * a slope would leave their visual + physics tilt mismatched against the
   * now-sloped ground.
   */
  private gradeCell(cell: Cell, kind: RoadKind): { flatHeight: number; slope: SlopeInfo | null } {
    const canSlope = kind !== RoadKind.Ramp && kind !== RoadKind.Crossroad;
    const slope = canSlope ? this.computeSlope(cell, this.tileConnectionMask(cell)) : null;
    const center = cellCenter(cell);
    let flatHeight: number;
    if (slope) {
      const { axisIsZ, loHeight, hiHeight } = slope;
      this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, (x, z) => {
        const t = axisIsZ ? (z - center.z) / (TILE_SIZE / 2) : (x - center.x) / (TILE_SIZE / 2);
        return THREE.MathUtils.lerp(loHeight, hiHeight, (THREE.MathUtils.clamp(t, -1, 1) + 1) / 2);
      });
      flatHeight = (loHeight + hiHeight) / 2;
    } else {
      flatHeight = this.computeFlatHeight(cell, this.connectionMask(cell));
      this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, () => flatHeight);
    }
    return { flatHeight, slope };
  }

  place(cell: Cell, kind: RoadKind): boolean {
    if (!this.canPlace(cell)) return false;
    // Placing directly on the spawn/target cell (before anything else connects to
    // it) has no incoming neighbor to orient from; default to facing south.
    const incoming = this.incomingDirection(cell) ?? 0;
    const facing = (incoming + 2) % 4; // ramp launches away from the connected neighbor

    const { flatHeight, slope } = this.gradeCell(cell, kind);
    const center = cellCenter(cell);
    center.y = flatHeight;

    const tile = new RoadTile(this.RAPIER, this.world, cell, kind, center.y, facing, this.roadAssets, slope);
    tile.group.position.copy(center);
    this.root.add(tile.group);

    // Only ramps get their own physics collider (a tilted launch surface) — every
    // other tile kind is visual + curbs only, relying on the (now-flattened)
    // terrain heightfield for support.
    if (kind === RoadKind.Ramp) {
      // Pivot the tilt at the ground-level entry edge (where this tile meets its
      // incoming neighbor), not the tile center. Pivoting at the center buried the
      // collider's entry half below the (flat) terrain and left its launch half
      // floating unreachably high, so a car driving onto the tile just kept
      // rolling across the terrain heightfield underneath — never actually
      // touching the tilted ramp surface — instead of climbing and launching.
      const travelDir = new THREE.Vector3(DIRS[facing].dc, 0, DIRS[facing].dr);
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
      // shortcut edge in edgesFrom(). The long half-extent runs along Z for a N/S
      // ramp (rotated around X) or X for an E/W ramp (rotated around Z).
      const halfLen = RAMP_LENGTH / 2;
      const halfWidth = TILE_SIZE / 2;
      const [hx, hz] = facing % 2 === 0 ? [halfWidth, halfLen] : [halfLen, halfWidth];
      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(hx, RAMP_THICKNESS / 2, hz)
        // Local offset (pre-rotation) so the box's near face sits at the pivot
        // (entry edge) and it extends towards the launch end, rather than being
        // centered on the pivot.
        .setTranslation(travelDir.x * halfLen, 0, travelDir.z * halfLen)
        .setFriction(1.1);
      this.world.createCollider(colliderDesc, body);
      tile.rampBody = body;
    }
    this.tiles.set(cellKey(cell), tile);

    // Recompute shape/curbs for this tile and every orthogonal neighbor tile,
    // cascading further outward wherever a tile's grade actually changes (a
    // neighbor's own shape may need to upgrade, e.g. straight -> curve, and
    // that can in turn change the terrain height at a shared edge that one of
    // *its* other neighbors sampled its own slope from).
    this.propagateRegrade([cell, ...DIRS.map(({ dc, dr }) => ({ col: cell.col + dc, row: cell.row + dr }))]);
    return true;
  }

  /**
   * Re-grades each seed cell, and whenever a tile's height/slope actually
   * changes, enqueues its own placed neighbors too — re-grading isn't
   * confined to direct neighbors of the newly placed tile because a tile
   * samples its own edge height from the live (possibly just-flattened)
   * terrain, so a change can ripple past the immediate neighbor and leave a
   * more distant tile's pavement stale relative to the ground under it
   * (visible as the pavement clipping into or floating above the terrain).
   */
  private propagateRegrade(seed: Cell[]): void {
    const queue: Cell[] = [...seed];
    const queued = new Set(queue.map(cellKey));
    // Defensive cap: this converges in practice (each re-grade averages
    // toward its neighbors' current heights), but bound the loop so a
    // pathological chain of edits can't hang the tab instead of settling.
    const maxIterations = Math.max(64, this.tiles.size * 8);
    let iterations = 0;
    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const cell = queue.shift()!;
      queued.delete(cellKey(cell));
      if (!this.refreshCurbs(cell)) continue;
      for (const { dc, dr } of DIRS) {
        const neighbor = { col: cell.col + dc, row: cell.row + dr };
        const key = cellKey(neighbor);
        if (this.tiles.has(key) && !queued.has(key)) {
          queue.push(neighbor);
          queued.add(key);
        }
      }
    }
  }

  /** Re-grades and rebuilds a single tile's mesh/curbs; returns whether its height/slope changed. */
  private refreshCurbs(cell: Cell): boolean {
    const tile = this.tiles.get(cellKey(cell));
    if (!tile) return false;
    // A newly-placed neighbor can change this tile's own rendered shape (e.g.
    // straight -> curve/T/crossroad plate as a third or fourth side connects),
    // which changes whether it should be flat or sloped — re-grade the ground
    // under it to match before rebuilding the mesh/curbs, not just once at the
    // tile's original placement. This applies to every kind, including
    // Ramp/Crossroad: their own asset is always flat/fixed regardless of
    // shape, but their *pad height* still needs to track their connected
    // edges, same as any junction tile (applyGrade keeps a ramp's launch
    // collider glued to its pad if that height moves).
    const { flatHeight, slope } = this.gradeCell(cell, tile.kind);
    const changed = tile.applyGrade(flatHeight, slope);
    tile.updateConnections(this.connectionMask(cell), this.tileConnectionMask(cell));
    return changed;
  }

  /**
   * Dijkstra shortest path (weighted by tile speed, so faster tiles like
   * boost strips are preferred) from the spawn cell to the target cell.
   * Returns the ordered cell path, or null if no route exists yet.
   */
  findPath(): Cell[] | null {
    const startKey = cellKey(this.spawnCell);
    const goalKey = cellKey(this.targetCell);
    const dist = new Map<string, number>([[startKey, 0]]);
    const prev = new Map<string, Cell>();
    const visited = new Set<string>();
    const frontier: string[] = [startKey];

    while (frontier.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < frontier.length; i++) {
        if ((dist.get(frontier[i]) ?? Infinity) < (dist.get(frontier[bestIdx]) ?? Infinity)) bestIdx = i;
      }
      const currentKey = frontier.splice(bestIdx, 1)[0];
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      if (currentKey === goalKey) break;

      const [col, row] = currentKey.split(":").map(Number);
      const current: Cell = { col, row };
      for (const edge of this.edgesFrom(current)) {
        const edgeKey = cellKey(edge.cell);
        if (visited.has(edgeKey)) continue;
        const nd = (dist.get(currentKey) ?? Infinity) + edge.weight;
        if (nd < (dist.get(edgeKey) ?? Infinity)) {
          dist.set(edgeKey, nd);
          prev.set(edgeKey, current);
          frontier.push(edgeKey);
        }
      }
    }

    if (!dist.has(goalKey)) return null;
    const path: Cell[] = [this.targetCell];
    let currentKey = goalKey;
    while (currentKey !== startKey) {
      const p = prev.get(currentKey);
      if (!p) return null;
      path.push(p);
      currentKey = cellKey(p);
    }
    path.reverse();
    return path;
  }

  /** Orthogonal neighbors plus ramp shortcut edges (a ramp jumps 2 tiles). */
  private edgesFrom(cell: Cell): Array<{ cell: Cell; weight: number }> {
    const edges: Array<{ cell: Cell; weight: number }> = [];
    for (const { dc, dr } of DIRS) {
      const neighbor = { col: cell.col + dc, row: cell.row + dr };
      if (!this.isNetworkCell(neighbor)) continue;
      const kind = this.tiles.get(cellKey(neighbor))?.kind;
      const speed = kind ? SPEED_MULTIPLIER[kind] : 1;
      edges.push({ cell: neighbor, weight: TILE_SIZE / speed });
    }
    const tile = this.tiles.get(cellKey(cell));
    if (tile?.kind === RoadKind.Ramp) {
      const { dc, dr } = DIRS[tile.facing];
      const landing = { col: cell.col + dc * 2, row: cell.row + dr * 2 };
      if (this.isNetworkCell(landing)) {
        edges.push({ cell: landing, weight: TILE_SIZE * 1.5 });
      }
    }
    return edges;
  }

  /**
   * Samples points along the tile's actual curve for a bend, so the autopilot
   * hugs the pavement through a turn instead of cutting straight across the
   * tile from one neighbor's center to the next.
   */
  private sampleBendPoints(cell: Cell, dirIn: number, dirOut: number): THREE.Vector3[] {
    const center = this.cellWorldCenter(cell);
    if ((dirIn + 2) % 4 === dirOut) return [center]; // straight-through, one point suffices

    const A = DIRS[dirIn];
    const B = DIRS[dirOut];
    const half = TILE_SIZE / 2;
    const cx = center.x + (A.dc + B.dc) * half;
    const cz = center.z + (A.dr + B.dr) * half;
    const angleA = Math.atan2(-B.dr, -B.dc);
    const angleB = Math.atan2(-A.dr, -A.dc);
    let delta = angleB - angleA;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const samples = 3;
    const points: THREE.Vector3[] = [];
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const ang = angleA + delta * t;
      points.push(new THREE.Vector3(cx + Math.cos(ang) * half, center.y, cz + Math.sin(ang) * half));
    }
    return points;
  }

  /**
   * Converts a cell path into world-space waypoints, tracing curves through
   * bends and using exact spawn/target positions at the ends. Points on a
   * bend's arc are tagged `slow`, along with the point immediately before
   * one, so the autopilot starts easing off before it's already mid-turn.
   */
  buildWaypoints(path: Cell[], spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): Waypoint[] {
    const points: Waypoint[] = [];
    for (let i = 0; i < path.length; i++) {
      if (i === 0) {
        points.push({ position: spawnWorld.clone(), slow: false });
        continue;
      }
      if (i === path.length - 1) {
        points.push({ position: targetWorld.clone(), slow: false });
        continue;
      }
      const cell = path[i];
      const dirIn = directionBetween(cell, path[i - 1]);
      const dirOut = directionBetween(cell, path[i + 1]);
      if (dirIn !== null && dirOut !== null) {
        const bendPoints = this.sampleBendPoints(cell, dirIn, dirOut);
        const isBend = bendPoints.length > 1;
        if (isBend && points.length > 0) points[points.length - 1].slow = true; // brake before entering the turn
        for (const position of bendPoints) points.push({ position, slow: isBend });
      } else {
        points.push({ position: this.cellWorldCenter(cell), slow: false });
      }
    }
    return points;
  }

  getKindAt(x: number, z: number): RoadKind | null {
    const cell = this.worldToCell(x, z);
    if (Math.abs(x - cell.col * TILE_SIZE) > TILE_SIZE / 2) return null;
    if (Math.abs(z - cell.row * TILE_SIZE) > TILE_SIZE / 2) return null;
    return this.tiles.get(cellKey(cell))?.kind ?? null;
  }

  get tileCount(): number {
    return this.tiles.size;
  }
}
