import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";

// Shared grid used by every transport network (roads, train tracks, canals) so
// their tiles line up on the same cells and can block one another.
export const TILE_SIZE = 4;
const DECAL_HEIGHT = 0.08; // clearance above flattened terrain to dodge z-fighting
// Max grade a single straight tile will climb; a bigger gap between two
// connected points gets climbed gradually over consecutive tiles instead.
const MAX_GRADE_PITCH = 0.22;

export interface Cell {
  col: number;
  row: number;
}

export interface Waypoint {
  position: THREE.Vector3;
  /** True for points on/approaching a bend's curve, so a follower slows down ahead of the turn instead of only reacting once already inside it. */
  slow: boolean;
}

/** Grading info for a straight tile climbing/descending a slope; junctions stay flat (null). */
export interface SlopeInfo {
  axisIsZ: boolean;
  pitch: number; // radians, matches THREE's rotation.x convention
  loHeight: number; // height at the tile's "low" edge (S for a N/S run, W for an E/W run)
  hiHeight: number; // height at the tile's "high" edge (N for a N/S run, E for an E/W run)
}

export const DIRS: Array<{ dc: number; dr: number }> = [
  { dc: 0, dr: 1 }, // N
  { dc: 1, dr: 0 }, // E
  { dc: 0, dr: -1 }, // S
  { dc: -1, dr: 0 }, // W
];

export function cellKey(c: Cell): string {
  return `${c.col}:${c.row}`;
}

export function cellCenter(cell: Cell): THREE.Vector3 {
  return new THREE.Vector3(cell.col * TILE_SIZE, 0, cell.row * TILE_SIZE);
}

export function worldToCell(x: number, z: number): Cell {
  return { col: Math.round(x / TILE_SIZE), row: Math.round(z / TILE_SIZE) };
}

/** Direction index pointing from `from` to `to`, or null if they aren't orthogonal neighbors. */
export function directionBetween(from: Cell, to: Cell): number | null {
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

export function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}

// --- Kenney mesh helpers (shared straight/curve/T/crossroad shape logic) ---
//
// Any network that reuses a Kenney-style straight/curve/T-junction/crossroad
// kit (currently just roads) can drive its tile visuals off these. A network
// with its own visual style (e.g. procedural train tracks) can ignore these
// and supply its own `buildMesh` override instead — the terrain-flush grading
// logic below is what's actually load-bearing for "doesn't clip terrain".

export interface KenneyNetworkAssets {
  straight: THREE.Object3D;
  straightVariant?: THREE.Object3D;
  curve: THREE.Object3D;
  tJunction: THREE.Object3D;
  crossroad: THREE.Object3D;
}

/** Converts a measured sRGB swatch component to the renderer's linear working space, for tintMultiplier-style color math. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Clones a Kenney template, scales it to tile size, tilts/rotates it, and recolors it via a gamma-correct tint multiplier. */
export function buildKenneyMesh(
  template: THREE.Object3D,
  rotationY: number,
  targetColorHex: number,
  swatchLinear: number[],
  pitch = 0,
): THREE.Object3D {
  const mesh = template.clone(true);
  mesh.scale.setScalar(TILE_SIZE);
  // THREE's default 'XYZ' Euler order composes as Rx * Ry * Rz, which — read as a
  // transform applied to a vector — rotates around Y (yaw) *first* and X (pitch)
  // *last*, using the fixed world X axis. For an E/W run that pitches the
  // already-yawed mesh around world X, tilting it based on tile *width* instead
  // of length. 'YXZ' order applies pitch to the untouched template first (always
  // tilting its native local-Z travel axis) and yaw second, so it works for both.
  mesh.rotation.set(pitch, rotationY, 0, "YXZ");
  // The template's own bottom face sits at local y=0, exactly the flattened terrain's
  // height — without this clearance the two surfaces z-fight, showing as a fine
  // flickering/checkered moire pattern where the terrain and road interleave.
  mesh.position.y = DECAL_HEIGHT;
  const target = new THREE.Color(targetColorHex);
  const tint = new THREE.Color(target.r / swatchLinear[0], target.g / swatchLinear[1], target.b / swatchLinear[2]);
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

// The corner template natively (rotationY = 0) connects dirs {3, 0} (W, N); the
// T/split template natively connects {3, 0, 1} (W, N, E), i.e. every side but
// S (dir 2). A rotation of k*90° shifts every connected direction index by k
// (mod 4) — verified empirically by rendering the piece at each of the 4
// rotations and sampling which tile edge was pavement vs. grass.
const CORNER_NATIVE_DIRS: [number, number] = [3, 0];
const T_JUNCTION_NATIVE_MISSING_DIR = 2;

/** Picks straight / curve / T-junction / crossroad shape from a tile's live connectivity mask. */
export function buildKenneyShapeMesh(
  mask: boolean[],
  cell: Cell,
  pitch: number,
  assets: KenneyNetworkAssets,
  targetColorHex: number,
  swatchLinear: number[],
  useVariant: (cell: Cell) => boolean = () => false,
): THREE.Object3D {
  const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
  const buildStraight = (axisIsZ: boolean) => {
    const template = useVariant(cell) && assets.straightVariant ? assets.straightVariant : assets.straight;
    return buildKenneyMesh(template, axisIsZ ? 0 : Math.PI / 2, targetColorHex, swatchLinear, pitch);
  };
  if (dirs.length === 2) {
    const [a, b] = dirs;
    const opposite = (a + 2) % 4 === b;
    if (opposite) return buildStraight(a % 2 === 0);
    const nativeStart = a === 0 && b === 3 ? 3 : a;
    const steps = (((nativeStart - CORNER_NATIVE_DIRS[0]) % 4) + 4) % 4;
    return buildKenneyMesh(assets.curve, steps * (Math.PI / 2), targetColorHex, swatchLinear);
  }
  if (dirs.length === 3) {
    const missingDir = [0, 1, 2, 3].find((d) => !dirs.includes(d))!;
    const steps = (((missingDir - T_JUNCTION_NATIVE_MISSING_DIR) % 4) + 4) % 4;
    return buildKenneyMesh(assets.tJunction, steps * (Math.PI / 2), targetColorHex, swatchLinear);
  }
  if (dirs.length === 1) return buildStraight(dirs[0] % 2 === 0);
  if (dirs.length === 0) return buildStraight(true);
  return buildKenneyMesh(assets.crossroad, 0, targetColorHex, swatchLinear); // 4-way
}

// --- Generic tile network ---------------------------------------------------

class NetworkTile<TKind extends string> {
  readonly cell: Cell;
  readonly kind: TKind;
  readonly group = new THREE.Group();
  private curbBodies: RAPIER.RigidBody[] = [];
  private curbMeshes: THREE.Object3D[] = [];
  private surfaceMesh: THREE.Object3D | null = null;
  centerHeight: number;
  slope: SlopeInfo | null;
  /** Direction (index into DIRS) this tile "points" — meaningful for kinds like a ramp; unused by most. */
  readonly facing: number;
  /** Extra physics body a subclass attached in onTilePlaced (e.g. a ramp's launch surface), kept flush with the tile's pad height across re-grades. */
  extraBody: RAPIER.RigidBody | null = null;

  constructor(cell: Cell, kind: TKind, centerHeight: number, facing: number, slope: SlopeInfo | null) {
    this.cell = cell;
    this.kind = kind;
    this.centerHeight = centerHeight;
    this.facing = facing;
    this.slope = slope;
  }

  applyGrade(centerHeight: number, slope: SlopeInfo | null): boolean {
    const changed = Math.abs(this.centerHeight - centerHeight) > 1e-4 || !slopesEqual(this.slope, slope);
    const heightDelta = centerHeight - this.centerHeight;
    this.centerHeight = centerHeight;
    this.slope = slope;
    this.group.position.y = centerHeight;
    if (this.extraBody) {
      const t = this.extraBody.translation();
      this.extraBody.setTranslation({ x: t.x, y: t.y + heightDelta, z: t.z }, true);
    }
    return changed;
  }

  setSurfaceMesh(mesh: THREE.Object3D): void {
    if (this.surfaceMesh) {
      this.group.remove(this.surfaceMesh);
      disposeObject3D(this.surfaceMesh);
    }
    this.surfaceMesh = mesh;
    this.group.add(mesh);
  }

  clearCurbs(world: RAPIER.World): void {
    for (const body of this.curbBodies) world.removeRigidBody(body);
    this.curbBodies = [];
    for (const mesh of this.curbMeshes) this.group.remove(mesh);
    this.curbMeshes = [];
  }

  addCurbBody(body: RAPIER.RigidBody): void {
    this.curbBodies.push(body);
  }

  addCurbMesh(mesh: THREE.Object3D): void {
    this.group.add(mesh);
    this.curbMeshes.push(mesh);
  }
}

const CURB_HEIGHT = 0.6;
const CURB_THICKNESS = 0.25;

/**
 * Generic terrain-flush tile network: placement/connectivity, grading the
 * ground so pavement never clips or floats, Dijkstra pathfinding, and
 * waypoint generation through bends. Roads, train tracks, and canals all
 * subclass this so "doesn't clip terrain" is the *same* grading code path
 * for every transport, not a reimplementation per type.
 */
export abstract class TileNetwork<TKind extends string> {
  readonly root = new THREE.Group();
  protected readonly tiles = new Map<string, NetworkTile<TKind>>();
  protected readonly RAPIER: Rapier;
  protected readonly world: RAPIER.World;
  protected readonly terrain: Terrain;
  protected spawnCell: Cell = { col: 0, row: 0 };
  protected targetCell: Cell = { col: 0, row: 0 };
  /** Shared cross-transport occupancy: returns false if another network already owns this cell. */
  private readonly isCellFree: (cell: Cell) => boolean;
  private readonly claimCell: (cell: Cell) => void;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    terrain: Terrain,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.terrain = terrain;
    this.isCellFree = isCellFree;
    this.claimCell = claimCell;
  }

  protected abstract speedMultiplier(kind: TKind): number;
  protected abstract buildMesh(kind: TKind, facing: number, mask: boolean[], cell: Cell, pitch: number): THREE.Object3D;
  /** Whether curb walls (physical + visual) are built at all for this network (canals have none). */
  protected buildsCurbs(_kind: TKind): boolean {
    return true;
  }
  /** Junction-like kinds that stay flat/open on every side regardless of connectivity (e.g. crossroad). */
  protected isAlwaysOpen(_kind: TKind): boolean {
    return false;
  }
  /** Kinds excluded from slope grading (e.g. a ramp/plate whose mesh is always flat). */
  protected canSlope(_kind: TKind): boolean {
    return true;
  }
  /** Extra per-direction curb skip beyond the connectivity mask (e.g. a ramp's launch/entry ends). */
  protected curbSkipExtra(_kind: TKind, _dir: number, _facing: number): boolean {
    return false;
  }
  /** Curb wall color — roads use plain grey, but a subclass can theme it (e.g. canal banks). */
  protected curbColor(_kind: TKind): number {
    return 0x9a9a9a;
  }
  /** Target flat height for a non-sloped tile; default averages already-connected edges. Canals override to carve a fixed depth instead of matching surrounding terrain. */
  protected targetFlatHeight(cell: Cell, mask: boolean[]): number {
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
  /** Hook for a subclass to attach an extra physics body when a tile is placed (e.g. a ramp's launch collider). Store it on tile.extraBody so re-grades keep it flush. */
  protected onTilePlaced(_tile: { group: THREE.Group; cell: Cell; facing: number; setExtraBody: (b: RAPIER.RigidBody) => void }, _kind: TKind): void {}
  /** Extra pathfinding edges beyond orthogonal neighbors (e.g. a ramp's 2-tile jump). */
  protected extraEdges(_cell: Cell, _kind: TKind, _facing: number): Array<{ cell: Cell; weight: number }> {
    return [];
  }
  /** Facing for a newly placed tile, given the direction its network neighbor lies in. Default points away from the connection (e.g. a ramp launches away from where you drove in). */
  protected facingForPlacement(incoming: number): number {
    return (incoming + 2) % 4;
  }

  /**
   * The network is permanent and persists across rounds — only the
   * spawn/target endpoints move each time a new run starts.
   */
  setEndpoints(spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): void {
    this.spawnCell = this.worldToCell(spawnWorld.x, spawnWorld.z);
    this.targetCell = this.worldToCell(targetWorld.x, targetWorld.z);
    for (const cell of [...this.tiles.keys()]) {
      const [col, row] = cell.split(":").map(Number);
      this.refreshTile({ col, row });
    }
  }

  worldToCell(x: number, z: number): Cell {
    return worldToCell(x, z);
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
    const isEndpoint =
      (cell.col === this.spawnCell.col && cell.row === this.spawnCell.row) ||
      (cell.col === this.targetCell.col && cell.row === this.targetCell.row);
    if (!isEndpoint && this.incomingDirection(cell) === null) return false;
    // A cell already claimed by a different transport's network blocks this one —
    // the player has to route around it, same as any other obstacle.
    if (!isEndpoint && !this.isCellFree(cell)) return false;
    return true;
  }

  /**
   * For a tile that will render as a straight piece (one real-tile connection,
   * or two opposite), grades it as a ramp from its low edge's actual terrain
   * height to its high edge's, capped to MAX_GRADE_PITCH. Junction shapes
   * (bends/T/4-way) return null and stay flat.
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
   * Grades the ground under a cell so the surface (and its physics) sits
   * flush with the (now-levelled or ramped) terrain underneath, and returns
   * the resulting pad height/slope. This is the terrain-flush logic every
   * transport network shares — the actual fix for tiles clipping/floating.
   */
  private gradeCell(cell: Cell, kind: TKind): { flatHeight: number; slope: SlopeInfo | null } {
    const slope = this.canSlope(kind) ? this.computeSlope(cell, this.tileConnectionMask(cell)) : null;
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
      flatHeight = this.targetFlatHeight(cell, this.connectionMask(cell));
      this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, () => flatHeight);
    }
    return { flatHeight, slope };
  }

  place(cell: Cell, kind: TKind): boolean {
    if (!this.canPlace(cell)) return false;
    const incoming = this.incomingDirection(cell) ?? 0;
    const facing = this.facingForPlacement(incoming);

    const { flatHeight, slope } = this.gradeCell(cell, kind);
    const center = cellCenter(cell);
    center.y = flatHeight;

    const tile = new NetworkTile<TKind>(cell, kind, center.y, facing, slope);
    tile.group.position.copy(center);
    this.root.add(tile.group);
    this.tiles.set(cellKey(cell), tile);
    this.claimCell(cell);

    this.onTilePlaced(
      { group: tile.group, cell, facing, setExtraBody: (b) => (tile.extraBody = b) },
      kind,
    );

    // Recompute shape/curbs for this tile and every orthogonal neighbor tile,
    // cascading further outward wherever a tile's grade actually changes.
    this.propagateRegrade([cell, ...DIRS.map(({ dc, dr }) => ({ col: cell.col + dc, row: cell.row + dr }))]);
    return true;
  }

  /**
   * Re-grades each seed cell, and whenever a tile's height/slope actually
   * changes, enqueues its own placed neighbors too — a change can ripple past
   * the immediate neighbor and leave a more distant tile's surface stale
   * relative to the ground under it (clipping into or floating above it).
   */
  private propagateRegrade(seed: Cell[]): void {
    const queue: Cell[] = [...seed];
    const queued = new Set(queue.map(cellKey));
    const maxIterations = Math.max(64, this.tiles.size * 8);
    let iterations = 0;
    while (queue.length > 0 && iterations < maxIterations) {
      iterations++;
      const cell = queue.shift()!;
      queued.delete(cellKey(cell));
      if (!this.refreshTile(cell)) continue;
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
  private refreshTile(cell: Cell): boolean {
    const tile = this.tiles.get(cellKey(cell));
    if (!tile) return false;
    const { flatHeight, slope } = this.gradeCell(cell, tile.kind);
    const changed = tile.applyGrade(flatHeight, slope);

    const shapeMask = this.tileConnectionMask(cell);
    tile.setSurfaceMesh(this.buildMesh(tile.kind, tile.facing, shapeMask, cell, tile.slope?.pitch ?? 0));

    tile.clearCurbs(this.world);
    if (this.buildsCurbs(tile.kind) && !this.isAlwaysOpen(tile.kind)) {
      const curbMask = this.connectionMask(cell);
      const center = cellCenter(cell);
      for (let dir = 0; dir < 4; dir++) {
        if (curbMask[dir]) continue;
        if (this.curbSkipExtra(tile.kind, dir, tile.facing)) continue;
        this.addCurb(tile, dir, center);
      }
    }
    return changed;
  }

  private addCurb(tile: NetworkTile<TKind>, dir: number, center: THREE.Vector3): void {
    const { dc, dr } = DIRS[dir];
    const isNS = dc === 0;
    const hx = isNS ? TILE_SIZE / 2 : CURB_THICKNESS / 2;
    const hz = isNS ? CURB_THICKNESS / 2 : TILE_SIZE / 2;
    const x = center.x + (dc * TILE_SIZE) / 2;
    const z = center.z + (dr * TILE_SIZE) / 2;

    let y = tile.centerHeight + DECAL_HEIGHT + CURB_HEIGHT / 2;
    let tiltX = 0;
    let tiltZ = 0;
    if (tile.slope) {
      const isParallelSide = tile.slope.axisIsZ ? !isNS : isNS;
      if (isParallelSide) {
        tiltX = tile.slope.axisIsZ ? tile.slope.pitch : 0;
        tiltZ = tile.slope.axisIsZ ? 0 : -tile.slope.pitch;
      } else {
        const loDir = tile.slope.axisIsZ ? 2 : 3;
        y = (dir === loDir ? tile.slope.loHeight : tile.slope.hiHeight) + DECAL_HEIGHT + CURB_HEIGHT / 2;
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
    tile.addCurbBody(body);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, CURB_HEIGHT, hz * 2),
      new THREE.MeshStandardMaterial({ color: this.curbColor(tile.kind), roughness: 0.8 }),
    );
    mesh.position.set(x - center.x, y - tile.centerHeight, z - center.z);
    mesh.rotation.set(tiltX, 0, tiltZ);
    mesh.castShadow = true;
    tile.addCurbMesh(mesh);
  }

  /**
   * Dijkstra shortest path (weighted by tile speed) from the spawn cell to
   * the target cell. Returns the ordered cell path, or null if no route
   * exists yet.
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

  private edgesFrom(cell: Cell): Array<{ cell: Cell; weight: number }> {
    const edges: Array<{ cell: Cell; weight: number }> = [];
    for (const { dc, dr } of DIRS) {
      const neighbor = { col: cell.col + dc, row: cell.row + dr };
      if (!this.isNetworkCell(neighbor)) continue;
      const kind = this.tiles.get(cellKey(neighbor))?.kind;
      const speed = kind ? this.speedMultiplier(kind) : 1;
      edges.push({ cell: neighbor, weight: TILE_SIZE / speed });
    }
    const tile = this.tiles.get(cellKey(cell));
    if (tile) {
      for (const edge of this.extraEdges(cell, tile.kind, tile.facing)) {
        if (this.isNetworkCell(edge.cell)) edges.push(edge);
      }
    }
    return edges;
  }

  /**
   * Samples points along the tile's actual curve for a bend, so a follower
   * hugs the surface through a turn instead of cutting straight across the
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
   * bends and using exact spawn/target positions at the ends.
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
        if (isBend && points.length > 0) points[points.length - 1].slow = true;
        for (const position of bendPoints) points.push({ position, slow: isBend });
      } else {
        points.push({ position: this.cellWorldCenter(cell), slow: false });
      }
    }
    return points;
  }

  getKindAt(x: number, z: number): TKind | null {
    const cell = this.worldToCell(x, z);
    if (Math.abs(x - cell.col * TILE_SIZE) > TILE_SIZE / 2) return null;
    if (Math.abs(z - cell.row * TILE_SIZE) > TILE_SIZE / 2) return null;
    return this.tiles.get(cellKey(cell))?.kind ?? null;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  get occupiedCells(): Cell[] {
    return [...this.tiles.values()].map((t) => t.cell);
  }
}
